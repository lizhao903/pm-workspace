// Package terminal 是「终端」插件的后端（TERM-01a）：本机 pty 加 WebSocket，前端（TERM-01b）用 xterm 接。
// 会话和输出只在服务进程内存里，接口和收发协议见 docs/api-contract.md「终端插件 terminal」。
package terminal

import (
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

//go:embed plugin.json
var manifestJSON []byte

// Plugin 是终端插件的入口，cmd/pmw 用 Registry.Add 登记。
type Plugin struct {
	m         plugin.Manifest
	publicURL string // --public-url，WebSocket 握手时认它的 Origin
	// 测试用：换 shell 和参数、追加环境变量
	shell     string
	shellArgs []string
	env       []string
}

// New 的 publicURL 是浏览器访问工作台的地址（--public-url），空串时只认本机 Origin。
func New(publicURL string) *Plugin {
	return &Plugin{m: plugin.MustParse(manifestJSON), publicURL: publicURL}
}

func (p *Plugin) Manifest() plugin.Manifest { return p.m }

// Migrations：没有自己的表。
func (p *Plugin) Migrations() fs.FS { return nil }

func (p *Plugin) Register(r plugin.Registrar) error {
	m := newManager() // 每次启用一个，只建结构不起进程
	m.shell, m.shellArgs, m.env = p.shell, p.shellArgs, p.env
	h := &handlers{c: r.Core(), m: m, origins: newOriginCheck(p.publicURL)}
	r.Routes(func(rr plugin.RouteRegistrar) {
		rr.HandleFunc("GET /api/terminal/sessions", h.list)
		rr.HandleFunc("POST /api/terminal/sessions", h.create)
		rr.HandleFunc("DELETE /api/terminal/sessions/{id}", h.remove)
		rr.HandleFunc("GET /api/terminal/sessions/{id}/ws", h.ws)
	})
	// 常驻任务只等取消：插件停用、服务关闭时结束这次启用起的全部会话
	r.Job(plugin.Job{Name: "sessions", Run: func(ctx context.Context, _ plugin.Core) error {
		<-ctx.Done()
		m.closeAll()
		return nil
	}})
	return nil
}

type handlers struct {
	c       plugin.Core
	m       *manager
	origins originCheck
}

func (h *handlers) list(w http.ResponseWriter, _ *http.Request) {
	all := h.m.list()
	writeJSON(w, http.StatusOK, map[string]any{"data": all, "meta": map[string]any{"total": len(all)}})
}

type createIn struct {
	Cwd  string `json:"cwd"`
	Cols *int   `json:"cols"`
	Rows *int   `json:"rows"`
}

func (h *handlers) create(w http.ResponseWriter, r *http.Request) {
	var in createIn
	if err := decode(r, &in); err != nil {
		h.fail(w, r, err)
		return
	}
	cwd, err := checkCwd(in.Cwd)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	cols, rows := 80, 24
	if in.Cols != nil {
		cols = *in.Cols
	}
	if in.Rows != nil {
		rows = *in.Rows
	}
	if cols < minSize || cols > maxSize || rows < minSize || rows > maxSize {
		h.fail(w, r, apiErr(errValidation, "cols 和 rows 要在 %d 到 %d 之间", minSize, maxSize))
		return
	}
	s, err := h.m.start(cwd, cols, rows)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"data": s.view()})
}

func (h *handlers) remove(w http.ResponseWriter, r *http.Request) {
	if err := h.m.remove(r.PathValue("id")); err != nil {
		h.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": nil})
}

// checkCwd：空串取用户主目录；否则必须是存在的绝对目录。
func checkCwd(cwd string) (string, error) {
	if strings.TrimSpace(cwd) == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", apiErr(errValidation, "没给 cwd，也取不到用户主目录")
		}
		cwd = home
	}
	if !filepath.IsAbs(cwd) {
		return "", apiErr(errValidation, "cwd 要是绝对路径：%s", cwd)
	}
	cwd = filepath.Clean(cwd)
	if st, err := os.Stat(cwd); err != nil || !st.IsDir() {
		return "", apiErr(errValidation, "目录 %s 不存在或不是文件夹", cwd)
	}
	return cwd, nil
}

func decode(r *http.Request, v any) error {
	body, err := io.ReadAll(io.LimitReader(r.Body, 64<<10+1))
	if err != nil {
		return apiErr(errValidation, "read body: %v", err)
	}
	if len(body) > 64<<10 {
		return apiErr(errValidation, "body too large")
	}
	if len(strings.TrimSpace(string(body))) == 0 {
		return nil // 全用默认值
	}
	if err := json.Unmarshal(body, v); err != nil {
		return apiErr(errValidation, "invalid json: %v", err)
	}
	return nil
}

// fail 按内核的错误信封写回：{"error":{"code","message"}}。
func (h *handlers) fail(w http.ResponseWriter, r *http.Request, err error) {
	status, code, msg := http.StatusInternalServerError, "internal", err.Error()
	switch {
	case errors.Is(err, errNotFound):
		status, code = http.StatusNotFound, "not_found"
	case errors.Is(err, errConflict):
		status, code = http.StatusConflict, "conflict"
	case errors.Is(err, errValidation):
		status, code = http.StatusBadRequest, "validation"
	default:
		h.c.Log().Error("request failed", "method", r.Method, "path", r.URL.Path, "err", err)
		msg = "internal server error"
	}
	if code != "internal" {
		_, msg, _ = strings.Cut(msg, ": ")
	}
	writeJSON(w, status, map[string]any{"error": map[string]string{"code": code, "message": msg}})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
