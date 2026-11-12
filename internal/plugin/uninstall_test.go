// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package plugin_test

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"

	"github.com/lizhao903/pm-workspace/internal/plugin"
	"github.com/lizhao903/pm-workspace/internal/plugin/plugintest"
)

// hookPlugin 记下 OnInstall、OnUninstall 有没有被调、带的参数。
type hookPlugin struct {
	*plugintest.Demo
	installed   int
	uninstalled []bool
	failUn      error
}

func (p *hookPlugin) OnInstall(context.Context, plugin.Core) error { p.installed++; return nil }
func (p *hookPlugin) OnUninstall(_ context.Context, _ plugin.Core, deleteData bool) error {
	p.uninstalled = append(p.uninstalled, deleteData)
	return p.failUn
}

// TestUninstallKeepsDataByDefault：要先停用；保留数据时表和迁移记录都在，重装跳过已应用的迁移。
func TestUninstallKeepsDataByDefault(t *testing.T) {
	ctx := context.Background()
	d := migratedDB(t)
	hp := &hookPlugin{Demo: plugintest.NewDemo(time.Hour)}
	r, err := sqlRegistry(t, d, hp)
	if err != nil {
		t.Fatal(err)
	}
	installEnable(t, r, "demo")
	if hp.installed != 1 {
		t.Fatalf("OnInstall 调了 %d 次", hp.installed)
	}
	if _, err := d.W.Exec(`INSERT INTO demo_items (id, title, created_at) VALUES ('a', 'x', '2026-10-28T00:00:00Z')`); err != nil {
		t.Fatal(err)
	}

	if _, err := r.Uninstall(ctx, "demo", plugin.UninstallOptions{}); !errors.Is(err, plugin.ErrState) {
		t.Fatalf("启用中卸载 err = %v", err)
	}
	if err := r.Disable(ctx, "demo"); err != nil {
		t.Fatal(err)
	}
	res, err := r.Uninstall(ctx, "demo", plugin.UninstallOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if res.DataDeleted || res.Backup != "" || len(res.DroppedTables) != 0 {
		t.Fatalf("保留数据的卸载结果 = %+v", res)
	}
	if info, _ := r.Get("demo"); info.State.Installed || info.State.Enabled {
		t.Fatalf("卸载后状态 = %+v", info.State)
	}
	var n int
	if err := d.R.QueryRow(`SELECT COUNT(*) FROM demo_items`).Scan(&n); err != nil || n != 1 {
		t.Fatalf("保留数据后 demo_items 行数 = %d, %v", n, err)
	}
	if !slices.Equal(hp.uninstalled, []bool{false}) {
		t.Fatalf("OnUninstall 调用 = %v", hp.uninstalled)
	}
	if _, err := r.Uninstall(ctx, "demo", plugin.UninstallOptions{}); !errors.Is(err, plugin.ErrState) {
		t.Fatalf("重复卸载 err = %v", err)
	}

	// 重装：迁移已应用，跳过，数据还在
	installEnable(t, r, "demo")
	if err := d.R.QueryRow(`SELECT COUNT(*) FROM demo_items`).Scan(&n); err != nil || n != 1 {
		t.Fatalf("重装后 demo_items 行数 = %d, %v", n, err)
	}
}

// TestUninstallDeleteDataBacksUpFirst：删数据先调 Backup，再删前缀表和迁移记录；
// Backup 失败什么都不删、状态不变；重装后迁移重新跑。
func TestUninstallDeleteDataBacksUpFirst(t *testing.T) {
	ctx := context.Background()
	d := migratedDB(t)
	r, err := sqlRegistry(t, d, plugintest.NewDemo(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	installEnable(t, r, "demo")
	if err := r.Disable(ctx, "demo"); err != nil {
		t.Fatal(err)
	}

	if _, err := r.Uninstall(ctx, "demo", plugin.UninstallOptions{DeleteData: true}); err == nil {
		t.Fatal("删数据没给 Backup 却通过了")
	}
	boom := errors.New("disk full")
	_, err = r.Uninstall(ctx, "demo", plugin.UninstallOptions{DeleteData: true,
		Backup: func(context.Context) (string, error) { return "", boom }})
	if !errors.Is(err, boom) {
		t.Fatalf("备份失败时 err = %v", err)
	}
	if cols := columns(t, d, "demo_items"); len(cols) == 0 {
		t.Fatal("备份失败后表被删了")
	}
	if info, _ := r.Get("demo"); !info.State.Installed {
		t.Fatal("备份失败后状态被改成未安装")
	}

	snap := filepath.Join(t.TempDir(), "snap.db")
	var tablesAtBackup []string
	res, err := r.Uninstall(ctx, "demo", plugin.UninstallOptions{DeleteData: true,
		Backup: func(context.Context) (string, error) {
			// 备份时表必须还在
			tablesAtBackup = columns(t, d, "demo_items")
			if _, err := d.W.Exec(`VACUUM INTO ?`, snap); err != nil {
				return "", err
			}
			return snap, nil
		}})
	if err != nil {
		t.Fatal(err)
	}
	if len(tablesAtBackup) == 0 {
		t.Fatal("备份时表已经没了")
	}
	if _, err := os.Stat(snap); err != nil {
		t.Fatalf("快照文件不在：%v", err)
	}
	if !res.DataDeleted || res.Backup != snap || !slices.Equal(res.DroppedTables, []string{"demo_items"}) {
		t.Fatalf("删数据的卸载结果 = %+v", res)
	}
	if cols := columns(t, d, "demo_items"); len(cols) != 0 {
		t.Fatalf("删数据后 demo_items 还在：%v", cols)
	}
	var n int
	if err := d.R.QueryRow(`SELECT COUNT(*) FROM plugins_migrations WHERE plugin_id = 'demo'`).Scan(&n); err != nil || n != 0 {
		t.Fatalf("迁移记录还剩 %d 条, %v", n, err)
	}
	if err := d.R.QueryRow(`SELECT COUNT(*) FROM objects`).Scan(&n); err != nil {
		t.Fatalf("内核表受了影响：%v", err)
	}

	installEnable(t, r, "demo")
	if cols := columns(t, d, "demo_items"); len(cols) != 5 {
		t.Fatalf("重装后迁移没重新跑：%v", cols)
	}
}

// TestUninstallBlockedByInstalledDependents：依赖方停用了但还装着，也不能卸载。
func TestUninstallBlockedByInstalledDependents(t *testing.T) {
	ctx := context.Background()
	child := &fakePlugin{m: manifest(t, "child", `,"depends":{"demo":">=0.1.0 <1.0.0"}`)}
	r := newRegistry(t, plugin.NewMemStateStore(), plugintest.NewDemo(time.Hour), child)
	installEnable(t, r, "demo")
	installEnable(t, r, "child")
	if info, _ := r.Get("demo"); !slices.Equal(info.Dependents, []string{"child"}) {
		t.Fatalf("Info.Dependents = %v", info.Dependents)
	}
	for _, id := range []string{"child", "demo"} {
		if err := r.Disable(ctx, id); err != nil {
			t.Fatal(err)
		}
	}
	var de *plugin.DependentsError
	if _, err := r.Uninstall(ctx, "demo", plugin.UninstallOptions{}); !errors.As(err, &de) ||
		!de.Uninstall || !slices.Equal(de.Dependents, []string{"child"}) {
		t.Fatalf("被已安装插件依赖时卸载 err = %v", err)
	}
	if _, err := r.Uninstall(ctx, "child", plugin.UninstallOptions{}); err != nil {
		t.Fatal(err)
	}
	if _, err := r.Uninstall(ctx, "demo", plugin.UninstallOptions{}); err != nil {
		t.Fatal(err)
	}
}

// TestOnUninstallErrorKeepsState：OnUninstall 出错整次失败，状态和数据都不动。
func TestOnUninstallErrorKeepsState(t *testing.T) {
	ctx := context.Background()
	hp := &hookPlugin{Demo: plugintest.NewDemo(time.Hour), failUn: errors.New("busy")}
	r := newRegistry(t, plugin.NewMemStateStore(), hp)
	installEnable(t, r, "demo")
	if err := r.Disable(ctx, "demo"); err != nil {
		t.Fatal(err)
	}
	if _, err := r.Uninstall(ctx, "demo", plugin.UninstallOptions{}); err == nil {
		t.Fatal("OnUninstall 出错却卸载成功")
	}
	if info, _ := r.Get("demo"); !info.State.Installed {
		t.Fatal("OnUninstall 出错后状态被改了")
	}
}

// TestCheckInstallChangesNothing：CheckInstall 报出和 Install 一样的错，权限没确认时同时是 ErrUnconfirmed。
func TestCheckInstallChangesNothing(t *testing.T) {
	r := newRegistry(t, plugin.NewMemStateStore(), plugintest.NewDemo(time.Hour))
	if err := r.CheckInstall("demo", nil); !errors.Is(err, plugin.ErrUnconfirmed) || !errors.Is(err, plugin.ErrState) {
		t.Fatalf("没确认权限 err = %v", err)
	}
	if err := r.CheckInstall("demo", []string{"network:localhost"}); err != nil {
		t.Fatal(err)
	}
	if info, _ := r.Get("demo"); info.State.Installed {
		t.Fatal("CheckInstall 改了状态")
	}
	if err := r.CheckInstall("nope", nil); !errors.Is(err, plugin.ErrNotFound) {
		t.Fatalf("不存在的插件 err = %v", err)
	}
}
