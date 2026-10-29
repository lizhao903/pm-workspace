package sop

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"sync"
	"time"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// 执行引擎（SOP-01b），语义同原型 web-next/src/sopflow.ts 的 startRun、advance、tick、act，
// 规格见 web-next/docs/spec/sop.md「执行语义」。
//
// 每条没结束的执行一个协程（runner），只有它改这条执行的内存状态、写它的行（单写者）；
// 节点在各自的协程里执行，结果发回 runner，几路并行就是同时有几个节点协程。
// 引擎本身是插件的常驻后台任务：启用时先把库里没结束的执行接着调度（断点续跑），停用、服务关闭时取消，
// 执行中的步骤留在库里还是 running，下次启动重跑一次。

// 事件类型，清单 emits 里声明。
const (
	EventRunStatus  = "sop.run_status_changed"
	EventStepStatus = "sop.step_status_changed"
)

const maxSubflowDepth = 5

// agentPoll 是 agent 步骤停下等确认时看会话有没有新回复的间隔，测试里调小。
var agentPoll = 2 * time.Second

type engine struct {
	c plugin.Core
	// hook 在每个节点执行前调，测试用它卡住执行；返回错误就不出结果（等取消）
	hook func(ctx context.Context, runID, step string) error

	mu    sync.Mutex
	ctx   context.Context // 后台任务的 ctx，ready 关闭后才有
	runs  map[string]*runner
	ready chan struct{}
	wg    sync.WaitGroup
}

func newEngine(c plugin.Core) *engine {
	return &engine{c: c, runs: map[string]*runner{}, ready: make(chan struct{})}
}

// job 是常驻后台任务：接着调度没结束的执行，然后等取消，取消后等全部协程退出。
func (e *engine) job(ctx context.Context, _ plugin.Core) error {
	defer e.wg.Wait()
	e.mu.Lock()
	e.ctx = ctx
	e.mu.Unlock()
	ids, err := unfinishedRuns(ctx, e.c.Store())
	if err != nil {
		close(e.ready)
		return fmt.Errorf("读没结束的执行：%w", err)
	}
	for _, id := range ids {
		run, err := loadRun(ctx, e.c.Store(), id)
		if err != nil {
			e.c.Log().Error("sop run not resumed", "run", id, "err", err)
			continue
		}
		r, err := newRunner(e, run)
		if err != nil {
			e.c.Log().Error("sop run not resumed", "run", id, "err", err)
			continue
		}
		r.resume()
		e.spawn(r)
	}
	if len(ids) > 0 {
		e.c.Log().Info("sop runs resumed", "runs", len(ids))
	}
	close(e.ready)
	<-ctx.Done()
	return nil
}

// waitReady 等引擎起来（恢复执行做完），接口在这之前进来的请求等一会儿。
func (e *engine) waitReady(ctx context.Context) (context.Context, error) {
	select {
	case <-e.ready:
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-time.After(10 * time.Second):
		return nil, apiErr(errConflict, "执行引擎还没起来，稍后再试")
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.ctx == nil || e.ctx.Err() != nil {
		return nil, apiErr(errConflict, "执行引擎已经停了")
	}
	return e.ctx, nil
}

func (e *engine) spawn(r *runner) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.ctx == nil || e.ctx.Err() != nil {
		return
	}
	e.runs[r.run.ID] = r
	e.wg.Add(1)
	go r.loop(e.ctx)
}

func (e *engine) runner(id string) *runner {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.runs[id]
}

func (e *engine) remove(r *runner) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.runs[r.run.ID] == r {
		delete(e.runs, r.run.ID)
	}
}

