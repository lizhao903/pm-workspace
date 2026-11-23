// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package pluginhost

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestDevDirAutoLoadReloadAndUninstall(t *testing.T) {
	devRoot := t.TempDir()
	pluginDir := filepath.Join(devRoot, "hello_world")
	obj := testManifestObj(platformKey(), "bin/hello_world")
	writeTestPackage(t, pluginDir, obj)

	h, getFake := newFakeHost(t, Options{DevDir: devRoot})
	t.Cleanup(h.Close)
	ctx := context.Background()
	if err := h.Start(ctx); err != nil {
		t.Fatalf("Start: %v", err)
	}
	list := h.List()
	if len(list) != 1 || list[0].Source.Type != "dev" || list[0].Enabled {
		t.Fatalf("开发目录启动后应有一个未启用的 dev 插件：%+v", list)
	}
	info, err := h.Enable(ctx, "hello_world")
	if err != nil || !info.Running {
		t.Fatalf("Enable dev: %v %+v", err, info)
	}
	first := getFake()

	// 改版本后 Reload：更新状态并按原启用状态重启。
	obj["version"] = "0.2.0"
	writeTestPackage(t, pluginDir, obj)
	infos, err := h.ReloadDev(ctx)
	if err != nil {
		t.Fatalf("ReloadDev: %v", err)
	}
	if len(infos) != 1 || infos[0].Version != "0.2.0" || !infos[0].Running {
		t.Fatalf("Reload 后状态不对：%+v", infos)
	}
	if getFake() == first {
		t.Fatal("Reload 后应重新拉起进程")
	}

	// 卸载 dev 插件不能删源码目录。
	if _, err := h.Uninstall(ctx, "hello_world", false); err != nil {
		t.Fatalf("Uninstall: %v", err)
	}
	if _, err := os.Stat(filepath.Join(pluginDir, "plugin.json")); err != nil {
		t.Fatalf("卸载开发目录插件删掉了源码：%v", err)
	}
	if _, err := h.Get("hello_world"); err == nil {
		t.Fatal("卸载后状态应删除")
	}
}

func TestInstallDevSourceExplicitly(t *testing.T) {
	devRoot := t.TempDir()
	pluginDir := filepath.Join(devRoot, "hello_world")
	obj := testManifestObj(platformKey(), "bin/hello_world")
	writeTestPackage(t, pluginDir, obj)
	h, _ := newFakeHost(t, Options{})
	t.Cleanup(h.Close)
	ctx := context.Background()
	info, err := h.Install(ctx, Source{Type: "dev", Path: pluginDir}, []string{"objects:read", "notify"})
	if err != nil {
		t.Fatalf("Install dev: %v", err)
	}
	if info.Source.Type != "dev" || info.InstallDir != pluginDir {
		t.Fatalf("dev 安装应链接源码目录：%+v", info)
	}
	// 正式安装的 id 与 dev 冲突时拒绝（这里反过来验证 dev 已占用 → 正式安装 conflict）。
	obj2 := testManifestObj(platformKey(), "bin/hello_world")
	obj2["version"] = "0.2.0"
	dir2 := t.TempDir()
	writeTestPackage(t, dir2, obj2)
	if _, err := h.Install(ctx, Source{Type: "dir", Path: dir2}, []string{"objects:read", "notify"}); err == nil {
		t.Fatal("同一 id 已有 dev 安装时正式安装应拒绝")
	}
}
