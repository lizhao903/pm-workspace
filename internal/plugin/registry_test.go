package plugin_test

import (
	"context"
	"errors"
	"io/fs"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/lizhao903/pm-workspace/internal/db"
	"github.com/lizhao903/pm-workspace/internal/plugin"
	"github.com/lizhao903/pm-workspace/internal/plugin/plugintest"
)

var quiet = slog.New(slog.DiscardHandler)

// fakePlugin 用一段清单和一个 Register 函数拼出插件，测登记校验和依赖。
type fakePlugin struct {
	m   plugin.Manifest
	reg func(r plugin.Registrar) error
	// guard 不为空时实现 DisableGuard
	guard func() (bool, string)
}

func (p *fakePlugin) Manifest() plugin.Manifest { return p.m }
func (p *fakePlugin) Migrations() fs.FS         { return nil }
func (p *fakePlugin) Register(r plugin.Registrar) error {
	if p.reg == nil {
		return nil
	}
	return p.reg(r)
}

type guardedPlugin struct{ *fakePlugin }

func (p guardedPlugin) CanDisable(context.Context, plugin.Core) (bool, string) { return p.guard() }

func manifest(t *testing.T, id, extra string) plugin.Manifest {
	t.Helper()
	js := `{"id":"` + id + `","name":"` + id + `","version":"0.1.0","core":">=1.0.0 <2.0.0",` +
		`"provides":{},"permissions":[]` + extra + `}`
	m, err := plugin.Parse([]byte(js))
	if err != nil {
		t.Fatalf("manifest %s: %v", id, err)
	}
	return *m
}

func newRegistry(t *testing.T, store plugin.StateStore, ps ...plugin.Plugin) *plugin.Registry {
	t.Helper()
	return newRegistryM(t, store, plugin.NewMemMigrationStore(), ps...)
}

// newRegistryM 同 newRegistry，迁移记录用给定的 store（重启类测试要和状态表一起留着）。
func newRegistryM(t *testing.T, store plugin.StateStore, migs plugin.MigrationStore, ps ...plugin.Plugin) *plugin.Registry {
	t.Helper()
	r := plugin.NewRegistry(store, quiet)
	r.Migrations = migs
	for _, p := range ps {
		if err := r.Add(p); err != nil {
			t.Fatalf("add: %v", err)
		}
	}
	if err := r.Start(context.Background()); err != nil {
		t.Fatalf("start: %v", err)
	}
	t.Cleanup(r.Close)
	return r
}

// mux 把插件路由挂到一个 ServeMux 上，没挂的、停用的都回 404。
func mux(r *plugin.Registry) http.Handler {
	m := http.NewServeMux()
	nf := func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNotFound) }
	for _, rt := range r.Routes(nf) {
		m.HandleFunc(rt.Pattern, rt.Handler)
	}
	m.HandleFunc("/", nf)
	return m
}

func get(t *testing.T, h http.Handler, path string) int {
	t.Helper()
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
	return rec.Code
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("等不到：%s", what)
		}
		time.Sleep(2 * time.Millisecond)
	}
}

func installEnable(t *testing.T, r *plugin.Registry, id string) {
	t.Helper()
	info, err := r.Get(id)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if err := r.Install(ctx, id, info.Manifest.Permissions); err != nil {
		t.Fatalf("install %s: %v", id, err)
	}
	if err := r.Enable(ctx, id); err != nil {
		t.Fatalf("enable %s: %v", id, err)
	}
}

