package plugin

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"runtime/debug"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/idgen"
	"github.com/lizhao903/pm-workspace/internal/incident"
	"github.com/lizhao903/pm-workspace/internal/runner"
)

// 插件发起运行的句柄（VID-03a），见 docs/plugin-api.md 2.0「发起运行」。
// 三种：按 Agent 加提示词跑一轮（AgentService.RunAgent）、按流程加入参起一条 SOP 执行（Registry.StartSOP）、
// 按工作目录加提示词交给本机 Claude Code（internal/runner）。都不等跑完，先回运行 id。
// 跑完给发起的插件投一条 run.finished，只投给它、不上总线：总线上的 run.finished 是任务执行的，通知中心、
// 事件流都按任务执行认。插件停用后运行照样跑完，只是不再投给它。运行记录只在进程内存里，重启后查不到。

// 运行的种类。
const (
	RunKindAgent      = "agent"
	RunKindSOP        = "sop"
	RunKindClaudeCode = "claude_code"
)

// 运行状态。Agent 停在要确认的调用上记 waiting 并算结束，确认后接着跑由会话管（AgentState 查）。
const (
	RunRunning  = "running"
	RunDone     = "done"
	RunFailed   = "failed"
	RunWaiting  = "waiting"
	RunCanceled = "canceled"
	RunStopped  = "stopped"
)

// RunFinishedEvent 是运行结束时投给发起插件的事件，和内核的执行结束同名，插件要在清单 subscribes 里写它。
const RunFinishedEvent = "run.finished"

// sopRunStatusEvent 是 SOP 插件发的执行状态变化，内核据此认出 SOP 运行结束。
const sopRunStatusEvent = "sop.run_status_changed"

// AgentRunTimeout 是插件发起的一轮 Agent 的上限，同 Agent 的自动执行。
const AgentRunTimeout = 10 * time.Minute

// maxFinishedRuns 是内存里最多留多少条跑完的运行，超了丢最早结束的。
const maxFinishedRuns = 500

var (
	// ErrRunNotFound：没有这条运行，或者不是本插件发起的。
	ErrRunNotFound = errors.New("没有这条运行")
	// ErrNoClaudeRunner：注册表没接上 Claude Code 的执行器（测试里没接时）。
	ErrNoClaudeRunner = errors.New("Claude Code 执行还没接上")
	// ErrRunInactive：插件没在跑，不能发起运行。
	ErrRunInactive = errors.New("插件没在跑，不能发起运行")
	// ErrRunNotCancelable：只有交给 Claude Code 的运行能取消。
	ErrRunNotCancelable = errors.New("只有交给 Claude Code 的运行能取消")
	// ErrRunNotReportable：只有交给 Claude Code 的运行能回报结论。
	ErrRunNotReportable = errors.New("只有插件交给 Claude Code 的运行能回报结论")
	// ErrRunEnded：运行已经结束或已经回报过，不能再回报。
	ErrRunEnded = errors.New("这次执行已经结束了")
)

// AgentRunStart 是发起一轮 Agent：Agent 是 id 或名称，Title 是会话标题（空时取提示词开头）。
type AgentRunStart struct {
	Agent  string
	Prompt string
	Title  string
}

// SOPRunStart 是发起一条 SOP 执行：Flow 是流程 id 或名称，Input 没给的字段取流程默认值。
type SOPRunStart struct {
	Flow  string
	Input map[string]any
	// ObjectID 是执行关联的工作对象（SOP-06），执行会出现在那条对象上；空表示不关联。
	ObjectID string
}

// ClaudeCodeStart 是交给 Claude Code 跑一次。
type ClaudeCodeStart struct {
	Workdir string // 绝对路径，必填
	Prompt  string // 必填，原样交给 claude
	// AllowWrites 放开文件编辑，要用户确认过 process:spawn；默认只读
	AllowWrites bool
	// ObjectID 可选，产物挂到这个对象
	ObjectID string
	// ScopeType、ScopeID 可选，产物的非对象归属（例 video、vd_xxx），要同时给
	ScopeType string
	ScopeID   string
	// PresetID 可选，角色（预置提示词，SPEC-settings-24）的 id，内核取出执行要求、输出要求拼在提示词后面；找不到报错。
	// 角色是只读的一律不放开写，不管 AllowWrites
	PresetID string
	// FollowPreset 为真且给了角色时，写不写按角色的权限定（accept_edits 放开写），忽略 AllowWrites
	FollowPreset bool
	// Timeout 可选，这次执行的上限，到点取消、记失败；空用执行器的默认（10 分钟）
	Timeout time.Duration
	// RecordOnTask 为真且给了 ObjectID 时，在那条任务上建一条执行记录（任务抽屉「执行记录」里能看到、能取消），
	// 运行 id 就是那条记录的 id（AUTO-01）
	RecordOnTask bool
	// ReportBack 为真时要 Claude Code 结束前经工作台 MCP 的 pmw_finish_run 回报结论（summary、结构化 result），
	// 内核在提示词末尾加「回写到工作台」一节，并给这次执行接上回写用的 MCP（AUTO-01）
	ReportBack bool
}

