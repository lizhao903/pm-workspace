package plugin_test

import (
	"context"
	"errors"
	"slices"
	"testing"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// 换了二进制：状态表里是 0.0.9、没确认过 network:any，二进制里是 0.1.0、要 network:any。
func upgradeFixture(t *testing.T, confirmed []string, perms string) (*plugin.Registry, *plugin.MemStateStore, func() plugin.Core) {
	t.Helper()
	var got plugin.Core
	p := &fakePlugin{reg: func(r plugin.Registrar) error {
		got = r.Core()
		return nil
	}}
	m, err := plugin.Parse([]byte(`{"id":"demo","name":"demo","version":"0.1.0","core":">=1.0.0 <2.0.0","provides":{},"permissions":` + perms + `}`))
	if err != nil {
		t.Fatal(err)
	}
	p.m = *m
	store := plugin.NewMemStateStore()
	_ = store.Save(context.Background(), plugin.State{ID: "demo", Installed: true, Enabled: true, Version: "0.0.9", Permissions: confirmed})
	r := newRegistry(t, store, p)
	return r, store, func() plugin.Core { return got }
}

func TestGrantedOnlyConfirmed(t *testing.T) {
	r, store, core := upgradeFixture(t, []string{}, `["network:any"]`)
	in, _ := r.Get("demo")
	if !in.Running {
		t.Fatal("版本变了也照常启用")
	}
	c := core()
	if c.Granted("network:any") {
		t.Fatal("没确认的权限不该算授予")
	}
	err := plugin.Require(c, "network:any")
	if !errors.Is(err, plugin.ErrNotGranted) || err.Error() != "插件 demo 的 network:any 权限还没确认，到插件管理里升级并确认" {
		t.Fatalf("Require: %v", err)
	}
	if got := in.NewPermissions(); !slices.Equal(got, []string{"network:any"}) {
		t.Fatalf("NewPermissions = %v", got)
	}

	// 不带权限：拒绝并列出新增的，什么都不动
	err = r.Upgrade(context.Background(), "demo", nil)
	var pe *plugin.UpgradePermissionsError
	if !errors.As(err, &pe) || !slices.Equal(pe.Missing, []string{"network:any"}) {
		t.Fatalf("upgrade without perms: %v", err)
	}
	if err := r.CheckUpgrade("demo", nil); !errors.As(err, &pe) {
		t.Fatalf("CheckUpgrade: %v", err)
	}
	if in, _ := r.Get("demo"); in.State.Version != "0.0.9" || c.Granted("network:any") {
		t.Fatalf("拒绝后不该变：%+v", in.State)
	}

	if err := r.Upgrade(context.Background(), "demo", []string{"network:any"}); err != nil {
		t.Fatalf("upgrade: %v", err)
	}
	in, _ = r.Get("demo")
	if in.State.Version != "0.1.0" || !in.Running || !slices.Equal(in.State.Permissions, []string{"network:any"}) || in.State.PermissionsAt == nil {
		t.Fatalf("升级后状态不对：%+v running=%v", in.State, in.Running)
	}
	if !core().Granted("network:any") || plugin.Require(core(), "network:any") != nil {
		t.Fatal("确认后应当授予")
	}
	st, _ := store.Load(context.Background())
	if st["demo"].Version != "0.1.0" {
		t.Fatalf("状态表没写：%+v", st["demo"])
	}
	// 已是最新再升级：冲突
	if err := r.Upgrade(context.Background(), "demo", nil); !errors.Is(err, plugin.ErrState) {
		t.Fatalf("再升级应当冲突：%v", err)
	}
}

func TestUpgradeRevokesDroppedPermissions(t *testing.T) {
	r, _, core := upgradeFixture(t, []string{"network:any", "process:spawn"}, `["network:any"]`)
	if !core().Granted("process:spawn") {
		t.Fatal("升级前状态表里确认过的照常授予")
	}
	if err := r.Upgrade(context.Background(), "demo", nil); err != nil {
		t.Fatalf("只减少权限不用确认：%v", err)
	}
	if core().Granted("process:spawn") || !core().Granted("network:any") {
		t.Fatal("清单里去掉的权限要收回")
	}
}

func TestGrantedFollowsInstallState(t *testing.T) {
	m, _ := plugin.Parse([]byte(`{"id":"demo","name":"demo","version":"0.1.0","core":">=1.0.0 <2.0.0","provides":{},"permissions":["process:spawn"]}`))
	var c plugin.Core
	p := &fakePlugin{m: *m, reg: func(r plugin.Registrar) error { c = r.Core(); return nil }}
	r := newRegistry(t, plugin.NewMemStateStore(), p)
	if err := r.Install(context.Background(), "demo", []string{"process:spawn"}); err != nil {
		t.Fatal(err)
	}
	if err := r.Enable(context.Background(), "demo"); err != nil {
		t.Fatal(err)
	}
	if !c.Granted("process:spawn") {
		t.Fatal("安装时确认的权限要授予")
	}
	if err := r.Upgrade(context.Background(), "demo", nil); !errors.Is(err, plugin.ErrState) {
		t.Fatalf("版本没变不能升级：%v", err)
	}
	if err := r.Disable(context.Background(), "demo"); err != nil {
		t.Fatal(err)
	}
	if _, err := r.Uninstall(context.Background(), "demo", plugin.UninstallOptions{}); err != nil {
		t.Fatal(err)
	}
	if c.Granted("process:spawn") {
		t.Fatal("卸载后不再授予")
	}
}

func TestLocalDir(t *testing.T) {
	for in, want := range map[string]string{
		"file:///Volumes/docs/Know Me/FDE工作": "/Volumes/docs/Know Me/FDE工作",
		"file:///tmp/a%20b":                  "/tmp/a b",
		"file://localhost/tmp/x":             "/tmp/x",
		"FILE:///tmp/x":                      "/tmp/x",
		"/tmp/plain":                         "/tmp/plain",
		"":                                   "",
		"file://other-host/tmp/x":            "file://other-host/tmp/x",
		"https://example.com/x":              "https://example.com/x",
	} {
		if got := plugin.LocalDir(in); got != want {
			t.Errorf("LocalDir(%q) = %q，要 %q", in, got, want)
		}
	}
}
