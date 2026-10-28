package api

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"testing"
	"time"

	"github.com/lizhao903/pm-workspace/internal/plugin"
	"github.com/lizhao903/pm-workspace/internal/plugin/plugintest"
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