// create 按流程当前定义的快照建一次执行，放出起点步骤，写库，交给新的 runner。
func (e *engine) create(ctx context.Context, f Flow, input Json, stepThrough bool, parentRun, parentStep string) (*Run, error) {
	ectx, err := e.waitReady(ctx)
	if err != nil {
		return nil, err
	}
	t := now()
	snap := f
	run := &Run{ID: newRunID(), FlowID: f.ID, FlowName: f.Name, FlowVersion: f.Version, Flow: &snap, Title: runTitle(f, input),
		Input: input, StepThrough: stepThrough, ParentRunID: parentRun, ParentStep: parentStep, StartedAt: t, UpdatedAt: t}
	defs, err := parseSteps(&snap)
	if err != nil {
		return nil, err
	}
	for _, d := range defs {
		run.Steps = append(run.Steps, RunStep{Key: d.Key, Status: stPending, Log: []LogLine{}})
	}
	r, err := newRunner(e, run)
	if err != nil {
		return nil, err
	}
	r.advance(t)
	run.Status = runStatus(run)
	if err := insertRun(ectx, e.c.Store(), run); err != nil {
		return nil, err
	}
	r.markSaved()
	e.publish(ectx, EventRunStatus, map[string]any{"run_id": run.ID, "flow_id": run.FlowID, "from": "", "to": run.Status})
	out := r.snapshot()
	e.spawn(r)
	return out, nil
}