// RunInfo 是一条运行的样子，Finished 为假时只有 ID、Kind、Source、Status、StartedAt 可信。
type RunInfo struct {
	ID     string
	Kind   string
	Source string // 发起的插件 id
	Status string
	OK     bool // 只有 done 为真
	// Ref 是底下那条记录：SOP 执行 id、Agent 会话 id；Claude Code 为空
	Ref string
	// Output 是 Agent 最新一条回复、Claude Code 的过程记录（已截断）；SOP 为空，详情查 SOP 执行
	Output   string
	Error    string
	ExitCode int
	// Artifacts 是登记的产物 id（Claude Code 改动的文件）
	Artifacts []string
	// Summary、Result 是 Claude Code 经 pmw_finish_run 回报的结论摘要和结构化结论（AUTO-01），没回报为空
	Summary string
	Result  map[string]any
	// Reported 是 Claude Code 回报的结果（done、failed、canceled），没回报为空。进程正常结束但回报 failed 时整条记失败
	Reported string
	// TaskRun 为真表示在任务上建了执行记录，ID 就是那条记录的 id
	TaskRun    bool
	Finished   bool
	StartedAt  time.Time
	FinishedAt time.Time
}

// RunService 是插件发起运行的入口，回运行 id，不等跑完。
type RunService interface {
	StartAgent(ctx context.Context, q AgentRunStart) (string, error)
	StartSOP(ctx context.Context, q SOPRunStart) (string, error)
	StartClaudeCode(ctx context.Context, q ClaudeCodeStart) (string, error)
	// Get 查本插件发起的运行，别的插件发起的回 ErrRunNotFound。
	Get(runID string) (RunInfo, error)
	// Cancel 取消本插件发起、还没结束的 Claude Code 运行（AUTO-01），只发出请求不等进程退出；
	// 已经结束的不报错，别的插件发起的回 ErrRunNotFound，Agent、SOP 运行回 ErrRunNotCancelable。
	Cancel(runID string) error
}

// ClaudeRunner 是 Claude Code 的执行器，*runner.Runner 满足它。
type ClaudeRunner interface {
	Start(ctx context.Context, req runner.Request, on func(runner.Event)) (*runner.Result, error)
}

// claudeBox 是 Claude Code 执行器和发起时要用的几样配置，整体替换（发起时现取）。
type claudeBox struct {
	r ClaudeRunner
	// mcpBin、apiURL 是回写用的 MCP：工作台的 MCP 程序和本实例地址（ReportBack 时用）
	mcpBin, apiURL string
	// presets 按 id 取预置提示词
	presets PresetLookup
}

// PresetLookup 按 id 取一个角色（预置提示词），找不到回错误（文案给用户看）。
type PresetLookup func(ctx context.Context, id string) (*runner.Preset, error)

func (r *Registry) updateClaude(f func(b *claudeBox)) {
	for {
		old := r.claude.Load()
		var b claudeBox
		if old != nil {
			b = *old
		}
		f(&b)
		if r.claude.CompareAndSwap(old, &b) {
			return
		}
	}
}

// SetClaudeRunner 接上 Claude Code 的执行器，可以在 Start 之后调（发起时现取）。
func (r *Registry) SetClaudeRunner(cr ClaudeRunner) { r.updateClaude(func(b *claudeBox) { b.r = cr }) }

// SetRunCallback 设回写用的 MCP（AUTO-01）：工作台的 MCP 程序路径和本实例地址。
// 没设或程序不在时 ReportBack 的运行照样跑，只是 Claude Code 没法回报结构化结论。
func (r *Registry) SetRunCallback(mcpBin, apiURL string) {
	r.updateClaude(func(b *claudeBox) {
		b.mcpBin, b.apiURL = strings.TrimSpace(mcpBin), strings.TrimRight(strings.TrimSpace(apiURL), "/")
	})
}

