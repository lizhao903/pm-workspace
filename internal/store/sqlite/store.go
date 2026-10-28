// Package sqlite 用直白的 SQL 实现 store.Store。个人工具没有换库需求，不引 ORM。
package sqlite

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/lizhao903/pm-workspace/internal/db"
	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/store"
)

// Version 写进 Stats，给状态栏显示。
const Version = "0.1.0"

var _ store.Store = (*Store)(nil)

type Store struct {
	db *db.DB
	// keys 存模型服务商的 api_key，启动时 AttachVault 设一次，之后只读
	keys ProviderKeyVault
}

// Open 打开数据库并跑完迁移，返回可直接使用的 Store。
func Open(ctx context.Context, path string) (*Store, error) {
	d, err := db.Open(path)
	if err != nil {
		return nil, err
	}
	if err := db.Migrate(ctx, d); err != nil {
		_ = d.Close()
		return nil, err
	}
	return &Store{db: d}, nil
}

func (s *Store) Close() error { return s.db.Close() }

func (s *Store) Ping(ctx context.Context) error { return s.db.Ping(ctx) }

func (s *Store) Stats(ctx context.Context) (map[string]any, error) {
	out := map[string]any{
		"db_path": s.db.Path,
		"version": Version,
	}

	// WAL 里的数据还没 checkpoint 回主库，体积要把它算进去才是真实占用。
	var size int64
	for _, suffix := range []string{"", "-wal"} {
		if fi, err := os.Stat(s.db.Path + suffix); err == nil {
			size += fi.Size()
		}
	}
	out["db_size"] = size

	var objects int
	if err := s.db.R.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM objects WHERE deleted_at IS NULL`).Scan(&objects); err != nil {
		return nil, fmt.Errorf("count objects: %w", err)
	}
	out["objects"] = objects

	var lastWrite sql.NullString
	if err := s.db.R.QueryRowContext(ctx,
		`SELECT MAX(updated_at) FROM objects`).Scan(&lastWrite); err != nil {
		return nil, fmt.Errorf("last write: %w", err)
	}
	if t := parseNullTime(lastWrite); t != nil {
		out["last_write"] = t.Format(time.RFC3339)
	} else {
		out["last_write"] = nil
	}
	return out, nil
}

// --- 事务辅助 ---

// withTx 把写操作包进事务，回调返回错误即回滚。
func (s *Store) withTx(ctx context.Context, fn func(tx *sql.Tx) error) error {
	tx, err := s.db.W.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	if err := fn(tx); err != nil {
		_ = tx.Rollback()
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit tx: %w", err)
	}
	return nil
}

// rowScanner 让同一段 scan 代码既能吃 *sql.Row 也能吃 *sql.Rows。
type rowScanner interface {
	Scan(dest ...any) error
}

// --- 时间转换 ---

// 库里统一存 UTC 的 RFC3339，这样 TEXT 的字典序就等于时间序，
// 逾期/本周这类比较可以直接交给 SQL。
func nowStr() string { return time.Now().UTC().Format(time.RFC3339) }

func timeStr(t time.Time) string { return t.UTC().Format(time.RFC3339) }

// timeArg 把可空时间转成 SQL 参数，nil 落成 NULL。
func timeArg(t *time.Time) any {
	if t == nil {
		return nil
	}
	return timeStr(*t)
}

// 迁移脚本里的种子数据用的是 datetime('now')，格式和 RFC3339 不同，读取时要一并认。
var timeLayouts = []string{time.RFC3339Nano, time.RFC3339, "2006-01-02 15:04:05", "2006-01-02"}

func parseTime(s string) time.Time {
	for _, l := range timeLayouts {
		if t, err := time.Parse(l, s); err == nil {
			return t
		}
	}
	return time.Time{}
}

func parseNullTime(ns sql.NullString) *time.Time {
	if !ns.Valid || ns.String == "" {
		return nil
	}
	t := parseTime(ns.String)
	if t.IsZero() {
		return nil
	}
	return &t
}

func nullStr(ns sql.NullString) string {
	if !ns.Valid {
		return ""
	}
	return ns.String
}

// strPtr 把可空外键转成 *string。
func strPtr(ns sql.NullString) *string {
	if !ns.Valid || ns.String == "" {
		return nil
	}
	v := ns.String
	return &v
}

// ptrArg 让 *string 直接当 SQL 参数用，空串视同 NULL（外键不接受空串）。
func ptrArg(p *string) any {
	if p == nil || *p == "" {
		return nil
	}
	return *p
}

// --- 错误辅助 ---

// wrapped 让 message 只留业务描述，错误类别交给哨兵（API 层据此映射 code）。
// 用 fmt.Errorf("%w: ...") 会把哨兵自己的文案也拼进去，出现 "not found: object not found" 这种叠词。
type wrapped struct {
	msg      string
	sentinel error
}

func (e *wrapped) Error() string { return e.msg }
func (e *wrapped) Unwrap() error { return e.sentinel }

// notFound 只说明是什么东西没找到。具体 ID 不进返回给前端的 message，要排查看调用方日志。
func notFound(entity string) error {
	return &wrapped{msg: entity + " not found", sentinel: domain.ErrNotFound}
}

func validation(field, msg string) error {
	return &wrapped{msg: field + " " + msg, sentinel: domain.ErrValidation}
}

func conflict(msg string) error {
	return &wrapped{msg: msg, sentinel: domain.ErrConflict}
}

func readOnly(msg string) error {
	return &wrapped{msg: msg, sentinel: domain.ErrReadOnly}
}

// isUnique 判断错误是不是唯一索引冲突，驱动没暴露错误码常量，只能认字符串。
func isUnique(err error) bool {
	if err == nil {
		return false
	}
	return strings.Contains(err.Error(), "UNIQUE constraint failed")
}

func noRows(err error) bool { return errors.Is(err, sql.ErrNoRows) }

// --- 通用 SQL 片段 ---

// likeEscape 转义 LIKE 通配符，避免用户输入的 % _ 变成模式。
func likeEscape(s string) string {
	r := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`)
	return r.Replace(s)
}

// placeholders 生成 ?,?,? 占位串。值一律走参数绑定，不拼进 SQL。
func placeholders(n int) string {
	if n <= 0 {
		return ""
	}
	return strings.TrimSuffix(strings.Repeat("?,", n), ",")
}

func anySlice(ss []string) []any {
	out := make([]any, len(ss))
	for i, s := range ss {
		out[i] = s
	}
	return out
}
