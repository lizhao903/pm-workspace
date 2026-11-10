// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// Package browser 是「内置浏览器」插件的后端（BR-01a）。清单 plugin.json 只有这一份，前端构建时也读它。
// 标签页落在 browser_tabs（形状同原型 web-next/src/browserdata.ts 的 BrowserTab，多顺序和是否当前），
// 允许嵌入的地址白名单落在 browser_allowlist。Google 账号不单独存：以 Google Drive 连接器实例为准，
// 经内核的连接器句柄读状态、发起授权、断开（docs/plugin-api.md 2.5）。本插件不访问任何外部服务。
// 接口契约见 docs/api-contract.md「内置浏览器插件 browser」。
package browser

import (
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/plugin"
)

//go:embed plugin.json
var manifestJSON []byte

//go:embed migrations/*.sql
var migrationsFS embed.FS

// Plugin 是浏览器插件的入口，cmd/pmw 用 Registry.Add 登记。
type Plugin struct{ m plugin.Manifest }

func New() *Plugin { return &Plugin{m: plugin.MustParse(manifestJSON)} }

func (p *Plugin) Manifest() plugin.Manifest { return p.m }

// Migrations 是 migrations/ 下的 .sql，安装时由内核按文件名顺序应用（CORE-05）。
func (p *Plugin) Migrations() fs.FS {
	sub, err := fs.Sub(migrationsFS, "migrations")
	if err != nil {
		panic(err)
	}
	return sub
}

func (p *Plugin) Register(r plugin.Registrar) error {
	h := &handler{c: r.Core()}
	r.Routes(func(m plugin.RouteRegistrar) {
		m.HandleFunc("GET /api/browser/tabs", h.listTabs)
		m.HandleFunc("PUT /api/browser/tabs", h.putTabs)
		m.HandleFunc("GET /api/browser/allowlist", h.listAllow)
		m.HandleFunc("POST /api/browser/allowlist", h.addAllow)
		m.HandleFunc("DELETE /api/browser/allowlist", h.removeAllow)
		m.HandleFunc("GET /api/browser/google", h.google)
		m.HandleFunc("POST /api/browser/google/login", h.googleLogin)
		m.HandleFunc("POST /api/browser/google/logout", h.googleLogout)
	})
	return nil
}

type handler struct {
	c plugin.Core
	// tabsMu 让整体替换一个一个来：替换是「写入再删多余的」两条语句
	tabsMu sync.Mutex
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

const maxBody = 1 << 20

// readBody 读 JSON 对象，出现 allowed 以外的字段 400；empty 为真时空请求体当作 {}。
func readBody(r *http.Request, empty bool, allowed ...string) (map[string]json.RawMessage, error) {
	body, err := io.ReadAll(io.LimitReader(r.Body, maxBody+1))
	if err != nil {
		return nil, apiErr(errValidation, "读请求体失败：%v", err)
	}
	if len(body) > maxBody {
		return nil, apiErr(errValidation, "请求体超过 1MB")
	}
	if empty && strings.TrimSpace(string(body)) == "" {
		return map[string]json.RawMessage{}, nil
	}
	var out map[string]json.RawMessage
	if err := json.Unmarshal(body, &out); err != nil || out == nil {
		return nil, apiErr(errValidation, "请求体必须是 JSON 对象")
	}
	for k := range out {
		if !slices.Contains(allowed, k) {
			return nil, apiErr(errValidation, "不认识的字段 %s", k)
		}
	}
	return out, nil
}

// fail 按内核的错误信封写回：{"error":{"code","message"}}。内核连接器回的 domain 错误照同样的口径。
func fail(w http.ResponseWriter, r *http.Request, c plugin.Core, err error) {
	status, code, msg := http.StatusInternalServerError, "internal", err.Error()
	switch {
	case errors.Is(err, errConflict), errors.Is(err, domain.ErrConflict):
		status, code = http.StatusConflict, "conflict"
	case errors.Is(err, errNotFound), errors.Is(err, domain.ErrNotFound), errors.Is(err, plugin.ErrNoRows):
		status, code = http.StatusNotFound, "not_found"
	case errors.Is(err, errValidation), errors.Is(err, domain.ErrValidation):
		status, code = http.StatusBadRequest, "validation"
	default:
		c.Log().Error("request failed", "method", r.Method, "path", r.URL.Path, "err", err)
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

func nowStr() string { return time.Now().UTC().Format(time.RFC3339) }
