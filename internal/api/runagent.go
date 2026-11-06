package api

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/lizhao903/pm-workspace/internal/agent"
	"github.com/lizhao903/pm-workspace/internal/audit"
	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/runner"
	"github.com/lizhao903/pm-workspace/internal/store"
)

// --- 交给工作台 Agent 执行（TSK-0460，harness=agent） ---
//
// 和 claude / deepseek 两个执行器走同一个接口（POST /api/objects/{id}/run）、同一种 SSE 事件和执行记录，
// 区别只在「谁来跑」：不起外部进程，在工作台进程里跑 internal/agent 的 Runner——同一套工具、授权（Policy）、
// 要确认的调用（agent_tool_calls）、熔断和失败改用（agent.Service.TaskChat），不另写一套模型调用。
//
// 会话：每次执行建一个挂 Agent 的全局会话（会话列表里看得到），source_ref 记 kind=task_run 和来自哪条任务；
// 执行记录的 harness_session 记会话 id，执行完能打开会话接着聊，resume_session 续用它。
//
// 确认：Runner 遇到要确认的调用照旧发 confirm 并结束这一段；这里接着等人的决定（执行记录改成 waiting），
// 人在执行面板或会话里点确认 / 拒绝都走 POST /api/agent/tool-calls/{id}/confirm|reject——那边先问这里
// 「有没有在途执行在等这次调用」，有就把决定交过来，由这里 Resume 接着跑，不在那边另起一轮。
// 等到 confirm_wait_minutes 还没人决定按拒绝处理，执行不会一直挂着。
//
// 预算：步数（调一次模型算一步，Run 和 Resume 合起来算）和时长（不含等确认的时间），超了失败并写明原因。

// 预算默认值和范围。时长默认同会话里一轮对话的上限（agentRunTimeout），步数比会话里一轮（8 轮）宽：
// 一条任务要读任务、读关联、记几条进展、改状态，八步不够用。
const (
	defaultAgentRunSteps   = 30
	maxAgentRunSteps       = 100
	defaultAgentRunMinutes = int(agentRunTimeout / time.Minute)
	maxAgentRunMinutes     = 60
	defaultConfirmWaitMins = 10
	maxConfirmWaitMins     = 60
)

// errRunCanceled 是执行记录被取消（POST /api/runs/{id}/cancel）时 context 的 cause。
var errRunCanceled = errors.New("run canceled")

// agentTaskRuns 是本进程里在跑的 Agent 执行和它们在等的确认。取消、判残留、把确认交回执行都靠它。
type agentTaskRuns struct {
	mu    sync.Mutex
	runs  map[string]context.CancelCauseFunc
	waits map[string]chan bool
}

func (a *agentTaskRuns) add(runID string, cancel context.CancelCauseFunc) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.runs == nil {
		a.runs = map[string]context.CancelCauseFunc{}
	}
	a.runs[runID] = cancel
}

func (a *agentTaskRuns) remove(runID string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	delete(a.runs, runID)
}

func (a *agentTaskRuns) running(runID string) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	_, ok := a.runs[runID]
	return ok
}

// cancel 取消在跑的执行，没有这条回 false。
func (a *agentTaskRuns) cancel(runID string) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	c, ok := a.runs[runID]
	if ok {
		c(errRunCanceled)
	}
	return ok
}

// wait 登记「在等这次调用的决定」，回收决定的通道（有缓冲，送的一方不会卡住）。
func (a *agentTaskRuns) wait(callID string) chan bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.waits == nil {
		a.waits = map[string]chan bool{}
	}
	ch := make(chan bool, 1)
	a.waits[callID] = ch
	return ch
}

// claim 认领一次调用的决定权：有在途执行在等它就摘下来回通道，没有回 nil。
// 人点确认和等待超时都先 claim，谁先拿到算谁的，另一边就不会再动这次调用。
func (a *agentTaskRuns) claim(callID string) chan bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	ch := a.waits[callID]
	delete(a.waits, callID)
	return ch
}

// agentRunBudget 是一次执行的预算，unit 是「一分钟」有多长（测试里调短）。
type agentRunBudget struct {
	steps       int
	duration    time.Duration
	confirmWait time.Duration
	minutes     int
}

