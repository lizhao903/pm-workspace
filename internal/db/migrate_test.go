package db

import (
	"context"
	"io/fs"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
)

func openTestDB(t *testing.T) (*DB, context.Context) {
	t.Helper()
	d, err := Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	t.Cleanup(func() { _ = d.Close() })
	return d, context.Background()
}

func appliedChecksums(t *testing.T, d *DB) map[string]string {
	t.Helper()
	out, err := appliedVersions(context.Background(), d)
	if err != nil {
		t.Fatalf("applied versions: %v", err)
	}
	return out
}

func TestMigrateRecordsChecksums(t *testing.T) {
	d, ctx := openTestDB(t)
	fsys := fstest.MapFS{
		"0001_a.sql": &fstest.MapFile{Data: []byte(`CREATE TABLE a (id TEXT PRIMARY KEY);`)},
		"0002_b.sql": &fstest.MapFile{Data: []byte(`CREATE TABLE b (id TEXT PRIMARY KEY);`)},
	}

	if err := migrate(ctx, d, fsys); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	applied := appliedChecksums(t, d)
	if len(applied) != 2 {
		t.Fatalf("applied %d migrations, want 2", len(applied))
	}
	for name, sum := range applied {
		if len(sum) != 64 {
			t.Errorf("%s: checksum = %q, want 64 hex chars", name, sum)
		}
		want, err := checksumOf(fsys, name)
		if err != nil {
			t.Fatalf("checksum: %v", err)
		}
		if sum != want {
			t.Errorf("%s: recorded %s, want %s", name, sum, want)
		}
	}

	// 重复跑是幂等的，不该重复应用也不该报错。
	if err := migrate(ctx, d, fsys); err != nil {
		t.Fatalf("second migrate: %v", err)
	}
}

// 迁移按文件名判重，内容被换掉时库会以为它跑过了；这里要求启动期直接报错。
func TestMigrateRejectsModifiedMigration(t *testing.T) {
	d, ctx := openTestDB(t)
	fsys := fstest.MapFS{
		"0001_a.sql": &fstest.MapFile{Data: []byte(`CREATE TABLE a (id TEXT PRIMARY KEY);`)},
	}
	if err := migrate(ctx, d, fsys); err != nil {
		t.Fatalf("migrate: %v", err)
	}

	// 同名不同内容，模拟另一个人把 0001 重写了。
	tampered := fstest.MapFS{
		"0001_a.sql": &fstest.MapFile{Data: []byte(`CREATE TABLE a (id TEXT PRIMARY KEY, extra TEXT);`)},
	}
	err := migrate(ctx, d, tampered)
	if err == nil {
		t.Fatal("modified migration must be rejected")
	}
	msg := err.Error()
	for _, want := range []string{"0001_a.sql", "was modified after it was applied", "checksum"} {
		if !strings.Contains(msg, want) {
			t.Errorf("error message missing %q: %s", want, msg)
		}
	}
	// 报错里要带上两边 checksum 的前 8 位，方便对照。
	recorded := appliedChecksums(t, d)["0001_a.sql"]
	current, err2 := checksumOf(tampered, "0001_a.sql")
	if err2 != nil {
		t.Fatalf("checksum: %v", err2)
	}
	if !strings.Contains(msg, short(recorded)) || !strings.Contains(msg, short(current)) {
		t.Errorf("error should contain both checksum prefixes: %s", msg)
	}

	// 失败之后不能把新迁移偷偷应用掉。
	withNew := fstest.MapFS{
		"0001_a.sql": tampered["0001_a.sql"],
		"0002_b.sql": &fstest.MapFile{Data: []byte(`CREATE TABLE b (id TEXT PRIMARY KEY);`)},
	}
	if err := migrate(ctx, d, withNew); err == nil {
		t.Fatal("must still fail with a pending migration")
	}
	if _, ok := appliedChecksums(t, d)["0002_b.sql"]; ok {
		t.Error("0002 must not be applied while an earlier migration is tampered")
	}
}

// 加 checksum 列之前写入的老记录 checksum 是空串，不能因为历史数据把启动卡住。
func TestMigrateSkipsLegacyRowsWithoutChecksum(t *testing.T) {
	d, ctx := openTestDB(t)
	fsys := fstest.MapFS{
		"0001_a.sql": &fstest.MapFile{Data: []byte(`CREATE TABLE a (id TEXT PRIMARY KEY);`)},
	}
	if err := migrate(ctx, d, fsys); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	// 退化成旧格式：清掉 checksum。
	if _, err := d.W.ExecContext(ctx,
		`UPDATE schema_migrations SET checksum = '' WHERE version = '0001_a.sql'`); err != nil {
		t.Fatalf("downgrade row: %v", err)
	}

	tampered := fstest.MapFS{
		"0001_a.sql": &fstest.MapFile{Data: []byte(`CREATE TABLE a (id TEXT PRIMARY KEY, extra TEXT);`)},
		"0002_b.sql": &fstest.MapFile{Data: []byte(`CREATE TABLE b (id TEXT PRIMARY KEY);`)},
	}
	if err := migrate(ctx, d, tampered); err != nil {
		t.Fatalf("legacy row without checksum must not block startup: %v", err)
	}
	if _, ok := appliedChecksums(t, d)["0002_b.sql"]; !ok {
		t.Error("pending migration should still be applied")
	}
}

