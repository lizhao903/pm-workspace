package db

import (
	"context"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

//go:embed migrations/*.sql
var migrationFS embed.FS

// legacyChecksums 是 0001-0004 的期望 sha256（取自首次提交 78536d4，此后未改过）。
// 这四个文件应用时还没有 checksum 列，库里只有空串，只能在代码里比对（CORE-05）。
var legacyChecksums = map[string]string{
	"0001_init.sql":                   "64566810053377993ccc14b4755c53bbab75fdc844d49569857dc62e2bcfaf3f",
	"0002_seed_types.sql":             "f8fae997a37a562d6cffa04ff97c9c741cfbf1940afc70597913f11c1ced2a05",
	"0003_shortcuts.sql":              "68a652fe873af29ec8880b9464053dded46b20f76677e78283153f730f916d28",
	"0004_inherit_category_color.sql": "50a17f382cfd572d1b06532003f6d33b2873e90429b977c255c4c811d3fc3aba",
}

// MigrationError 是应用迁移失败：本次待应用的迁移整体回滚，库版本停在迁移前。
// Snapshot 是迁移前打的快照，新建的空库不打快照，此时为空串。
type MigrationError struct {
	Version  string
	Snapshot string
	Err      error
}

func (e *MigrationError) Error() string {
	if e.Snapshot == "" {
		return e.Err.Error()
	}
	return fmt.Sprintf("%v (rolled back; pre-migration snapshot: %s)", e.Err, e.Snapshot)
}

func (e *MigrationError) Unwrap() error { return e.Err }

// Migrate 按文件名字典序执行未应用的迁移，可重复调用。
// 已有数据的库在应用前先打快照到库文件旁的 backups/；待应用的迁移放在同一个事务里，
// 任何一个失败都整体回滚，返回 *MigrationError。没有待应用的迁移时什么都不做。
func Migrate(ctx context.Context, d *DB) error {
	sub, err := fs.Sub(migrationFS, "migrations")
	if err != nil {
		return fmt.Errorf("open migrations dir: %w", err)
	}
	return migrate(ctx, d, sub)
}

// migrate 把迁移源抽出来，测试可以塞一个内存 FS 进来模拟「文件被改过」。
func migrate(ctx context.Context, d *DB, fsys fs.FS) error {
	if _, err := d.W.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS schema_migrations (
		version    TEXT PRIMARY KEY,
		applied_at TEXT NOT NULL
	)`); err != nil {
		return fmt.Errorf("create schema_migrations: %w", err)
	}
	if err := ensureChecksumColumn(ctx, d); err != nil {
		return err
	}

	applied, err := appliedVersions(ctx, d)
	if err != nil {
		return err
	}
	names, err := migrationNames(fsys)
	if err != nil {
		return err
	}

	// 0001-0004 是加 checksum 列之前应用的，库里记录是空串、无从比对，
	// 改成和代码里写死的期望值比。库里的老记录不补写：那等于改迁移历史。
	for _, name := range names {
		want, ok := legacyChecksums[name]
		if !ok {
			continue
		}
		sum, err := checksumOf(fsys, name)
		if err != nil {
			return err
		}
		if sum != want {
			return fmt.Errorf(
				"migration %s does not match its built-in checksum (expected %s, current %s); "+
					"it was applied before checksums were recorded and must never be edited",
				name, short(want), short(sum))
		}
	}

	// 先把已应用的全校验一遍再动手。迁移是按文件名判重的，文件内容被换掉时
	// 库会以为它已经跑过而静默跳过，事后极难查，这里要让它在启动期就炸出来。
	for _, name := range names {
		recorded, ok := applied[name]
		if !ok || recorded == "" {
			// 没记录，或是加 checksum 列之前写入的老记录，无从比对。
			continue
		}
		sum, err := checksumOf(fsys, name)
		if err != nil {
			return err
		}
		if sum != recorded {
			return fmt.Errorf(
				"migration %s was modified after it was applied (recorded checksum %s, current %s); "+
					"migrations are matched by file name, so the change would be silently skipped; "+
					"during development delete the db file (data/pm.db*) to rebuild from scratch",
				name, short(recorded), short(sum))
		}
	}

	var pending []string
	for _, name := range names {
		if _, ok := applied[name]; !ok {
			pending = append(pending, name)
		}
	}
	if len(pending) == 0 {
		return nil
	}

	// 新建的库没有可丢的数据，不打快照；否则先快照再动手，快照失败就不迁移。
	snapshot := ""
	if len(applied) > 0 {
		snapshot, err = snapshotBeforeMigrate(ctx, d, pending[len(pending)-1])
		if err != nil {
			return fmt.Errorf("snapshot before migrating: %w", err)
		}
		slog.Info("迁移前已打快照", "snapshot", snapshot, "pending", len(pending), "target", pending[len(pending)-1])
	}
	if name, err := applyAll(ctx, d, fsys, pending); err != nil {
		return &MigrationError{Version: name, Snapshot: snapshot, Err: err}
	}
	return nil
}

// applyAll 在一个事务里应用全部待应用的迁移，失败时返回出错的文件名，事务回滚。
// 一起回滚而不是逐个提交：中途失败时库停在迁移前的版本，和快照对得上，不会卡在半截。
func applyAll(ctx context.Context, d *DB, fsys fs.FS, pending []string) (string, error) {
	tx, err := d.W.BeginTx(ctx, nil)
	if err != nil {
		return pending[0], fmt.Errorf("begin migrations: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	now := time.Now().UTC().Format(time.RFC3339)
	for _, name := range pending {
		body, err := fs.ReadFile(fsys, name)
		if err != nil {
			return name, fmt.Errorf("read migration %s: %w", name, err)
		}
		if _, err := tx.ExecContext(ctx, string(body)); err != nil {
			return name, fmt.Errorf("apply migration %s: %w", name, err)
		}
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO schema_migrations (version, applied_at, checksum) VALUES (?, ?, ?)`,
			name, now, checksumBytes(body)); err != nil {
			return name, fmt.Errorf("record migration %s: %w", name, err)
		}
	}
	if err := tx.Commit(); err != nil {
		return pending[len(pending)-1], fmt.Errorf("commit migrations: %w", err)
	}
	return "", nil
}