func (s *Server) agentBudgetOf(req runObjectReq) (agentRunBudget, error) {
	pick := func(name string, v, def, hi int) (int, error) {
		if v == 0 {
			return def, nil
		}
		if v < 1 || v > hi {
			return 0, validationf("%s 要在 1 到 %d 之间", name, hi)
		}
		return v, nil
	}
	unit := s.agentTimeUnit
	if unit <= 0 {
		unit = time.Minute
	}
	steps, err := pick("max_steps", req.MaxSteps, defaultAgentRunSteps, maxAgentRunSteps)
	if err != nil {
		return agentRunBudget{}, err
	}
	mins, err := pick("max_minutes", req.MaxMinutes, defaultAgentRunMinutes, maxAgentRunMinutes)
	if err != nil {
		return agentRunBudget{}, err
	}
	wait, err := pick("confirm_wait_minutes", req.ConfirmWaitMinutes, defaultConfirmWaitMins, maxConfirmWaitMins)
	if err != nil {
		return agentRunBudget{}, err
	}
	return agentRunBudget{steps: steps, duration: time.Duration(mins) * unit, confirmWait: time.Duration(wait) * unit, minutes: mins}, nil
}

// taskRunAgent 定这次执行用哪个 Agent：请求里指定的；没指定用场景「执行任务」选的；
// 没选（或选的那个删了、停了）用第一个启用的；一个都没有回 400。
func (s *Server) taskRunAgent(ctx context.Context, id string) (*domain.Agent, error) {
	if id = strings.TrimSpace(id); id != "" {
		if _, err := s.st.GetAgent(ctx, id); err != nil {
			return nil, err
		}
		return s.chatAgent(ctx, id)
	}
	if sid, err := agent.ScenarioAgent(ctx, s.st, agent.ScenarioTaskRun); err == nil && sid != "" {
		if a, err := s.chatAgent(ctx, sid); err == nil {
			return a, nil
		}
	}
	list, err := s.st.ListAgents(ctx)
	if err != nil {
		return nil, err
	}
	for _, a := range list {
		if a.Enabled {
			return a, nil
		}
	}
	return nil, validationf("还没有可用的 Agent：先到 Agent 页建一个并启用，再交给它执行")
}

// agentTaskSource 是执行建的会话的来源（0047）：会话列表和会话页头部据此标出来自哪条任务，
// Agent 在会话里新建的对象（子任务）缺省挂到任务所属的项目。
func agentTaskSource(obj *domain.Object, runID string) map[string]any {
	src := map[string]any{
		"kind": "task_run", "label": "任务 " + strings.TrimSpace(obj.Ref+" "+obj.Title) + " 的执行",
		"object_id": obj.ID, "ref": obj.Ref, "run_id": runID,
	}
	if obj.ProjectID != nil && strings.TrimSpace(*obj.ProjectID) != "" {
		src["project_id"] = *obj.ProjectID
	}
	return src
}

// agentPromptFor 拼交给工作台 Agent 的第一条消息：任务内容同交给 Claude Code 的（taskOf、所属项目、角色、补充说明）。
func (s *Server) agentPromptFor(ctx context.Context, o *domain.Object, workdir, extra string, preset *runner.Preset, resume bool) string {
	t := s.taskOf(ctx, o, workdir, extra)
	t.Project = s.projectOf(ctx, o)
	t.Preset = preset
	return runner.BuildAgentPrompt(runner.AgentTask{Task: t, Resume: resume})
}

