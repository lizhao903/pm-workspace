package connector

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/lizhao903/pm-workspace/internal/domain"
)

// 1x1 的 PNG
var tinyPNG = []byte("\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15\xc4\x89\x00\x00\x00\rIDATx\x9cc\xf8\x0f\x00\x00\x01\x01\x00\x05\x18\xd8N\x00\x00\x00\x00IEND\xaeB`\x82")

// TSK-0725：内置连接器都有平台图标的键，插件的按 tool 补，自己给了的不覆盖，不合规的登记失败。
func TestBuiltinLogos(t *testing.T) {
	for tool, logo := range builtinLogos {
		if !logoRe.MatchString(logo) {
			t.Errorf("%s 的图标键 %q 不合规", tool, logo)
		}
	}
	for _, d := range []Def{CustomMCP(), CustomOpenAPI(), Slack(SlackEndpoints{}), GoogleDrive(GoogleEndpoints{}), GoogleCalendar(GoogleCalendarEndpoints{})} {
		p, err := Prepare(d)
		if err != nil {
			t.Fatal(err)
		}
		if p.Logo == "" || p.Logo != builtinLogos[d.Tool] {
			t.Errorf("%s 的 logo = %q", d.Tool, p.Logo)
		}
	}
	// 插件登记的（这里拿假连接器改个 tool 模拟）按 tool 补；自己给了的保留
	d := Fake()
	d.Tool = "telegram"
	if p, _ := Prepare(d); p.Logo != "telegram" {
		t.Errorf("插件连接器 logo = %q", p.Logo)
	}
	d.Logo = "custom1"
	if p, _ := Prepare(d); p.Logo != "custom1" {
		t.Errorf("自己给的 logo 被覆盖成 %q", p.Logo)
	}
	d.Logo = "Bad-Key"
	if _, err := Prepare(d); err == nil {
		t.Error("不合规的 logo 应该登记失败")
	}
}

func TestSiteBase(t *testing.T) {
	for host, want := range map[string]string{
		"mcp.notion.com": "notion.com", "notion.com": "notion.com", "a.b.example.co": "b.example.co",
		"127.0.0.1": "127.0.0.1", "localhost": "localhost",
	} {
		if got := siteBase(host); got != want {
			t.Errorf("siteBase(%s) = %s, want %s", host, got, want)
		}
	}
}