// SetRunPresets 接上预置提示词的查询（AUTO-01），ClaudeCodeStart.PresetID 用它取内容。
func (r *Registry) SetRunPresets(f PresetLookup) {
	r.updateClaude(func(b *claudeBox) { b.presets = f })
}

// taskRunRecorder 是在任务上建、收尾执行记录的 store 方法，cmd/pmw 交的外层 store 满足它。
type taskRunRecorder interface {
	CreateTaskRun(ctx context.Context, in *domain.TaskRun) (*domain.TaskRun, error)
	FinishTaskRun(ctx context.Context, id, status string, exitCode int, output, errMsg string) (*domain.TaskRun, error)
	SetTaskRunPrompt(ctx context.Context, id, prompt string) error
}

// artifactRecorder 是登记产物的 store 方法，cmd/pmw 交的外层 store 满足它。
type artifactRecorder interface {
	RecordArtifact(ctx context.Context, in domain.ArtifactInput) (*domain.Artifact, error)
}

// runTable 是进程内存里的运行记录。
type runTable struct {
	mu   sync.Mutex
	m    map[string]*RunInfo
	sops map[string]string // SOP 执行 id -> 运行 id
	// early 是还没对上运行的 SOP 结束状态：执行跑得比 StartSOP 返回还快时先记在这
	early map[string]string
	// cancels 是在跑的 Claude Code 运行的取消函数（AUTO-01）
	cancels map[string]context.CancelFunc
	wg      sync.WaitGroup
}

// WaitRuns 等在途的运行和 run.finished 投递，最多等 timeout；等到了返回 true。进程退出和测试用。
func (r *Registry) WaitRuns(timeout time.Duration) bool {
	done := make(chan struct{})
	go func() {
		r.runs.wg.Wait()
		close(done)
	}()
	select {
	case <-done:
		return true
	case <-time.After(timeout):
		return false
	}
}

func (c *core) Runs() RunService { return runService{c} }

type runService struct{ c *core }

// begin 检查插件在跑，记一条运行和一条审计。id 为空时新生成一个。
func (s runService) begin(ctx context.Context, id, kind, summary string, detail map[string]any) (*RunInfo, error) {
	r := s.c.reg
	if r == nil {
		return nil, ErrRunInactive
	}
	if e := r.entries[s.c.id]; e == nil || e.active.Load() == nil {
		return nil, fmt.Errorf("%w：%s", ErrRunInactive, s.c.id)
	}
	if id == "" {
		id = idgen.Prefixed("run")
	}
	info := &RunInfo{ID: id, Kind: kind, Source: s.c.id, Status: RunRunning, StartedAt: time.Now().UTC()}
	r.runs.mu.Lock()
	if r.runs.m == nil {
		r.runs.m, r.runs.sops, r.runs.early = map[string]*RunInfo{}, map[string]string{}, map[string]string{}
	}
	if r.runs.cancels == nil {
		r.runs.cancels = map[string]context.CancelFunc{}
	}
	r.runs.m[info.ID] = info
	r.runs.mu.Unlock()
	detail["kind"] = kind
	s.c.note(ctx, WriteMeta{}, "run", "plugin_run", info.ID, summary, detail)
	return info, nil
}

func (s runService) StartAgent(ctx context.Context, q AgentRunStart) (string, error) {
	q.Agent, q.Prompt = strings.TrimSpace(q.Agent), strings.TrimSpace(q.Prompt)
	if q.Agent == "" || q.Prompt == "" {
		return "", errors.New("Agent 和提示词都不能为空")
	}
	svc := s.c.Agent()
	if _, ok := svc.(noAgent); ok {
		return "", ErrNoAgent
	}
	info, err := s.begin(ctx, "", RunKindAgent, "发起 Agent 运行："+q.Agent, map[string]any{"agent": q.Agent})
	if err != nil {
		return "", err
	}
	r := s.c.reg
	r.runs.wg.Add(1)
	go func() {
		defer r.runs.wg.Done()
		rctx, cancel := context.WithTimeout(context.Background(), AgentRunTimeout)
		defer cancel()
		res, err := safeRunAgent(rctx, svc, AgentRunRequest{Agent: q.Agent, Prompt: q.Prompt, Title: q.Title})
		r.finishRun(info.ID, func(i *RunInfo) {
			i.Ref, i.Output = res.SessionID, res.Reply
			switch {
			case err != nil:
				i.Status, i.Error = RunFailed, err.Error()
			case res.Waiting:
				i.Status, i.Error = RunWaiting, res.Pending
			default:
				i.Status = RunDone
			}
		})
	}()
	return info.ID, nil
}

