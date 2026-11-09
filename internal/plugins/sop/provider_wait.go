package sop

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// 等服务商恢复（TSK-0392）：调模型的步骤因为服务商不可用（内核熔断中、或重试用完仍是 5xx / 连不上）失败时，
// 自动发起的执行（IM 消息、定时、插件、子流程）不标失败，挂起成「等服务商恢复」：步骤仍是 running，不占模型名额，
// 到内核给的探测时间、或同一服务商有别的步骤重跑成功时，原地重跑这一步（同一条执行，不新建，所以不会按同一条消息重复建任务）。
// 最多等到执行发起后 providerWaitMax，过了就照常失败。手动发起的执行有人在看，直接失败。
// 不管挂起还是失败，运行异常都按服务商记成一条（指纹 sop:provider:<服务商 id>），标题写明影响几次执行，正文给修复指引；
// 每条执行第一次挂起时记一次，之后重跑再被挡下不再记；同一服务商最快 incidentEvery 写一次，窗口内的攒着到点写最新的。
// 挂起的状态只在内存里：服务重启后执行中的步骤本来就会重跑一次，还不通会重新挂起。

type providerOutage = plugin.ProviderUnavailableError

var (
	// providerWaitMax 是执行发起后最多等多久，和 IM 触发只发起 24 小时内的消息一致
	providerWaitMax = 24 * time.Hour
	// providerRetryMin 是挂起后最早多久重跑，免得探测时间已过时立刻打转
	providerRetryMin = 5 * time.Second
	// providerRetryDefault 是服务商还没熔断（重试用完但没到熔断次数）时多久重跑
	providerRetryDefault = time.Minute
)

// providerWaitSources 是会挂起等服务商的发起来源：没人盯着的自动执行。
var providerWaitSources = map[string]bool{SourceIM: true, SourceSchedule: true, SourcePlugin: true, SourceSubflow: true}

// waitsForProvider 是会挂起的节点：经 Complete 调模型的几种。agent 节点每跑一次新建一个会话，不自动重跑。
func waitsForProvider(kind string) bool {
	switch kind {
	case "ai", "extract", "classifier", "iterate":
		return true
	}
	return false
}

// StepProviderWait 是挂起等服务商恢复的步骤标记，接口回执行时带上（同 Queue，不落库）。
type StepProviderWait struct {
	ProviderID string    `json:"provider_id"`
	Provider   string    `json:"provider"`
	Reason     string    `json:"reason"`
	Since      time.Time `json:"since"`
	RetryAt    time.Time `json:"retry_at"`
}

// providerRetryMsg 是挂起的步骤到点重跑，token 对不上就丢掉。
type providerRetryMsg struct{ step, token int }

// providerWaits 是引擎里挂起的步骤，零值可用。
type providerWaits struct {
	mu    sync.Mutex
	steps map[string]map[string]*StepProviderWait // 执行 id → 步骤 key
	// recovered 是每个服务商一个，有步骤重跑成功时关掉，叫醒同一服务商挂起的其他步骤
	recovered map[string]chan struct{}
	// inc 是每个服务商那条运行异常的写入节奏（见 noteOutage）
	inc map[string]*outageIncident
}

// outageIncident 是一个服务商那条运行异常的写入状态：last 上次写的时间，pending 是攒着等写的最新一份，
// failed 是这次故障里直接失败的执行数（服务商恢复时清零）。
type outageIncident struct {
	last    time.Time
	pending func(affected int) plugin.Incident
	timer   bool
	failed  int
}

// incidentEvery 是同一服务商的运行异常最快多久写一次：比内核的合并窗口（1 分钟）长一点，
// 保证每次写都会用新的标题（影响几次执行）和正文覆盖；窗口内来的攒着，到点写最新的一份。
var incidentEvery = time.Minute + 5*time.Second

// hold 记下（或更新）一步的挂起，回是不是这条执行这一步第一次挂起。
func (w *providerWaits) hold(runID, key string, ue *providerOutage, t, retry time.Time) bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.steps == nil {
		w.steps = map[string]map[string]*StepProviderWait{}
	}
	m := w.steps[runID]
	if m == nil {
		m = map[string]*StepProviderWait{}
		w.steps[runID] = m
	}
	cur := m[key]
	first := cur == nil || cur.ProviderID != ue.ProviderID
	since := t
	if !first {
		since = cur.Since
	}
	m[key] = &StepProviderWait{ProviderID: ue.ProviderID, Provider: ue.Provider, Reason: ue.Cause, Since: since.UTC(), RetryAt: retry.UTC()}
	return first
}

