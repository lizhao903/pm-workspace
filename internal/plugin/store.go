package plugin

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/lizhao903/pm-workspace/internal/db"
	"github.com/lizhao903/pm-workspace/internal/domain"
)

// 插件的数据句柄（plugin-api.md 2.0）：Store 只能读写本插件 table_prefix 开头的表；
// 内核数据只读、只给插件要用到的几项（Objects、Contacts、Conversations），写内核数据要走内核接口，修订和审计才不漏。

// ErrNoRows：Get 没查到，或 QueryRow 的 Scan 没有行。插件不 import database/sql，用这个判断。
var ErrNoRows = sql.ErrNoRows

// ErrNoStore：注册表没接上数据库（测试里用内存状态表时）。
var ErrNoStore = errors.New("plugin store is not configured")

// Store 是本插件自己的表。每次只能执行一条语句；语句里出现内核表或别的插件的表名直接拒绝，
// sqlite_ 开头的系统表、pragma 函数、ATTACH 之类也不行。
type Store interface {
	Exec(ctx context.Context, query string, args ...any) (sql.Result, error)
	Query(ctx context.Context, query string, args ...any) (*sql.Rows, error)
	// QueryRow 检查不通过时返回的 Row 在 Scan 时报错。
	QueryRow(ctx context.Context, query string, args ...any) Row
}

// Row 是 *sql.Row 的 Scan。
type Row interface{ Scan(dest ...any) error }

// ObjectInfo 是内核对象里插件常用的几项；软删的 Deleted 为 true。
// Workdir 是对象自身的 workdir 列（项目的 root），没设为空串，不往所属项目继承（TERM-01c）。
// Ref 是给人看的编号（REQ-0001），Props 是对象的自定义字段（JSON 解出来的，解不开为空 map）。
type ObjectInfo struct {
	ID      string
	Type    string
	Ref     string
	Title   string
	Workdir string
	Props   map[string]any
	Deleted bool
	// Status 是状态 key（按类型隔离，任务的已完成是 done）。
	Status string
	// ProjectID 是所属项目（objects.project_id），没挂项目为空串（AUTO-07：项目插件从任务找到项目档案）。
	ProjectID string
	// OwnerID 是负责人（联系人 id），没有为空串（TSK-0411：SOP 的更新任务节点输出改后的负责人）。
	OwnerID string
}

// ObjectReader 只读查内核对象。没有这个 id 返回 ErrNoRows。
type ObjectReader interface {
	Get(ctx context.Context, id string) (ObjectInfo, error)
	// Find 在某个类型里按 id、ref（不分大小写）、标题（完全相同）依次找一个没删的对象，标题重名取最早建的；
	// 都找不到返回 ErrNoRows（SOP 节点按「项目 id、ref 或名字」认项目用）。
	Find(ctx context.Context, typeID, key string) (ObjectInfo, error)
	// TaskStages 按来源消息或提出人查任务阶段（AUTO-05，taskstages.go），给 IM 里「问进度」用。
	TaskStages(ctx context.Context, q TaskStageQuery) ([]domain.TaskStageRow, error)
}

// ContactInfo 是干系人名册里的一个人；已归档的 Archived 为 true。
type ContactInfo struct {
	ID       string
	Name     string
	Email    string // 联系人的邮箱，没填为空串（IM 插件从渠道资料补邮箱时看它空不空）
	Archived bool
}

// ContactReader 只读查联系人（干系人名册）。没有这个 id 返回 ErrNoRows。
type ContactReader interface {
	Get(ctx context.Context, id string) (ContactInfo, error)
	// FindByName 按名字找没归档的，重名取最早建的（SOP-02a，writes.go）。
	FindByName(ctx context.Context, name string) (ContactInfo, error)
}

// ConversationInfo 是 IM 会话（CT-02，0028）里插件常用的几项，不带成员。
type ConversationInfo struct {
	ID         string
	Channel    string
	ExternalID string
	Kind       string // group 或 direct
	Name       string
}

// ConversationReader 只读查 IM 会话。没有这个 id 返回 ErrNoRows。
type ConversationReader interface {
	Get(ctx context.Context, id string) (ConversationInfo, error)
	// Find 按渠道和会话编号找（identities.go）。
	Find(ctx context.Context, channel, externalID string) (ConversationInfo, error)
	// Match 不知道渠道时按一句话找会话（TSK-0481，SOP 的 IM 触发按会话过滤时用）：先按各渠道里的会话编号原样比（Slack 的 C0BNCBRL5C0），
	// 都没有再按会话名比（不分大小写，开头的 # 去掉）。按渠道、编号排序，可能多条（不同渠道同一个编号、同名的群）；都没有回空。
	Match(ctx context.Context, ref string) ([]ConversationInfo, error)
}