func safeRunAgent(ctx context.Context, svc AgentService, q AgentRunRequest) (res AgentRunResult, err error) {
	defer func() {
		if v := recover(); v != nil {
			err = fmt.Errorf("Agent 运行出错：%v", v)
		}
	}()
	return svc.RunAgent(ctx, q)
}

func (s runService) StartSOP(ctx context.Context, q SOPRunStart) (string, error) {
	q.Flow = strings.TrimSpace(q.Flow)
	if q.Flow == "" {
		return "", errors.New("没有指定流程")
	}
	r := s.c.reg
	if r == nil || r.sopStarterOwner("") == "" {
		return "", ErrNoSOPStarter
	}
	info, err := s.begin(ctx, "", RunKindSOP, "发起 SOP 运行："+q.Flow, map[string]any{"flow": q.Flow})
	if err != nil {
		return "", err
	}
	input := q.Input
	if input == nil {
		input = map[string]any{}
	}
	st, err := r.StartSOP(ctx, SOPStartRequest{FlowID: q.Flow, Input: input, Source: "plugin", SourceID: s.c.id, SourceName: s.c.id,
		ObjectID: strings.TrimSpace(q.ObjectID)})
	if err != nil {
		// 没起来：运行 id 没交出去，记录直接丢掉，不投 run.finished
		r.runs.mu.Lock()
		delete(r.runs.m, info.ID)
		r.runs.mu.Unlock()
		return "", err
	}
	r.runs.mu.Lock()
	info.Ref = st.RunID
	r.runs.sops[st.RunID] = info.ID
	end, early := r.runs.early[st.RunID]
	delete(r.runs.early, st.RunID)
	if st.Status == RunWaiting {
		info.Status = RunWaiting
	}
	r.runs.mu.Unlock()
	if early {
		r.endSOP(st.RunID, end)
	} else if sopEnded(st.Status) {
		r.endSOP(st.RunID, st.Status)
	}
	return info.ID, nil
}

