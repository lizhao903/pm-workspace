package api

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/lizhao903/pm-workspace/internal/plugin"
	"github.com/lizhao903/pm-workspace/internal/plugin/plugintest"
	"github.com/lizhao903/pm-workspace/internal/plugins/jobs"
)

func newPluginServer(t *testing.T) (*Server, *plugin.Registry, *plugintest.Demo) {
	t.Helper()
	d := plugintest.NewDemo(2 * time.Millisecond)
	reg := plugin.NewRegistry(plugin.NewMemStateStore(), slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err := reg.Add(d); err != nil {
		t.Fatal(err)
	}
	if err := reg.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(reg.Close)
	s := newTestServer(newFakeStore(), func(o *Options) { o.Plugins = reg })
	return s, reg, d
}

// TestPluginRoutesFollowEnabledState：插件路由经过接口层的完整中间件链，
// 未安装、停用时回和不存在的接口一样的 JSON 404，启用、重新启用后恢复；内核接口不受影响。
func TestPluginRoutesFollowEnabledState(t *testing.T) {
	s, reg, d := newPluginServer(t)
	ctx := context.Background()

	e := assertError(t, do(s, http.MethodGet, "/api/demo/ping", ""), http.StatusNotFound, "not_found")
	if e["message"] != "no such endpoint: GET /api/demo/ping" {
		t.Fatalf("未安装时的 404 和不存在的接口不一样：%v", e["message"])
	}

	if err := reg.Install(ctx, "demo", []string{"network:localhost"}); err != nil {
		t.Fatal(err)
	}
	if err := reg.Enable(ctx, "demo"); err != nil {
		t.Fatal(err)
	}
	if w := do(s, http.MethodGet, "/api/demo/ping", ""); w.Code != http.StatusOK {
		t.Fatalf("启用后 ping = %d：%s", w.Code, w.Body.String())
	}
	if w := do(s, http.MethodGet, "/api/demo/items/a1", ""); w.Code != http.StatusOK {
		t.Fatalf("启用后带参数的路由 = %d", w.Code)
	}
	// 路由只挂了 GET，别的方法落到 /api/ 兜底的 404，和内核接口一致
	assertError(t, do(s, http.MethodPost, "/api/demo/ping", "{}"), http.StatusNotFound, "not_found")
	assertError(t, do(s, http.MethodGet, "/api/demo/nope", ""), http.StatusNotFound, "not_found")

	if err := reg.Disable(ctx, "demo"); err != nil {
		t.Fatal(err)
	}
	e = assertError(t, do(s, http.MethodGet, "/api/demo/ping", ""), http.StatusNotFound, "not_found")
	if e["message"] != "no such endpoint: GET /api/demo/ping" {
		t.Fatalf("停用后的 404 和不存在的接口不一样：%v", e["message"])
	}
	assertError(t, do(s, http.MethodGet, "/api/demo/items/a1", ""), http.StatusNotFound, "not_found")
	if n := d.Resident.Load(); n != 0 {
		t.Fatalf("停用后常驻任务还有 %d 个", n)
	}
	if w := do(s, http.MethodGet, "/api/health", ""); w.Code != http.StatusOK {
		t.Fatalf("内核接口受了影响：health = %d", w.Code)
	}

	if err := reg.Enable(ctx, "demo"); err != nil {
		t.Fatal(err)
	}
	if w := do(s, http.MethodGet, "/api/demo/ping", ""); w.Code != http.StatusOK {
		t.Fatalf("重新启用后 ping = %d", w.Code)
	}
	if d.Starts.Load() != 2 {
		// Enable 返回前协程已经起了，但 Run 里的计数可能还差一拍
		deadline := time.Now().Add(2 * time.Second)
		for d.Starts.Load() != 2 && time.Now().Before(deadline) {
			time.Sleep(2 * time.Millisecond)
		}
		if d.Starts.Load() != 2 {
			t.Fatalf("重新启用后常驻任务起了 %d 次，要 2", d.Starts.Load())
		}
	}
}

// TestNoPluginsNoRoutes：不接注册表时 routes() 和原来一样，契约测试照常比对。
func TestNoPluginsNoRoutes(t *testing.T) {
	rec := &recordingMux{}
	(&Server{}).routes(rec)
	withReg := &recordingMux{}
	reg := plugin.NewRegistry(plugin.NewMemStateStore(), nil)
	if err := reg.Add(plugintest.NewDemo(time.Hour)); err != nil {
		t.Fatal(err)
	}
	(&Server{opt: Options{Plugins: reg}}).routes(withReg)
	if got, want := len(withReg.patterns)-len(rec.patterns), 2; got != want {
		t.Fatalf("接上示例插件后多了 %d 条路由，要 %d", got, want)
	}
}

// TestMigrationsIncludePlugins：/api/admin/migrations 内核记录在前、插件已应用的在后；
// ?plugin=<id> 只给这个插件的，含待应用的；不存在的插件 404。
func TestMigrationsIncludePlugins(t *testing.T) {
	s, reg, _ := newPluginServer(t)
	ctx := context.Background()

	rows := func(target string) []map[string]any {
		t.Helper()
		w := do(s, http.MethodGet, target, "")
		if w.Code != http.StatusOK {
			t.Fatalf("%s = %d：%s", target, w.Code, w.Body.String())
		}
		var out []map[string]any
		for _, it := range decodeEnvelope(t, w)["data"].([]any) {
			out = append(out, it.(map[string]any))
		}
		return out
	}

	pend := rows("/api/admin/migrations?plugin=demo")
	if len(pend) != 2 || pend[0]["pending"] != true || pend[0]["applied_at"] != nil || pend[0]["plugin"] != "demo" {
		t.Fatalf("安装前应是两条待应用：%v", pend)
	}
	if got := rows("/api/admin/migrations"); len(got) != 1 || got[0]["plugin"] != nil {
		t.Fatalf("安装前只该有内核记录：%v", got)
	}

	if err := reg.Install(ctx, "demo", []string{"network:localhost"}); err != nil {
		t.Fatal(err)
	}
	all := rows("/api/admin/migrations")
	if len(all) != 3 || all[0]["version"] != "0001_init.sql" {
		t.Fatalf("安装后应是 1 条内核加 2 条插件：%v", all)
	}
	for _, r := range all[1:] {
		if r["plugin"] != "demo" || r["plugin_version"] != "0.1.0" || r["pending"] != nil ||
			r["applied_at"] == nil || len(r["checksum"].(string)) != checksumPrefix {
			t.Fatalf("插件行不对：%v", r)
		}
	}
	if all[1]["version"] != "0001_items.sql" || all[2]["version"] != "0002_item_note.sql" {
		t.Fatalf("插件迁移的顺序不对：%v", all[1:])
	}
	assertError(t, do(s, http.MethodGet, "/api/admin/migrations?plugin=nope", ""), http.StatusNotFound, "not_found")
}

func TestPluginJobsEndpoint(t *testing.T) {
	reg := plugin.NewRegistry(plugin.NewMemStateStore(), slog.New(slog.DiscardHandler))
	if err := reg.Add(jobs.New(func() []plugin.JobStats {
		return []plugin.JobStats{{PluginID: "demo", Name: "tick", Success: 2, Total: 2}}
	})); err != nil {
		t.Fatal(err)
	}
	if err := reg.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(reg.Close)
	s := newTestServer(newFakeStore(), func(o *Options) { o.Plugins = reg })
	assertError(t, do(s, "GET", "/api/jobs/stats", ""), 404, "not_found")
	if err := reg.Install(context.Background(), "jobs", nil); err != nil {
		t.Fatal(err)
	}
	if err := reg.Enable(context.Background(), "jobs"); err != nil {
		t.Fatal(err)
	}
	w := do(s, "GET", "/api/jobs/stats", "")
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"plugin_id":"demo"`) {
		t.Fatalf("bad stats: %d %s", w.Code, w.Body.String())
	}
	if err := reg.Disable(context.Background(), "jobs"); err != nil {
		t.Fatal(err)
	}
	assertError(t, do(s, "GET", "/api/jobs/stats", ""), 404, "not_found")
}