// runObjectWithAgent 是 handleRunObject 的 harness=agent 分支：开流之前的问题（Agent、服务商、预算、
// 续跑没有会话）回普通 JSON 错误，开流之后的一切进流。
func (s *Server) runObjectWithAgent(w http.ResponseWriter, r *http.Request, flusher http.Flusher, obj *domain.Object, req runObjectReq) {
	ctx := r.Context()

	// 工作目录可选：有就是 write_file 的产物目录；请求里给了不能用的目录才报错，继承来的不能用就当没有
	workdir := ""
	if strings.TrimSpace(req.Workdir) != "" {
		wd, err := s.workdirFor(ctx, obj.ID, req.Workdir)
		if err != nil {
			s.fail(w, r, err)
			return
		}
		workdir = wd
	} else if wd, err := s.workdirFor(ctx, obj.ID, ""); err == nil {
		workdir = wd
	}
	preset, err := s.presetOf(ctx, req.PresetID)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	budget, err := s.agentBudgetOf(req)
	if err != nil {
		s.fail(w, r, err)
		return
	}

	var sess *domain.AgentSession
	var ag *domain.Agent
	if req.ResumeSession {
		sid, err := s.lastHarnessSession(ctx, obj.ID, domain.RunHarnessAgent)
		if err != nil {
			s.fail(w, r, err)
			return
		}
		if sid != "" {
			if sess, err = s.st.GetAgentSession(ctx, sid); err != nil && !errors.Is(err, domain.ErrNotFound) {
				s.fail(w, r, err)
				return
			}
		}
		if sess == nil || sess.AgentID == nil {
			s.fail(w, r, validationf("这个任务还没有可续的工作台 Agent 会话（没跑过，或者上次的会话已经删了），先跑一次再续"))
			return
		}
		if ag, err = s.chatAgent(ctx, *sess.AgentID); err != nil {
			s.fail(w, r, err)
			return
		}
		if s.turns.running(sess.ID) {
			s.fail(w, r, conflictf("上次的会话里还有一轮在跑，等它跑完或先停下再续跑"))
			return
		}
	} else if ag, err = s.taskRunAgent(ctx, req.AgentID); err != nil {
		s.fail(w, r, err)
		return
	}

	// 服务商和模型：请求里给了用请求的，没给用 Agent 设置的
	providerID, model := strings.TrimSpace(req.ProviderID), strings.TrimSpace(req.Model)
	if providerID == "" {
		providerID = ag.ProviderID
		if model == "" {
			model = ag.Model
		}
	}
	chat, model, prov, err := s.agentSvc.TaskChat(ctx, providerID, model)
	if err != nil {
		if errors.Is(err, domain.ErrNotFound) {
			s.fail(w, r, err)
		} else {
			s.fail(w, r, validationf("%v", err))
		}
		return
	}
	policy, err := s.agentPolicy(ctx, ag)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	readOnly := preset != nil && preset.ReadOnly
	if readOnly {
		policy = policy.ReadOnly()
	}
	prompt := s.agentPromptFor(ctx, obj, workdir, req.ExtraPrompt, preset, req.ResumeSession)

	run, err := s.st.CreateTaskRun(ctx, &domain.TaskRun{
		ObjectID: obj.ID, Workdir: workdir, Prompt: prompt,
		Status: domain.RunRunning, Mode: domain.RunModeStream, Harness: domain.RunHarnessAgent,
	})
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if sess == nil {
		sess, err = s.st.CreateAgentSession(ctx, &domain.AgentSession{
			Title: clipTitle(strings.TrimSpace(obj.Ref + " " + obj.Title)), ProviderID: prov.ID, Model: model,
			Workdir: workdir, AgentID: &ag.ID, SourceRef: agentTaskSource(obj, run.ID),
		})
		if err != nil {
			_ = s.finishRun(context.WithoutCancel(ctx), run.ID, domain.RunFailed, -1, "", "建 Agent 会话失败："+err.Error())
			s.fail(w, r, err)
			return
		}
	}
	if err := s.st.SetTaskRunSession(ctx, run.ID, sess.ID); err != nil {
		s.log.Warn("save agent run session failed", "run", run.ID, "err", err)
	}
	run.HarnessSession = sess.ID

	s.markDoing(ctx, r, obj, agentExecutor(ag))

	h := w.Header()
	h.Set("Content-Type", "text/event-stream; charset=utf-8")
	h.Set("Cache-Control", "no-cache")
	h.Set("Connection", "keep-alive")
	h.Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	flusher.Flush()

	var mu sync.Mutex
	var out strings.Builder
	emit := func(ev runner.Event) {
		mu.Lock()
		defer mu.Unlock()
		renderAgentEvent(&out, ev)
		if err := writeRunSSE(w, ev); err != nil {
			s.log.Error("run sse event dropped", "run", run.ID, "type", ev.Type, "err", err)
			return
		}
		flusher.Flush()
	}
	emit(runner.Event{Type: runner.EventStart, RunID: run.ID, Workdir: workdir, SessionID: sess.ID})

	// 和 claude 执行一样跟浏览器连接脱钩：关掉页面照样跑完、落库；停用 /cancel
	bg := context.WithoutCancel(ctx)
	runCtx, cancelRun := context.WithCancelCause(bg)
	defer cancelRun(nil)
	s.agentTasks.add(run.ID, cancelRun)
	defer s.agentTasks.remove(run.ID)

	x := &agentTaskExec{
		s: s, run: run, obj: obj, sess: sess, ag: ag, emit: emit, budget: budget,
		r: &agent.Runner{
			Store: s.st, Chat: chat, Model: model, Session: sess, Object: obj, Agent: ag,
			Skills: s.agentSkills(ctx, ag), Policy: policy,
			Budget: &agent.Budget{MaxSteps: budget.steps}, Unattended: true,
		},
	}
	status, reason := x.execute(runCtx, bg, prompt)
	s.settleAgentRun(bg, x, status, reason, &mu, &out)
}

