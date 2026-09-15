package api

import (
	"errors"
	"io/fs"
	"net/http"

	"github.com/lizhao903/pm-workspace/internal/fsbrowse"
)

// 目录浏览：让界面能用真正的文件夹选择器，而不是让用户手打路径。
// 业务逻辑与安全边界全在 internal/fsbrowse，这里只做协议转换。

func (s *Server) handleFsBrowse(w http.ResponseWriter, r *http.Request) {
	// path 省略时 fsbrowse 从主目录起步，界面首次打开不用先猜一个路径。
	listing, err := fsbrowse.List(r.URL.Query().Get("path"))
	if err != nil {
		s.failFs(w, r, err)
		return
	}
	respondData(w, http.StatusOK, listing)
}

func (s *Server) handleFsShortcuts(w http.ResponseWriter, r *http.Request) {
	respondData(w, http.StatusOK, fsbrowse.Shortcuts())
}

func (s *Server) handleFsMkdir(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Parent string `json:"parent"`
		Name   string `json:"name"`
	}
	if err := decodeBody(r, &req); err != nil {
		s.fail(w, r, err)
		return
	}
	listing, err := fsbrowse.Mkdir(req.Parent, req.Name)
	if err != nil {
		s.failFs(w, r, err)
		return
	}
	respondData(w, http.StatusOK, listing)
}

// failFs 把 fsbrowse 的错误映射到契约里的错误码。
//
// 越界本该是 403 forbidden，但 respond.go 的错误码表里没有这一档，而那个文件不归
// 这里改（改了会撞上别的改动）。所以降级成 400 validation——fsbrowse 的错误信息
// 本身就写清了「可选范围是哪几块、下一步该怎么办」，用户拿到的说明不受影响，
// 只是状态码不如 403 精确。等 respond.go 加了 forbidden 码，把这里换掉即可。
func (s *Server) failFs(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, fsbrowse.ErrForbidden),
		errors.Is(err, fsbrowse.ErrBadRequest),
		errors.Is(err, fsbrowse.ErrNotDir),
		errors.Is(err, fs.ErrPermission):
		s.fail(w, r, validationf("%s", err.Error()))
	case errors.Is(err, fs.ErrNotExist):
		s.fail(w, r, notFoundf("%s", err.Error()))
	default:
		s.fail(w, r, err)
	}
}
