// Package webui 把 vite 构建产物嵌进二进制，让 pmw 单文件即可分发。
package webui

import (
	"bytes"
	"embed"
	"io/fs"
	"net/http"
	"path"
	"strings"
	"time"
)

// dist 由 web/ 的 vite build 产出（outDir 指向这里）。仓库里只留一个占位 index.html，
// 因为 //go:embed 找不到目录会直接编译失败。
//
//go:embed all:dist
var dist embed.FS

type handler struct {
	files fs.FS
}

// Handler 返回带 SPA history fallback 的静态资源处理器。
func Handler() http.Handler {
	sub, err := fs.Sub(dist, "dist")
	if err != nil {
		// 只可能是 embed 目录缺失，属于构建期错误，早崩早发现。
		panic(err)
	}
	return handlerFor(sub)
}

// handlerFor 抽出来是为了让测试能喂一份假的文件系统，不依赖真实构建产物。
func handlerFor(fsys fs.FS) http.Handler { return &handler{files: fsys} }

func (h *handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Clean 挡掉 ../ 之类的越界写法。
	name := strings.TrimPrefix(path.Clean("/"+strings.TrimPrefix(r.URL.Path, "/")), "/")
	if name == "" || name == "index.html" {
		h.serveIndex(w, r)
		return
	}
	info, err := fs.Stat(h.files, name)
	if err != nil || info.IsDir() {
		// 命中不了真实文件就当成前端路由，交给 index.html 自己 render。
		h.serveIndex(w, r)
		return
	}

	// vite 给 /assets 下的产物带内容 hash，可以永久缓存；其余静态文件保守一点。
	if strings.HasPrefix(name, "assets/") {
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	} else {
		w.Header().Set("Cache-Control", "public, max-age=3600")
	}
	http.ServeFileFS(w, r, h.files, name)
}

// serveIndex 直接把 index.html 的内容写出去，而不是走 ServeFileFS：
// 后者会因为原始 URL 里带 .. 直接回 400，而 SPA 的前端路由本就该一律回落。
func (h *handler) serveIndex(w http.ResponseWriter, r *http.Request) {
	b, err := fs.ReadFile(h.files, "index.html")
	if err != nil {
		http.Error(w, "前端尚未构建，执行 make web", http.StatusNotFound)
		return
	}
	// index.html 引用的资源名每次构建都变，自身必须每次回源校验。
	w.Header().Set("Cache-Control", "no-cache")
	http.ServeContent(w, r, "index.html", time.Time{}, bytes.NewReader(b))
}
