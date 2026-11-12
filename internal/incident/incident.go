// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// Package incident 是运行异常（INC-01a，0043，规格 SPEC-settings-18、19）：系统运行中出的问题集中记一份，
// 同一个问题按指纹合并只累加次数；能转成研发任务，定时任务的「运行异常巡检」把要修的建成给 Claude Code 修的任务。
//
// 记录来源有三种：前端上报（POST /api/incidents/report）、内核（连接器鉴权和同步失败）、插件（Core().Incidents()）。
// 写成功后往事件总线发一条 incident，前端按它刷新；转任务、改状态、巡检建任务记审计。
package incident

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/lizhao903/pm-workspace/internal/audit"
	"github.com/lizhao903/pm-workspace/internal/db"
	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/idgen"
	"github.com/lizhao903/pm-workspace/internal/store"
)

// 级别。
const (
	LevelError = "error"
	LevelWarn  = "warn"
)

// 状态，同原型 IncidentStatus。
const (
	StatusOpen     = "open"
	StatusTasked   = "tasked"
	StatusIgnored  = "ignored"
	StatusResolved = "resolved"
)

// 来源。插件的是 plugin:<插件 id>。
const (
	SourceFrontend = "frontend"
	SourceBackend  = "backend"
	SourcePlugin   = "plugin:"
)

// EventType 是写成功后发到事件总线上的事件类型，载荷见 Event。
const EventType = "incident"

const (
	// MaxOccurrences 是 occurrences 留几个。
	MaxOccurrences = 20
	// Throttle 内同一指纹再出现只加次数、更新最近时间，不追加时间线、不覆盖内容。
	Throttle = time.Minute

	maxFingerprint = 300
	maxModule      = 50
	maxTitle       = 200
	maxMessage     = 4000
	maxStack       = 16 << 10
)

// note 的几种写法。
const (
	noteReopenedResolved = "标为已解决后又出现了"
	noteReopenedIgnored  = "忽略后又出现了"
	noteTaskDeleted      = "关联的任务已删除"
)

// timeLayout 定长毫秒 UTC，字符串比较即时间比较。
const timeLayout = "2006-01-02T15:04:05.000Z"

// Incident 是一条运行异常，字段对照原型 Incident；TaskRef、TaskStatus、TaskDone 是读的时候按 task_id 查出来的。
type Incident struct {
	ID          string         `json:"id"`
	Fingerprint string         `json:"fingerprint"`
	Level       string         `json:"level"`
	Module      string         `json:"module"`
	Title       string         `json:"title"`
	Message     string         `json:"message"`
	Context     map[string]any `json:"context"`
	Stack       string         `json:"stack"`
	Status      string         `json:"status"`
	Note        string         `json:"note"`
	Count       int            `json:"count"`
	FirstAt     time.Time      `json:"first_at"`
	LastAt      time.Time      `json:"last_at"`
	Occurrences []time.Time    `json:"occurrences"`
	TaskID      *string        `json:"task_id"`
	TaskRef     string         `json:"task_ref"`
	TaskStatus  string         `json:"task_status"`
	TaskDone    bool           `json:"task_done"`
	Source      string         `json:"source"`
}

// Report 是记一次异常的输入。Fingerprint 必填（前端上报省略时由接口层按模块、标题、堆栈第一帧算）。
type Report struct {
	Fingerprint string
	Level       string
	Module      string
	Title       string
	Message     string
	Stack       string
	Context     map[string]any
	Source      string
}

// Event 是事件 incident 的载荷。Action：created 新记一条、merged 合并进已有的、reopened 再出现重新打开、
// updated 改了状态、tasked 转了任务。
type Event struct {
	ID          string `json:"id"`
	Action      string `json:"action"`
	Status      string `json:"status"`
	Level       string `json:"level"`
	Fingerprint string `json:"fingerprint"`
}

