// Package domains 是「内网域名」插件的后端（DOM-01a）：接现有 bro.vip 方案（docs/local-domain.md），
// 只读检测 hosts、pf 转发、本地证书的状态（status.go），生成 hosts 片段、pf anchor、Caddy、Nginx 配置和
// 要用户自己执行的 sudo 命令（config.go）。插件不写任何系统文件、不执行 sudo。
// 设置和路由落在插件表（settings.go、routes.go），形状同原型 web-next/src/domaindata.ts。
// 接口契约见 docs/api-contract.md「内网域名插件 domains」。
package domains

import (
	"context"
	"crypto/rand"
	"embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
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

//go:embed migrations/*.sql
var migrationsFS embed.FS

// Options 是 cmd/pmw 传进来的服务参数，用来判断端口转发对不对、证书在哪。
type Options struct {
	Addr    string // --addr，明文监听地址
	TLSAddr string // --tls-addr
	TLSCert string // --tls-cert，给了就以它所在目录为 certs/
	RepoDir string // 仓库根目录，生成的命令先 cd 过去跑 scripts/；空串取当前目录
}

// Plugin 是内网域名插件的入口，cmd/pmw 用 Registry.Add 登记。
type Plugin struct {
	m    plugin.Manifest
	opt  Options
	sys  System
	inst string // 本进程的实例标记，可达检测靠它认出「回到的是本服务」
}

func New(opt Options) *Plugin {
	if opt.RepoDir == "" {
		if wd, err := os.Getwd(); err == nil {
			opt.RepoDir = wd
		}
	}
	certDir := filepath.Join(opt.RepoDir, "certs")
	if opt.TLSCert != "" {
		certDir = filepath.Dir(opt.TLSCert)
	}
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return &Plugin{m: plugin.MustParse(manifestJSON), opt: opt, sys: defaultSystem(certDir), inst: hex.EncodeToString(b)}
}

// WithSystem 换掉系统路径和外部命令，测试指向临时目录。
func (p *Plugin) WithSystem(s System) *Plugin {
	p.sys = s
	return p
}

func (p *Plugin) Manifest() plugin.Manifest { return p.m }

// Migrations 是 migrations/ 下的 .sql，安装时由内核按文件名顺序应用（CORE-05）。
func (p *Plugin) Migrations() fs.FS {
	sub, err := fs.Sub(migrationsFS, "migrations")
	if err != nil {
		panic(err)
	}
	return sub
}

// OnInstall 写默认设置（bro.vip 方案）和工作台自己的那条路由。
func (p *Plugin) OnInstall(ctx context.Context, c plugin.Core) error {
	return ensureDefaults(ctx, c.Store())
}

func (p *Plugin) Register(r plugin.Registrar) error {
	h := &handlers{c: r.Core(), p: p}
	r.Routes(func(m plugin.RouteRegistrar) {
		m.HandleFunc("GET /api/domains/settings", h.getSettings)
		m.HandleFunc("PUT /api/domains/settings", h.putSettings)
		m.HandleFunc("GET /api/domains/routes", h.listRoutes)
		m.HandleFunc("POST /api/domains/routes", h.addRoute)
		m.HandleFunc("PATCH /api/domains/routes/{id}", h.updateRoute)
		m.HandleFunc("DELETE /api/domains/routes/{id}", h.removeRoute)
		m.HandleFunc("POST /api/domains/routes/{id}/check", h.checkRoute)
		m.HandleFunc("GET /api/domains/status", h.status)
		m.HandleFunc("GET /api/domains/config", h.config)
	})
	return nil
}

type handlers struct {
	c plugin.Core
	p *Plugin
}

// 错误分类，对应信封里的 code
var (
	errValidation = errors.New("validation")
	errNotFound   = errors.New("not_found")
	errConflict   = errors.New("conflict")
)

func apiErr(kind error, format string, args ...any) error {
	return fmt.Errorf("%w: "+format, append([]any{kind}, args...)...)
}

const maxBody = 64 << 10

func readBody(r *http.Request) (map[string]json.RawMessage, error) {
	body, err := io.ReadAll(io.LimitReader(r.Body, maxBody+1))
	if err != nil {
		return nil, apiErr(errValidation, "读请求体失败：%v", err)
	}
	if len(body) > maxBody {
		return nil, apiErr(errValidation, "请求体超过 64KB")
	}
	var out map[string]json.RawMessage
	if err := json.Unmarshal(body, &out); err != nil || out == nil {
		return nil, apiErr(errValidation, "请求体必须是 JSON 对象")
	}
	return out, nil
}

// fail 按内核的错误信封写回：{"error":{"code","message"}}。
func (h *handlers) fail(w http.ResponseWriter, r *http.Request, err error) {
	status, code, msg := http.StatusInternalServerError, "internal", err.Error()
	switch {
	case errors.Is(err, errConflict):
		status, code = http.StatusConflict, "conflict"
	case errors.Is(err, errNotFound):
		status, code = http.StatusNotFound, "not_found"
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
