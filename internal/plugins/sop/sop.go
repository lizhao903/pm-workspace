// Package sop 是「SOP 编排」插件的后端（SOP-01a 起）。清单 plugin.json 只有这一份，前端构建时也读它。
// 流程定义落在插件表 sop_flows，形状同原型 web-next/src/sopflow.ts 的 Sop，保存前校验（flows.go）。
// 执行引擎（SOP-01b）：运行落在 sop_runs、sop_run_steps，调度见 engine.go，节点执行见 nodes.go。
// AI 类和外部节点（SOP-01c）；定时任务和 Agent 经内核钩子发起（SOP-01d，launch.go）。
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
	// activeRuns 查一条流程进行中的执行数，删除前用；nil 时查运行表，测试里可以换掉
	activeRuns func(ctx context.Context, id string) (int, error)
	// stepHook 在每个节点执行前调，测试用它卡住执行
	stepHook func(ctx context.Context, runID, step string) error
	// complete 是 AI 协助调模型的入口（SOP-04a，assist.go），nil 时用默认服务商
	complete completer
	// core 是最近一次启用拿到的 Core，测试里直接调插件内部函数用
	core plugin.Core
}

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
	c := r.Core()
	p.core = c
	active := p.activeRuns
	if active == nil {
		active = func(ctx context.Context, id string) (int, error) { return countActive(ctx, c.Store(), id) }
	}
	f := &flows{c: c, activeRuns: active}
	// 每次启用一个新引擎，停用时后台任务取消、引擎跟着停
	e := newEngine(c)
	e.hook = p.stepHook
	rn := &runs{c: c, e: e}
	sg := &settings{c: c, e: e}
	ph := &pipelineHandlers{c: c, e: e}
	as := &assist{c: c, complete: p.complete}
	if as.complete == nil {
		as.complete = coreCompleter(c)
	}
	r.Routes(func(m plugin.RouteRegistrar) {
		m.HandleFunc("GET /api/sop/flows", f.list)
		m.HandleFunc("POST /api/sop/flows", f.add)
		m.HandleFunc("GET /api/sop/flows/{id}", f.show)
		m.HandleFunc("PATCH /api/sop/flows/{id}", f.update)
		m.HandleFunc("DELETE /api/sop/flows/{id}", f.remove)
		m.HandleFunc("GET /api/sop/node-types", f.nodeTypes)
		m.HandleFunc("POST /api/sop/flows/{id}/runs", rn.start)
		// 批量发起（IM 页批量分诊，batch.go）
		m.HandleFunc("POST /api/sop/flows/{id}/runs/batch", rn.startBatch)
		m.HandleFunc("GET /api/sop/runs", rn.list)
		m.HandleFunc("GET /api/sop/runs/{id}", rn.show)
		m.HandleFunc("POST /api/sop/runs/{id}/actions", rn.act)
		// 失败执行批量重跑（执行记录「失败」页，runbatch.go）
		m.HandleFunc("POST /api/sop/runs/batch-actions", rn.batchAct)
		m.HandleFunc("POST /api/sop/assist", as.handle)
		m.HandleFunc("GET /api/sop/settings", sg.get)
		m.HandleFunc("PATCH /api/sop/settings", sg.patch)
		// 流水线视图与待我处理（AUTO-12，pipeline.go）
		m.HandleFunc("GET /api/sop/pipeline/{id}", ph.pipeline)
		m.HandleFunc("GET /api/sop/waiting", ph.waiting)
	})
	r.Job(plugin.Job{Name: "engine", Run: e.job})
	// 旧触发方式 daily、weekly 转成随流程管理的定时任务（TSK-0463，flowsched.go），幂等
	r.Job(plugin.Job{Name: "legacy_trigger", Every: legacyEvery, Run: legacyJob})
	// 别的插件登记的节点挂起后经内核 SOP().Resume 唤醒，交给这个引擎（SOP-03a）
	r.SOPEngine(e)
	// 定时任务的 sop 动作和 Agent 的 run_sop 经内核钩子发起执行（SOP-01d，launch.go）
	st := &starter{c: c, e: e}
	r.SOPStarter(st)
	// 触发方式是 im 的流程来消息自动发起（SOP-05，imtrigger.go）
	r.Subscribe(imReceivedEvent, st.onIMMessage)
	// Claude Code 节点等的运行结束了叫醒它（AUTO-01，nodes_claude.go）；兜底还有轮询
	r.Subscribe(plugin.RunFinishedEvent, e.onRunFinished)
	r.TodayCard(plugin.TodayCardDef{Key: "sop_pending", Title: "SOP 待我处理", Order: 50, Load: pendingCard})
	return nil
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

// checkError 是保存前校验没过：message 是全部问题用「；」连起来，issues 逐条给前端定位。
type checkError struct{ issues []Issue }

func (e *checkError) Error() string {
	ts := make([]string, len(e.issues))
	for i, x := range e.issues {
		ts[i] = x.Text
	}
	return strings.Join(ts, "；")
}

// blockedError 是删除被拦下（SOP-01d）：409，schedules 是指向它的定时任务 {id, name}，没有是 []。
type blockedError struct {
	msg       string
	schedules []plugin.SOPScheduleRef
}

func (e *blockedError) Error() string { return e.msg }

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
	var be *blockedError
	if errors.As(err, &be) {
		writeJSON(w, http.StatusConflict, map[string]any{"error": map[string]any{
			"code": "conflict", "message": be.msg, "schedules": be.schedules,
		}})
		return
	}
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