// Publisher 往事件总线上发事件，*events.Bus 满足它。
type Publisher interface {
	Publish(ctx context.Context, eventType string, payload any) error
}

// TaskCreator 是建任务要用的 store 方法；传外层包装过的 store，修订、事件、审计照常。
type TaskCreator interface {
	CreateObject(ctx context.Context, o *domain.Object, a store.Actor) (*domain.Object, error)
}

// Filter 是列表的筛选，每项可以逗号分隔多选，空的不参与。
type Filter struct {
	Status []string
	Level  []string
	Module []string
}

// Store 读写 incidents 表（0043）。Events、Audit、Tasks 由 cmd/pmw 接上，没接时不发事件、不记审计、不能转任务。
type Store struct {
	db  *db.DB
	log *slog.Logger
	now func() time.Time
	loc *time.Location

	Events Publisher
	Audit  *audit.Log
	Tasks  TaskCreator

	// mu 让读改写一个一个来：合并、转任务都是先读后写
	mu sync.Mutex
	// reports 是前端上报的整体限流
	reports *limiter
}

// New 建一个运行异常表的读写。
func New(d *db.DB, log *slog.Logger) *Store {
	if log == nil {
		log = slog.Default()
	}
	return &Store{db: d, log: log.With("component", "incident"), now: time.Now, loc: time.Local,
		reports: newLimiter(ReportLimit, time.Minute)}
}

// SetClock 换掉取当前时间的函数，测试用。
func (s *Store) SetClock(now func() time.Time) { s.now = now }

// SetLocation 换掉任务描述里时间的时区，测试用；默认 time.Local。
func (s *Store) SetLocation(loc *time.Location) { s.loc = loc }

func invalid(format string, a ...any) error {
	return fmt.Errorf("%w: %s", domain.ErrValidation, fmt.Sprintf(format, a...))
}

func conflict(format string, a ...any) error {
	return fmt.Errorf("%w: %s", domain.ErrConflict, fmt.Sprintf(format, a...))
}

// clip 按字数截断，超出的加省略号。
func clip(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	r := []rune(s)
	return string(r[:n]) + "…"
}

// clipBytes 按字节截断，不切坏 UTF-8。
func clipBytes(s string, n int) string {
	if len(s) <= n {
		return s
	}
	s = s[:n]
	for len(s) > 0 && !utf8.ValidString(s) {
		s = s[:len(s)-1]
	}
	return s + "\n…（已截断）"
}

// normalize 去空白、查必填、按上限截断。
func (r Report) normalize() (Report, error) {
	r.Fingerprint = strings.TrimSpace(r.Fingerprint)
	r.Level = strings.TrimSpace(r.Level)
	r.Module = strings.TrimSpace(r.Module)
	r.Title = strings.TrimSpace(r.Title)
	r.Message = strings.TrimSpace(r.Message)
	r.Stack = strings.TrimRight(r.Stack, " \t\r\n")
	r.Source = strings.TrimSpace(r.Source)
	switch {
	case r.Fingerprint == "":
		return r, invalid("fingerprint is required")
	case utf8.RuneCountInString(r.Fingerprint) > maxFingerprint:
		return r, invalid("fingerprint is longer than %d characters", maxFingerprint)
	case r.Level != LevelError && r.Level != LevelWarn:
		return r, invalid("level must be error or warn, got %q", r.Level)
	case r.Module == "":
		return r, invalid("module is required")
	case r.Title == "":
		return r, invalid("title is required")
	}
	r.Module = clip(r.Module, maxModule)
	r.Title = clip(r.Title, maxTitle)
	r.Message = clip(r.Message, maxMessage)
	r.Stack = clipBytes(r.Stack, maxStack)
	if r.Context == nil {
		r.Context = map[string]any{}
	}
	if r.Source == "" {
		r.Source = SourceBackend
	}
	return r, nil
}