func (s runService) StartClaudeCode(ctx context.Context, q ClaudeCodeStart) (string, error) {
	q.Prompt, q.ObjectID, q.PresetID = strings.TrimSpace(q.Prompt), strings.TrimSpace(q.ObjectID), strings.TrimSpace(q.PresetID)
	if q.Prompt == "" {
		return "", errors.New("提示词不能为空")
	}
	if (q.ScopeType == "") != (q.ScopeID == "") {
		return "", errors.New("产物归属的类型和 id 要同时给")
	}
	if q.Timeout < 0 {
		return "", errors.New("超时不能是负数")
	}
	workdir, err := runner.CheckWorkdir(q.Workdir)
	if err != nil {
		return "", err
	}
	r := s.c.reg
	var box claudeBox
	if r != nil {
		if b := r.claude.Load(); b != nil {
			box = *b
		}
	}
	prompt := q.Prompt
	if q.PresetID != "" {
		if box.presets == nil {
			return "", fmt.Errorf("角色 %s 取不到：工作台没接上角色", q.PresetID)
		}
		p, err := box.presets(ctx, q.PresetID)
		if err != nil {
			return "", err
		}
		if p != nil {
			prompt += presetSection(*p)
			if q.FollowPreset {
				q.AllowWrites = !p.ReadOnly
			} else if p.ReadOnly {
				q.AllowWrites = false
			}
		}
	}
	if q.AllowWrites {
		if err := Require(s.c, "process:spawn"); err != nil {
			return "", err
		}
	}
	cr := box.r
	if cr == nil {
		return "", ErrNoClaudeRunner
	}
	// 在任务上留执行记录：先建记录拿到 id，运行 id 就用它，任务抽屉、GET /api/runs/{id} 都认
	var tr taskRunRecorder
	id := ""
	if q.RecordOnTask && q.ObjectID != "" {
		if rec, ok := r.objectCreator().(taskRunRecorder); ok {
			run, err := rec.CreateTaskRun(ctx, &domain.TaskRun{ObjectID: q.ObjectID, Workdir: workdir, Prompt: prompt,
				Status: domain.RunRunning, Mode: domain.RunModeStream})
			if err != nil {
				return "", fmt.Errorf("在任务上建执行记录失败：%w", err)
			}
			tr, id = rec, run.ID
		}
	}
	info, err := s.begin(ctx, id, RunKindClaudeCode, "交给 Claude Code："+workdir,
		map[string]any{"workdir": workdir, "allow_writes": q.AllowWrites, "object_id": q.ObjectID, "preset_id": q.PresetID})
	if err != nil {
		if tr != nil {
			_, _ = tr.FinishTaskRun(domain.WithRunOrigin(context.WithoutCancel(ctx), "plugin:"+s.c.id), id, domain.RunFailed, -1, "", err.Error())
		}
		return "", err
	}
	info.TaskRun = tr != nil
	req := runner.Request{RunID: info.ID, Workdir: workdir, AllowWrites: q.AllowWrites, Timeout: q.Timeout}
	cleanup := func() {}
	if q.ReportBack {
		path, done, cbErr := writeCallbackMCP(box.mcpBin, box.apiURL)
		if cbErr != nil {
			s.c.log.Warn("claude code run has no write-back mcp", "run", info.ID, "err", cbErr)
		} else {
			req.MCPConfig, req.AllowedTools, cleanup = path, []string{"mcp__" + CallbackMCPServer}, done
		}
		prompt += reportBackSection(info.ID, q.ObjectID, cbErr == nil)
	}
	req.Prompt = prompt
	if tr != nil {
		if err := tr.SetTaskRunPrompt(ctx, info.ID, prompt); err != nil {
			s.c.log.Warn("task run prompt not saved", "run", info.ID, "err", err)
		}
	}
	rctx, cancel := context.WithCancel(context.Background())
	r.runs.mu.Lock()
	r.runs.cancels[info.ID] = cancel
	r.runs.mu.Unlock()
	r.runs.wg.Add(1)
	go func() {
		defer r.runs.wg.Done()
		defer cleanup()
		defer func() {
			cancel()
			r.runs.mu.Lock()
			delete(r.runs.cancels, info.ID)
			r.runs.mu.Unlock()
		}()
		// 执行前拍快照，跑完比对出改动的文件登记成产物（同 POST /api/objects/{id}/run）
		before := runner.TakeSnapshot(workdir)
		res, err := safeClaude(rctx, cr, req)
		arts := s.recordArtifacts(info.ID, workdir, q, before, tr != nil)
		var failed *incident.ClaudeRun
		var final RunInfo
		filled := false
		r.finishRun(info.ID, func(i *RunInfo) {
			i.Artifacts = arts
			if err != nil {
				i.Status, i.Error, i.ExitCode = RunFailed, err.Error(), -1
			} else {
				i.Status, i.Output, i.Error, i.ExitCode = res.Status, res.Output, res.Error, res.ExitCode
			}
			applyReport(i)
			if i.Status == RunFailed {
				failed = &incident.ClaudeRun{RunID: i.ID, ObjectID: q.ObjectID, Workdir: workdir, ExitCode: i.ExitCode,
					Error: i.Error, Output: i.Output, AllowWrites: q.AllowWrites, Via: s.c.id, Source: incident.SourcePlugin + s.c.id}
			}
			final, filled = *i, true
		})
		// 任务上的执行记录跟着收尾：有回报的结论摘要放在过程记录前面
		if tr != nil && filled {
			out := final.Output
			if final.Summary != "" {
				out = final.Summary + "\n\n---\n\n" + out
			}
			fctx, fcancel := context.WithTimeout(domain.WithRunOrigin(context.Background(), "plugin:"+s.c.id), 10*time.Second)
			if _, ferr := tr.FinishTaskRun(fctx, final.ID, final.Status, final.ExitCode, out, final.Error); ferr != nil {
				s.c.log.Warn("task run not finished", "run", final.ID, "err", ferr)
			}
			fcancel()
		}
		// 失败记运行异常（INC-01a），取消不记；记不上只记日志
		if failed != nil {
			s.noteClaudeFailed(*failed)
		}
	}()
	return info.ID, nil
}