// clipTitle 截到会话列表放得下的长度。
func clipTitle(t string) string {
	if utf8.RuneCountInString(t) <= 40 {
		return t
	}
	return string([]rune(t)[:40]) + "…"
}

// renderAgentEvent 把事件写进落库的过程记录，格式同 claude 执行（runner.Render），确认和决定各记一行。
func renderAgentEvent(w *strings.Builder, ev runner.Event) {
	switch ev.Type {
	case runner.EventConfirm:
		w.WriteString("\n[等待确认] " + ev.Summary + "\n")
	case runner.EventDecision:
		switch {
		case ev.Approved:
			w.WriteString("[已确认]\n")
		case ev.Reason == "timeout":
			w.WriteString("[等待超时，按拒绝处理]\n")
		default:
			w.WriteString("[已拒绝]\n")
		}
	default:
		runner.Render(w, ev)
	}
}

// agentTaskExec 是一次在跑的 Agent 执行。
type agentTaskExec struct {
	s      *Server
	run    *domain.TaskRun
	obj    *domain.Object
	sess   *domain.AgentSession
	ag     *domain.Agent
	r      *agent.Runner
	emit   func(runner.Event)
	budget agentRunBudget

	// 以下只在跑模型的那个 goroutine 里动
	seq     int
	open    []openTool
	pending []pendingCall
}

type openTool struct{ id, name string }

type pendingCall struct{ id, name, args, summary string }

// onAgent 把 Agent 的流事件翻成执行的事件：delta 原样，tool_call / tool_result 配上 id，
// confirm 先记下来，这一段跑完再一条条等人决定。
func (x *agentTaskExec) onAgent(ev agent.StreamEvent) {
	switch ev.Type {
	case "delta":
		x.emit(runner.Event{Type: runner.EventDelta, Text: ev.Text})
	case "tool_call":
		x.seq++
		id := fmt.Sprintf("t%d", x.seq)
		x.open = append(x.open, openTool{id: id, name: ev.Name})
		x.emit(runner.Event{Type: runner.EventTool, ID: id, Name: ev.Name, Detail: argBrief(ev.Args)})
	case "tool_result":
		// 拒绝了的调用没执行：确认卡片上已经写了「已拒绝」，不再多一张工具卡
		if strings.HasPrefix(ev.Summary, "用户拒绝了：") {
			return
		}
		id := ""
		for i := len(x.open) - 1; i >= 0; i-- {
			if x.open[i].name == ev.Name {
				id = x.open[i].id
				x.open = append(x.open[:i], x.open[i+1:]...)
				break
			}
		}
		if id == "" {
			x.seq++
			id = fmt.Sprintf("t%d", x.seq)
		}
		ok := !toolFailed(ev.Summary)
		e := runner.Event{Type: runner.EventToolResult, ID: id, Name: ev.Name, OK: ok, Summary: ev.Summary}
		if !ok {
			e.Message = ev.Summary
		}
		x.emit(e)
	case "artifact":
		var size int64
		if ev.Size != nil {
			size = *ev.Size
		}
		x.emit(runner.Event{Type: runner.EventArtifact, Path: ev.Path, Size: size, IsNew: true})
	case "confirm":
		x.pending = append(x.pending, pendingCall{id: ev.ID, name: ev.Name, args: ev.Args, summary: ev.Summary})
	}
}