const cols = `i.id, i.fingerprint, i.level, i.module, i.title, i.message, i.context, i.stack, i.status, i.note, i.count,
	i.first_at, i.last_at, i.occurrences, i.task_id, i.source,
	COALESCE(o.ref, ''), COALESCE(o.status, ''),
	CASE WHEN o.id IS NULL THEN 0 ELSE EXISTS (SELECT 1 FROM object_types t, json_each(t.statuses) j
		WHERE t.id = o.type_id AND json_extract(j.value, '$.key') = o.status AND json_extract(j.value, '$.terminal')) END`

const from = ` FROM incidents i LEFT JOIN objects o ON o.id = i.task_id AND o.deleted_at IS NULL`

type scanner interface{ Scan(dest ...any) error }

func scan(r scanner) (*Incident, error) {
	var (
		x                   Incident
		ctxJSON, occJSON    string
		firstAt, lastAt     string
		taskID              sql.NullString
		taskDone            int
		taskRef, taskStatus string
	)
	if err := r.Scan(&x.ID, &x.Fingerprint, &x.Level, &x.Module, &x.Title, &x.Message, &ctxJSON, &x.Stack, &x.Status,
		&x.Note, &x.Count, &firstAt, &lastAt, &occJSON, &taskID, &x.Source, &taskRef, &taskStatus, &taskDone); err != nil {
		return nil, err
	}
	x.Context = map[string]any{}
	_ = json.Unmarshal([]byte(ctxJSON), &x.Context)
	if x.Context == nil {
		x.Context = map[string]any{}
	}
	x.Occurrences = decodeTimes(occJSON)
	x.FirstAt, _ = time.Parse(timeLayout, firstAt)
	x.LastAt, _ = time.Parse(timeLayout, lastAt)
	if taskID.Valid && taskID.String != "" {
		v := taskID.String
		x.TaskID = &v
	}
	x.TaskRef, x.TaskStatus, x.TaskDone = taskRef, taskStatus, taskDone != 0
	return &x, nil
}

func decodeTimes(raw string) []time.Time {
	var ss []string
	_ = json.Unmarshal([]byte(raw), &ss)
	out := make([]time.Time, 0, len(ss))
	for _, s := range ss {
		if t, err := time.Parse(timeLayout, s); err == nil {
			out = append(out, t)
		}
	}
	return out
}

func encodeTimes(ts []time.Time) string {
	ss := make([]string, len(ts))
	for i, t := range ts {
		ss[i] = t.UTC().Format(timeLayout)
	}
	b, _ := json.Marshal(ss)
	return string(b)
}

func encodeContext(m map[string]any) (string, error) {
	if m == nil {
		m = map[string]any{}
	}
	b, err := json.Marshal(m)
	if err != nil {
		return "", invalid("context: %v", err)
	}
	return string(b), nil
}