// drop 去掉一步的挂起，回原来的（没有为 nil）。
func (w *providerWaits) drop(runID, key string) *StepProviderWait {
	w.mu.Lock()
	defer w.mu.Unlock()
	m := w.steps[runID]
	cur := m[key]
	if cur == nil {
		return nil
	}
	delete(m, key)
	if len(m) == 0 {
		delete(w.steps, runID)
	}
	return cur
}

// get 取一条执行挂起的步骤（拷贝）。
func (w *providerWaits) get(runID string) map[string]StepProviderWait {
	w.mu.Lock()
	defer w.mu.Unlock()
	if len(w.steps[runID]) == 0 {
		return nil
	}
	out := map[string]StepProviderWait{}
	for k, v := range w.steps[runID] {
		out[k] = *v
	}
	return out
}

// runsOn 是在等这个服务商的执行 id；alive 判断执行还在调度，不在的（终止了）顺手清掉。
func (w *providerWaits) runsOn(providerID string, alive func(runID string) bool) []string {
	w.mu.Lock()
	var ids []string
	for id, m := range w.steps {
		for _, v := range m {
			if v.ProviderID == providerID {
				ids = append(ids, id)
				break
			}
		}
	}
	w.mu.Unlock()
	out := ids[:0]
	for _, id := range ids {
		if alive(id) {
			out = append(out, id)
			continue
		}
		w.mu.Lock()
		delete(w.steps, id)
		w.mu.Unlock()
	}
	return out
}

func (w *providerWaits) recoveredCh(providerID string) chan struct{} {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.recovered == nil {
		w.recovered = map[string]chan struct{}{}
	}
	ch := w.recovered[providerID]
	if ch == nil {
		ch = make(chan struct{})
		w.recovered[providerID] = ch
	}
	return ch
}

func (w *providerWaits) recover(providerID string) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if st := w.inc[providerID]; st != nil {
		st.failed = 0
	}
	if ch := w.recovered[providerID]; ch != nil {
		close(ch)
		delete(w.recovered, providerID)
	}
}

/* ---------- 执行 ---------- */

// outageAgent 包住 Core.Agent()，记下 Complete 回的服务商不可用。
type outageAgent struct {
	plugin.AgentService
	mu  sync.Mutex
	err *providerOutage
}

func (a *outageAgent) Complete(ctx context.Context, req plugin.CompleteRequest) (string, error) {
	out, err := a.AgentService.Complete(ctx, req)
	if ue, ok := plugin.AsProviderUnavailable(err); ok {
		a.mu.Lock()
		a.err = ue
		a.mu.Unlock()
	}
	return out, err
}

func (a *outageAgent) last() *providerOutage {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.err
}

// outageCore 让节点经 outageAgent 调模型，其余照旧。
type outageCore struct {
	plugin.Core
	ag *outageAgent
}

func (c outageCore) Agent() plugin.AgentService { return c.ag }

// execGuarded 同 execNode；会挂起的节点失败时标上是不是服务商不可用。im 是流程的触发方式是不是 IM 消息（失败文案要用）。
func execGuarded(ctx context.Context, c plugin.Core, def stepDef, input Json, deps []string, im bool) nodeResult {
	if !waitsForProvider(def.Kind) {
		return execNode(ctx, c, def, input, deps, im)
	}
	ag := &outageAgent{AgentService: c.Agent()}
	res := execNode(ctx, outageCore{Core: c, ag: ag}, def, input, deps, im)
	if res.err != "" && ctx.Err() == nil {
		res.outage = ag.last()
	}
	return res
}

// engineCtx 是后台任务的 ctx，引擎停了为 nil。
func (e *engine) engineCtx() context.Context {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.ctx == nil || e.ctx.Err() != nil {
		return nil
	}
	return e.ctx
}

// settleProvider 是一步出了不是「服务商不可用」的结果：挂起过的去掉；成功了说明服务商恢复，叫醒同一服务商挂起的步骤。
func (r *runner) settleProvider(i int, t time.Time, res nodeResult) {
	if res.outage != nil {
		return
	}
	pw := r.e.pwaits.drop(r.run.ID, r.defs[i].Key)
	if pw == nil || res.err != "" {
		return
	}
	r.log(i, t, fmt.Sprintf("服务商「%s」恢复了，重跑这一步", pw.Provider))
	r.e.pwaits.recover(pw.ProviderID)
}

