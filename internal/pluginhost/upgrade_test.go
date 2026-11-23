// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package pluginhost

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func versionedPackage(t *testing.T, version string, extraMigration bool) string {
	t.Helper()
	obj := testManifestObj(platformKey(), "bin/hello_world")
	obj["version"] = version
	dir := t.TempDir()
	writeTestPackage(t, dir, obj)
	if extraMigration {
		if err := os.WriteFile(filepath.Join(dir, "migrations", "002_v2.sql"),
			[]byte("ALTER TABLE hello_items ADD COLUMN v2 TEXT NOT NULL DEFAULT '';\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

func TestUpgradeAndRollback(t *testing.T) {
	v1 := versionedPackage(t, "0.1.0", false)
	v2 := versionedPackage(t, "0.2.0", true)
	h, getFake := newFakeHost(t, Options{})
	t.Cleanup(h.Close)
	ctx := context.Background()
	if _, err := h.Install(ctx, Source{Type: "dir", Path: v1}, []string{"objects:read", "notify"}); err != nil {
		t.Fatal(err)
	}
	if _, err := h.Enable(ctx, "hello_world"); err != nil {
		t.Fatal(err)
	}
	first := getFake()
	info, err := h.Upgrade(ctx, "hello_world", Source{Type: "dir", Path: v2}, []string{"objects:read", "notify"})
	if err != nil {
		t.Fatalf("Upgrade: %v", err)
	}
	if info.Version != "0.2.0" || !info.Enabled || !info.Running || info.PreviousVersion != "0.1.0" {
		t.Fatalf("升级后 Info 不对：%+v", info)
	}
	if getFake() == first {
		t.Fatal("升级后没有重新拉起进程")
	}
	if _, err := os.Stat(filepath.Join(h.packagesDir, "hello_world", "0.1.0")); err != nil {
		t.Fatalf("旧版本目录应保留：%v", err)
	}
	// 升级后新迁移已应用。
	p := h.lookupProc("hello_world")
	if p == nil || p.db == nil {
		t.Fatal("升级后进程/私有库没起来")
	}
	var count int
	if err := p.db.R.QueryRow(`SELECT COUNT(*) FROM pragma_table_info('hello_items') WHERE name='v2'`).Scan(&count); err != nil || count != 1 {
		t.Fatalf("v2 迁移没应用：count=%d err=%v", count, err)
	}

	rollback, err := h.Rollback(ctx, "hello_world")
	if err != nil {
		t.Fatalf("Rollback: %v", err)
	}
	if rollback.Version != "0.1.0" || !rollback.Running || rollback.PreviousVersion != "0.2.0" {
		t.Fatalf("回滚后 Info 不对：%+v", rollback)
	}

	// 同版本不能再升级；降级也不允许升级接口。
	if _, err := h.Upgrade(ctx, "hello_world", Source{Type: "dir", Path: v1}, []string{"objects:read", "notify"}); !errors.Is(err, ErrConflict) {
		t.Fatalf("升级到同版本应 conflict，得到 %v", err)
	}
	// 没有可回滚版本时 rollback conflict。
	h2, _ := newFakeHost(t, Options{})
	t.Cleanup(h2.Close)
	if _, err := h2.Install(ctx, Source{Type: "dir", Path: v1}, []string{"objects:read", "notify"}); err != nil {
		t.Fatal(err)
	}
	if _, err := h2.Rollback(ctx, "hello_world"); !errors.Is(err, ErrConflict) {
		t.Fatalf("没有上一版本时 rollback 应 conflict，得到 %v", err)
	}
}