// Record 记一次异常：指纹没见过就新建一条未处理；见过就合并——次数加一、更新最近时间，
// 距上次进时间线超过 Throttle 的才追加时间线（最多留 MaxOccurrences 个）、用这次的内容覆盖；
// 已忽略、已解决的再出现重新打开（有任务的回 tasked），note 写明。
func (s *Store) Record(ctx context.Context, r Report) (*Incident, error) {
	r, err := r.normalize()
	if err != nil {
		return nil, err
	}
	ctxJSON, err := encodeContext(r.Context)
	if err != nil {
		return nil, err
	}
	now := s.now().UTC().Truncate(time.Millisecond)
	stamp := now.Format(timeLayout)

	s.mu.Lock()
	cur, err := s.byFingerprint(ctx, r.Fingerprint)
	action := "created"
	var id string
	switch {
	case errors.Is(err, sql.ErrNoRows):
		id = idgen.Prefixed("inc")
		_, err = s.db.W.ExecContext(ctx, `INSERT INTO incidents (id, fingerprint, level, module, title, message, context, stack,
			status, note, count, first_at, last_at, occurrences, task_id, source)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', '', 1, ?, ?, ?, NULL, ?)`,
			id, r.Fingerprint, r.Level, r.Module, r.Title, r.Message, ctxJSON, r.Stack, stamp, stamp,
			encodeTimes([]time.Time{now}), r.Source)
	case err != nil:
	default:
		id = cur.ID
		action = "merged"
		status, note := cur.Status, cur.Note
		if status == StatusResolved || status == StatusIgnored {
			note = noteReopenedResolved
			if status == StatusIgnored {
				note = noteReopenedIgnored
			}
			status = StatusOpen
			if cur.TaskID != nil {
				status = StatusTasked
			}
			action = "reopened"
		} else if note == noteTaskDeleted {
			// 修复任务删了以后又出现：不再是「先不修」，清掉标记，巡检重新算它
			note = ""
		}
		throttled := len(cur.Occurrences) > 0 && now.Sub(cur.Occurrences[0]) < Throttle
		if throttled {
			_, err = s.db.W.ExecContext(ctx, `UPDATE incidents SET count = count + 1, last_at = ?, status = ?, note = ? WHERE id = ?`,
				stamp, status, note, id)
		} else {
			occ := append([]time.Time{now}, cur.Occurrences...)
			if len(occ) > MaxOccurrences {
				occ = occ[:MaxOccurrences]
			}
			_, err = s.db.W.ExecContext(ctx, `UPDATE incidents SET count = count + 1, last_at = ?, status = ?, note = ?,
				level = ?, module = ?, title = ?, message = ?, context = ?, stack = ?, occurrences = ?, source = ? WHERE id = ?`,
				stamp, status, note, r.Level, r.Module, r.Title, r.Message, ctxJSON, r.Stack, encodeTimes(occ), r.Source, id)
		}
	}
	s.mu.Unlock()
	if err != nil {
		return nil, fmt.Errorf("record incident: %w", err)
	}
	out, err := s.get(ctx, s.db.W, id)
	if err != nil {
		return nil, err
	}
	s.publish(ctx, out, action)
	return out, nil
}

// Note 是 Record 的不回错版本：内核和插件记异常不该挡住自己的业务，失败只记日志。
func (s *Store) Note(ctx context.Context, r Report) {
	if s == nil {
		return
	}
	if _, err := s.Record(context.WithoutCancel(ctx), r); err != nil {
		s.log.Error("incident not recorded", "fingerprint", r.Fingerprint, "err", err)
	}
}

func (s *Store) byFingerprint(ctx context.Context, fp string) (*Incident, error) {
	return scan(s.db.W.QueryRowContext(ctx, `SELECT `+cols+from+` WHERE i.fingerprint = ?`, fp))
}

