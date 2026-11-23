// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package pluginhost

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func TestProxyHTTP(t *testing.T) {
	dir, _ := newTestPackageDir(t)
	h, _ := newFakeHost(t, Options{})
	t.Cleanup(h.Close)
	ctx := context.Background()
	installTestPlugin(t, h, dir)
	if _, err := h.Enable(ctx, "hello_world"); err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodPost, "/api/plugins/external/hello_world/api/echo", strings.NewReader("hi"))
	req.Header.Set("Content-Type", "text/plain")
	rec := httptest.NewRecorder()
	if err := h.ProxyHTTP(ctx, "hello_world", req, rec); err != nil {
		t.Fatalf("ProxyHTTP: %v", err)
	}
	if rec.Code != http.StatusCreated {
		t.Fatalf("状态：%d", rec.Code)
	}
	if body := rec.Body.String(); body != `{"ok":true}` {
		t.Fatalf("body：%q", body)
	}
	if rec.Header().Get("X-Plugin") != "fake" {
		t.Fatalf("插件响应头没透传：%v", rec.Header())
	}
}

func TestProxyHTTPStream(t *testing.T) {
	dir, _ := newTestPackageDir(t)
	h, _ := newFakeHost(t, Options{})
	t.Cleanup(h.Close)
	ctx := context.Background()
	installTestPlugin(t, h, dir)
	if _, err := h.Enable(ctx, "hello_world"); err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodGet, "/api/plugins/external/hello_world/api/stream", nil)
	rec := httptest.NewRecorder()
	if err := h.ProxyHTTP(ctx, "hello_world", req, rec); err != nil {
		t.Fatalf("ProxyHTTP stream: %v", err)
	}
	body := rec.Body.String()
	if !strings.Contains(body, "data: one") || !strings.Contains(body, "data: two") {
		t.Fatalf("流式响应不完整：%q", body)
	}
	if ct := rec.Header().Get("Content-Type"); !strings.Contains(ct, "text/event-stream") {
		t.Fatalf("Content-Type：%q", ct)
	}
}

func TestProxyWebSocket(t *testing.T) {
	dir, _ := newTestPackageDir(t)
	h, _ := newFakeHost(t, Options{})
	t.Cleanup(h.Close)
	ctx := context.Background()
	installTestPlugin(t, h, dir)
	if _, err := h.Enable(ctx, "hello_world"); err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = h.ProxyWebSocket(r.Context(), "hello_world", w, r)
	}))
	defer srv.Close()
	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http") + "/api/plugins/external/hello_world/api/ws"
	dialCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(dialCtx, wsURL, nil)
	if err != nil {
		t.Fatalf("WS dial: %v", err)
	}
	defer conn.Close(websocket.StatusNormalClosure, "")
	if err := conn.Write(dialCtx, websocket.MessageText, []byte("ping")); err != nil {
		t.Fatalf("WS write: %v", err)
	}
	readCtx, cancelRead := context.WithTimeout(ctx, 5*time.Second)
	defer cancelRead()
	_, data, err := conn.Read(readCtx)
	if err != nil {
		t.Fatalf("WS read: %v", err)
	}
	if string(data) != "ping" {
		t.Fatalf("WS echo 不对：%q", string(data))
	}
	_, _ = io.ReadAll(io.LimitReader(strings.NewReader(""), 0))
}

// 插件收到的 path 是 /api/plugins/external/<id>/api 之后的部分（spec 7.4）；以前误给成 /plugins/external/<id>/api/...
func TestPluginAPIPath(t *testing.T) {
	cases := map[string]string{
		"/api/plugins/external/hello_world/api/echo":     "/echo",
		"/api/plugins/external/hello_world/api/runs/123": "/runs/123",
		"/api/plugins/external/hello_world/api/api/runs": "/api/runs",
		"/api/plugins/external/hello_world/api/":         "/",
		"/api/plugins/external/hello_world/api":          "/",
		"/api/plugins/external/other/api/echo":           "/api/plugins/external/other/api/echo",
	}
	for in, want := range cases {
		if got := pluginAPIPath(in, "hello_world"); got != want {
			t.Errorf("pluginAPIPath(%q) = %q，应为 %q", in, got, want)
		}
	}
}