// database 是插件句柄用的库：注册表的 DB，没设时取 SQL 迁移记录用的那个（cmd/pmw 两者是同一个连接）。
func (r *Registry) database() *db.DB {
	if r == nil {
		return nil
	}
	if r.DB != nil {
		return r.DB
	}
	if s, ok := r.Migrations.(*SQLMigrationStore); ok {
		return s.d
	}
	return nil
}

func (c *core) db() *db.DB {
	if c.reg == nil {
		return nil
	}
	return c.reg.database()
}

func (c *core) Store() Store            { return &pluginStore{c: c} }
func (c *core) Objects() ObjectReader   { return objectReader{c} }
func (c *core) Contacts() ContactReader { return contactReader{c} }
func (c *core) Conversations() ConversationReader {
	return conversationReader{c}
}

type pluginStore struct{ c *core }

func (s *pluginStore) prefix() string { return s.c.prefix }

func (s *pluginStore) Exec(ctx context.Context, query string, args ...any) (sql.Result, error) {
	d := s.c.db()
	if d == nil {
		return nil, ErrNoStore
	}
	if err := checkStoreSQL(ctx, d, s.prefix(), query); err != nil {
		return nil, err
	}
	return d.W.ExecContext(ctx, query, args...)
}

func (s *pluginStore) Query(ctx context.Context, query string, args ...any) (*sql.Rows, error) {
	d := s.c.db()
	if d == nil {
		return nil, ErrNoStore
	}
	if err := checkStoreSQL(ctx, d, s.prefix(), query); err != nil {
		return nil, err
	}
	return d.R.QueryContext(ctx, query, args...)
}

func (s *pluginStore) QueryRow(ctx context.Context, query string, args ...any) Row {
	d := s.c.db()
	if d == nil {
		return errRow{ErrNoStore}
	}
	if err := checkStoreSQL(ctx, d, s.prefix(), query); err != nil {
		return errRow{err}
	}
	return d.R.QueryRowContext(ctx, query, args...)
}

type errRow struct{ err error }

func (r errRow) Scan(...any) error { return r.err }

// checkStoreSQL 把语句里的标识符和库里现有的表名比对：不是本插件前缀的表一律不许出现。
// 列名和内核表重名也会被拒，插件的列避开这些名字即可（报错里会写出是哪个）。
func checkStoreSQL(ctx context.Context, d *db.DB, prefix, query string) error {
	if prefix == "" {
		return fmt.Errorf("插件没有 table_prefix，不能用 Store")
	}
	stmts, err := splitSQL(query)
	if err != nil {
		return err
	}
	if len(stmts) != 1 {
		return fmt.Errorf("Store 一次只能执行一条语句")
	}
	idents := sqlIdents(stmts[0])
	if len(idents) > 0 {
		switch strings.ToUpper(idents[0]) {
		case "ATTACH", "DETACH", "PRAGMA", "VACUUM", "CREATE", "DROP", "ALTER", "REINDEX":
			return fmt.Errorf("Store 不允许 %s，表结构只能在迁移里改", strings.ToUpper(idents[0]))
		}
	}
	others, err := foreignTables(ctx, d, prefix)
	if err != nil {
		return err
	}
	low := strings.ToLower(prefix)
	for _, id := range idents {
		l := strings.ToLower(id)
		if strings.HasPrefix(l, low) {
			continue
		}
		if strings.HasPrefix(l, "sqlite_") || strings.HasPrefix(l, "pragma_") || others[l] {
			return fmt.Errorf("Store 只能访问 %s 开头的表，语句里出现了 %s", prefix, id)
		}
	}
	return nil
}

// foreignTables 是库里不以本插件前缀开头的表和视图（小写）。
func foreignTables(ctx context.Context, d *db.DB, prefix string) (map[string]bool, error) {
	rows, err := d.R.QueryContext(ctx, `SELECT name FROM sqlite_master WHERE type IN ('table', 'view')`)
	if err != nil {
		return nil, fmt.Errorf("list tables: %w", err)
	}
	defer func() { _ = rows.Close() }()
	out := map[string]bool{}
	low := strings.ToLower(prefix)
	for rows.Next() {
		var n string
		if err := rows.Scan(&n); err != nil {
			return nil, err
		}
		if l := strings.ToLower(n); !strings.HasPrefix(l, low) {
			out[l] = true
		}
	}
	return out, rows.Err()
}