// act 把动作交给这条执行的 runner，等它做完，回执行的最新状态。
func (e *engine) act(ctx context.Context, id string, a Action) (*Run, error) {
	if _, err := e.waitReady(ctx); err != nil {
		return nil, err
	}
	r := e.runner(id)
	if r == nil {
		run, err := loadRun(ctx, e.c.Store(), id)
		if err != nil {
			return nil, err
		}
		if run.Stopped || run.EndedAt != nil {
			return nil, apiErr(errConflict, "这次执行已经结束")
		}
		return nil, apiErr(errConflict, "这次执行没在调度里，稍后再试")
	}
	reply := make(chan actReply, 1)
	select {
	case r.inbox <- actMsg{a: a, reply: reply}:
	case <-r.done:
		return nil, apiErr(errConflict, "这次执行已经结束")
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	select {
	case res := <-reply:
		return res.run, res.err
	case <-r.done:
		// runner 处理完这个动作后结束了（比如终止），结果仍在 reply 里
		select {
		case res := <-reply:
			return res.run, res.err
		default:
			return nil, apiErr(errConflict, "这次执行已经结束")
		}
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

// deliver 把消息投给一条执行的 runner，不在调度里就丢掉（它恢复时会自己从库里查）。
func (e *engine) deliver(id string, m any) {
	r := e.runner(id)
	if r == nil {
		return
	}
	select {
	case r.inbox <- m:
	case <-r.done:
	}
}

func (e *engine) publish(ctx context.Context, typ string, payload any) {
	if err := e.c.Events().Publish(ctx, typ, payload); err != nil {
		e.c.Log().Warn("sop event not published", "type", typ, "err", err)
	}
}

/* ---------- runner：一条执行的单写者 ---------- */

type actMsg struct {
	a     Action
	reply chan actReply
}

type actReply struct {
	run *Run
	err error
}

// resultMsg 是节点协程发回的结果，token 对不上（步骤已经被终止、退回、重试）就丢掉。
type resultMsg struct {
	step, token int
	res         nodeResult
}

// childMsg 是子执行结束时发给父执行的通知。
type childMsg struct{ child string }

type runner struct {
	e    *engine
	run  *Run
	defs []stepDef
	idx  map[string]int

	inbox chan any
	done  chan struct{}

	seq      int
	inflight map[int]inflight // 正在执行的节点协程
	saved    []string         // 上次写库时每步的 JSON，用来只写改过的
	savedSt  []string         // 上次写库时每步的状态，用来发事件
	savedRun string           // 上次写库时的运行状态
	savedRow string           // 上次写库时运行行的几列（rowSig）
}

type inflight struct {
	token  int
	cancel context.CancelFunc
}

func newRunner(e *engine, run *Run) (*runner, error) {
	defs, err := parseSteps(run.Flow)
	if err != nil {
		return nil, err
	}
	if len(defs) != len(run.Steps) {
		return nil, fmt.Errorf("执行 %s 的步骤数和快照对不上", run.ID)
	}
	idx := map[string]int{}
	for i, d := range defs {
		idx[d.Key] = i
	}
	r := &runner{e: e, run: run, defs: defs, idx: idx, inbox: make(chan any, 16), done: make(chan struct{}), inflight: map[int]inflight{}}
	r.markSaved()
	return r, nil
}

func (r *runner) markSaved() {
	r.saved = make([]string, len(r.run.Steps))
	r.savedSt = make([]string, len(r.run.Steps))
	for i, s := range r.run.Steps {
		b, _ := json.Marshal(s)
		r.saved[i], r.savedSt[i] = string(b), s.Status
	}
	r.savedRun, r.savedRow = r.run.Status, r.rowSig()
}

func (r *runner) rowSig() string {
	return fmt.Sprint(r.run.StepThrough, r.run.Stopped, r.run.Status, tsPtr(r.run.EndedAt))
}

func (r *runner) snapshot() *Run {
	b, _ := json.Marshal(r.run)
	var out Run
	_ = json.Unmarshal(b, &out)
	return &out
}

func (r *runner) over() bool { return r.run.Stopped || r.run.EndedAt != nil }

func (r *runner) log(i int, t time.Time, text string) {
	r.run.Steps[i].Log = append(r.run.Steps[i].Log, LogLine{At: t, Text: text})
}

func (r *runner) deps(i int) []int { return depsOf(r.defs, r.idx, i) }

// resume 是服务重启后接着调度前的整理：执行中的步骤重跑一次（attempts 加 1，写节点、插件节点不加）；
// 等待节点按原到点时间继续，子流程节点接着等已经起了的子执行；paused、review 原样等人。
func (r *runner) resume() {
	t := now()
	for i := range r.run.Steps {
		s := &r.run.Steps[i]
		if s.Status != stRunning {
			continue
		}
		switch kind := r.defs[i].Kind; {
		case pluginWaiting(r.defs[i], *s):
			r.log(i, t, "服务重启后继续等插件唤醒")
		case kind == "wait" && s.WakeAt != nil:
			r.log(i, t, "服务重启后继续等待，到点时间不变")
		case kind == "subflow" && s.ChildRunID != "":
			r.log(i, t, "服务重启后继续等子流程")
		case isWriteKind(kind):
			// 写节点按原来那次尝试重跑，写过的按幂等键取回，不重复写（SOP-02a）
			s.StartedAt = &t
			r.log(i, t, "服务重启后重跑，这次尝试写过的不再写")
		case isPluginKind(kind):
			// 插件节点也按原来那次尝试重跑，由插件按运行 id、步骤 key、尝试次数去重（POL-02，例：发消息不重复发）
			s.StartedAt = &t
			r.log(i, t, "服务重启后重跑同一次尝试")
		default:
			s.Attempts++
			s.StartedAt = &t
			s.WakeAt, s.ChildRunID = nil, ""
			r.log(i, t, "服务重启后重跑")
		}
	}
}

func (r *runner) loop(ctx context.Context) {
	defer r.e.wg.Done()
	defer close(r.done)
	defer r.e.remove(r)
	r.advance(now())
	r.dispatch(ctx)
	r.save(ctx)
	for !r.over() {
		select {
		case <-ctx.Done():
			r.cancelAll()
			return
		case m := <-r.inbox:
			switch m := m.(type) {
			case actMsg:
				err := r.apply(ctx, m.a)
				if err == nil {
					r.advance(now())
					r.dispatch(ctx)
				}
				r.save(ctx)
				if err != nil {
					m.reply <- actReply{err: err}
				} else {
					m.reply <- actReply{run: r.snapshot()}
				}
			case resultMsg:
				r.finish(m)
				r.advance(now())
				r.dispatch(ctx)
				r.save(ctx)
			case childMsg:
				r.childEnded(ctx, m.child)
				r.advance(now())
				r.dispatch(ctx)
				r.save(ctx)
			case resumeMsg:
				err := r.resumeStep(m)
				if err == nil {
					r.advance(now())
					r.dispatch(ctx)
				}
				r.save(ctx)
				m.reply <- err
			}
		}
	}
	r.cancelAll()
	if r.run.ParentRunID != "" {
		r.e.wg.Add(1)
		go func() {
			defer r.e.wg.Done()
			r.e.deliver(r.run.ParentRunID, childMsg{child: r.run.ID})
		}()
	}
}

func (r *runner) cancelAll() {
	for i, f := range r.inflight {
		f.cancel()
		delete(r.inflight, i)
	}
}

func (r *runner) cancelStep(i int) {
	if f, ok := r.inflight[i]; ok {
		f.cancel()
		delete(r.inflight, i)
	}
}

// inputFor 同原型：没有依赖用执行参数；一路依赖用它的输出；汇合时按上游 key 分组（没走到的分支不算）。
func (r *runner) inputFor(i int) (Json, []string) {
	var keys []string
	var live []int
	for _, j := range r.deps(i) {
		if r.run.Steps[j].Status != stBypassed {
			live = append(live, j)
			keys = append(keys, r.defs[j].Key)
		}
	}
	switch len(live) {
	case 0:
		return clone(r.run.Input), keys
	case 1:
		return orEmpty(clone(r.run.Steps[live[0]].Output)), keys
	}
	out := Json{}
	for _, j := range live {
		out[r.defs[j].Key] = orEmpty(clone(r.run.Steps[j].Output))
	}
	return out, keys
}

func orEmpty(v Json) Json {
	if v == nil {
		return Json{}
	}
	return v
}

func clone(v Json) Json {
	if v == nil {
		return nil
	}
	b, _ := json.Marshal(v)
	var out Json
	_ = json.Unmarshal(b, &out)
	return out
}

// advance 同原型：把依赖都结束的步骤放出来，没选中的分支标 bypassed，循环到不动为止。
func (r *runner) advance(t time.Time) {
	if r.run.Stopped {
		return
	}
	for changed := true; changed; {
		changed = false
		for i := range r.run.Steps {
			s := &r.run.Steps[i]
			if s.Status != stPending {
				continue
			}
			deps := r.deps(i)
			if slices.ContainsFunc(deps, func(j int) bool { return !finished(r.run.Steps[j].Status) }) {
				continue
			}
			def := r.defs[i]
			branchOff := false
			if def.Branch != nil {
				j, ok := r.idx[def.Branch.Of]
				branchOff = !ok || r.run.Steps[j].Route != def.Branch.Case
			}
			allBypassed := len(deps) > 0 && !slices.ContainsFunc(deps, func(j int) bool { return r.run.Steps[j].Status != stBypassed })
			if branchOff || allBypassed {
				s.Status = stBypassed
				r.log(i, t, "所在分支未被选中，不执行")
			} else {
				s.Input, _ = r.inputFor(i)
				s.Output, s.Error, s.WakeAt, s.ChildRunID = nil, "", nil, ""
				if r.run.StepThrough {
					s.Status = stPaused
					r.log(i, t, "执行前暂停，等待确认输入")
				} else {
					s.Status = stRunning
					s.StartedAt = &t
					s.Attempts++
					r.log(i, t, "开始执行")
				}
			}
			changed = true
		}
	}
	if r.run.EndedAt == nil && !slices.ContainsFunc(r.run.Steps, func(s RunStep) bool { return !finished(s.Status) }) {
		r.run.EndedAt = &t
	}
}

// dispatch 给每个 running 但还没在执行的步骤起节点协程；等待、子流程节点先把到点时间、子执行落下来。
func (r *runner) dispatch(ctx context.Context) {
	if r.over() {
		return
	}
	// 不再执行中、也不在等 Agent 确认的步骤，收掉它的协程（比如等确认时被人工放行）
	for i, f := range r.inflight {
		if _, ok := waitingAgent(r.defs[i], r.run.Steps[i]); !ok && r.run.Steps[i].Status != stRunning {
			f.cancel()
			delete(r.inflight, i)
		}
	}
	r.watchAgents(ctx)
	for i := range r.run.Steps {
		s := &r.run.Steps[i]
		if s.Status != stRunning {
			continue
		}
		if _, busy := r.inflight[i]; busy {
			continue
		}
		def := r.defs[i]
		if pluginWaiting(def, *s) {
			// 挂起的插件节点不起协程，等 Resume
			r.inflight[i] = inflight{token: -1, cancel: func() {}}
			continue
		}
		switch def.Kind {
		case "subflow":
			r.startSubflow(ctx, i)
			continue
		case "wait":
			if s.WakeAt == nil {
				d, err := parseWait(def.Config["duration"])
				if err != nil {
					r.fail(i, now(), err.Error())
					continue
				}
				at := now().Add(d)
				s.WakeAt = &at
				r.log(i, now(), "等到 "+at.Local().Format("2006-01-02 15:04:05"))
			}
		}
		r.seq++
		token := r.seq
		sctx, cancel := context.WithCancel(ctx)
		r.inflight[i] = inflight{token: token, cancel: cancel}
		input, keys := clone(s.Input), slices.Clone(keyList(r, i))
		wake := s.WakeAt
		wr := writeRun{runID: r.run.ID, flowID: r.run.FlowID, flowName: r.run.FlowName, step: def.Key, attempt: s.Attempts}
		r.e.wg.Add(1)
		go func() {
			defer r.e.wg.Done()
			defer cancel()
			if h := r.e.hook; h != nil {
				if err := h(sctx, r.run.ID, def.Key); err != nil {
					return
				}
			}
			var res nodeResult
			if def.Kind == "wait" {
				if err := sleepUntil(sctx, *wake); err != nil {
					return
				}
				res = nodeResult{output: with(orEmpty(input), "waited", orDefault(def.Config["duration"], "1 小时"))}
			} else if isWriteKind(def.Kind) {
				res = runWrite(sctx, r.e.c, wr, def, orEmpty(input))
			} else if isPluginKind(def.Kind) {
				res = runPluginNode(sctx, r.e.c, wr, def, orEmpty(input))
			} else {
				res = execNode(sctx, r.e.c, def, orEmpty(input), keys)
			}
			select {
			case r.inbox <- resultMsg{step: i, token: token, res: res}:
			case <-sctx.Done():
			}
		}()
	}
}

// watchAgents 给停下等确认的 agent 步骤起协程看会话，出了新回复按结果发回来（服务重启后也接着看）。
func (r *runner) watchAgents(ctx context.Context) {
	for i := range r.run.Steps {
		st, ok := waitingAgent(r.defs[i], r.run.Steps[i])
		if !ok {
			continue
		}
		if _, busy := r.inflight[i]; busy {
			continue
		}
		r.seq++
		token := r.seq
		sctx, cancel := context.WithCancel(ctx)
		r.inflight[i] = inflight{token: token, cancel: cancel}
		input, every := orEmpty(clone(r.run.Steps[i].Input)), agentPoll
		step := i
		r.e.wg.Add(1)
		go func() {
			defer r.e.wg.Done()
			defer cancel()
			res, ok := watchAgent(sctx, r.e.c.Agent(), input, st, every)
			if !ok {
				return
			}
			select {
			case r.inbox <- resultMsg{step: step, token: token, res: res}:
			case <-sctx.Done():
			}
		}()
	}
}

func keyList(r *runner, i int) []string {
	var keys []string
	for _, j := range r.deps(i) {
		if r.run.Steps[j].Status != stBypassed {
			keys = append(keys, r.defs[j].Key)
		}
	}
	return keys
}

func orDefault(s, d string) string {
	if s == "" {
		return d
	}
	return s
}

func (r *runner) fail(i int, t time.Time, msg string) {
	s := &r.run.Steps[i]
	s.Status, s.Error, s.EndedAt = stFailed, msg, &t
	r.log(i, t, "失败："+msg)
}

// finish 同原型 tick 里一步出结果：失败、分支节点自动判断、人工判断、人工检查、其余完成。
func (r *runner) finish(m resultMsg) {
	f, ok := r.inflight[m.step]
	if !ok || f.token != m.token {
		return
	}
	delete(r.inflight, m.step)
	s := &r.run.Steps[m.step]
	def := r.defs[m.step]
	if _, ok := waitingAgent(def, *s); ok {
		// 人在会话里确认后 Agent 接着跑完了
		t := now()
		s.Status, s.Output, s.EndedAt = stDone, m.res.output, &t
		r.log(m.step, t, "会话里已经确认，Agent 跑完了这一轮，这一步完成")
		return
	}
	if s.Status != stRunning {
		return
	}
	t := now()
	res := m.res
	if res.log != "" {
		r.log(m.step, t, res.log)
	}
	switch {
	case res.err != "":
		r.fail(m.step, t, res.err)
	case res.waiting != "":
		s.Output = waitingMark(def.Kind, res.waiting)
		r.inflight[m.step] = inflight{token: -1, cancel: func() {}}
		r.log(m.step, t, "挂起："+res.waiting+"，等插件唤醒")
	case res.route != "":
		s.Status, s.Output, s.Route, s.RouteReason, s.EndedAt = stDone, res.output, res.route, res.reason, &t
		r.log(m.step, t, fmt.Sprintf("判断结果：走「%s」，%s", caseLabel(def, res.route), res.reason))
	case res.review && def.Kind == "agent":
		s.Status, s.Output = stReview, res.output
	case res.review && def.Kind == "decide":
		s.Status, s.Output = stReview, res.output
		r.log(m.step, t, "等待人工判断走哪个分支")
	case res.review:
		s.Status, s.Output = stReview, res.output
		r.log(m.step, t, "已就绪，等待人工检查")
	default:
		s.Status, s.Output, s.EndedAt = stDone, res.output, &t
		used := 0.0
		if s.StartedAt != nil {
			used = t.Sub(*s.StartedAt).Seconds()
		}
		r.log(m.step, t, fmt.Sprintf("完成，用时 %.1fs", used))
	}
}

func caseLabel(def stepDef, key string) string {
	for _, c := range def.Cases {
		if c.Key == key {
			return c.Label
		}
	}
	return key
}

/* ---------- 子流程 ---------- */

// startSubflow 起一条子执行（输入是这一步的输入），记下子执行 id；已经起过的（重启后）去库里看它结束没有。
func (r *runner) startSubflow(ctx context.Context, i int) {
	s := &r.run.Steps[i]
	if s.ChildRunID != "" {
		r.inflight[i] = inflight{token: -1, cancel: func() {}}
		r.childEnded(ctx, s.ChildRunID)
		return
	}
	t := now()
	if d := r.depth(ctx); d >= maxSubflowDepth {
		r.fail(i, t, fmt.Sprintf("子流程嵌套超过 %d 层", maxSubflowDepth))
		return
	}
	ref := r.defs[i].Config["sop"]
	f, err := findFlow(ctx, r.e.c, ref)
	if err != nil {
		if errors.Is(err, errNotFound) {
			r.fail(i, t, fmt.Sprintf("子流程「%s」不存在", ref))
		} else {
			r.fail(i, t, "起子流程失败："+err.Error())
		}
		return
	}
	input, err := fillInput(f, orEmpty(clone(s.Input)))
	if err != nil {
		_, msg, _ := cutKind(err)
		r.fail(i, t, "子流程的输入不全："+msg)
		return
	}
	child, err := r.e.create(ctx, f, input, r.run.StepThrough, r.run.ID, r.defs[i].Key)
	if err != nil {
		r.fail(i, t, "起子流程失败："+err.Error())
		return
	}
	s.ChildRunID = child.ID
	r.inflight[i] = inflight{token: -1, cancel: func() {}}
	r.log(i, t, fmt.Sprintf("起了子执行 %s（%s），等它结束", child.ID, f.Name))
}

// childEnded 子执行结束后结算父执行里对应的那一步：完成就带上子执行的结果，被终止算失败。
func (r *runner) childEnded(ctx context.Context, childID string) {
	i := slices.IndexFunc(r.run.Steps, func(s RunStep) bool { return s.Status == stRunning && s.ChildRunID == childID })
	if i < 0 {
		return
	}
	child, err := loadRun(ctx, r.e.c.Store(), childID)
	if err != nil {
		r.fail(i, now(), "读子执行失败："+err.Error())
		delete(r.inflight, i)
		return
	}
	if !child.Stopped && child.EndedAt == nil {
		return
	}
	delete(r.inflight, i)
	t := now()
	s := &r.run.Steps[i]
	if child.Stopped {
		r.fail(i, t, "子流程被终止")
		return
	}
	s.Status, s.EndedAt = stDone, &t
	s.Output = with(orEmpty(clone(s.Input)), "subflow", map[string]any{
		"run_id": child.ID, "flow_id": child.FlowID, "sop": child.FlowName, "status": "done", "output": childOutput(child),
	})
	r.log(i, t, "子流程已完成")
}

// childOutput 是子执行的结果：没有下游的、完成了的步骤的输出；只有一个就是它，多个按步骤 key 分开。
func childOutput(c *Run) Json {
	defs, _ := parseSteps(c.Flow)
	idx := map[string]int{}
	for i, d := range defs {
		idx[d.Key] = i
	}
	hasDown := make([]bool, len(defs))
	for i := range defs {
		for _, j := range depsOf(defs, idx, i) {
			hasDown[j] = true
		}
	}
	out := Json{}
	var last Json
	n := 0
	for i, s := range c.Steps {
		if hasDown[i] || (s.Status != stDone && s.Status != stSkipped) {
			continue
		}
		n++
		last = orEmpty(s.Output)
		out[s.Key] = last
	}
	if n == 1 {
		return last
	}
	return out
}

func (r *runner) depth(ctx context.Context) int {
	d, id := 0, r.run.ParentRunID
	for id != "" && d <= maxSubflowDepth {
		d++
		var parent *string
		if err := r.e.c.Store().QueryRow(ctx, `SELECT parent_run_id FROM sop_runs WHERE id = ?`, id).Scan(&parent); err != nil || parent == nil {
			break
		}
		id = *parent
	}
	return d
}

// findFlow 按 id 找流程，找不到再按名称找（原型存的是流程名）。
func findFlow(ctx context.Context, c plugin.Core, ref string) (Flow, error) {
	fl := &flows{c: c}
	f, err := fl.get(ctx, ref)
	if err == nil || !errors.Is(err, errNotFound) {
		return f, err
	}
	f, err = scanFlow(c.Store().QueryRow(ctx, `SELECT `+flowCols+` FROM sop_flows WHERE name = ? ORDER BY created_at LIMIT 1`, ref))
	if errors.Is(err, plugin.ErrNoRows) {
		return Flow{}, apiErr(errNotFound, "流程 %s 不存在", ref)
	}
	return f, err
}

func cutKind(err error) (string, string, bool) {
	s := err.Error()
	for i := 0; i+1 < len(s); i++ {
		if s[i] == ':' && s[i+1] == ' ' {
			return s[:i], s[i+2:], true
		}
	}
	return "", s, false
}

/* ---------- 动作 ---------- */

// stepOf 认 step：下标（从 0 起）或步骤 key。
func (r *runner) stepOf(raw json.RawMessage) (int, error) {
	if len(raw) == 0 || string(raw) == "null" {
		return 0, apiErr(errValidation, "要带 step")
	}
	var n int
	if err := json.Unmarshal(raw, &n); err == nil {
		if n < 0 || n >= len(r.run.Steps) {
			return 0, apiErr(errValidation, "step %d 超出范围", n)
		}
		return n, nil
	}
	var k string
	if err := json.Unmarshal(raw, &k); err == nil {
		if i, ok := r.idx[k]; ok {
			return i, nil
		}
		return 0, apiErr(errValidation, "步骤 %s 不存在", k)
	}
	return 0, apiErr(errValidation, "step 要是下标或步骤 key")
}

// apply 同原型 act，另外按规格的「什么时候能做」挡掉不合适的动作（409）。
func (r *runner) apply(ctx context.Context, a Action) error {
	t := now()
	switch a.Kind {
	case "stop":
		r.run.Stopped, r.run.EndedAt = true, &t
		for i := range r.run.Steps {
			s := &r.run.Steps[i]
			if s.Status == stRunning || s.Status == stPaused || s.Status == stReview {
				if s.ChildRunID != "" {
					child := s.ChildRunID
					r.e.wg.Add(1)
					go func() {
						defer r.e.wg.Done()
						_, _ = r.e.act(ctx, child, Action{Kind: "stop"})
					}()
				}
				r.cancelStep(i)
				s.Status = stPending
				r.log(i, t, "执行被终止")
			}
		}
		return nil
	case "step-through":
		r.run.StepThrough = *a.On
		return nil
	}
	i, err := r.stepOf(a.Step)
	if err != nil {
		return err
	}
	s := &r.run.Steps[i]
	def := r.defs[i]
	branching := isBranching(def.Kind)
	switch a.Kind {
	case "confirm-input":
		if s.Status != stPaused {
			return apiErr(errConflict, "这一步不在等确认输入")
		}
		s.Status, s.StartedAt = stRunning, &t
		s.Attempts++
		if a.Input != nil {
			s.Input, s.Edited = a.Input, "input"
			r.log(i, t, "输入已修改，开始执行")
		} else {
			r.log(i, t, "输入已确认，开始执行")
		}
	case "approve":
		if s.Status != stReview || branching {
			return apiErr(errConflict, "这一步不在等人工检查")
		}
		s.Status, s.EndedAt = stDone, &t
		if a.Output != nil {
			s.Output, s.Edited = a.Output, "output"
			r.log(i, t, "输出已修改并放行")
		} else {
			r.log(i, t, "检查通过")
		}
	case "route":
		if s.Status != stReview || !branching {
			return apiErr(errConflict, "这一步不在等人工判断")
		}
		if !slices.ContainsFunc(def.Cases, func(c Case) bool { return c.Key == a.Route }) {
			return apiErr(errValidation, "分支 %s 不存在", a.Route)
		}
		s.Status, s.Route, s.RouteReason, s.Edited, s.EndedAt = stDone, a.Route, "人工判断", "route", &t
		r.log(i, t, fmt.Sprintf("人工判断：走「%s」", caseLabel(def, a.Route)))
	case "rework":
		if s.Status != stReview || branching {
			return apiErr(errConflict, "只有等人工检查的步骤能退回")
		}
		var ups []int
		for _, j := range r.deps(i) {
			if r.run.Steps[j].Status != stBypassed {
				ups = append(ups, j)
			}
		}
		if len(ups) == 0 {
			return apiErr(errConflict, "这一步没有可以退回的上游")
		}
		s.Status, s.Output = stPending, nil
		r.log(i, t, "退回上游重做")
		for _, j := range ups {
			u := &r.run.Steps[j]
			r.cancelStep(j)
			u.Status, u.Output, u.StartedAt, u.EndedAt, u.Edited = stRunning, nil, &t, nil, ""
			u.Route, u.RouteReason, u.Error, u.WakeAt, u.ChildRunID = "", "", "", nil, ""
			u.Attempts++
			r.log(j, t, "被下游退回，重新执行")
		}
	case "retry":
		if s.Status != stFailed {
			return apiErr(errConflict, "这一步没有失败")
		}
		s.Status, s.Error, s.StartedAt, s.EndedAt, s.WakeAt, s.ChildRunID = stRunning, "", &t, nil, nil, ""
		s.Attempts++
		r.log(i, t, fmt.Sprintf("第 %d 次尝试", s.Attempts))
	case "skip":
		if s.Status != stFailed && (s.Status != stPaused || branching) {
			return apiErr(errConflict, "只有失败的步骤、或等确认输入的非分支步骤能跳过")
		}
		s.Status, s.Output, s.Error, s.EndedAt = stSkipped, clone(s.Input), "", &t
		r.log(i, t, "已跳过，输入原样传给下游")
	}
	return nil
}

/* ---------- 写库 ---------- */

// save 写改过的步骤和运行行，状态变了发事件。写失败只记日志，下次再写。
func (r *runner) save(ctx context.Context) {
	st := r.e.c.Store()
	r.run.Status = runStatus(r.run)
	dirty := false
	for i, s := range r.run.Steps {
		b, _ := json.Marshal(s)
		if string(b) == r.saved[i] {
			continue
		}
		dirty = true
		if err := updateStep(ctx, st, r.run.ID, i, s); err != nil {
			if ctx.Err() == nil {
				r.e.c.Log().Error("sop step not saved", "run", r.run.ID, "step", s.Key, "err", err)
			}
			continue
		}
		r.saved[i] = string(b)
		if r.savedSt[i] != s.Status {
			r.e.publish(ctx, EventStepStatus, map[string]any{"run_id": r.run.ID, "step": s.Key, "from": r.savedSt[i], "to": s.Status, "attempts": s.Attempts})
			r.savedSt[i] = s.Status
		}
	}
	if !dirty && r.rowSig() == r.savedRow {
		return
	}
	r.run.UpdatedAt = now()
	if err := updateRunRow(ctx, st, r.run); err != nil {
		if ctx.Err() == nil {
			r.e.c.Log().Error("sop run not saved", "run", r.run.ID, "err", err)
		}
		return
	}
	r.savedRow = r.rowSig()
	if r.run.Status != r.savedRun {
		r.e.publish(ctx, EventRunStatus, map[string]any{"run_id": r.run.ID, "flow_id": r.run.FlowID, "from": r.savedRun, "to": r.run.Status})
		r.savedRun = r.run.Status
	}
}
