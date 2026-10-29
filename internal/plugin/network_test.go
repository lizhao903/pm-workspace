package plugin_test

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// fakeNet 顶替真实出网：记下发到哪，回 200；地址以 /redirect 结尾时回 302 跳到 evil.example.com。
type fakeNet struct {
	mu   sync.Mutex
	hits []string
}

func (f *fakeNet) RoundTrip(req *http.Request) (*http.Response, error) {
	f.mu.Lock()
	f.hits = append(f.hits, req.URL.Host+req.URL.Path)
	f.mu.Unlock()
	res := &http.Response{StatusCode: http.StatusOK, Header: http.Header{}, Body: io.NopCloser(strings.NewReader("ok")), Request: req}
	if strings.HasSuffix(req.URL.Path, "/redirect") {
		res.StatusCode = http.StatusFound
		res.Header.Set("Location", "https://evil.example.com/steal")
	}
	return res, nil
}

func (f *fakeNet) count() int { f.mu.Lock(); defer f.mu.Unlock(); return len(f.hits) }

func netGet(t *testing.T, c *http.Client, raw string) (*http.Response, error) {
	t.Helper()
	req, err := http.NewRequestWithContext(context.Background(), http.MethodGet, raw, nil)
	if err != nil {
		t.Fatal(err)
	}
	res, err := c.Do(req)
	if err == nil {
		_ = res.Body.Close()
	}
	return res, err
}

// TestHTTPOnlyDeclaredGroups：没声明的组拿不到；声明了没确认的拿不到；清单外的域名（含重定向过去的）不发出去。
func TestHTTPOnlyDeclaredGroups(t *testing.T) {
	r, _, core := upgradeFixture(t, []string{"network:market-data"}, `["network:market-data","network:media-platforms"]`)
	fn := &fakeNet{}
	r.SetHTTPTransport(fn)
	c := core()

	for _, g := range []string{"exchanges", "any", "nope", ""} {
		if _, err := c.HTTP(g); !errors.Is(err, plugin.ErrNetworkNotDeclared) {
			t.Fatalf("没声明 %q 应拿不到：%v", g, err)
		}
	}
	if _, err := c.HTTP("media-platforms"); !errors.Is(err, plugin.ErrNotGranted) {
		t.Fatalf("声明了没确认应拿不到：%v", err)
	}

	hc, err := c.HTTP("market-data")
	if err != nil {
		t.Fatal(err)
	}
	for _, u := range []string{"https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT", "https://www.okx.com/api/v5/market/ticker?instId=BTC-USDT",
		"https://api.binance.com/api/v3/ticker/price"} {
		if res, err := netGet(t, hc, u); err != nil || res.StatusCode != http.StatusOK {
			t.Fatalf("%s 应放行：%v", u, err)
		}
	}
	before := fn.count()
	for _, u := range []string{"https://evil.example.com/x?token=abc", "https://api.binance.com/api/v3/order", "https://www.okx.com/api/v5/trade/order",
		"https://binance.vision.evil.com/", "ftp://data-api.binance.vision/"} {
		_, err := netGet(t, hc, u)
		if !errors.Is(err, plugin.ErrHostNotAllowed) {
			t.Fatalf("%s 应拒绝：%v", u, err)
		}
		// 外面的 *url.Error 是标准库包的，带完整地址；内核自己的说明里不带查询串
		var he *plugin.HostNotAllowedError
		if !errors.As(err, &he) || strings.Contains(he.Error(), "token=abc") {
			t.Fatalf("说明里不该带查询串：%v", err)
		}
	}
	if fn.count() != before {
		t.Fatalf("被拒的请求不该发出去：%v", fn.hits)
	}
	// 重定向到清单外：第一跳发了，第二跳拦下
	if _, err := netGet(t, hc, "https://data-api.binance.vision/redirect"); !errors.Is(err, plugin.ErrHostNotAllowed) ||
		!strings.Contains(err.Error(), "插件 demo 的 network:market-data 不允许访问 https://evil.example.com/steal") {
		t.Fatalf("重定向到清单外应拒绝：%v", err)
	}
	if fn.count() != before+1 {
		t.Fatalf("只该发出第一跳：%v", fn.hits)
	}
}

// TestHTTPLocalhost：network:localhost 走默认底层连本机假服务；清单外照样拦。
func TestHTTPLocalhost(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = io.WriteString(w, "hi") }))
	defer srv.Close()
	_, _, core := upgradeFixture(t, []string{"network:localhost"}, `["network:localhost"]`)
	hc, err := core().HTTP("localhost")
	if err != nil {
		t.Fatal(err)
	}
	if res, err := netGet(t, hc, srv.URL+"/a"); err != nil || res.StatusCode != http.StatusOK {
		t.Fatalf("本机地址应放行：%v", err)
	}
	if _, err := netGet(t, hc, "https://bilibili.com/"); !errors.Is(err, plugin.ErrHostNotAllowed) {
		t.Fatalf("localhost 组不能出网：%v", err)
	}
}

func TestNetworkAllows(t *testing.T) {
	cases := []struct {
		group, raw string
		want       bool
	}{
		{"media-platforms", "https://member.bilibili.com/x/vu/web/add", true},
		{"media-platforms", "https://BILIBILI.COM./", true},
		{"media-platforms", "https://notbilibili.com/", false},
		{"media-platforms", "https://www.googleapis.com/upload/youtube/v3/videos", true},
		{"media-platforms", "https://www.googleapis.com/drive/v3/files", false},
		{"media-platforms", "https://open.douyin.com/oauth/access_token/", true},
		{"market-data", "https://api.binance.com/api/v3/order", false},
		{"exchanges", "https://api.binance.com/api/v3/order", true},
		{"exchanges", "https://data-api.binance.vision/api/v3/klines", false},
		{"localhost", "http://127.0.0.2:8080/", true},
		{"localhost", "http://[::1]:9/", true},
		{"localhost", "http://app.localhost/", true},
		{"localhost", "http://10.0.0.1/", false},
		{"im", "https://hooks.slack.com/services/x", true},
		{"any", "https://example.org/", true},
		{"any", "file:///etc/passwd", false},
		{"nope", "https://example.org/", false},
	}
	for _, tc := range cases {
		u, err := url.Parse(tc.raw)
		if err != nil {
			t.Fatal(err)
		}
		if got := plugin.NetworkAllows(tc.group, u); got != tc.want {
			t.Errorf("NetworkAllows(%s, %s) = %v，期望 %v", tc.group, tc.raw, got, tc.want)
		}
	}
}
