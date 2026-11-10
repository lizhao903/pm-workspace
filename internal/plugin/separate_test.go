// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package plugin_test

import (
	"context"
	"errors"
	"slices"
	"testing"

	"github.com/lizhao903/pm-workspace/internal/audit"
	"github.com/lizhao903/pm-workspace/internal/plugin"
	"github.com/lizhao903/pm-workspace/internal/store"
)

type grantGuarded struct {
	*fakePlugin
	ok bool
}

func (p *grantGuarded) CanGrant(context.Context, plugin.Core, string) (bool, string) {
	if p.ok {
		return true, ""
	}
	return false, "评审还没通过"
}

// 单独申请的权限（TRD-08c）：安装、升级都不授予也不要求确认；单独授予要插件同意；收回随时可以；升级时已授予的保留。
func TestSeparatePermission(t *testing.T) {
	ctx := context.Background()
	var got plugin.Core
	p := &grantGuarded{fakePlugin: &fakePlugin{m: manifest(t, "live", `,"version":"0.1.0"`), reg: func(r plugin.Registrar) error {
		got = r.Core()
		return nil
	}}}
	m, err := plugin.Parse([]byte(`{"id":"live","name":"实盘","version":"0.1.0","core":">=1.0.0 <2.0.0","provides":{},"permissions":["network:any","trade:live"]}`))
	if err != nil {
		t.Fatal(err)
	}
	p.m = *m
	store := plugin.NewMemStateStore()
	r := newRegistry(t, store, p)

	// 安装只要确认 network:any，带不带 trade:live 都不授予
	if err := r.Install(ctx, "live", []string{"network:any", "trade:live"}); err != nil {
		t.Fatal(err)
	}
	if err := r.Enable(ctx, "live"); err != nil {
		t.Fatal(err)
	}
	in, _ := r.Get("live")
	if !slices.Equal(in.State.Permissions, []string{"network:any"}) || got.Granted("trade:live") || len(in.NewPermissions()) != 0 {
		t.Fatalf("安装后：%v，新增 %v", in.State.Permissions, in.NewPermissions())
	}
	if !slices.Equal(in.SeparateDeclared(), []string{"trade:live"}) {
		t.Fatalf("SeparateDeclared = %v", in.SeparateDeclared())
	}

	// 不是单独申请的、清单没声明的不能单独授予
	if err := r.Grant(ctx, "live", "network:any"); !errors.Is(err, plugin.ErrNotSeparate) {
		t.Fatalf("普通权限单独授予：%v", err)
	}
	// 插件不同意
	var gd *plugin.GrantDeniedError
	if err := r.Grant(ctx, "live", "trade:live"); !errors.As(err, &gd) || gd.Reason != "评审还没通过" || got.Granted("trade:live") {
		t.Fatalf("插件不同意：%v", err)
	}
	p.ok = true
	if err := r.Grant(ctx, "live", "trade:live"); err != nil || !got.Granted("trade:live") {
		t.Fatalf("同意后授予：%v", err)
	}
	if err := r.Grant(ctx, "live", "trade:live"); err != nil {
		t.Fatalf("重复授予是幂等的：%v", err)
	}

	// 插件自己收回
	if err := got.RevokePermission(ctx, "trade:live"); err != nil || got.Granted("trade:live") {
		t.Fatalf("插件收回：%v", err)
	}
	if err := got.RevokePermission(ctx, "network:any"); !errors.Is(err, plugin.ErrNotSeparate) {
		t.Fatalf("只能收回单独申请的：%v", err)
	}
	st, _ := store.Load(ctx)
	if slices.Contains(st["live"].Permissions, "trade:live") {
		t.Fatalf("状态表里要收回：%v", st["live"].Permissions)
	}

	// 停用后不能单独授予
	if err := r.Disable(ctx, "live"); err != nil {
		t.Fatal(err)
	}
	if err := r.Grant(ctx, "live", "trade:live"); !errors.Is(err, plugin.ErrState) {
		t.Fatalf("停用后授予：%v", err)
	}

	// 换了二进制升级：状态表里已授予的 trade:live 保留，不要求确认；没授予的也不会因为升级授予
	r.Close()
	_ = store.Save(ctx, plugin.State{ID: "live", Installed: true, Enabled: true, Version: "0.1.0", Permissions: []string{"network:any", "trade:live"}})
	m2 := *m
	m2.Version = "0.2.0"
	p2 := &grantGuarded{fakePlugin: &fakePlugin{m: m2, reg: func(r plugin.Registrar) error {
		got = r.Core()
		return nil
	}}}
	r2 := newRegistry(t, store, p2)
	if err := r2.Upgrade(ctx, "live", nil); err != nil {
		t.Fatalf("升级：%v", err)
	}
	if in, _ := r2.Get("live"); !slices.Contains(in.State.Permissions, "trade:live") || !got.Granted("trade:live") {
		t.Fatalf("升级后 trade:live 要保留：%v", in.State.Permissions)
	}
}

// 只接受用户本人：来源 ui、不带会话标识。Agent、api、带会话标识的都不算。
func TestRequireUser(t *testing.T) {
	for _, c := range []struct {
		a  store.Actor
		ok bool
	}{
		{store.Actor{Name: "me", Source: "ui"}, true},
		{store.Actor{Name: "me", Source: "ui", Session: "x"}, false},
		{store.Actor{Name: "Claude Code", Source: "agent", Session: "s"}, false},
		{store.Actor{Name: "me", Source: "api"}, false},
		{store.Actor{Name: "me", Source: "import"}, false},
	} {
		err := plugin.RequireUser(audit.WithActor(context.Background(), c.a), "实盘评审")
		if (err == nil) != c.ok || (err != nil && !errors.Is(err, plugin.ErrNotUser)) {
			t.Errorf("%+v：%v", c.a, err)
		}
	}
	if err := plugin.RequireUser(context.Background(), "实盘评审"); !errors.Is(err, plugin.ErrNotUser) {
		t.Fatalf("没有操作者（后台任务）：%v", err)
	}
}
