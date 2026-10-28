// Package audit 是审计日志（CORE-08）：记已成功的配置变更、删除、Agent 写操作和下单，按对象、时间、操作者查。
//
// 记录点分两处：对象和其它业务数据的删除、Agent 写操作在 store 外层包装（store.go）里记，
// 配置类（类型、字典、服务商、插件、保险箱）由 internal/api 在 handler 成功后调 Record。
// 审计写在业务事务提交之后另起一次，写失败只记日志，不让业务写入失败。
//
// 凭证一律只记「已设置 / 已更新 / 已清除」这类提示，不记明文、密文和脱敏尾号。
package audit

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/lizhao903/pm-workspace/internal/db"
	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/idgen"
	"github.com/lizhao903/pm-workspace/internal/store"
)

// 分组。
const (
	KindConfig = "config"
	KindDelete = "delete"
	KindAgent  = "agent"
	KindOrder  = "order" // 下单，交易插件以后接
)

// 凭证的提示文字，detail 里只出现这几个值。
const (
	SecretSet     = "已设置"
	SecretUpdated = "已更新"
	SecretCleared = "已清除"
)

// timeLayout 定长毫秒 UTC，字符串比较即时间比较。
const timeLayout = "2006-01-02T15:04:05.000Z"

// Entry 是一条审计。
type Entry struct {
	ID         string         `json:"id"`
	At         time.Time      `json:"at"`
	Kind       string         `json:"kind"`
	Action     string         `json:"action"`
	TargetType string         `json:"target_type"`
	TargetID   string         `json:"target_id"`
	Actor      string         `json:"actor"`
	Source     string         `json:"source"`
	Summary    string         `json:"summary"`
	Detail     map[string]any `json:"detail"`
}

// Filter 是查询条件，零值字段不参与过滤。
type Filter struct {
	TargetType string
	TargetID   string
	Kinds      []string
	Action     string
	// Actor 按名字匹配，含同名的所有会话；带 # 时按完整的「名字#会话」精确匹配
	Actor  string
	Source string
	Since  *time.Time // 含，精确到秒
	Until  *time.Time // 含，精确到秒
	Limit  int
	Offset int
}

// DefaultLimit 是不指定条数时的一页长度。
const DefaultLimit = 50

// Log 读写 audits 表（0018）。
type Log struct {
	db  *db.DB
	log *slog.Logger
	now func() time.Time
}

func New(d *db.DB, log *slog.Logger) *Log {
	if log == nil {
		log = slog.Default()
	}
	return &Log{db: d, log: log.With("component", "audit"), now: time.Now}
}

// --- 操作者 ---

type actorKey struct{}

// WithActor 把这次请求的操作者放进 ctx，给不带 Actor 参数的 store 方法用。
func WithActor(ctx context.Context, a store.Actor) context.Context {
	return context.WithValue(ctx, actorKey{}, a)
}

// ActorFrom 取 ctx 里的操作者；没有时是 store.DefaultActor。
func ActorFrom(ctx context.Context) store.Actor {
	if a, ok := ctx.Value(actorKey{}).(store.Actor); ok {
		return a
	}
	return store.DefaultActor
}

// --- 写 ---