// presetSection 是角色拼在提示词后面的一节，口径同任务执行的「执行要求」（internal/runner/prompt.go）。
func presetSection(p runner.Preset) string {
	var b strings.Builder
	content, output := strings.TrimSpace(p.Content), strings.TrimSpace(p.Output)
	if content == "" && output == "" && !p.ReadOnly {
		return ""
	}
	b.WriteString("\n\n## 执行要求")
	if sc := strings.TrimSpace(p.Scene); sc != "" {
		b.WriteString("（" + sc + "）")
	}
	b.WriteString("\n")
	if content != "" {
		b.WriteString(content + "\n")
	}
	if p.ReadOnly {
		b.WriteString("\n这个角色只读：不要创建、修改或删除任何文件，结论写在回复里。\n")
	}
	if output != "" {
		b.WriteString("\n输出要求：\n" + output + "\n")
	}
	return strings.TrimRight(b.String(), "\n")
}

// applyReport 把 Claude Code 的回报并进结果：进程正常结束、回报不是 done 时按回报算（做不下去、用户让停）。
// 进程本身失败、超时、取消的照旧，回报只补结论。
func applyReport(i *RunInfo) {
	if i.Reported == "" || i.Status != RunDone || i.Reported == RunDone {
		return
	}
	i.Status = i.Reported
	if i.Error == "" {
		i.Error = "Claude Code 回报" + map[string]string{RunFailed: "做不下去", RunCanceled: "已停下"}[i.Reported]
		if i.Summary != "" {
			i.Error += "：" + clipText(i.Summary, 300)
		}
	}
}

func clipText(s string, n int) string {
	rs := []rune(s)
	if len(rs) <= n {
		return s
	}
	return string(rs[:n]) + "…"
}

// CallbackMCPServer 是回写用的 MCP server 名，和任务执行、终端交接共用 runner.MCPServer（TSK-0499）。
// 不叫 pm-workspace：工作目录里的 .mcp.json 可能已经有一个同名的、指向别的工作台实例，分开起名免得回写到别处。
const CallbackMCPServer = runner.MCPServer

// writeCallbackMCP 把回写用的 MCP 配置写进临时目录（只有本人可读写），回路径和删掉它的函数。
// 配置内容由 runner.MCPConfigJSON 生成，三条路同一份。
func writeCallbackMCP(bin, api string) (string, func(), error) {
	return runner.TempMCPConfig(bin, api)
}

// reportBackSection 是 ReportBack 时加在提示词末尾的一节：结束前用 pmw_finish_run 回报结论，下游按 result 判断。
func reportBackSection(runID, objectID string, mcp bool) string {
	var b strings.Builder
	b.WriteString("\n\n## 回写到工作台\n")
	fmt.Fprintf(&b, "这次是「产品工作台」的 SOP 自动交给你的执行（执行记录 %s），没有人在旁边看，后面的步骤按你回报的结论往下走。\n", runID)
	if !mcp {
		b.WriteString("工作台这次没能接上回写用的 MCP，做完后在最后一段写清结论即可。\n")
		return b.String()
	}
	fmt.Fprintf(&b, "工作台的 MCP 已经接上（server 名 %s）。\n", CallbackMCPServer)
	if objectID != "" {
		fmt.Fprintf(&b, "- 关联任务 %s：需要正文和验收标准就用 pmw_get_object 读；做完关键步骤用 pmw_append_progress 记一条；产出用 pmw_record_artifact 登记（带 object_id=%s、run_id=%s）。\n", objectID, objectID, runID)
	}
	fmt.Fprintf(&b, "- 结束时（做完、或做不下去）必须调一次 pmw_finish_run：run_id=%s，status 填 done 或 failed，summary 写结论摘要（做了什么、产出在哪、还剩什么），"+
		"result 填结构化结论（JSON 对象），至少带 verdict（\"pass\" 表示通过、\"reject\" 表示不通过要退回），不通过时 issues 逐条写要改什么，产出可以列在 artifacts。只调一次。\n", runID)
	return b.String()
}

func safeClaude(ctx context.Context, cr ClaudeRunner, req runner.Request) (res *runner.Result, err error) {
	defer func() {
		if v := recover(); v != nil {
			res, err = nil, fmt.Errorf("Claude Code 执行出错：%v", v)
		}
	}()
	return cr.Start(ctx, req, nil)
}