// TestDisableStopsRoutesAndJobs：停用后路由 404、后台协程全部退出、不再收事件；重新启用全部恢复。
func TestDisableStopsRoutesAndJobs(t *testing.T) {
	d := plugintest.NewDemo(2 * time.Millisecond)
	r := newRegistry(t, plugin.NewMemStateStore(), d)
	h := mux(r)
	ctx := context.Background()

	if code := get(t, h, "/api/demo/ping"); code != http.StatusNotFound {
		t.Fatalf("未安装时 ping = %d，要 404", code)
	}

	installEnable(t, r, "demo")
	if code := get(t, h, "/api/demo/ping"); code != http.StatusOK {
		t.Fatalf("启用后 ping = %d，要 200", code)
	}
	if code := get(t, h, "/api/demo/items/x1"); code != http.StatusOK {
		t.Fatalf("启用后带参数的路由 = %d，要 200", code)
	}
	waitFor(t, "常驻任务起来", func() bool { return d.Resident.Load() == 1 })
	waitFor(t, "定时任务跑起来", func() bool { return d.Ticks.Load() >= 3 })
	if info, _ := r.Get("demo"); !info.Running || info.Jobs != 2 {
		t.Fatalf("启用后 running=%v jobs=%d，要 true、2", info.Running, info.Jobs)
	}
	if n := len(r.Subscribers("object.created")); n != 1 {
		t.Fatalf("启用后订阅者 %d 个，要 1", n)
	}

	if err := r.Disable(ctx, "demo"); err != nil {
		t.Fatalf("disable: %v", err)
	}
	if code := get(t, h, "/api/demo/ping"); code != http.StatusNotFound {
		t.Fatalf("停用后 ping = %d，要 404", code)
	}
	if code := get(t, h, "/api/demo/items/x1"); code != http.StatusNotFound {
		t.Fatalf("停用后带参数的路由 = %d，要 404", code)
	}
	// Disable 返回时协程已经退出，不用等
	if n := d.Resident.Load(); n != 0 {
		t.Fatalf("停用后常驻任务还有 %d 个", n)
	}
	info, _ := r.Get("demo")
	if info.Running || info.Jobs != 0 || info.State.Enabled || !info.State.Installed {
		t.Fatalf("停用后 info = %+v", info)
	}
	ticks := d.Ticks.Load()
	time.Sleep(20 * time.Millisecond)
	if got := d.Ticks.Load(); got != ticks {
		t.Fatalf("停用后定时任务还在跑：%d -> %d", ticks, got)
	}
	if n := len(r.Subscribers("object.created")); n != 0 {
		t.Fatalf("停用后订阅者 %d 个，要 0", n)
	}

	if err := r.Enable(ctx, "demo"); err != nil {
		t.Fatalf("re-enable: %v", err)
	}
	if code := get(t, h, "/api/demo/ping"); code != http.StatusOK {
		t.Fatalf("重新启用后 ping = %d，要 200", code)
	}
	waitFor(t, "常驻任务重新起来", func() bool { return d.Resident.Load() == 1 && d.Starts.Load() == 2 })
	waitFor(t, "定时任务重新跑", func() bool { return d.Ticks.Load() > ticks })
	subs := r.Subscribers("object.created")
	if len(subs) != 1 {
		t.Fatalf("重新启用后订阅者 %d 个，要 1", len(subs))
	}
	if err := subs[0].Handle(ctx, plugin.Event{Type: "object.created"}); err != nil || d.Events.Load() != 1 {
		t.Fatalf("事件没送到：err=%v events=%d", err, d.Events.Load())
	}

	r.Close()
	if n := d.Resident.Load(); n != 0 {
		t.Fatalf("Close 后常驻任务还有 %d 个", n)
	}
}

