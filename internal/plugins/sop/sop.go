// Package sop 是「SOP 编排」插件的后端（SOP-01a 起）。清单 plugin.json 只有这一份，前端构建时也读它。
// 流程定义落在插件表 sop_flows，形状同原型 web-next/src/sopflow.ts 的 Sop，保存前校验（flows.go）。
// 执行引擎（SOP-01b）、AI 类和外部节点（SOP-01c）、定时任务和 Agent 发起（SOP-01d）后续接上。
// 接口契约见 docs/api-contract.md「SOP 编排插件 sop」。
package sop

import (
	"context"
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

// Plugin 是 SOP 插件的入口，cmd/pmw 用 Registry.Add 登记。
type Plugin struct {
	m plugin.Manifest
	// activeRuns 查一条流程进行中的执行数，删除前用；SOP-01b 之前恒为 0，测试里可以换掉
	activeRuns func(ctx context.Context, id string) (int, error)
}

func New() *Plugin { return &Plugin{m: plugin.MustParse(manifestJSON), activeRuns: noRuns} }

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
	f := &flows{c: r.Core(), activeRuns: p.activeRuns}
	r.Routes(func(m plugin.RouteRegistrar) {
		m.HandleFunc("GET /api/sop/flows", f.list)
		m.HandleFunc("POST /api/sop/flows", f.add)
		m.HandleFunc("GET /api/sop/flows/{id}", f.show)
		m.HandleFunc("PATCH /api/sop/flows/{id}", f.update)
		m.HandleFunc("DELETE /api/sop/flows/{id}", f.remove)
		m.HandleFunc("GET /api/sop/node-types", f.nodeTypes)
	})
	return nil
}

// noRuns 是还没有执行引擎时的进行中运行数，SOP-01b 换成查运行表。
func noRuns(context.Context, string) (int, error) { return 0, nil }

// 错误分类，对应信封里的 code
var (
	errValidation = errors.New("validation")
	errNotFound   = errors.New("not_found")
	errConflict   = errors.New("conflict")
)

func apiErr(kind error, format string, args ...any) error {
	return fmt.Errorf("%w: "+format, append([]any{kind}, args...)...)
}

// checkError 是保存前校验没过：message 是全部问题用「；」连起来，issues 逐条给前端定位。
type checkError struct{ issues []Issue }

func (e *checkError) Error() string {
	ts := make([]string, len(e.issues))
	for i, x := range e.issues {
		ts[i] = x.Text
	}
	return strings.Join(ts, "；")
}

const maxBody = 1 << 20

func readBody(r *http.Request) (map[string]json.RawMessage, error) {
	body, err := io.ReadAll(io.LimitReader(r.Body, maxBody+1))
	if err != nil {
		return nil, apiErr(errValidation, "读请求体失败：%v", err)
	}
	if len(body) > maxBody {
		return nil, apiErr(errValidation, "请求体超过 1MB")
	}
	var out map[string]json.RawMessage
	if err := json.Unmarshal(body, &out); err != nil || out == nil {
		return nil, apiErr(errValidation, "请求体必须是 JSON 对象")
	}
	return out, nil
}

// fail 按内核的错误信封写回：{"error":{"code","message"}}，校验没过时多带 issues。
func fail(w http.ResponseWriter, r *http.Request, c plugin.Core, err error) {
	var ce *checkError
	if errors.As(err, &ce) {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": map[string]any{
			"code": "validation", "message": ce.Error(), "issues": ce.issues,
		}})
		return
	}
	status, code, msg := http.StatusInternalServerError, "internal", err.Error()
	switch {
	case errors.Is(err, errConflict):
		status, code = http.StatusConflict, "conflict"
	case errors.Is(err, errNotFound):
		status, code = http.StatusNotFound, "not_found"
	case errors.Is(err, errValidation):
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