// 从网站取图标：首页的 apple-touch-icon 优先，别的站点的图标地址跳过，没有时退回 /favicon.ico；
// 不是图片、太大、跳到别的网站都算没取到。
func TestFetchIcon(t *testing.T) {
	ctx := context.Background()
	other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "image/png")
		_, _ = w.Write(tinyPNG)
	}))
	defer other.Close()

	var hits []string
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		hits = append(hits, r.URL.Path)
		if r.Header.Get("Authorization") != "" {
			t.Errorf("取图标不该带凭证：%s", r.Header.Get("Authorization"))
		}
		switch r.URL.Path {
		case "/":
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			_, _ = w.Write([]byte(`<html><head>
<link rel="icon" href="/small.png" sizes="16x16">
<link rel='apple-touch-icon' href='/touch.png' sizes="180x180">
<link rel="icon" href="` + other.URL + `/cdn.png" sizes="512x512">
</head></html>`))
		case "/touch.png":
			// 没声明类型，按内容判断
			w.Header().Set("Content-Type", "application/octet-stream")
			_, _ = w.Write(tinyPNG)
		default:
			http.NotFound(w, r)
		}
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	s := newCustomStore(t)
	c, err := s.Create(ctx, Input{Tool: CustomMCPTool, AuthMode: AuthToken, Config: map[string]string{"url": srv.URL + "/mcp"},
		Secrets: map[string]string{"token": "tok-0123456789"}})
	if err != nil {
		t.Fatal(err)
	}
	res, err := s.FetchIcon(ctx, c.ID)
	if err != nil {
		t.Fatal(err)
	}
	if res.Source != srv.URL+"/touch.png" || !strings.HasPrefix(res.Connector.Icon, "data:image/png;base64,") {
		t.Fatalf("取到 %s，icon = %.40s", res.Source, res.Connector.Icon)
	}
	if got, _ := s.Get(ctx, c.ID); got.Icon != res.Connector.Icon {
		t.Fatal("图标没存进实例")
	}
	for _, h := range hits {
		if h == "/cdn.png" {
			t.Fatal("别的站点的图标地址不该去取")
		}
	}

	// 首页没写图标：退回 /favicon.ico；首页不是网页也一样
	mux2 := http.NewServeMux()
	mux2.HandleFunc("/favicon.ico", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "image/x-icon")
		_, _ = w.Write([]byte("\x00\x00\x01\x00fake-ico"))
	})
	srv2 := httptest.NewServer(mux2)
	defer srv2.Close()
	c2, err := s.Create(ctx, Input{Tool: CustomOpenAPITool, Config: map[string]string{"spec_url": srv2.URL + "/openapi.json"}})
	if err != nil {
		t.Fatal(err)
	}
	res2, err := s.FetchIcon(ctx, c2.ID)
	if err != nil || res2.Source != srv2.URL+"/favicon.ico" || !strings.HasPrefix(res2.Connector.Icon, "data:image/x-icon;base64,") {
		t.Fatalf("favicon = %+v %v", res2, err)
	}

	// 取不到：不是图片、太大、跳到别的网站 -> 409，图标不动
	bad := http.NewServeMux()
	bad.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/":
			w.Header().Set("Content-Type", "text/html")
			_, _ = w.Write([]byte(`<link rel="icon" href="/big.png"><link rel="icon" href="/away.png" sizes="32x32">`))
		case "/big.png":
			w.Header().Set("Content-Type", "image/png")
			_, _ = w.Write(make([]byte, maxIconBytes+10))
		case "/away.png":
			http.Redirect(w, r, other.URL+"/x.png", http.StatusFound)
		case "/favicon.ico":
			w.Header().Set("Content-Type", "text/plain")
			_, _ = w.Write([]byte("not an image"))
		}
	})
	srv3 := httptest.NewServer(bad)
	defer srv3.Close()
	c3, err := s.Create(ctx, Input{Tool: CustomMCPTool, Config: map[string]string{"url": srv3.URL + "/mcp"}})
	if err != nil {
		t.Fatal(err)
	}
	_, err = s.FetchIcon(ctx, c3.ID)
	if !errors.Is(err, domain.ErrConflict) || !strings.Contains(err.Error(), "没取到图标") {
		t.Fatalf("取不到应 409，得到 %v", err)
	}
	if got, _ := s.Get(ctx, c3.ID); got.Icon != "" {
		t.Fatal("取不到时图标不该动")
	}

	// 不是自定义分类、没保存地址：400
	f, err := s.Create(ctx, Input{Tool: FakeTool, Secrets: map[string]string{"token": "fake-token-123"}})
	if err == nil {
		if _, err := s.FetchIcon(ctx, f.ID); !errors.Is(err, domain.ErrValidation) {
			t.Fatalf("内置连接器应 400，得到 %v", err)
		}
	}
	c4, err := s.Create(ctx, Input{Tool: CustomOpenAPITool, Config: map[string]string{"spec_text": `{"openapi":"3.0.0","info":{"title":"x","version":"1"},"paths":{}}`}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.FetchIcon(ctx, c4.ID); !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("没地址应 400，得到 %v", err)
	}
}

// 跳转只能在同一个站点里
func TestSiteIconRedirect(t *testing.T) {
	ctx := context.Background()
	other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "image/png")
		_, _ = w.Write(tinyPNG)
	}))
	defer other.Close()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, other.URL+r.URL.Path, http.StatusFound)
	}))
	defer srv.Close()
	_, _, err := siteIcon(ctx, &http.Client{}, srv.URL+"/mcp")
	if err == nil || !strings.Contains(err.Error(), "别的网站") {
		t.Fatalf("跳到别的网站应失败，得到 %v", err)
	}
}