// recordArtifacts 把改动的文件登记成产物：来源 run、产出者记发起的插件，props 带运行 id。登记失败只记日志。
// onTask 为真时运行 id 是任务上的执行记录，产物同时挂到那条执行记录上。
func (s runService) recordArtifacts(runID, workdir string, q ClaudeCodeStart, before runner.Snapshot, onTask bool) []string {
	rec, ok := s.c.reg.objectCreator().(artifactRecorder)
	if !ok {
		return nil
	}
	changed, truncated := runner.Diff(before, runner.TakeSnapshot(workdir))
	if truncated {
		s.c.log.Warn("plugin run changed too many files", "run", runID, "limit", runner.MaxRecordedArtifacts)
	}
	var objID *string
	if q.ObjectID != "" {
		objID = &q.ObjectID
	}
	var taskRun *string
	if onTask {
		taskRun = &runID
	}
	out := []string{}
	for _, f := range changed {
		art, err := rec.RecordArtifact(context.Background(), domain.ArtifactInput{
			ObjectID: objID, RunID: taskRun, Path: f.Path, BaseDir: workdir, Platform: "local", Size: f.Size,
			Source: domain.ArtifactSourceRun, ActorType: domain.ActorRun, ActorID: s.c.id, ActorLabel: s.c.id,
			ScopeType: q.ScopeType, ScopeID: q.ScopeID,
			Props: map[string]any{"plugin_run_id": runID},
		})
		if err != nil {
			s.c.log.Warn("record plugin run artifact failed", "run", runID, "path", f.Path, "err", err)
			continue
		}
		out = append(out, art.ID)
	}
	return out
}

func (s runService) Get(runID string) (RunInfo, error) {
	r := s.c.reg
	if r == nil {
		return RunInfo{}, ErrRunNotFound
	}
	r.runs.mu.Lock()
	defer r.runs.mu.Unlock()
	i, ok := r.runs.m[runID]
	if !ok || i.Source != s.c.id {
		return RunInfo{}, ErrRunNotFound
	}
	out := *i
	out.Artifacts = slices.Clone(i.Artifacts)
	return out, nil
}

func (s runService) Cancel(runID string) error {
	r := s.c.reg
	if r == nil {
		return ErrRunNotFound
	}
	r.runs.mu.Lock()
	i, ok := r.runs.m[runID]
	if !ok || i.Source != s.c.id {
		r.runs.mu.Unlock()
		return ErrRunNotFound
	}
	if i.Kind != RunKindClaudeCode {
		r.runs.mu.Unlock()
		return ErrRunNotCancelable
	}
	cancel := r.runs.cancels[runID]
	r.runs.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	return nil
}

// ReportRun 记下 Claude Code 经 pmw_finish_run 回报的结论（AUTO-01）：只收插件交给 Claude Code、还在跑的运行，只收一次。
// 不收尾运行：进程退出时按回报和退出码定结果，再投 run.finished。没有这条运行回 ErrRunNotFound（调用方再按任务执行查）。
func (r *Registry) ReportRun(id, status, summary string, result map[string]any) (RunInfo, error) {
	if r == nil {
		return RunInfo{}, ErrRunNotFound
	}
	r.runs.mu.Lock()
	defer r.runs.mu.Unlock()
	i, ok := r.runs.m[id]
	if !ok {
		return RunInfo{}, ErrRunNotFound
	}
	if i.Kind != RunKindClaudeCode {
		return RunInfo{}, ErrRunNotReportable
	}
	if i.Finished || i.Reported != "" {
		return RunInfo{}, ErrRunEnded
	}
	switch status {
	case RunDone, RunFailed, RunCanceled:
	default:
		return RunInfo{}, fmt.Errorf("status 只能是 done、failed 或 canceled")
	}
	i.Reported, i.Summary, i.Result = status, strings.TrimSpace(summary), result
	out := *i
	out.Artifacts = slices.Clone(i.Artifacts)
	return out, nil
}

// finishRun 收尾一条运行（只收一次），再投 run.finished 给发起的插件。
func (r *Registry) finishRun(id string, fill func(*RunInfo)) {
	r.runs.mu.Lock()
	i, ok := r.runs.m[id]
	if !ok || i.Finished {
		r.runs.mu.Unlock()
		return
	}
	fill(i)
	i.OK = i.Status == RunDone
	i.Finished, i.FinishedAt = true, time.Now().UTC()
	info := *i
	r.pruneRuns()
	r.runs.mu.Unlock()
	r.deliverRunFinished(info)
}

