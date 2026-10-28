package main

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/lizhao903/pm-workspace/internal/db"
)

// 子进程里直接跑 main，用来检查退出码。
func TestMain(m *testing.M) {
	if os.Getenv("PMW_TEST_RUN_MAIN") == "1" {
		os.Args = append([]string{"pmw"}, strings.Fields(os.Getenv("PMW_TEST_ARGS"))...)
		main()
		os.Exit(0)
	}
	os.Exit(m.Run())
}

// 迁移失败时进程非零退出、打印快照路径、库版本不变。
func TestStartupMigrationFailureExitsNonZero(t *testing.T) {
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "pm.db")
	ctx := context.Background()

	// 跑完全部迁移再删掉最后一条记录：它的表已存在，重新应用必然失败。
	d, err := db.Open(dbPath)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	if err := db.Migrate(ctx, d); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	var last string
	if err := d.W.QueryRowContext(ctx, `SELECT MAX(version) FROM schema_migrations`).Scan(&last); err != nil {
		t.Fatalf("max version: %v", err)
	}
	if _, err := d.W.ExecContext(ctx, `DELETE FROM schema_migrations WHERE version = ?`, last); err != nil {
		t.Fatalf("delete: %v", err)
	}
	countRows := func() int {
		var n int
		if err := d.R.QueryRowContext(ctx, `SELECT COUNT(*) FROM schema_migrations`).Scan(&n); err != nil {
			t.Fatalf("count: %v", err)
		}
		return n
	}
	before := countRows()

	cmd := exec.Command(os.Args[0], "-test.run=^TestStartupMigrationFailureExitsNonZero$")
	cmd.Env = append(os.Environ(),
		"PMW_TEST_RUN_MAIN=1",
		"PMW_TEST_ARGS=--db "+dbPath+" --addr 127.0.0.1:0 --vault-keychain=false")
	out, err := cmd.CombinedOutput()
	var exitErr *exec.ExitError
	if !errors.As(err, &exitErr) || exitErr.ExitCode() == 0 {
		t.Fatalf("pmw should exit non-zero, err = %v, output:\n%s", err, out)
	}

	entries, err := os.ReadDir(filepath.Join(dir, "backups"))
	if err != nil || len(entries) != 1 {
		t.Fatalf("backups = %v (err %v), want one snapshot", entries, err)
	}
	snap := filepath.Join(dir, "backups", entries[0].Name())
	if !strings.Contains(string(out), snap) {
		t.Errorf("output should print snapshot path %s:\n%s", snap, out)
	}
	if after := countRows(); after != before {
		t.Errorf("schema_migrations rows %d -> %d, want unchanged", before, after)
	}
	_ = d.Close()
}