// Record 落一条审计。e.Actor、e.Source 为空时取 ctx 里的操作者。
// 请求结束 ctx 被取消也照样写完：业务已经提交了，审计不能半途丢。
func (l *Log) Record(ctx context.Context, e Entry) error {
	if l == nil {
		return nil
	}
	if e.Actor == "" && e.Source == "" {
		a := ActorFrom(ctx)
		e.Actor, e.Source = domain.ComposeActor(a.Name, a.Session), a.Source
	}
	if e.ID == "" {
		e.ID = idgen.Prefixed("aud")
	}
	if e.At.IsZero() {
		e.At = l.now()
	}
	if e.Detail == nil {
		e.Detail = map[string]any{}
	}
	raw, err := json.Marshal(e.Detail)
	if err != nil {
		return fmt.Errorf("audit detail: %w", err)
	}
	_, err = l.db.W.ExecContext(context.WithoutCancel(ctx),
		`INSERT INTO audits (id, at, kind, action, target_type, target_id, actor, source, summary, detail)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		e.ID, e.At.UTC().Format(timeLayout), e.Kind, e.Action, e.TargetType, e.TargetID,
		e.Actor, e.Source, e.Summary, string(raw))
	if err != nil {
		return fmt.Errorf("insert audit: %w", err)
	}
	return nil
}

// Note 是 Record 的不回错版本：失败只记日志。记录点都用它。
func (l *Log) Note(ctx context.Context, e Entry) {
	if l == nil {
		return
	}
	if err := l.Record(ctx, e); err != nil {
		l.log.Error("audit record failed", "kind", e.Kind, "action", e.Action, "target", e.TargetType+":"+e.TargetID, "err", err)
	}
}

// --- 读 ---

// List 按条件查，最近的在前（同一毫秒按写入顺序）；total 不含 Limit/Offset。
func (l *Log) List(ctx context.Context, f Filter) ([]Entry, int, error) {
	var (
		where []string
		args  []any
	)
	add := func(cond string, v ...any) {
		where = append(where, cond)
		args = append(args, v...)
	}
	if f.TargetType != "" {
		add("target_type = ?", f.TargetType)
	}
	if f.TargetID != "" {
		add("target_id = ?", f.TargetID)
	}
	if len(f.Kinds) > 0 {
		add("kind IN ("+strings.TrimSuffix(strings.Repeat("?,", len(f.Kinds)), ",")+")", anys(f.Kinds)...)
	}
	if f.Action != "" {
		add("action = ?", f.Action)
	}
	if f.Actor != "" {
		if strings.Contains(f.Actor, domain.ActorSessionSep) {
			add("actor = ?", f.Actor)
		} else {
			// 同名的所有会话：actor 等于名字，或以「名字#」开头
			add("(actor = ? OR substr(actor, 1, ?) = ?)", f.Actor, len(f.Actor)+len(domain.ActorSessionSep), f.Actor+domain.ActorSessionSep)
		}
	}
	if f.Source != "" {
		add("source = ?", f.Source)
	}
	// 两端精确到秒，都含：until=12:00:00 含 12:00:00.999
	if f.Since != nil {
		add("at >= ?", f.Since.Truncate(time.Second).UTC().Format(timeLayout))
	}
	if f.Until != nil {
		add("at < ?", f.Until.Truncate(time.Second).Add(time.Second).UTC().Format(timeLayout))
	}
	cond := ""
	if len(where) > 0 {
		cond = " WHERE " + strings.Join(where, " AND ")
	}

	var total int
	if err := l.db.R.QueryRowContext(ctx, `SELECT COUNT(*) FROM audits`+cond, args...).Scan(&total); err != nil {
		return nil, 0, fmt.Errorf("count audits: %w", err)
	}
	limit := f.Limit
	if limit <= 0 {
		limit = DefaultLimit
	}
	rows, err := l.db.R.QueryContext(ctx,
		`SELECT id, at, kind, action, target_type, target_id, actor, source, summary, detail FROM audits`+cond+
			` ORDER BY at DESC, rowid DESC LIMIT ? OFFSET ?`,
		append(args, limit, max(f.Offset, 0))...)
	if err != nil {
		return nil, 0, fmt.Errorf("list audits: %w", err)
	}
	defer func() { _ = rows.Close() }()
	out := []Entry{}
	for rows.Next() {
		var (
			e          Entry
			at, detail string
		)
		if err := rows.Scan(&e.ID, &at, &e.Kind, &e.Action, &e.TargetType, &e.TargetID, &e.Actor, &e.Source, &e.Summary, &detail); err != nil {
			return nil, 0, err
		}
		e.At, _ = time.Parse(timeLayout, at)
		if err := json.Unmarshal([]byte(detail), &e.Detail); err != nil || e.Detail == nil {
			e.Detail = map[string]any{}
		}
		out = append(out, e)
	}
	return out, total, rows.Err()
}

func anys(in []string) []any {
	out := make([]any, len(in))
	for i, s := range in {
		out[i] = s
	}
	return out
}