// TestStateSurvivesRestart：状态存进 0016 的 plugins 表，换一个注册表（等于重启进程）照样按状态启用。
func TestStateSurvivesRestart(t *testing.T) {
	ctx := context.Background()
	d0, err := db.Open(filepath.Join(t.TempDir(), "pm.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = d0.Close() })
	if err := db.Migrate(ctx, d0); err != nil {
		t.Fatal(err)
	}
	store := plugin.NewSQLStateStore(d0)
	migs := plugin.NewSQLMigrationStore(d0)

	r1 := plugin.NewRegistry(store, quiet)
	r1.Migrations = migs
	d1 := plugintest.NewDemo(time.Hour)
	if err := r1.Add(d1); err != nil {
		t.Fatal(err)
	}
	if err := r1.Start(ctx); err != nil {
		t.Fatal(err)
	}
	installEnable(t, r1, "demo")
	r1.Close()
	if d1.Resident.Load() != 0 {
		t.Fatal("Close 后常驻任务没退出")
	}

	states, err := store.Load(ctx)
	if err != nil {
		t.Fatal(err)
	}
	st := states["demo"]
	if !st.Installed || !st.Enabled || st.Version != "0.1.0" || st.InstalledAt == nil || st.PermissionsAt == nil ||
		!slices.Equal(st.Permissions, []string{"network:localhost"}) {
		t.Fatalf("状态表里的行不对：%+v", st)
	}

	d2 := plugintest.NewDemo(time.Hour)
	r2 := newRegistryM(t, store, migs, d2)
	if code := get(t, mux(r2), "/api/demo/ping"); code != http.StatusOK {
		t.Fatalf("重启后 ping = %d，要 200", code)
	}
	waitFor(t, "重启后常驻任务起来", func() bool { return d2.Resident.Load() == 1 })

	if err := r2.Disable(ctx, "demo"); err != nil {
		t.Fatal(err)
	}
	r2.Close()
	d3 := plugintest.NewDemo(time.Hour)
	r3 := newRegistryM(t, store, migs, d3)
	if code := get(t, mux(r3), "/api/demo/ping"); code != http.StatusNotFound {
		t.Fatalf("停用后重启 ping = %d，要 404", code)
	}
	if d3.Starts.Load() != 0 {
		t.Fatal("停用的插件在重启后起了后台任务")
	}
}

func TestInstallNeedsConfirmedPermissions(t *testing.T) {
	r := newRegistry(t, plugin.NewMemStateStore(), plugintest.NewDemo(time.Hour))
	ctx := context.Background()
	err := r.Install(ctx, "demo", nil)
	if !errors.Is(err, plugin.ErrState) || !strings.Contains(err.Error(), "network:localhost") {
		t.Fatalf("没确认权限时 err = %v", err)
	}
	if err := r.Enable(ctx, "demo"); !errors.Is(err, plugin.ErrState) {
		t.Fatalf("未安装就启用 err = %v", err)
	}
	if err := r.Install(ctx, "nope", nil); !errors.Is(err, plugin.ErrNotFound) {
		t.Fatalf("不存在的插件 err = %v", err)
	}
	if err := r.Install(ctx, "demo", []string{"network:localhost"}); err != nil {
		t.Fatal(err)
	}
	if err := r.Install(ctx, "demo", []string{"network:localhost"}); !errors.Is(err, plugin.ErrState) {
		t.Fatalf("重复安装 err = %v", err)
	}
}

func TestDependencies(t *testing.T) {
	child := &fakePlugin{m: manifest(t, "child", `,"depends":{"demo":">=0.1.0 <1.0.0"}`)}
	r := newRegistry(t, plugin.NewMemStateStore(), child, plugintest.NewDemo(time.Hour))
	ctx := context.Background()

	if err := r.Install(ctx, "child", nil); err == nil {
		t.Fatal("依赖没装时装上了")
	}
	installEnable(t, r, "demo")
	installEnable(t, r, "child")

	var de *plugin.DependentsError
	if err := r.Disable(ctx, "demo"); !errors.As(err, &de) || !slices.Equal(de.Dependents, []string{"child"}) {
		t.Fatalf("停用被依赖的插件 err = %v", err)
	}
	if info, _ := r.Get("demo"); !info.Running {
		t.Fatal("拒绝停用后插件却停了")
	}
	if err := r.Disable(ctx, "child"); err != nil {
		t.Fatal(err)
	}
	if err := r.Disable(ctx, "demo"); err != nil {
		t.Fatal(err)
	}
	if err := r.Enable(ctx, "child"); !errors.Is(err, plugin.ErrState) {
		t.Fatalf("依赖停用时启用 err = %v", err)
	}
}

// TestStartOrdersByDependency：状态表里两个都启用，登记顺序是被依赖的在后，启动时也要先起被依赖的。
func TestStartOrdersByDependency(t *testing.T) {
	store := plugin.NewMemStateStore()
	ctx := context.Background()
	for _, id := range []string{"demo", "child"} {
		_ = store.Save(ctx, plugin.State{ID: id, Installed: true, Enabled: true, Version: "0.1.0"})
	}
	child := &fakePlugin{m: manifest(t, "child", `,"depends":{"demo":">=0.1.0 <1.0.0"}`)}
	// 状态表是直接写的、没走安装，迁移记录也没有；这里只看启动顺序，去掉迁移
	r := newRegistry(t, store, child, plugintest.NewDemo(time.Hour).WithMigrations(nil))
	for _, id := range []string{"demo", "child"} {
		if info, _ := r.Get(id); !info.Running {
			t.Fatalf("%s 没起来", id)
		}
	}
}

func TestCoreVersionOutOfRange(t *testing.T) {
	store := plugin.NewMemStateStore()
	_ = store.Save(context.Background(), plugin.State{ID: "demo", Installed: true, Enabled: true, Version: "0.1.0"})
	r := plugin.NewRegistry(store, quiet)
	r.APIVersion = "2.0.0"
	if err := r.Add(plugintest.NewDemo(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if err := r.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(r.Close)
	if info, _ := r.Get("demo"); info.Running {
		t.Fatal("插件 API 版本不在 core 范围里却启用了")
	}
	if err := r.Enable(context.Background(), "demo"); err == nil || !strings.Contains(err.Error(), "core") {
		t.Fatalf("enable err = %v", err)
	}
}

func TestRegisterChecksManifest(t *testing.T) {
	ok := func(http.ResponseWriter, *http.Request) {}
	run := func(context.Context, plugin.Core) error { return nil }
	cases := []struct {
		name string
		reg  func(r plugin.Registrar)
		want string
	}{
		{"路径越界", func(r plugin.Registrar) {
			r.Routes(func(m plugin.RouteRegistrar) { m.HandleFunc("GET /api/objects", ok) })
		}, "必须在 /api/bad/ 下"},
		{"没写方法", func(r plugin.Registrar) {
			r.Routes(func(m plugin.RouteRegistrar) { m.HandleFunc("/api/bad/x", ok) })
		}, "方法 路径"},
		{"路由重复", func(r plugin.Registrar) {
			r.Routes(func(m plugin.RouteRegistrar) {
				m.HandleFunc("GET /api/bad/x", ok)
				m.HandleFunc("GET /api/bad/x", ok)
			})
		}, "路由重复"},
		{"订阅没声明", func(r plugin.Registrar) {
			r.Subscribe("run.finished", func(context.Context, plugin.Core, plugin.Event) error { return nil })
		}, "subscribes"},
		{"任务重名", func(r plugin.Registrar) {
			r.Job(plugin.Job{Name: "a", Run: run})
			r.Job(plugin.Job{Name: "a", Run: run})
		}, "后台任务重复"},
		{"任务没有 Run", func(r plugin.Registrar) { r.Job(plugin.Job{Name: "a"}) }, "没有 Run"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			p := &fakePlugin{m: manifest(t, "bad", ""), reg: func(r plugin.Registrar) error { tc.reg(r); return nil }}
			err := plugin.NewRegistry(plugin.NewMemStateStore(), quiet).Add(p)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("err = %v，要包含 %q", err, tc.want)
			}
		})
	}

	r := plugin.NewRegistry(plugin.NewMemStateStore(), quiet)
	if err := r.Add(plugintest.NewDemo(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if err := r.Add(plugintest.NewDemo(time.Hour)); err == nil {
		t.Fatal("同一个 id 登记了两次")
	}
	if err := r.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := r.Add(&fakePlugin{m: manifest(t, "late", "")}); err == nil {
		t.Fatal("Start 之后还能 Add")
	}
}

// TestEnableRejectsChangedRoutes：启用时登记的路由和启动时挂进去的不一样，说明新路由没挂上，要拒绝。
func TestEnableRejectsChangedRoutes(t *testing.T) {
	calls := 0
	p := &fakePlugin{m: manifest(t, "flaky", ""), reg: func(r plugin.Registrar) error {
		calls++
		path := "GET /api/flaky/a"
		if calls > 1 {
			path = "GET /api/flaky/b"
		}
		r.Routes(func(m plugin.RouteRegistrar) { m.HandleFunc(path, func(http.ResponseWriter, *http.Request) {}) })
		return nil
	}}
	r := newRegistry(t, plugin.NewMemStateStore(), p)
	ctx := context.Background()
	if err := r.Install(ctx, "flaky", nil); err != nil {
		t.Fatal(err)
	}
	if err := r.Enable(ctx, "flaky"); err == nil || !strings.Contains(err.Error(), "不一致") {
		t.Fatalf("err = %v", err)
	}
	if info, _ := r.Get("flaky"); info.State.Enabled {
		t.Fatal("登记失败却写成了启用")
	}
}

func TestDisableGuard(t *testing.T) {
	allow := false
	p := guardedPlugin{&fakePlugin{m: manifest(t, "trade_demo", ""), guard: func() (bool, string) {
		return allow, "还有挂单"
	}}}
	r := newRegistry(t, plugin.NewMemStateStore(), p)
	installEnable(t, r, "trade_demo")
	ctx := context.Background()
	var ge *plugin.GuardError
	if err := r.Disable(ctx, "trade_demo"); !errors.As(err, &ge) || ge.Reason != "还有挂单" {
		t.Fatalf("err = %v", err)
	}
	allow = true
	if err := r.Disable(ctx, "trade_demo"); err != nil {
		t.Fatal(err)
	}
}

// TestJobPanicAndStubbornJob：任务 panic 不拖垮进程；不理 ctx 的任务最多等 StopTimeout。
func TestJobPanicAndStubbornJob(t *testing.T) {
	release := make(chan struct{})
	t.Cleanup(func() { close(release) })
	p := &fakePlugin{m: manifest(t, "rough", ""), reg: func(r plugin.Registrar) error {
		r.Job(plugin.Job{Name: "boom", Every: time.Millisecond, Run: func(context.Context, plugin.Core) error {
			panic("boom")
		}})
		r.Job(plugin.Job{Name: "stubborn", Run: func(context.Context, plugin.Core) error {
			<-release
			return nil
		}})
		return nil
	}}
	r := plugin.NewRegistry(plugin.NewMemStateStore(), quiet)
	r.StopTimeout = 30 * time.Millisecond
	if err := r.Add(p); err != nil {
		t.Fatal(err)
	}
	if err := r.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	installEnable(t, r, "rough")
	time.Sleep(10 * time.Millisecond)

	start := time.Now()
	if err := r.Disable(context.Background(), "rough"); err != nil {
		t.Fatal(err)
	}
	if el := time.Since(start); el > time.Second {
		t.Fatalf("停用等了 %v，没按 StopTimeout 放手", el)
	}
	if info, _ := r.Get("rough"); info.Running || info.State.Enabled || info.Jobs != 1 {
		t.Fatalf("info = %+v，要已停用、还剩 1 个没退出的任务", info)
	}
}
