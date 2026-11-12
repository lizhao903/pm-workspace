// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package plugin_test

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

func hostPlugin(t *testing.T, id, perms string, suffix *string, matched *[]string) *fakePlugin {
	t.Helper()
	m := manifest(t, id, "")
	m.Permissions = strings.Fields(perms)
	return &fakePlugin{m: m, reg: func(r plugin.Registrar) error {
		r.HostHandler(plugin.HostHandlerDef{
			Suffix: func() string { return *suffix },
			Match: func(h string) bool {
				*matched = append(*matched, h)
				return strings.HasPrefix(h, "proto")
			},
			Handler: http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = io.WriteString(w, id) }),
		})
		return nil
	}}
}

func hostGet(t *testing.T, h http.Handler, host string) string {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/api/x", nil)
	req.Host = host
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec.Body.String()
}

// TestHostDispatch：后缀下、插件认的主机交给插件；IP、localhost、--public-url 的主机、后缀本身、插件不认的照常进工作台；
// 插件停用、后缀为空时不交。
func TestHostDispatch(t *testing.T) {
	suffix := "Bro.vip"
	var matched []string
	p := hostPlugin(t, "domains", "network:localhost", &suffix, &matched)
	r := newRegistry(t, plugin.NewMemStateStore(), p)
	installEnable(t, r, "domains")
	app := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = io.WriteString(w, "app") })
	h := r.HostDispatch(app, "https://Proto.bro.vip:443")

	for host, want := range map[string]string{
		"proto-a.bro.vip":       "domains",
		"PROTO-A.BRO.VIP:8080":  "domains",
		"proto-a.bro.vip.":      "domains",
		"proto.bro.vip":         "app", // --public-url 的主机
		"bro.vip":               "app", // 后缀本身
		"other.bro.vip":         "app", // 插件不认
		"proto-a.example.com":   "app", // 不在后缀下
		"proto-a.xbro.vip":      "app",
		"127.0.0.1:7777":        "app",
		"[::1]:7777":            "app",
		"localhost:7777":        "app",
		"proto.localhost":       "app",
		"":                      "app",
		"proto-b.a.bro.vip":     "domains", // 多级子域名由插件自己决定
		"192.168.1.23":          "app",
		"proto-a.bro.vip:12345": "domains",
	} {
		if got := hostGet(t, h, host); got != want {
			t.Errorf("Host %q 交给了 %s，应该是 %s", host, got, want)
		}
	}
	for _, m := range matched {
		if m == "bro.vip" || m == "proto.bro.vip" || strings.Contains(m, ":") {
			t.Fatalf("不该问插件：%q", m)
		}
	}

	suffix = ""
	if got := hostGet(t, h, "proto-a.bro.vip"); got != "app" {
		t.Fatalf("后缀为空时还交给了插件：%s", got)
	}
	suffix = "bro.vip"
	if err := r.Disable(context.Background(), "domains"); err != nil {
		t.Fatal(err)
	}
	if got := hostGet(t, h, "proto-a.bro.vip"); got != "app" {
		t.Fatalf("停用后还交给了插件：%s", got)
	}
}

// TestHostHandlerNeedsPermission：清单没声明 network:localhost 的插件登记不了 Host 处理器；只能登记一个。
func TestHostHandlerNeedsPermission(t *testing.T) {
	suffix := "bro.vip"
	var matched []string
	r := plugin.NewRegistry(plugin.NewMemStateStore(), quiet)
	if err := r.Add(hostPlugin(t, "nope", "", &suffix, &matched)); err == nil || !strings.Contains(err.Error(), "network:localhost") {
		t.Fatalf("没声明权限也登记上了：%v", err)
	}
	m := manifest(t, "twice", "")
	m.Permissions = []string{"network:localhost"}
	def := plugin.HostHandlerDef{Suffix: func() string { return "" }, Match: func(string) bool { return false }, Handler: http.NotFoundHandler()}
	twice := &fakePlugin{m: m, reg: func(r plugin.Registrar) error {
		r.HostHandler(def)
		r.HostHandler(def)
		return nil
	}}
	if err := r.Add(twice); err == nil || !strings.Contains(err.Error(), "只能登记一个") {
		t.Fatalf("登记了两个：%v", err)
	}
}