// toolFailed 认工具结果是不是失败：agent 的 ToolResult 没有成败位，失败和没授权的摘要有固定说法（tools.go failed、grants.go deniedResult）。
func toolFailed(summary string) bool {
	return strings.Contains(summary, "执行失败：") || strings.Contains(summary, "没有授权，没有执行")
}

// argBrief 把工具参数压成一行给卡片当说明。
func argBrief(args string) string {
	t := strings.Join(strings.Fields(args), " ")
	if t == "{}" {
		return ""
	}
	if utf8.RuneCountInString(t) > 120 {
		return string([]rune(t)[:120]) + "…"
	}
	return t
}

// segment 跑一段（Run 或 Resume）：时长截止按 deadline，会话页的「停止」也能停它。回这一段的错误，原因已经归好类。
func (x *agentTaskExec) segment(runCtx context.Context, deadline time.Time, f func(context.Context) error) error {
	segCtx, cancel := context.WithDeadline(runCtx, deadline)
	defer cancel()
	tctx, done := x.s.turns.start(segCtx, x.sess.ID)
	defer done()
	err := f(tctx)
	if err == nil {
		return nil
	}
	switch {
	case errors.Is(context.Cause(runCtx), errRunCanceled):
		return errAgentRunCanceled{"已取消"}
	case stoppedByUser(tctx):
		return errAgentRunCanceled{"在会话里手动停止了"}
	case errors.Is(segCtx.Err(), context.DeadlineExceeded) && runCtx.Err() == nil:
		return fmt.Errorf("超过时长上限（%d 分钟）还没做完，已停下。已经执行的操作不会撤回；可以调大时长上限后续跑，或者把任务拆小", x.budget.minutes)
	}
	if ue, ok := agent.AsUnavailable(err); ok {
		return fmt.Errorf("服务商不可用，执行失败：%s", ue.Error())
	}
	return err
}

// errAgentRunCanceled 是执行被取消（不算失败）。
type errAgentRunCanceled struct{ why string }

func (e errAgentRunCanceled) Error() string { return e.why }

// execute 跑完这次执行：先 Run，之后每条要确认的调用等人决定再 Resume。回最终状态和原因（done 时为空）。
func (x *agentTaskExec) execute(runCtx, bg context.Context, prompt string) (string, string) {
	deadline := time.Now().Add(x.budget.duration)
	err := x.segment(runCtx, deadline, func(c context.Context) error {
		_, err := x.r.Run(c, prompt, x.onAgent)
		return err
	})
	for err == nil && len(x.pending) > 0 {
		p := x.pending[0]
		x.pending = x.pending[1:]
		waitFrom := time.Now()
		var dec *agent.Decision
		var timedOut bool
		dec, timedOut, err = x.await(runCtx, bg, p)
		// 等确认的时间不算进时长
		deadline = deadline.Add(time.Since(waitFrom))
		if err != nil {
			break
		}
		err = x.segment(runCtx, deadline, func(c context.Context) error {
			_, err := x.r.Resume(c, dec, x.onAgent)
			return err
		})
		if dec.Result != "" {
			res := dec.Result
			if timedOut {
				res = "等待确认超时，按拒绝处理：" + strings.TrimPrefix(res, "用户拒绝了：")
			}
			if e := x.s.st.SetAgentToolCallResult(bg, p.id, res); e != nil {
				x.s.log.Warn("save tool call result failed", "call", p.id, "err", e)
			}
		}
	}
	// 没轮到的确认（取消、失败时还排着的）一律拒掉：执行已经结束了，不该留一个确认后才执行的写操作
	for _, p := range x.pending {
		x.dropPending(bg, p.id, "执行已经结束，没有执行")
	}
	if err == nil {
		return domain.RunDone, ""
	}
	var c errAgentRunCanceled
	if errors.As(err, &c) {
		return domain.RunCanceled, c.why
	}
	return domain.RunFailed, err.Error()
}

