// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package pluginhost

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestFetchMarketIndex(t *testing.T) {
	index := map[string]any{
		"index_version": 1,
		"title":         "测试索引",
		"plugins": []any{
			map[string]any{
				"id":         "hello_world",
				"title":      map[string]string{"zh": "示例", "en": "Hello"},
				"author":     "example",
				"repository": "https://github.com/example/hello",
				"versions": []any{
					map[string]any{
						"version": "0.1.0", "api": ">=2.0.0 <3.0.0", "pmw": ">=0.3.0 <1.0.0",
						"source": map[string]any{
							"type": "github-release", "repository": "example/hello", "tag": "v0.1.0",
							"assets": map[string]any{
								platformKey(): map[string]any{
									"url":    "https://github.com/example/hello/releases/download/v0.1.0/hello-0.1.0.tar.gz",
									"sha256": strings.Repeat("a", 64),
								},
							},
						},
					},
				},
			},
		},
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, ".sig") {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(index)
	}))
	defer srv.Close()

	h := newTestHost(t, Options{Version: "0.3.0"})
	view, err := h.FetchMarketIndex(context.Background(), srv.URL+"/index.json")
	if err != nil {
		t.Fatalf("FetchMarketIndex: %v", err)
	}
	if view.Title != "测试索引" || len(view.Entries) != 1 {
		t.Fatalf("视图不对：%+v", view)
	}
	e := view.Entries[0]
	if e.ID != "hello_world" || e.Title != "示例" || len(e.Versions) != 1 {
		t.Fatalf("条目不对：%+v", e)
	}
	v := e.Versions[0]
	if !v.Compatible || v.Install.SHA256 != strings.Repeat("a", 64) || !strings.Contains(v.Install.URL, "releases/download") {
		t.Fatalf("版本/安装来源不对：%+v", v)
	}

	// 非 http(s) 与跨主机重定向拒绝。
	if _, err := h.FetchMarketIndex(context.Background(), "file:///etc/passwd"); err == nil {
		t.Fatal("file:// 索引应被拒绝")
	}
	redir := httptest.NewServer(http.RedirectHandler("https://example.com/x", http.StatusFound))
	defer redir.Close()
	if _, err := h.FetchMarketIndex(context.Background(), redir.URL); err == nil {
		t.Fatal("跨主机重定向应被拒绝")
	}
}

func TestMirrorDownloadURL(t *testing.T) {
	u := "https://github.com/o/r/releases/download/v1/x.tar.gz"
	if got := mirrorDownloadURL("", u); got != u {
		t.Fatalf("空镜像应原样：%q", got)
	}
	if got := mirrorDownloadURL("https://ghproxy.example/", u); got != "https://ghproxy.example/"+u {
		t.Fatalf("前缀镜像不对：%q", got)
	}
	if got := mirrorDownloadURL("https://m.example/?url={url}", u); got != "https://m.example/?url="+u {
		t.Fatalf("占位符镜像不对：%q", got)
	}
}

func TestMarketIndexSignatureAndTOFU(t *testing.T) {
	pub, priv, pubB64 := testPublisherKey(t)
	_ = pub
	index := []byte(`{"index_version":1,"title":"签名索引","plugins":[]}`)
	sig := base64.StdEncoding.EncodeToString(ed25519.Sign(priv, index))
	sigFile, _ := json.Marshal(map[string]string{"key": pubB64, "sig": sig, "publisher": "github:maintainer"})
	var signed = true
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, ".sig") {
			if !signed {
				http.NotFound(w, r)
				return
			}
			_, _ = w.Write(sigFile)
			return
		}
		_, _ = w.Write(index)
	}))
	defer srv.Close()
	h := newTestHost(t, Options{Version: "0.3.0"})
	view, err := h.FetchMarketIndex(context.Background(), srv.URL+"/index.json")
	if err != nil {
		t.Fatalf("签名索引应通过：%v", err)
	}
	if !view.Signed || view.Publisher != "github:maintainer" {
		t.Fatalf("签名信息不对：%+v", view)
	}
	// TOFU：签名过之后再变回无签名 → 拒绝降级。
	signed = false
	if _, err := h.FetchMarketIndex(context.Background(), srv.URL+"/index.json"); !errors.Is(err, ErrValidation) {
		t.Fatalf("签名索引降级为无签名应拒绝，得到 %v", err)
	}
	// 换 key 签名 → conflict。
	_, priv2, pub2 := testPublisherKey(t)
	sig2 := base64.StdEncoding.EncodeToString(ed25519.Sign(priv2, index))
	sigFile2, _ := json.Marshal(map[string]string{"key": pub2, "sig": sig2})
	signed = true
	sigFile = sigFile2
	if _, err := h.FetchMarketIndex(context.Background(), srv.URL+"/index.json"); !errors.Is(err, ErrConflict) {
		t.Fatalf("换索引公钥应 ErrConflict，得到 %v", err)
	}
}
