// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package pluginhost

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func networkTestHost(t *testing.T, perms bool) (*Host, *pluginProcess, *httptest.Server) {
	t.Helper()
	obj := testManifestObj(platformKey(), "bin/hello_world")
	if perms {
		obj["permissions"] = []any{"network:localhost"}
		obj["permissions_reason"] = map[string]any{"network:localhost": "访问本机演示服务"}
	} else {
		obj["permissions"] = []any{}
		obj["permissions_reason"] = map[string]any{}
	}
	dir := t.TempDir()
	writeTestPackage(t, dir, obj)
	h, _ := newFakeHost(t, Options{})
	t.Cleanup(h.Close)
	ctx := context.Background()
	confirm := []string{}
	if perms {
		confirm = []string{"network:localhost"}
	}
	if _, err := h.Install(ctx, Source{Type: "dir", Path: dir}, confirm); err != nil {
		t.Fatal(err)
	}
	if _, err := h.Enable(ctx, "hello_world"); err != nil {
		t.Fatal(err)
	}
	p := h.lookupProc("hello_world")
	if p == nil {
		t.Fatal("进程没起来")
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Server", "fake")
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	t.Cleanup(srv.Close)
	return h, p, srv
}

func TestHostHTTPProxyAllowed(t *testing.T) {
	_, p, srv := networkTestHost(t, true)
	params, _ := json.Marshal(map[string]any{"method": "GET", "url": srv.URL + "/x"})
	res, err := p.handleHostCall(context.Background(), "host.http.request", params)
	if err != nil {
		t.Fatalf("host.http.request: %v", err)
	}
	m := res.(map[string]any)
	if m["status"] != 200 {
		t.Fatalf("status：%v", m["status"])
	}
	body, _ := base64.StdEncoding.DecodeString(m["body_b64"].(string))
	if string(body) != `{"ok":true}` {
		t.Fatalf("body：%s", body)
	}
}

func TestHostHTTPProxyDenied(t *testing.T) {
	_, p, srv := networkTestHost(t, false)
	params, _ := json.Marshal(map[string]any{"method": "GET", "url": srv.URL + "/x"})
	_, err := p.handleHostCall(context.Background(), "host.http.request", params)
	if err == nil {
		t.Fatal("没有 network 权限时应拒绝")
	}
	re, ok := err.(*rpcError)
	if !ok || re.Code != rpcErrorCodes["permission_denied"] {
		t.Fatalf("应为 permission_denied，得到 %#v", err)
	}
}

func TestHostHTTPProxyRedirectWhitelist(t *testing.T) {
	_, p, _ := networkTestHost(t, true)
	bad := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "https://example.com/evil", http.StatusFound)
	}))
	defer bad.Close()
	params, _ := json.Marshal(map[string]any{"method": "GET", "url": bad.URL})
	if _, err := p.handleHostCall(context.Background(), "host.http.request", params); err == nil {
		t.Fatal("重定向到无权限域名应拒绝")
	}
}