// snapshotBeforeMigrate 用 VACUUM INTO 把库快照到库文件旁的 backups/，做法同 /api/admin/snapshot
// （store/sqlite 的 Snapshot，db 包不能反向引用它）。文件名带 UTC 时间和目标版本，
// 例 pm-20261028-151200-before-0017.db。
func snapshotBeforeMigrate(ctx context.Context, d *DB, target string) (string, error) {
	dir := filepath.Join(filepath.Dir(d.Path), "backups")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", fmt.Errorf("create backup dir: %w", err)
	}
	version, _, _ := strings.Cut(target, "_")
	stamp := time.Now().UTC().Format("20060102-150405")
	for i := 1; i <= 100; i++ {
		name := fmt.Sprintf("pm-%s-before-%s.db", stamp, version)
		if i > 1 {
			name = fmt.Sprintf("pm-%s-before-%s-%d.db", stamp, version, i)
		}
		p := filepath.Join(dir, name)
		// VACUUM INTO 拒绝写已存在的文件，同一秒内撞名就加序号。
		if _, err := os.Stat(p); !errors.Is(err, os.ErrNotExist) {
			if err != nil {
				return "", fmt.Errorf("stat backup target: %w", err)
			}
			continue
		}
		if _, err := d.W.ExecContext(ctx, `VACUUM INTO ?`, p); err != nil {
			return "", fmt.Errorf("vacuum into %s: %w", p, err)
		}
		return p, nil
	}
	return "", errors.New("too many snapshots taken within the same second")
}

// ensureChecksumColumn 给老库补上 checksum 列，已经有了就跳过。
func ensureChecksumColumn(ctx context.Context, d *DB) error {
	var n int
	if err := d.W.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM pragma_table_info('schema_migrations') WHERE name = 'checksum'`).Scan(&n); err != nil {
		return fmt.Errorf("inspect schema_migrations: %w", err)
	}
	if n > 0 {
		return nil
	}
	if _, err := d.W.ExecContext(ctx,
		`ALTER TABLE schema_migrations ADD COLUMN checksum TEXT NOT NULL DEFAULT ''`); err != nil {
		return fmt.Errorf("add checksum column: %w", err)
	}
	return nil
}

// appliedVersions 返回版本到 checksum 的映射，老记录的 checksum 是空串。
func appliedVersions(ctx context.Context, d *DB) (map[string]string, error) {
	rows, err := d.W.QueryContext(ctx, `SELECT version, checksum FROM schema_migrations`)
	if err != nil {
		return nil, fmt.Errorf("list applied migrations: %w", err)
	}
	defer func() { _ = rows.Close() }()

	out := map[string]string{}
	for rows.Next() {
		var v, sum string
		if err := rows.Scan(&v, &sum); err != nil {
			return nil, err
		}
		out[v] = sum
	}
	return out, rows.Err()
}

func migrationNames(fsys fs.FS) ([]string, error) {
	entries, err := fs.ReadDir(fsys, ".")
	if err != nil {
		return nil, fmt.Errorf("read migrations dir: %w", err)
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		if !e.IsDir() {
			names = append(names, e.Name())
		}
	}
	sort.Strings(names)
	return names, nil
}

func checksumOf(fsys fs.FS, name string) (string, error) {
	body, err := fs.ReadFile(fsys, name)
	if err != nil {
		return "", fmt.Errorf("read migration %s: %w", name, err)
	}
	return checksumBytes(body), nil
}

func checksumBytes(body []byte) string {
	sum := sha256.Sum256(body)
	return hex.EncodeToString(sum[:])
}

// short 截短 checksum，报错信息里前 8 位足够定位。
func short(sum string) string {
	if len(sum) <= 8 {
		return sum
	}
	return sum[:8]
}
