// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package plugin

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io/fs"
	"regexp"
	"slices"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/lizhao903/pm-workspace/internal/db"
)

// 插件迁移（CORE-05，docs/plugin-api.md 2.4）：每个插件的迁移在自己的目录里从 0001 单独编号，
// 应用记录写进 plugins_migrations（0017），不进内核的 schema_migrations。
// 安装时应用；启动时校验已应用文件的校验和，不一致拒绝启动并指出插件和文件。

// AppliedMigration 是 plugins_migrations 的一行。
type AppliedMigration struct {
	Plugin        string    `json:"plugin"`
	File          string    `json:"file"` // 插件内的迁移版本，例 0001_items.sql
	Checksum      string    `json:"checksum"`
	PluginVersion string    `json:"plugin_version"`
	AppliedAt     time.Time `json:"applied_at"`
}

// MigrationStep 是一个插件的一条迁移：已应用的带应用记录，待应用的 Applied 为 nil。
type MigrationStep struct {
	Plugin   string
	File     string
	Checksum string
	Applied  *AppliedMigration
}

// MigrationStore 存取插件迁移记录。Apply 要在同一个事务里执行 body 并写记录。
// DropData 是卸载删数据：删掉表名以 prefix 开头的表和这个插件的迁移记录，同一个事务，返回删掉的表。
type MigrationStore interface {
	Applied(ctx context.Context) ([]AppliedMigration, error)
	Apply(ctx context.Context, m AppliedMigration, body string) error
	DropData(ctx context.Context, pluginID, prefix string) ([]string, error)
}

// PrepareStartup upgrades an explicitly selected installed plugin's schema,
// then initializes its data before Registry.Start. Versions, permissions and
// enabled state are preserved. Each migration and its record share a transaction.
func (r *Registry) PrepareStartup(ctx context.Context, id string, backup func(context.Context) (string, error)) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.started {
		return fmt.Errorf("plugin registry: PrepareStartup after Start")
	}
	e, err := r.get(id)
	if err != nil {
		return err
	}
	states, err := r.store.Load(ctx)
	if err != nil {
		return err
	}
	applied, err := r.appliedByPlugin(ctx)
	if err != nil {
		return err
	}
	// Validate all registered history before making any changes.
	for _, pluginID := range r.order {
		if err := verifyMigrations(pluginID, r.entries[pluginID].migs, applied[pluginID]); err != nil {
			r.log.Error("plugin startup migration history invalid", "plugin", pluginID, "err", err)
			return err
		}
	}
	if !states[id].Installed {
		e.core.log.Info("plugin startup preparation skipped", "reason", "not installed")
		return nil
	}
	files := pending(e.migs, applied[id])
	e.core.log.Info("plugin startup preparation started", "pending_migrations", len(files))
	if len(files) > 0 {
		if backup == nil {
			return fmt.Errorf("plugin %s startup migration requires backup", id)
		}
		e.core.log.Info("plugin startup migration backup started")
		path, err := backup(ctx)
		if err != nil || strings.TrimSpace(path) == "" {
			if err == nil {
				err = fmt.Errorf("empty backup path")
			}
			e.core.log.Error("plugin startup migration backup failed", "err", err)
			return fmt.Errorf("backup before plugin %s startup migration: %w", id, err)
		}
		e.core.log.Info("plugin startup migration backup completed", "snapshot", path)
		if err := r.migrate(ctx, e); err != nil {
			e.core.log.Error("plugin startup migration failed", "snapshot", path, "err", err)
			return fmt.Errorf("plugin %s startup migration failed (snapshot: %s): %w", id, path, err)
		}
	} else {
		e.core.log.Info("plugin startup migrations skipped", "reason", "already applied")
	}
	if init, ok := e.p.(StartupInitializer); ok {
		if err := init.PrepareStartup(ctx, e.core); err != nil {
			e.core.log.Error("plugin startup initialization failed", "err", err)
			return fmt.Errorf("plugin %s startup initialization: %w", id, err)
		}
	}
	e.core.log.Info("plugin startup preparation completed")
	return nil
}

// MemMigrationStore 只记录不执行 SQL，测试用（注册表默认也用它，cmd/pmw 换成 SQL 的）。
type MemMigrationStore struct {
	mu sync.Mutex
	m  []AppliedMigration
}

func NewMemMigrationStore() *MemMigrationStore { return &MemMigrationStore{} }

func (s *MemMigrationStore) Applied(context.Context) ([]AppliedMigration, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return slices.Clone(s.m), nil
}

func (s *MemMigrationStore) Apply(_ context.Context, m AppliedMigration, _ string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.m = append(s.m, m)
	return nil
}

// DropData 只删记录，没有表可删。
func (s *MemMigrationStore) DropData(_ context.Context, pluginID, _ string) ([]string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.m = slices.DeleteFunc(s.m, func(m AppliedMigration) bool { return m.Plugin == pluginID })
	return nil, nil
}

// Tamper 改写一条记录的校验和，测试用来模拟「文件在应用后被改过」。
func (s *MemMigrationStore) Tamper(pluginID, file, checksum string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i := range s.m {
		if s.m[i].Plugin == pluginID && s.m[i].File == file {
			s.m[i].Checksum = checksum
		}
	}
}