// holdForProvider 把服务商不可用的一步挂起等恢复，挂不了（手动发起的、不是调模型的节点、等太久了）回 false。
func (r *runner) holdForProvider(i int, t time.Time, ue *providerOutage) bool {
	def := r.defs[i]
	if !providerWaitSources[r.run.Source] || !waitsForProvider(def.Kind) || t.Sub(r.run.StartedAt) >= providerWaitMax {
		return false
	}
	ctx := r.e.engineCtx()
	if ctx == nil {
		return false
	}
	retry := ue.RetryAt
	if !ue.Open || retry.IsZero() {
		retry = t.Add(providerRetryDefault)
	}
	if earliest := t.Add(providerRetryMin); retry.Before(earliest) {
		retry = earliest
	}
	first := r.e.pwaits.hold(r.run.ID, def.Key, ue, t, retry)
	s := &r.run.Steps[i]
	s.Error, s.ErrorCode, s.Output = "", "", nil
	if first {
		r.log(i, t, fmt.Sprintf("服务商「%s」不可用（%s），先挂起，等它恢复后自动重跑这一步；%s 先探测一次，最多等到执行发起后 %s",
			ue.Provider, ue.Cause, retry.Local().Format("15:04:05"), waitLimitText()))
		r.noteProviderIncident(i, ue, "")
	}
	r.seq++
	token := r.seq
	sctx, cancel := context.WithCancel(ctx)
	r.inflight[i] = inflight{token: token, cancel: cancel}
	rec := r.e.pwaits.recoveredCh(ue.ProviderID)
	r.e.wg.Add(1)
	go func() {
		defer r.e.wg.Done()
		defer cancel()
		timer := time.NewTimer(time.Until(retry))
		defer timer.Stop()
		select {
		case <-timer.C:
		case <-rec:
		case <-sctx.Done():
			return
		}
		select {
		case r.inbox <- providerRetryMsg{step: i, token: token}:
		case <-sctx.Done():
		}
	}()
	return true
}

// providerRetry 是挂起的步骤到点了：收掉等待协程，交给 dispatch 重跑。
func (r *runner) providerRetry(m providerRetryMsg) bool {
	f, ok := r.inflight[m.step]
	if !ok || f.token != m.token || r.run.Steps[m.step].Status != stRunning {
		return false
	}
	delete(r.inflight, m.step)
	return true
}

// failOnOutage 是服务商不可用又挂不了的一步：照常失败，运行异常记到服务商那一条上。
func (r *runner) failOnOutage(i int, t time.Time, res nodeResult) {
	ue := res.outage
	msg := res.err
	if providerWaitSources[r.run.Source] && waitsForProvider(r.defs[i].Kind) {
		msg += fmt.Sprintf("（执行发起后已等了 %s，服务商仍没恢复，不再自动重跑；修好后在这里点重试）", waitLimitText())
	}
	r.e.pwaits.drop(r.run.ID, r.defs[i].Key)
	s := &r.run.Steps[i]
	s.Status, s.Error, s.ErrorCode, s.EndedAt = stFailed, msg, "", &t
	r.log(i, t, "失败："+msg)
	r.noteProviderIncident(i, ue, msg)
}

func waitLimitText() string {
	if providerWaitMax%time.Hour == 0 {
		return fmt.Sprintf("%d 小时", int(providerWaitMax/time.Hour))
	}
	return providerWaitMax.String()
}

// providerFingerprint 是服务商不可用那条运行异常的指纹。
func providerFingerprint(providerID string) string { return "sop:provider:" + providerID }

