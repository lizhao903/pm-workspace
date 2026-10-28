package db

import (
	"context"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"fmt"
	"io/fs"
	"sort"
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

// Migrate 按文件名字典序执行未应用的迁移，每个文件一个事务，可重复调用。
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

	for _, name := range names {
		if _, ok := applied[name]; ok {
			continue
		}
		body, err := fs.ReadFile(fsys, name)
		if err != nil {
			return fmt.Errorf("read migration %s: %w", name, err)
		}
		if err := applyOne(ctx, d, name, string(body), checksumBytes(body)); err != nil {
			return err
		}
	}
	return nil
}

func applyOne(ctx context.Context, d *DB, name, body, checksum string) error {
	tx, err := d.W.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin migration %s: %w", name, err)
	}
	defer func() { _ = tx.Rollback() }()

	if _, err := tx.ExecContext(ctx, body); err != nil {
		return fmt.Errorf("apply migration %s: %w", name, err)
	}
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO schema_migrations (version, applied_at, checksum) VALUES (?, ?, ?)`,
		name, time.Now().UTC().Format(time.RFC3339), checksum); err != nil {
		return fmt.Errorf("record migration %s: %w", name, err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit migration %s: %w", name, err)
	}
	return nil
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
