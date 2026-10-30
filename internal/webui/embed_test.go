package webui

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
)

func testFS() fstest.MapFS {
	return fstest.MapFS{
		"index.html":           {Data: []byte("<!doctype html><title>app</title>")},
		"assets/app-abc123.js": {Data: []byte("console.log(1)")},
		"favicon.svg":          {Data: []byte("<svg/>")},
	}
}

func get(h http.Handler, path string) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest(http.MethodGet, path, nil))
	return w
}

func TestServesStaticAssetWithImmutableCache(t *testing.T) {
	w := get(handlerFor(testFS()), "/assets/app-abc123.js")
	if w.Code != http.StatusOK {
		t.Fatalf("状态码 = %d", w.Code)
	}
	if got := w.Header().Get("Cache-Control"); got != "public, max-age=31536000, immutable" {
		t.Fatalf("Cache-Control = %q", got)
	}
	if !strings.Contains(w.Body.String(), "console.log") {
		t.Fatalf("body = %q", w.Body.String())
	}
}

func TestIndexIsNoCache(t *testing.T) {
	for _, p := range []string{"/", "/index.html"} {
		w := get(handlerFor(testFS()), p)
		if got := w.Header().Get("Cache-Control"); got != "no-cache" {
			t.Fatalf("%s Cache-Control = %q", p, got)
		}
	}
}

// 未命中真实文件的路径当作前端路由，回落 index.html 由 SPA 自己渲染。
func TestHistoryFallback(t *testing.T) {
	for _, p := range []string{"/inbox", "/objects/obj_1/detail", "/%E4%B8%AD%E6%96%87"} {
		w := get(handlerFor(testFS()), p)
		if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), "<title>app</title>") {
			t.Fatalf("%s -> %d %q", p, w.Code, w.Body.String())
		}
	}
}

// 越界路径不能读到 dist 之外的东西。
func TestPathTraversal(t *testing.T) {
	w := get(handlerFor(testFS()), "/../../etc/passwd")
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), "<title>app</title>") {
		t.Fatalf("越界路径应回落 index.html, 得到 %d %q", w.Code, w.Body.String())
	}
}

func TestMethodNotAllowed(t *testing.T) {
	w := httptest.NewRecorder()
	handlerFor(testFS()).ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/", nil))
	if w.Code != http.StatusMethodNotAllowed {
		t.Fatalf("状态码 = %d", w.Code)
	}
}

// 旧版页面要的旧产物找不到时回 404，不回 index.html。
func TestMissingAssetIs404(t *testing.T) {
	w := get(handlerFor(testFS()), "/assets/Page-old999.js")
	if w.Code != http.StatusNotFound || strings.Contains(w.Body.String(), "<title>app</title>") || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("-> %d %q %q", w.Code, w.Header().Get("Cache-Control"), w.Body.String())
	}
}