// SQLMigrationStore 把记录存进 plugins_migrations，迁移本身在同一个事务里执行。
type SQLMigrationStore struct{ d *db.DB }

func NewSQLMigrationStore(d *db.DB) *SQLMigrationStore { return &SQLMigrationStore{d: d} }

func (s *SQLMigrationStore) Applied(ctx context.Context) ([]AppliedMigration, error) {
	rows, err := s.d.R.QueryContext(ctx, `SELECT plugin_id, file, checksum, plugin_version, applied_at
		FROM plugins_migrations ORDER BY plugin_id, file`)
	if err != nil {
		return nil, fmt.Errorf("load plugin migrations: %w", err)
	}
	defer func() { _ = rows.Close() }()
	var out []AppliedMigration
	for rows.Next() {
		var m AppliedMigration
		var at string
		if err := rows.Scan(&m.Plugin, &m.File, &m.Checksum, &m.PluginVersion, &at); err != nil {
			return nil, fmt.Errorf("scan plugin migration: %w", err)
		}
		m.AppliedAt, _ = time.Parse(time.RFC3339, at)
		out = append(out, m)
	}
	return out, rows.Err()
}

func (s *SQLMigrationStore) Apply(ctx context.Context, m AppliedMigration, body string) error {
	tx, err := s.d.W.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin plugin migration: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, body); err != nil {
		return fmt.Errorf("插件 %s 的迁移 %s 执行失败：%w", m.Plugin, m.File, err)
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO plugins_migrations
		(plugin_id, file, checksum, plugin_version, applied_at) VALUES (?, ?, ?, ?, ?)`,
		m.Plugin, m.File, m.Checksum, m.PluginVersion, m.AppliedAt.UTC().Format(time.RFC3339)); err != nil {
		return fmt.Errorf("record plugin migration %s/%s: %w", m.Plugin, m.File, err)
	}
	return tx.Commit()
}

// DropData 按表名前缀删表（大小写不敏感，和静态检查一致），索引随表一起删。
// 外键检查推迟到提交：插件自己的表互相引用时删除顺序无所谓，提交时它们都已不在。
func (s *SQLMigrationStore) DropData(ctx context.Context, pluginID, prefix string) ([]string, error) {
	if prefix == "" {
		// 没有前缀就没有表；防止空前缀匹配到全部内核表
		if _, err := s.d.W.ExecContext(ctx, `DELETE FROM plugins_migrations WHERE plugin_id = ?`, pluginID); err != nil {
			return nil, fmt.Errorf("delete plugin migrations %s: %w", pluginID, err)
		}
		return []string{}, nil
	}
	tx, err := s.d.W.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("begin drop plugin data: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `PRAGMA defer_foreign_keys = ON`); err != nil {
		return nil, err
	}
	rows, err := tx.QueryContext(ctx, `SELECT name FROM sqlite_master WHERE type = 'table'
		AND lower(substr(name, 1, ?)) = lower(?) ORDER BY name`, len(prefix), prefix)
	if err != nil {
		return nil, fmt.Errorf("list plugin tables: %w", err)
	}
	tables := []string{}
	for rows.Next() {
		var n string
		if err := rows.Scan(&n); err != nil {
			_ = rows.Close()
			return nil, err
		}
		tables = append(tables, n)
	}
	_ = rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for _, n := range tables {
		if _, err := tx.ExecContext(ctx, `DROP TABLE "`+strings.ReplaceAll(n, `"`, `""`)+`"`); err != nil {
			return nil, fmt.Errorf("drop %s: %w", n, err)
		}
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM plugins_migrations WHERE plugin_id = ?`, pluginID); err != nil {
		return nil, fmt.Errorf("delete plugin migrations %s: %w", pluginID, err)
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return tables, nil
}

// migrationFile 是插件迁移目录里的一个文件。
type migrationFile struct {
	name     string
	body     string
	checksum string
}

var migrationNameRe = regexp.MustCompile(`^[0-9]{4}_[a-z0-9_]+\.sql$`)

// loadMigrations 读插件的迁移目录，按文件名排序，并逐条做静态检查。
// 第一方插件的迁移写得不对是代码问题，Add 时就报错。
func loadMigrations(m *Manifest, fsys fs.FS) ([]migrationFile, error) {
	if fsys == nil {
		return nil, nil
	}
	if m.TablePrefix == "" {
		return nil, fmt.Errorf("插件 %s 有迁移，清单里要写 table_prefix", m.ID)
	}
	entries, err := fs.ReadDir(fsys, ".")
	if err != nil {
		return nil, fmt.Errorf("插件 %s 的迁移目录读不了：%w", m.ID, err)
	}
	var out []migrationFile
	seen := map[string]string{}
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || !migrationNameRe.MatchString(name) {
			return nil, fmt.Errorf("插件 %s 的迁移目录里只能放 NNNN_说明.sql：%s", m.ID, name)
		}
		// Both branches shipped a distinct 0008 before their histories merged.
		// Preserve their filenames/checksums so existing databases skip the
		// migration they already applied. No other duplicate number is allowed.
		if prev, dup := seen[name[:4]]; dup && !(m.ID == "sop" && prev == "0008_flow_ownership.sql" && name == "0008_im_trigger.sql") {
			return nil, fmt.Errorf("插件 %s 的迁移编号重复：%s 和 %s", m.ID, prev, name)
		}
		seen[name[:4]] = name
		body, err := fs.ReadFile(fsys, name)
		if err != nil {
			return nil, fmt.Errorf("插件 %s 的迁移 %s 读不了：%w", m.ID, name, err)
		}
		if err := checkMigrationSQL(m.TablePrefix, string(body)); err != nil {
			return nil, fmt.Errorf("插件 %s 的迁移 %s 不合规：%w", m.ID, name, err)
		}
		sum := sha256.Sum256(body)
		out = append(out, migrationFile{name: name, body: string(body), checksum: hex.EncodeToString(sum[:])})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].name < out[j].name })
	return out, nil
}

// verifyMigrations 比对已应用文件的校验和。记录在、文件已不在的不报错（没内容可比），和内核一致。
func verifyMigrations(id string, files []migrationFile, applied map[string]AppliedMigration) error {
	for _, f := range files {
		a, ok := applied[f.name]
		if !ok {
			continue
		}
		if a.Checksum != f.checksum {
			return fmt.Errorf("插件 %s 的迁移 %s 应用后被改过（记录的校验和 %s，现在 %s）；"+
				"已应用的迁移不能改，要改表结构就加一个新编号的迁移", id, f.name, short8(a.Checksum), short8(f.checksum))
		}
	}
	return nil
}

func short8(s string) string {
	if len(s) > 8 {
		return s[:8]
	}
	return s
}

// --- 静态检查：只许建本插件前缀的表和索引、给本插件的表加列（2.4） ---

const sqlName = "(\"[^\"]+\"|`[^`]+`|\\[[^\\]]+\\]|[A-Za-z_][A-Za-z0-9_]*)"