// 已记录但文件已不在（比如那条迁移被删了）不该报错——没内容可比。
func TestMigrateIgnoresRecordedButMissingFile(t *testing.T) {
	d, ctx := openTestDB(t)
	if err := migrate(ctx, d, fstest.MapFS{
		"0001_a.sql": &fstest.MapFile{Data: []byte(`CREATE TABLE a (id TEXT PRIMARY KEY);`)},
		"0002_b.sql": &fstest.MapFile{Data: []byte(`CREATE TABLE b (id TEXT PRIMARY KEY);`)},
	}); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	if err := migrate(ctx, d, fstest.MapFS{
		"0001_a.sql": &fstest.MapFile{Data: []byte(`CREATE TABLE a (id TEXT PRIMARY KEY);`)},
	}); err != nil {
		t.Fatalf("missing file must not fail: %v", err)
	}
}

// 老库没有 checksum 列时要能就地补上，且重复调用安全。
func TestEnsureChecksumColumnIsIdempotent(t *testing.T) {
	d, ctx := openTestDB(t)
	if _, err := d.W.ExecContext(ctx, `CREATE TABLE schema_migrations (
		version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`); err != nil {
		t.Fatalf("create legacy table: %v", err)
	}
	if _, err := d.W.ExecContext(ctx,
		`INSERT INTO schema_migrations (version, applied_at) VALUES ('0001_a.sql','2026-01-01T00:00:00Z')`); err != nil {
		t.Fatalf("insert legacy row: %v", err)
	}

	for i := 0; i < 2; i++ {
		if err := ensureChecksumColumn(ctx, d); err != nil {
			t.Fatalf("ensure checksum column (run %d): %v", i+1, err)
		}
	}
	if got := appliedChecksums(t, d)["0001_a.sql"]; got != "" {
		t.Errorf("legacy row checksum = %q, want empty", got)
	}
}

// 真实的内嵌迁移必须能跑通，并且每个文件都留下 checksum。
func TestEmbeddedMigrationsApplyCleanly(t *testing.T) {
	d, ctx := openTestDB(t)
	if err := Migrate(ctx, d); err != nil {
		t.Fatalf("migrate embedded: %v", err)
	}
	sub, err := fs.Sub(migrationFS, "migrations")
	if err != nil {
		t.Fatalf("sub fs: %v", err)
	}
	names, err := migrationNames(sub)
	if err != nil {
		t.Fatalf("names: %v", err)
	}
	if len(names) == 0 {
		t.Fatal("no embedded migrations found")
	}
	applied := appliedChecksums(t, d)
	for _, name := range names {
		if applied[name] == "" {
			t.Errorf("%s has no recorded checksum", name)
		}
	}
	// 再跑一次不应重复应用，也不该因为 checksum 报错。
	if err := Migrate(ctx, d); err != nil {
		t.Fatalf("second migrate: %v", err)
	}
}

// 0001-0004 的期望 checksum 写在代码里，必须和内嵌的文件一致；少一个也算错。
func TestLegacyChecksumsMatchEmbeddedFiles(t *testing.T) {
	sub, err := fs.Sub(migrationFS, "migrations")
	if err != nil {
		t.Fatalf("sub fs: %v", err)
	}
	if len(legacyChecksums) != 4 {
		t.Fatalf("legacyChecksums has %d entries, want 4 (0001-0004)", len(legacyChecksums))
	}
	for name, want := range legacyChecksums {
		got, err := checksumOf(sub, name)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if got != want {
			t.Errorf("%s: embedded checksum %s, built-in %s", name, got, want)
		}
	}
}

// 0001-0004 被改过时，即使库里的记录是空串也要拒绝，报错里点出文件名。
func TestMigrateRejectsModifiedLegacyMigration(t *testing.T) {
	d, ctx := openTestDB(t)
	sub, err := fs.Sub(migrationFS, "migrations")
	if err != nil {
		t.Fatalf("sub fs: %v", err)
	}
	orig, err := fs.ReadFile(sub, "0003_shortcuts.sql")
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	fsys := fstest.MapFS{
		"0003_shortcuts.sql": &fstest.MapFile{Data: append(append([]byte{}, orig...), []byte("\n-- edited\n")...)},
	}
	err = migrate(ctx, d, fsys)
	if err == nil {
		t.Fatal("modified legacy migration must be rejected")
	}
	for _, want := range []string{"0003_shortcuts.sql", "built-in checksum", legacyChecksums["0003_shortcuts.sql"][:8]} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error missing %q: %s", want, err)
		}
	}
	if _, ok := appliedChecksums(t, d)["0003_shortcuts.sql"]; ok {
		t.Error("modified legacy migration must not be applied")
	}
}

// 老库里 0001-0004 的空 checksum 记录保持原样：比对只在代码里做，不回写库。
func TestLegacyRowsAreNotRewritten(t *testing.T) {
	d, ctx := openTestDB(t)
	if err := Migrate(ctx, d); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	// 退化成真实库的样子：0001-0004 的 checksum 是空串、时间是很早以前。
	const old = "2026-09-15T04:13:52Z"
	for name := range legacyChecksums {
		if _, err := d.W.ExecContext(ctx,
			`UPDATE schema_migrations SET checksum = '', applied_at = ? WHERE version = ?`, old, name); err != nil {
			t.Fatalf("downgrade %s: %v", name, err)
		}
	}
	if err := Migrate(ctx, d); err != nil {
		t.Fatalf("second migrate: %v", err)
	}
	rows, err := d.R.QueryContext(ctx, `SELECT version, checksum, applied_at FROM schema_migrations`)
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	defer func() { _ = rows.Close() }()
	seen := 0
	for rows.Next() {
		var v, sum, at string
		if err := rows.Scan(&v, &sum, &at); err != nil {
			t.Fatalf("scan: %v", err)
		}
		if _, ok := legacyChecksums[v]; !ok {
			continue
		}
		seen++
		if sum != "" || at != old {
			t.Errorf("%s was rewritten: checksum=%q applied_at=%s", v, sum, at)
		}
	}
	if seen != len(legacyChecksums) {
		t.Errorf("saw %d legacy rows, want %d", seen, len(legacyChecksums))
	}
}
