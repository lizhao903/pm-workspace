package projects

import (
	"context"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"testing"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

func TestManifestValid(t *testing.T) {
	m, err := plugin.Parse(manifestJSON)
	if err != nil {
		t.Fatalf("清单不合法：%v", err)
	}
	if m.ID != "projects" || m.TablePrefix != "projects_" {
		t.Fatalf("id=%s table_prefix=%s", m.ID, m.TablePrefix)
	}
}

// 迁移目录里有了 .sql 文件，Migrations 就不能再返回 nil，否则迁移永远不会被应用
func TestMigrationsEmbedded(t *testing.T) {
	files, err := filepath.Glob(filepath.Join("migrations", "*.sql"))
	if err != nil {
		t.Fatal(err)
	}
	if len(files) > 0 && New().Migrations() == nil {
		t.Fatalf("migrations/ 里有 %d 条迁移，但 Migrations() 返回 nil", len(files))
	}
	if _, err := os.Stat("migrations"); err != nil {
		t.Fatalf("迁移目录要在：%v", err)
	}
}

func TestLifecycle(t *testing.T) {
	ctx := context.Background()
	r := plugin.NewRegistry(plugin.NewMemStateStore(), slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err := r.Add(New()); err != nil {
		t.Fatal(err)
	}
	if err := r.Start(ctx); err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	if err := r.Install(ctx, "projects", nil); err != nil {
		t.Fatalf("安装：%v", err)
	}
	if err := r.Enable(ctx, "projects"); err != nil {
		t.Fatalf("启用：%v", err)
	}
	if err := r.Disable(ctx, "projects"); err != nil {
		t.Fatalf("停用：%v", err)
	}
	if _, err := r.Uninstall(ctx, "projects", plugin.UninstallOptions{}); err != nil {
		t.Fatalf("卸载：%v", err)
	}
}
