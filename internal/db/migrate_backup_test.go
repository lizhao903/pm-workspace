// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package db

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
)

// backupFiles 列出库文件旁 backups/ 里的文件名，目录不存在时为空。
func backupFiles(t *testing.T, d *DB) []string {
	t.Helper()
	entries, err := os.ReadDir(filepath.Join(filepath.Dir(d.Path), "backups"))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		t.Fatalf("read backups dir: %v", err)
	}
	var out []string
	for _, e := range entries {
		out = append(out, e.Name())
	}
	return out
}

func TestMigrateFreshDBTakesNoSnapshot(t *testing.T) {
	d, ctx := openTestDB(t)
	fsys := fstest.MapFS{
		"0001_a.sql": &fstest.MapFile{Data: []byte(`CREATE TABLE a (id TEXT PRIMARY KEY);`)},
	}
	if err := migrate(ctx, d, fsys); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	if got := backupFiles(t, d); len(got) != 0 {
		t.Fatalf("fresh db took snapshots: %v", got)
	}
}

func TestMigrateSnapshotsBeforePendingOnly(t *testing.T) {
	d, ctx := openTestDB(t)
	fsys := fstest.MapFS{
		"0001_a.sql": &fstest.MapFile{Data: []byte(`CREATE TABLE a (id TEXT PRIMARY KEY);`)},
	}
	if err := migrate(ctx, d, fsys); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	if _, err := d.W.ExecContext(ctx, `INSERT INTO a (id) VALUES ('keep')`); err != nil {
		t.Fatalf("insert: %v", err)
	}

	fsys["0002_b.sql"] = &fstest.MapFile{Data: []byte(`CREATE TABLE b (id TEXT PRIMARY KEY);`)}
	fsys["0003_c.sql"] = &fstest.MapFile{Data: []byte(`ALTER TABLE a ADD COLUMN c TEXT;`)}
	if err := migrate(ctx, d, fsys); err != nil {
		t.Fatalf("upgrade: %v", err)
	}
	got := backupFiles(t, d)
	if len(got) != 1 {
		t.Fatalf("snapshots = %v, want exactly one", got)
	}
	if !strings.HasPrefix(got[0], "pm-") || !strings.HasSuffix(got[0], "-before-0003.db") {
		t.Errorf("snapshot name %q should carry time and target version", got[0])
	}
	// 没有待应用的迁移：不再打快照。
	if err := migrate(ctx, d, fsys); err != nil {
		t.Fatalf("rerun: %v", err)
	}
	if got := backupFiles(t, d); len(got) != 1 {
		t.Fatalf("rerun without pending migrations took a snapshot: %v", got)
	}

	// 快照是迁移前的库：只有 0001，数据在。
	snap, err := Open(filepath.Join(filepath.Dir(d.Path), "backups", got[0]))
	if err != nil {
		t.Fatalf("open snapshot: %v", err)
	}
	defer func() { _ = snap.Close() }()
	if v := appliedChecksums(t, snap); len(v) != 1 {
		t.Errorf("snapshot has %d migrations, want 1", len(v))
	}
	var n int
	if err := snap.R.QueryRowContext(ctx, `SELECT COUNT(*) FROM a`).Scan(&n); err != nil || n != 1 {
		t.Errorf("snapshot rows = %d, err = %v; want 1", n, err)
	}

}

func TestMigrateFailureRollsBackAllPending(t *testing.T) {
	d, ctx := openTestDB(t)
	fsys := fstest.MapFS{
		"0001_a.sql": &fstest.MapFile{Data: []byte(`CREATE TABLE a (id TEXT PRIMARY KEY);`)},
	}
	if err := migrate(ctx, d, fsys); err != nil {
		t.Fatalf("migrate: %v", err)
	}

	// 0002 本身没问题，0003 会失败：两条都得回滚，库停在 0001。
	fsys["0002_b.sql"] = &fstest.MapFile{Data: []byte(`CREATE TABLE b (id TEXT PRIMARY KEY);`)}
	fsys["0003_bad.sql"] = &fstest.MapFile{Data: []byte(`ALTER TABLE no_such_table ADD COLUMN x TEXT;`)}
	err := migrate(ctx, d, fsys)
	var me *MigrationError
	if !errors.As(err, &me) {
		t.Fatalf("err = %v, want *MigrationError", err)
	}
	if me.Version != "0003_bad.sql" {
		t.Errorf("failed version = %q, want 0003_bad.sql", me.Version)
	}
	if me.Snapshot == "" || !strings.Contains(err.Error(), me.Snapshot) {
		t.Errorf("error %q should name the snapshot %q", err, me.Snapshot)
	}
	if _, statErr := os.Stat(me.Snapshot); statErr != nil {
		t.Errorf("snapshot missing: %v", statErr)
	}
	if filepath.Dir(me.Snapshot) != filepath.Join(filepath.Dir(d.Path), "backups") {
		t.Errorf("snapshot %s not in the db's backups dir", me.Snapshot)
	}

	applied := appliedChecksums(t, d)
	if len(applied) != 1 {
		t.Errorf("applied = %v, want only 0001", applied)
	}
	var n int
	if err := d.R.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'b'`).Scan(&n); err != nil || n != 0 {
		t.Errorf("table b exists after rollback (n=%d err=%v)", n, err)
	}
}