var (
	createTableRe = regexp.MustCompile(`(?is)^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?` + sqlName + `\s*\(`)
	createIndexRe = regexp.MustCompile(`(?is)^CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?` + sqlName + `\s+ON\s+` + sqlName + `\s*\(`)
	alterAddRe    = regexp.MustCompile(`(?is)^ALTER\s+TABLE\s+` + sqlName + `\s+ADD\s+`)
)

func checkMigrationSQL(prefix, body string) error {
	stmts, err := splitSQL(body)
	if err != nil {
		return err
	}
	if len(stmts) == 0 {
		return fmt.Errorf("没有语句")
	}
	for i, s := range stmts {
		var names []string
		if m := createTableRe.FindStringSubmatch(s); m != nil {
			names = m[1:]
		} else if m := createIndexRe.FindStringSubmatch(s); m != nil {
			names = m[1:]
		} else if m := alterAddRe.FindStringSubmatch(s); m != nil {
			names = m[1:]
		} else {
			return fmt.Errorf("第 %d 条语句不允许，只能 CREATE TABLE、CREATE INDEX、ALTER TABLE ... ADD COLUMN：%s", i+1, abbrev(s))
		}
		for _, n := range names {
			if !strings.HasPrefix(strings.ToLower(unquote(n)), strings.ToLower(prefix)) {
				return fmt.Errorf("第 %d 条语句的 %s 不是本插件前缀 %s：%s", i+1, unquote(n), prefix, abbrev(s))
			}
		}
	}
	return nil
}

// splitSQL 去掉注释、按引号外的分号切成语句，空语句丢掉。
func splitSQL(body string) ([]string, error) {
	var out []string
	var b strings.Builder
	flush := func() {
		if s := strings.Join(strings.Fields(b.String()), " "); s != "" {
			out = append(out, s)
		}
		b.Reset()
	}
	for i := 0; i < len(body); i++ {
		c := body[i]
		switch {
		case c == '-' && i+1 < len(body) && body[i+1] == '-':
			for i < len(body) && body[i] != '\n' {
				i++
			}
			b.WriteByte(' ')
		case c == '/' && i+1 < len(body) && body[i+1] == '*':
			end := strings.Index(body[i+2:], "*/")
			if end < 0 {
				return nil, fmt.Errorf("注释没有结束")
			}
			i += end + 3
			b.WriteByte(' ')
		case c == '\'' || c == '"' || c == '`' || c == '[':
			closer := c
			if c == '[' {
				closer = ']'
			}
			end := strings.IndexByte(body[i+1:], closer)
			if end < 0 {
				return nil, fmt.Errorf("引号没有闭合")
			}
			b.WriteString(body[i : i+end+2])
			i += end + 1
		case c == ';':
			flush()
		default:
			b.WriteByte(c)
		}
	}
	flush()
	return out, nil
}

func unquote(n string) string {
	if len(n) >= 2 {
		switch n[0] {
		case '"', '`', '[':
			return n[1 : len(n)-1]
		}
	}
	return n
}

func abbrev(s string) string {
	if r := []rune(s); len(r) > 60 {
		return string(r[:60]) + "..."
	}
	return s
}