// await 等一次要确认的调用的决定：人点了（任何页面）、等待超时（按拒绝）、执行被取消。
// 执行记录在等的时候是 waiting，流里发 confirm、decision。timedOut 为真是超时按拒绝处理的。
func (x *agentTaskExec) await(runCtx, bg context.Context, p pendingCall) (dec *agent.Decision, timedOut bool, err error) {
	st := x.s.st
	ch := x.s.agentTasks.wait(p.id)
	if err := st.SetTaskRunStatus(bg, x.run.ID, domain.RunWaiting); err != nil {
		x.s.log.Warn("set task run waiting failed", "run", x.run.ID, "err", err)
	}
	x.emit(runner.Event{Type: runner.EventConfirm, ID: p.id, Name: p.name, Args: p.args, Summary: p.summary,
		Deadline: time.Now().Add(x.budget.confirmWait)})
	timer := time.NewTimer(x.budget.confirmWait)
	defer timer.Stop()

	var approved bool
	reason := "user"
	select {
	case approved = <-ch:
	case <-timer.C:
		if x.s.agentTasks.claim(p.id) == nil {
			// 人在超时那一刻点了：决定已经在路上
			approved = <-ch
			break
		}
		reason = "timeout"
		if _, err := st.DecideAgentToolCall(bg, p.id, store.ToolCallRejected); err != nil {
			x.s.log.Warn("reject timed out tool call failed", "call", p.id, "err", err)
		}
		x.s.opt.Audit.Note(bg, audit.Entry{
			Kind: audit.KindAgent, Action: "reject", TargetType: "agent_tool_call", TargetID: p.id,
			Summary: fmt.Sprintf("等待确认超时，按拒绝处理 Agent「%s」的调用 %s", x.ag.Name, p.name),
			Detail:  map[string]any{"agent_id": x.ag.ID, "session_id": x.sess.ID, "tool": p.name, "run_id": x.run.ID},
		})
	case <-runCtx.Done():
		x.s.agentTasks.claim(p.id)
		x.dropPending(bg, p.id, "执行已取消，没有执行")
		if errors.Is(context.Cause(runCtx), errRunCanceled) {
			return nil, false, errAgentRunCanceled{"已取消"}
		}
		return nil, false, runCtx.Err()
	}
	if err := st.SetTaskRunStatus(bg, x.run.ID, domain.RunRunning); err != nil {
		x.s.log.Warn("set task run running failed", "run", x.run.ID, "err", err)
	}
	x.emit(runner.Event{Type: runner.EventDecision, ID: p.id, Approved: approved, Reason: reason})
	tc, err := st.GetAgentToolCall(bg, p.id)
	if err != nil {
		return nil, false, fmt.Errorf("读取待确认的调用失败：%w", err)
	}
	return &agent.Decision{Call: tc, Approved: approved}, reason == "timeout", nil
}

// dropPending 把还在等的调用拒掉并写明原因；已经决定过的不动。
func (x *agentTaskExec) dropPending(ctx context.Context, callID, why string) {
	if _, err := x.s.st.DecideAgentToolCall(ctx, callID, store.ToolCallRejected); err != nil {
		return
	}
	if err := x.s.st.SetAgentToolCallResult(ctx, callID, why); err != nil {
		x.s.log.Warn("save tool call result failed", "call", callID, "err", err)
	}
}