// pruneRuns 丢掉超出上限的最早结束的运行。调用方持有 runs.mu。
func (r *Registry) pruneRuns() {
	var done []*RunInfo
	for _, i := range r.runs.m {
		if i.Finished {
			done = append(done, i)
		}
	}
	if len(done) <= maxFinishedRuns {
		return
	}
	slices.SortFunc(done, func(a, b *RunInfo) int { return a.FinishedAt.Compare(b.FinishedAt) })
	for _, i := range done[:len(done)-maxFinishedRuns] {
		delete(r.runs.m, i.ID)
		if i.Kind == RunKindSOP {
			delete(r.runs.sops, i.Ref)
		}
	}
}

// deliverRunFinished 只投给发起的插件当前在跑的订阅，停用了就不投。异步执行，出错、panic 只记日志。
func (r *Registry) deliverRunFinished(i RunInfo) {
	// summary、result 是 Claude Code 回报的结论（AUTO-01），没回报时为空串和 null
	raw, err := json.Marshal(map[string]any{
		"run_id": i.ID, "kind": i.Kind, "source": i.Source, "status": i.Status, "ok": i.OK, "ref": i.Ref,
		"summary": clipText(i.Summary, 1500), "result": i.Result,
	})
	if err != nil {
		return
	}
	ev := Event{Type: RunFinishedEvent, At: i.FinishedAt, Payload: raw}
	for _, sub := range r.Subscribers(RunFinishedEvent) {
		if sub.Plugin != i.Source {
			continue
		}
		r.runs.wg.Add(1)
		go func() {
			defer r.runs.wg.Done()
			defer func() {
				if v := recover(); v != nil {
					r.log.Error("plugin run.finished handler panic", "plugin", sub.Plugin, "panic", v, "stack", string(debug.Stack()))
				}
			}()
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			if err := sub.Handle(ctx, ev); err != nil {
				r.log.Warn("plugin run.finished handler failed", "plugin", sub.Plugin, "run", i.ID, "err", err)
			}
		}()
	}
}

func sopEnded(status string) bool {
	return status == RunDone || status == RunFailed || status == RunStopped
}

// watchSOPRun 在 SOP 插件发执行状态变化时调：插件发起的执行结束了就收尾，还没对上的先记下。
func (r *Registry) watchSOPRun(payload any) {
	if r == nil {
		return
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return
	}
	var p struct {
		RunID string `json:"run_id"`
		To    string `json:"to"`
	}
	if json.Unmarshal(raw, &p) != nil || p.RunID == "" {
		return
	}
	r.runs.mu.Lock()
	id, ok := r.runs.sops[p.RunID]
	if !ok {
		if sopEnded(p.To) && r.runs.early != nil {
			if len(r.runs.early) >= 256 {
				clear(r.runs.early)
			}
			r.runs.early[p.RunID] = p.To
		}
		r.runs.mu.Unlock()
		return
	}
	if p.To == RunWaiting || p.To == RunRunning {
		if i := r.runs.m[id]; i != nil && !i.Finished {
			i.Status = p.To
		}
	}
	r.runs.mu.Unlock()
	if sopEnded(p.To) {
		r.endSOP(p.RunID, p.To)
	}
}

func (r *Registry) endSOP(sopRunID, status string) {
	r.runs.mu.Lock()
	id := r.runs.sops[sopRunID]
	r.runs.mu.Unlock()
	if id == "" {
		return
	}
	r.finishRun(id, func(i *RunInfo) {
		i.Status = status
		if status != RunDone {
			i.Error = "SOP 执行" + map[string]string{RunFailed: "失败", RunStopped: "被停止"}[status]
		}
	})
}

// noteClaudeFailed 插件交给 Claude Code 的运行失败，记一条运行异常，来源 plugin:<插件 id>；有对象时带上编号和标题。
func (s runService) noteClaudeFailed(c incident.ClaudeRun) {
	r := s.c.reg
	if r == nil {
		return
	}
	b := r.incidents.Load()
	if b == nil || b.r == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if c.ObjectID != "" {
		if o, err := s.c.Objects().Get(ctx, c.ObjectID); err == nil {
			c.ObjectTitle = o.Title
		}
	}
	if _, err := b.r.Record(ctx, incident.ClaudeRunReport(c)); err != nil {
		s.c.log.Warn("claude code run incident not recorded", "run", c.RunID, "err", err)
	}
}