// sqlIdents 取出语句里字符串字面量以外的标识符（引号包着的去掉引号）。
func sqlIdents(s string) []string {
	var out []string
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c == '\'':
			end := strings.IndexByte(s[i+1:], '\'')
			if end < 0 {
				return out
			}
			i += end + 1
		case c == '"' || c == '`' || c == '[':
			closer := c
			if c == '[' {
				closer = ']'
			}
			end := strings.IndexByte(s[i+1:], closer)
			if end < 0 {
				return out
			}
			out = append(out, s[i+1:i+1+end])
			i += end + 1
		case c == '_' || (c|0x20 >= 'a' && c|0x20 <= 'z'):
			j := i + 1
			for j < len(s) && (s[j] == '_' || (s[j]|0x20 >= 'a' && s[j]|0x20 <= 'z') || (s[j] >= '0' && s[j] <= '9')) {
				j++
			}
			out = append(out, s[i:j])
			i = j - 1
		case c >= '0' && c <= '9':
			// 数字里的字母（1e5、0x1F）不算标识符
			j := i + 1
			for j < len(s) && (s[j] == '.' || s[j] == '_' || (s[j]|0x20 >= 'a' && s[j]|0x20 <= 'z') || (s[j] >= '0' && s[j] <= '9')) {
				j++
			}
			i = j - 1
		}
	}
	return out
}

type objectReader struct{ c *core }

func (o objectReader) Get(ctx context.Context, id string) (ObjectInfo, error) {
	d := o.c.db()
	if d == nil {
		return ObjectInfo{}, ErrNoStore
	}
	return scanObject(d.R.QueryRowContext(ctx, `SELECT `+objectInfoCols+` FROM objects WHERE id = ?`, id))
}

const objectInfoCols = `id, type_id, ref, title, workdir, props, deleted_at, status, project_id, owner_id`

func scanObject(row *sql.Row) (ObjectInfo, error) {
	var info ObjectInfo
	var deleted, project, owner sql.NullString
	var props string
	if err := row.Scan(&info.ID, &info.Type, &info.Ref, &info.Title, &info.Workdir, &props, &deleted, &info.Status, &project, &owner); err != nil {
		return ObjectInfo{}, err
	}
	info.ProjectID = project.String
	info.OwnerID = owner.String
	info.Workdir = strings.TrimSpace(info.Workdir)
	info.Deleted = deleted.Valid
	if json.Unmarshal([]byte(props), &info.Props) != nil || info.Props == nil {
		info.Props = map[string]any{}
	}
	return info, nil
}

func (o objectReader) Find(ctx context.Context, typeID, key string) (ObjectInfo, error) {
	d := o.c.db()
	if d == nil {
		return ObjectInfo{}, ErrNoStore
	}
	key = strings.TrimSpace(key)
	if key == "" {
		return ObjectInfo{}, ErrNoRows
	}
	for _, cond := range []string{"id = ?", "ref = ? COLLATE NOCASE", "title = ?"} {
		info, err := scanObject(d.R.QueryRowContext(ctx, `SELECT `+objectInfoCols+` FROM objects
			WHERE type_id = ? AND deleted_at IS NULL AND `+cond+` ORDER BY created_at, id LIMIT 1`, typeID, key))
		if !errors.Is(err, sql.ErrNoRows) {
			return info, err
		}
	}
	return ObjectInfo{}, ErrNoRows
}

type contactReader struct{ c *core }

func (r contactReader) Get(ctx context.Context, id string) (ContactInfo, error) {
	d := r.c.db()
	if d == nil {
		return ContactInfo{}, ErrNoStore
	}
	var info ContactInfo
	var archived sql.NullString
	err := d.R.QueryRowContext(ctx, `SELECT id, name, email, archived_at FROM stakeholders WHERE id = ?`, id).
		Scan(&info.ID, &info.Name, &info.Email, &archived)
	if err != nil {
		return ContactInfo{}, err
	}
	info.Archived = archived.Valid
	return info, nil
}

type conversationReader struct{ c *core }

func (r conversationReader) Get(ctx context.Context, id string) (ConversationInfo, error) {
	d := r.c.db()
	if d == nil {
		return ConversationInfo{}, ErrNoStore
	}
	var info ConversationInfo
	err := d.R.QueryRowContext(ctx, `SELECT id, channel, external_id, kind, name FROM conversations WHERE id = ?`, id).
		Scan(&info.ID, &info.Channel, &info.ExternalID, &info.Kind, &info.Name)
	if err != nil {
		return ConversationInfo{}, err
	}
	return info, nil
}
