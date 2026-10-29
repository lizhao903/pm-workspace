package schedule

import (
	"cmp"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/lizhao903/pm-workspace/internal/db"
	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/idgen"
)

// timeLayout 定长毫秒 UTC，字符串比较即时间比较。
const timeLayout = "2006-01-02T15:04:05.000Z"

// maxName 是名字的字数上限。
const maxName = 100

// Schedule 是一个定时任务。NextRunAt 是读的时候按规则现算的，停用、一次性已过时为 nil。
type Schedule struct {
	ID        string     `json:"id"`
	Name      string     `json:"name"`
	Enabled   bool       `json:"enabled"`
	Rule      Rule       `json:"rule"`
	Action    Action     `json:"action"`
	NextRunAt *time.Time `json:"next_run_at"`
	CreatedAt time.Time  `json:"created_at"`
	UpdatedAt time.Time  `json:"updated_at"`
}

// Input 是新建的字段；Enabled 不给时为 true。
type Input struct {
	Name    string `json:"name"`
	Enabled *bool  `json:"enabled"`
	Rule    Rule   `json:"rule"`
	Action  Action `json:"action"`
}

// Patch 是修改的字段，nil 为不改；rule、action 整体替换。
type Patch struct {
	Name    *string `json:"name"`
	Enabled *bool   `json:"enabled"`
	Rule    *Rule   `json:"rule"`
	Action  *Action `json:"action"`
}

// Store 读写 schedules 表（0020）。
type Store struct {
	db  *db.DB
	loc *time.Location
	now func() time.Time
	// plugins 校验、执行插件登记的动作（VID-06a），SetPluginActions 接上
	plugins PluginActions
}

// New 建一个定时任务表的读写。loc 是规则里墙上时间所在的时区，nil 为 time.Local。
func New(d *db.DB, loc *time.Location) *Store {
	if loc == nil {
		loc = time.Local
	}
	return &Store{db: d, loc: loc, now: time.Now}
}

// Location 是规则按哪个时区算。
func (s *Store) Location() *time.Location { return s.loc }

// ZoneName 是时区的名字，给人看：time.Local 显示为 Local，这里换成 Asia/Shanghai 这类 IANA 名，取不到时用「CST +08:00」。
func (s *Store) ZoneName() string {
	if name := s.loc.String(); name != "Local" {
		return name
	}
	if tz := strings.TrimPrefix(os.Getenv("TZ"), ":"); tz != "" {
		return tz
	}
	if link, err := os.Readlink("/etc/localtime"); err == nil {
		if _, name, ok := strings.Cut(link, "zoneinfo/"); ok && name != "" {
			return name
		}
	}
	return s.now().In(s.loc).Format("MST -07:00")
}

// Now 是 Store 的当前时间，测试可以替换。
func (s *Store) Now() time.Time { return s.now() }

// SetClock 换掉取当前时间的函数，测试用。
func (s *Store) SetClock(now func() time.Time) { s.now = now }

// CheckRule 规范化并校验一条规则，一次性规则已过时也算错。保存和预览共用。
func (s *Store) CheckRule(r Rule) (Rule, error) {
	r = r.Normalize()
	if err := r.Validate(); err != nil {
		return r, err
	}
	if r.Expired(s.now(), s.loc) {
		return r, invalid("rule: %s %s has already passed", r.Date, r.Time)
	}
	return r, nil
}

func checkName(name string) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return "", invalid("name is required")
	}
	if utf8.RuneCountInString(name) > maxName {
		return "", invalid("name is longer than %d characters", maxName)
	}
	return name, nil
}

func (s *Store) checkAction(ctx context.Context, a Action) (Action, error) {
	a = a.Normalize()
	if !builtinKind(a.Kind) {
		return s.checkPluginAction(ctx, a)
	}
	return a, a.Validate()
}