func (s *Store) get(ctx context.Context, q *sql.DB, id string) (*Incident, error) {
	x, err := scan(q.QueryRowContext(ctx, `SELECT `+cols+from+` WHERE i.id = ?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, fmt.Errorf("%w: incident %s", domain.ErrNotFound, id)
	}
	return x, err
}

// Get 取一条；不存在回 ErrNotFound。
func (s *Store) Get(ctx context.Context, id string) (*Incident, error) {
	if err := s.reconcile(ctx); err != nil {
		return nil, err
	}
	return s.get(ctx, s.db.R, id)
}

// List 按最近一次倒序列出，不分页。
func (s *Store) List(ctx context.Context, f Filter) ([]Incident, error) {
	if err := s.reconcile(ctx); err != nil {
		return nil, err
	}
	var (
		where []string
		args  []any
	)
	in := func(col string, vals []string) {
		if len(vals) == 0 {
			return
		}
		where = append(where, col+" IN ("+strings.TrimSuffix(strings.Repeat("?,", len(vals)), ",")+")")
		for _, v := range vals {
			args = append(args, v)
		}
	}
	in("i.status", f.Status)
	in("i.level", f.Level)
	in("i.module", f.Module)
	q := `SELECT ` + cols + from
	if len(where) > 0 {
		q += " WHERE " + strings.Join(where, " AND ")
	}
	rows, err := s.db.R.QueryContext(ctx, q+` ORDER BY i.last_at DESC, i.rowid DESC`, args...)
	if err != nil {
		return nil, fmt.Errorf("list incidents: %w", err)
	}
	defer func() { _ = rows.Close() }()
	out := []Incident{}
	for rows.Next() {
		x, err := scan(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *x)
	}
	return out, rows.Err()
}

// reconcile 处理关联任务被删（含进回收站）的：已转任务的退回未处理、note 写「关联的任务已删除」，其余状态只清掉 task_id。
func (s *Store) reconcile(ctx context.Context) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	gone := `task_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM objects o WHERE o.id = incidents.task_id AND o.deleted_at IS NULL)`
	if _, err := s.db.W.ExecContext(ctx, `UPDATE incidents SET
		note = CASE WHEN status = 'tasked' THEN ? ELSE note END,
		status = CASE WHEN status = 'tasked' THEN 'open' ELSE status END,
		task_id = NULL WHERE `+gone, noteTaskDeleted); err != nil {
		return fmt.Errorf("reconcile incident tasks: %w", err)
	}
	return nil
}

// SetStatus 改状态：ignored 忽略、resolved 标为已解决、open 重新打开（有关联任务的回 tasked，tasked 同 open）。
// 改了就清掉 note；记审计、发事件。
func (s *Store) SetStatus(ctx context.Context, id, status string, a store.Actor) (*Incident, error) {
	status = strings.TrimSpace(status)
	switch status {
	case StatusOpen, StatusTasked, StatusIgnored, StatusResolved:
	default:
		return nil, invalid("status must be open / tasked / ignored / resolved, got %q", status)
	}
	if err := s.reconcile(ctx); err != nil {
		return nil, err
	}
	s.mu.Lock()
	cur, err := s.get(ctx, s.db.W, id)
	if err == nil {
		if status == StatusOpen || status == StatusTasked {
			status = StatusOpen
			if cur.TaskID != nil {
				status = StatusTasked
			}
		}
		_, err = s.db.W.ExecContext(ctx, `UPDATE incidents SET status = ?, note = '' WHERE id = ?`, status, id)
	}
	s.mu.Unlock()
	if err != nil {
		return nil, err
	}
	out, err := s.get(ctx, s.db.W, id)
	if err != nil {
		return nil, err
	}
	s.audit(ctx, a, audit.Entry{Kind: audit.KindConfig, Action: "update", TargetType: "incident", TargetID: id,
		Summary: fmt.Sprintf("运行异常「%s」%s → %s", out.Title, statusLabel(cur.Status), statusLabel(out.Status)),
		Detail:  map[string]any{"fields": []string{"status"}, "from": cur.Status, "to": out.Status}})
	s.publish(ctx, out, "updated")
	return out, nil
}

func statusLabel(st string) string {
	switch st {
	case StatusOpen:
		return "未处理"
	case StatusTasked:
		return "已转任务"
	case StatusIgnored:
		return "已忽略"
	case StatusResolved:
		return "已解决"
	}
	return st
}

func (s *Store) publish(ctx context.Context, x *Incident, action string) {
	if s.Events == nil || x == nil {
		return
	}
	if err := s.Events.Publish(ctx, EventType, Event{ID: x.ID, Action: action, Status: x.Status, Level: x.Level,
		Fingerprint: x.Fingerprint}); err != nil {
		s.log.Warn("incident event not published", "id", x.ID, "err", err)
	}
}

// audit 记一条审计；e.Actor 为空时用 a。
func (s *Store) audit(ctx context.Context, a store.Actor, e audit.Entry) {
	if s.Audit == nil {
		return
	}
	if e.Actor == "" {
		e.Actor, e.Source = domain.ComposeActor(a.Name, a.Session), a.Source
	}
	s.Audit.Note(ctx, e)
}