// settleAgentRun 收尾：落执行记录、给任务记一条进展（结论或失败原因）、会话里留一句，再发 error / done。
func (s *Server) settleAgentRun(bg context.Context, x *agentTaskExec, status, reason string, mu *sync.Mutex, out *strings.Builder) {
	summary := ""
	if status == domain.RunDone {
		if m, err := s.lastAssistant(bg, x.sess.ID); err == nil && m != nil {
			summary = strings.TrimSpace(m.Content)
		}
	} else if status == domain.RunCanceled {
		s.noteAgentStopped(bg, x.sess.ID)
	} else {
		s.noteAgentFailure(bg, x.sess.ID, errors.New(reason))
	}
	exit := 0
	switch status {
	case domain.RunFailed:
		exit = 1
	case domain.RunCanceled:
		exit = -1
	}
	mu.Lock()
	output := out.String()
	mu.Unlock()
	if ferr := s.finishRun(bg, x.run.ID, status, exit, output, reason); ferr != nil {
		x.emit(runner.Event{Type: runner.EventError, Message: "执行已结束，但记录落库失败：" + ferr.Error()})
	} else if reason != "" {
		x.emit(runner.Event{Type: runner.EventError, Message: reason})
	}

	// 进展写给任务：完成记结论，失败记原因；取消是人自己点的，不再记一条
	var text string
	short := x.run.ID
	if len(short) > 8 {
		short = short[len(short)-8:]
	}
	switch status {
	case domain.RunDone:
		if summary == "" {
			summary = "（Agent 没有写结论）"
		}
		text = fmt.Sprintf("工作台 Agent「%s」执行完成（执行记录 %s）：\n\n%s", x.ag.Name, short, summary)
	case domain.RunFailed:
		text = fmt.Sprintf("工作台 Agent「%s」执行失败（执行记录 %s）：%s", x.ag.Name, short, reason)
	}
	if text != "" {
		actor := store.Actor{Name: "agent", Source: "agent", Session: x.sess.ID}
		if _, err := s.st.AppendProgress(bg, x.obj.ID, domain.ProgressInput{Kind: domain.ProgressNote, Text: text}, actor); err != nil {
			s.log.Warn("append agent run progress failed", "run", x.run.ID, "object", x.obj.ID, "err", err)
		}
	}
	x.emit(runner.Event{Type: runner.EventDone, RunID: x.run.ID, ExitCode: exit})
}

// lastAssistant 是会话里最新一条 Agent 回复。
func (s *Server) lastAssistant(ctx context.Context, sessionID string) (*domain.AgentMessage, error) {
	msgs, err := s.st.ListAgentMessages(ctx, sessionID, 0)
	if err != nil {
		return nil, err
	}
	for i := len(msgs) - 1; i >= 0; i-- {
		if msgs[i].Role == domain.RoleAssistant {
			return msgs[i], nil
		}
	}
	return nil, nil
}

// decideForTaskRun 是 decideToolCall 的一支：这次调用有在途的任务执行在等（已经 claim 到 ch），
// 记下决定、记审计、把决定交给执行，由执行接着跑；这里的流只回一个 done，过程在任务的执行面板里。
// 决定没记上时按拒绝交过去：执行不能一直等一个不会来的决定，拒绝是不执行的那一边。
func (s *Server) decideForTaskRun(w http.ResponseWriter, r *http.Request, flusher http.Flusher, tc *store.AgentToolCall,
	ag *domain.Agent, session *domain.AgentSession, approved bool, ch chan bool) {
	ctx := r.Context()
	state, action, verb := store.ToolCallRejected, "reject", "拒绝"
	if approved {
		state, action, verb = store.ToolCallConfirmed, "confirm", "确认"
	}
	if _, err := s.st.DecideAgentToolCall(ctx, tc.ID, state); err != nil {
		ch <- false
		s.fail(w, r, err)
		return
	}
	s.opt.Audit.Note(ctx, audit.Entry{
		Kind: audit.KindAgent, Action: action, TargetType: "agent_tool_call", TargetID: tc.ID,
		Summary: fmt.Sprintf("%s Agent「%s」的调用 %s", verb, ag.Name, tc.Tool),
		Detail:  map[string]any{"agent_id": ag.ID, "session_id": session.ID, "tool": tc.Tool, "grant_key": tc.GrantKey},
	})
	ch <- approved

	h := w.Header()
	h.Set("Content-Type", "text/event-stream; charset=utf-8")
	h.Set("Cache-Control", "no-cache")
	h.Set("Connection", "keep-alive")
	h.Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	writeSSE(w, agent.StreamEvent{Type: "done", SessionID: session.ID})
	flusher.Flush()
}