// noteProviderIncident 按服务商记一条运行异常：标题写影响几次执行，正文写原因、什么时候探测、去哪修。failMsg 为空表示挂起了。
// 影响几次执行 = 正在等这个服务商的执行数 + 这次故障里直接失败的执行数，写的时候现算。
func (r *runner) noteProviderIncident(i int, ue *providerOutage, failMsg string) {
	def, s := r.defs[i], r.run.Steps[i]
	name := orDefault(def.Name, def.Key)
	handling := fmt.Sprintf("这一步已挂起为「等服务商恢复」，恢复后自动重跑同一条执行（不新建执行，不会按同一条消息重复建任务），最多等到执行发起后 %s。", waitLimitText())
	if failMsg != "" {
		handling = "这一步已标为失败：" + failMsg
	}
	probe := "还没到熔断的次数"
	if ue.Open && !ue.RetryAt.IsZero() {
		probe = "已熔断，" + ue.RetryAt.Local().Format("2006-01-02 15:04:05") + " 自动探测一次，通了就恢复"
	}
	msg := fmt.Sprintf("调模型失败：服务商「%s」不可用，最近一次是「%s」。%s。\n\n%s\n\n"+
		"怎么修：到 设置 → 模型服务商 检查「%s」的 base_url 能否访问、服务是否启动、代理是否通；"+
		"或者在它的配置里设「失败时改用」的备用服务商，熔断期间自动改用；也可以在流程节点里换一个服务商。",
		ue.Provider, ue.Cause, probe, handling, ue.Provider)
	runTitle, runID, attempts, flow := orDefault(r.run.Title, r.run.ID), r.run.ID, s.Attempts, r.run.FlowName
	build := func(affected int) plugin.Incident {
		affected = max(affected, 1)
		return plugin.Incident{
			Fingerprint: providerFingerprint(ue.ProviderID),
			Level:       "error",
			Module:      "SOP",
			Title:       fmt.Sprintf("服务商「%s」不可用，影响 %d 次执行", ue.Provider, affected),
			Message:     msg,
			Context: map[string]any{"服务商": ue.Provider, "服务商 id": ue.ProviderID, "原因": ue.Cause,
				"影响的执行": affected, "最近一次": map[string]any{"SOP": flow, "步骤": name,
					"执行": runTitle, "执行 id": runID, "第几次": attempts}},
		}
	}
	r.e.noteOutage(ue.ProviderID, failMsg != "", build)
}

// noteOutage 写服务商那条运行异常：离上次写超过 incidentEvery 马上写，否则攒着到点写最新的一份。
// failed 为真表示这次是直接失败的执行，计入影响数。
func (e *engine) noteOutage(providerID string, failed bool, build func(affected int) plugin.Incident) {
	w := &e.pwaits
	w.mu.Lock()
	if w.inc == nil {
		w.inc = map[string]*outageIncident{}
	}
	st := w.inc[providerID]
	if st == nil {
		st = &outageIncident{}
		w.inc[providerID] = st
	}
	if failed {
		st.failed++
	}
	now := time.Now()
	if wait := st.last.Add(incidentEvery).Sub(now); wait > 0 {
		st.pending = build
		if !st.timer {
			st.timer = true
			time.AfterFunc(wait, func() { e.flushOutage(providerID) })
		}
		w.mu.Unlock()
		return
	}
	st.last = now
	w.mu.Unlock()
	e.recordOutage(providerID, build)
}

func (e *engine) flushOutage(providerID string) {
	w := &e.pwaits
	w.mu.Lock()
	st := w.inc[providerID]
	build := st.pending
	st.pending, st.timer, st.last = nil, false, time.Now()
	w.mu.Unlock()
	if build != nil {
		e.recordOutage(providerID, build)
	}
}

func (e *engine) recordOutage(providerID string, build func(affected int) plugin.Incident) {
	alive := func(id string) bool { return e.runner(id) != nil }
	n := len(e.pwaits.runsOn(providerID, alive))
	e.pwaits.mu.Lock()
	if st := e.pwaits.inc[providerID]; st != nil {
		n += st.failed
	}
	e.pwaits.mu.Unlock()
	in := build(n)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := e.c.Incidents().Record(ctx, in); err != nil {
		e.c.Log().Warn("sop provider outage incident not recorded", "provider", providerID, "err", err)
	}
}

/* ---------- 接口回执行时标上 ---------- */

// markProviderWait 给回给前端的执行标上挂起等服务商的步骤。
func (e *engine) markProviderWait(run *Run) {
	if e == nil || run == nil {
		return
	}
	got := e.pwaits.get(run.ID)
	for i := range run.Steps {
		if v, ok := got[run.Steps[i].Key]; ok && run.Steps[i].Status == stRunning {
			run.Steps[i].ProviderWait = &v
		}
	}
}

// markBriefProviderWait 同 markProviderWait，给列表行。
func (e *engine) markBriefProviderWait(list []RunBrief) {
	if e == nil {
		return
	}
	for i := range list {
		got := e.pwaits.get(list[i].ID)
		for j := range list[i].Steps {
			st := &list[i].Steps[j]
			if v, ok := got[st.Key]; ok && st.Status == stRunning {
				st.ProviderWait = &v
			}
		}
	}
}
