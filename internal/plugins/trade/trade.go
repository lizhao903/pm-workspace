// Package trade 是交易套件插件的后端（TRD-01a）：一个插件、四个功能模块（行情、盯盘、策略与回测、交易执行），
// 以后要单独装时再拆。本条只有标的（instruments.go）、自选分组（watchlists.go）和行情源适配接口（source.go），
// 真实行情源在 TRD-01b、TRD-01c。
//
// 涉及资金的边界：只做行情、回测、模拟盘；不写任何向交易所下单、撤单、划转、提币的代码路径，
// 权限只有 network:market-data，不声明 network:exchanges 和 trade:live。
// 接口契约见 docs/api-contract.md「交易套件插件 trade」。
package trade

import (
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"strings"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

//go:embed plugin.json
var manifestJSON []byte

//go:embed migrations/*.sql
var migrationsFS embed.FS

// Plugin 是交易套件插件的入口，cmd/pmw 用 Registry.Add 登记。
type Plugin struct {
	m       plugin.Manifest
	sources []Source
}

// New 带上要用的行情源；id 重复或覆盖声明不对直接 panic（源是编译进来的，写错是代码问题）。
func New(sources ...Source) *Plugin {
	seen := map[string]bool{}
	for _, s := range sources {
		if err := checkSource(s); err != nil {
			panic(err)
		}
		if seen[s.ID()] {
			panic(fmt.Sprintf("行情源 %s 登记了两次", s.ID()))
		}
		seen[s.ID()] = true
	}
	return &Plugin{m: plugin.MustParse(manifestJSON), sources: sources}
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

func (p *Plugin) Register(r plugin.Registrar) error {
	h := &handlers{c: r.Core(), p: p}
	r.Routes(func(m plugin.RouteRegistrar) {
		m.HandleFunc("GET /api/trade/sources", h.listSources)
		m.HandleFunc("POST /api/trade/sources/{id}/sync", h.syncSource)
		m.HandleFunc("GET /api/trade/instruments", h.listInstruments)
		m.HandleFunc("GET /api/trade/instruments/{symbol}", h.getInstrument)
		m.HandleFunc("GET /api/trade/watchlists", h.listWatchlists)
		m.HandleFunc("POST /api/trade/watchlists", h.addWatchlist)
		m.HandleFunc("GET /api/trade/watchlists/{id}", h.getWatchlist)
		m.HandleFunc("PATCH /api/trade/watchlists/{id}", h.updateWatchlist)
		m.HandleFunc("DELETE /api/trade/watchlists/{id}", h.removeWatchlist)
	})
	return nil
}

func (p *Plugin) source(id string) Source {
	for _, s := range p.sources {
		if s.ID() == id {
			return s
		}
	}
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