// Create 新建一个定时任务。
func (s *Store) Create(ctx context.Context, in Input) (*Schedule, error) {
	name, err := checkName(in.Name)
	if err != nil {
		return nil, err
	}
	rule, err := s.CheckRule(in.Rule)
	if err != nil {
		return nil, err
	}
	action, err := s.checkAction(ctx, in.Action)
	if err != nil {
		return nil, err
	}
	enabled := in.Enabled == nil || *in.Enabled
	now := s.now().UTC().Truncate(time.Millisecond)
	sc := &Schedule{ID: idgen.Prefixed("sch"), Name: name, Enabled: enabled, Rule: rule, Action: action,
		CreatedAt: now, UpdatedAt: now}
	ruleJSON, actionJSON, err := encode(rule, action)
	if err != nil {
		return nil, err
	}
	if _, err := s.db.W.ExecContext(ctx,
		`INSERT INTO schedules (id, name, enabled, rule, action, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
		sc.ID, sc.Name, boolInt(enabled), ruleJSON, actionJSON, now.Format(timeLayout), now.Format(timeLayout)); err != nil {
		return nil, fmt.Errorf("insert schedule: %w", err)
	}
	s.fillNext(sc)
	return sc, nil
}

// Get 取一个；不存在回 ErrNotFound。
func (s *Store) Get(ctx context.Context, id string) (*Schedule, error) {
	return s.get(ctx, s.db.R, id)
}

func (s *Store) get(ctx context.Context, q *sql.DB, id string) (*Schedule, error) {
	row := q.QueryRowContext(ctx,
		`SELECT id, name, enabled, rule, action, created_at, updated_at FROM schedules WHERE id = ?`, id)
	sc, err := scan(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, fmt.Errorf("%w: schedule %s", domain.ErrNotFound, id)
	}
	if err != nil {
		return nil, err
	}
	s.fillNext(sc)
	return sc, nil
}

// List 全部定时任务：下次执行早的在前，不再执行的（停用、已过）排后面，同组按新建时间倒序。
func (s *Store) List(ctx context.Context) ([]Schedule, error) {
	rows, err := s.db.R.QueryContext(ctx,
		`SELECT id, name, enabled, rule, action, created_at, updated_at FROM schedules ORDER BY created_at DESC, rowid DESC`)
	if err != nil {
		return nil, fmt.Errorf("list schedules: %w", err)
	}
	defer func() { _ = rows.Close() }()
	out := []Schedule{}
	for rows.Next() {
		sc, err := scan(rows)
		if err != nil {
			return nil, err
		}
		s.fillNext(sc)
		out = append(out, *sc)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	slices.SortStableFunc(out, func(a, b Schedule) int {
		switch {
		case a.NextRunAt == nil && b.NextRunAt == nil:
			return 0
		case a.NextRunAt == nil:
			return 1
		case b.NextRunAt == nil:
			return -1
		}
		return cmp.Compare(a.NextRunAt.UnixNano(), b.NextRunAt.UnixNano())
	})
	return out, nil
}

// Update 改名字、启停、规则、动作；只改了启停或名字时不重新校验旧规则（过期的一次性任务也能改名、停用）。
func (s *Store) Update(ctx context.Context, id string, p Patch) (*Schedule, error) {
	cur, err := s.get(ctx, s.db.W, id)
	if err != nil {
		return nil, err
	}
	if p.Name != nil {
		if cur.Name, err = checkName(*p.Name); err != nil {
			return nil, err
		}
	}
	if p.Enabled != nil {
		cur.Enabled = *p.Enabled
	}
	if p.Rule != nil {
		if cur.Rule, err = s.CheckRule(*p.Rule); err != nil {
			return nil, err
		}
	}
	if p.Action != nil {
		if cur.Action, err = s.checkAction(ctx, *p.Action); err != nil {
			return nil, err
		}
	}
	ruleJSON, actionJSON, err := encode(cur.Rule, cur.Action)
	if err != nil {
		return nil, err
	}
	cur.UpdatedAt = s.now().UTC().Truncate(time.Millisecond)
	res, err := s.db.W.ExecContext(ctx,
		`UPDATE schedules SET name = ?, enabled = ?, rule = ?, action = ?, updated_at = ? WHERE id = ?`,
		cur.Name, boolInt(cur.Enabled), ruleJSON, actionJSON, cur.UpdatedAt.Format(timeLayout), id)
	if err != nil {
		return nil, fmt.Errorf("update schedule: %w", err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return nil, fmt.Errorf("%w: schedule %s", domain.ErrNotFound, id)
	}
	s.fillNext(cur)
	return cur, nil
}

// Delete 彻底删除；不存在回 ErrNotFound。
func (s *Store) Delete(ctx context.Context, id string) error {
	res, err := s.db.W.ExecContext(ctx, `DELETE FROM schedules WHERE id = ?`, id)
	if err != nil {
		return fmt.Errorf("delete schedule: %w", err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return fmt.Errorf("%w: schedule %s", domain.ErrNotFound, id)
	}
	return nil
}

func (s *Store) fillNext(sc *Schedule) {
	sc.NextRunAt = nil
	if sc.Enabled {
		sc.NextRunAt = Next(sc.Rule, s.now(), s.loc)
	}
}

func encode(r Rule, a Action) (string, string, error) {
	rb, err := json.Marshal(r)
	if err != nil {
		return "", "", fmt.Errorf("schedule rule: %w", err)
	}
	ab, err := json.Marshal(a)
	if err != nil {
		return "", "", fmt.Errorf("schedule action: %w", err)
	}
	return string(rb), string(ab), nil
}

func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

type scanner interface{ Scan(dest ...any) error }

func scan(r scanner) (*Schedule, error) {
	var (
		sc                   Schedule
		enabled              int
		rule, action, ca, ua string
	)
	if err := r.Scan(&sc.ID, &sc.Name, &enabled, &rule, &action, &ca, &ua); err != nil {
		return nil, err
	}
	sc.Enabled = enabled != 0
	if err := json.Unmarshal([]byte(rule), &sc.Rule); err != nil {
		return nil, fmt.Errorf("schedule %s rule: %w", sc.ID, err)
	}
	if err := json.Unmarshal([]byte(action), &sc.Action); err != nil {
		return nil, fmt.Errorf("schedule %s action: %w", sc.ID, err)
	}
	sc.Rule = sc.Rule.Normalize()
	sc.CreatedAt, _ = time.Parse(timeLayout, ca)
	sc.UpdatedAt, _ = time.Parse(timeLayout, ua)
	return &sc, nil
}
