// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/schedule"
	"github.com/lizhao903/pm-workspace/internal/store"
)

// --- Agent 的触发和执行记录（AG-01b4，0036） ---
//
// 任务新建或改了分配、标签，IM 消息到达，定时任务的 agent 动作：命中的启用中的 Agent 各跑一次。
// 每次建一条挂在触发对象下的会话、跑一轮、记一条执行记录；同一事件对同一 Agent 只触发一次，
// 靠执行记录上 (agent_id, event_key) 唯一，重放、重启都不会多跑。

// PropAgentID 是任务分配给哪个 Agent 的 props key。owner_id 是干系人的外键，放不了 Agent。
const PropAgentID = "agent_id"

// 订阅的事件，和 events、IM 插件里的一致；这里不 import 它们，免得 agent 依赖插件。
const (
	eventObjectCreated = "object.created"
	eventObjectUpdated = "object.updated"
	eventIMReceived    = "im.message_received"
)

// summaryMax 是执行记录总结的字数上限。
const summaryMax = 500

// DefaultRunTimeout 是一次自动执行的上限。
const DefaultRunTimeout = 10 * time.Minute

// DefaultRunSteps 是触发执行（无人值守）默认的步数上限（P0-O2）：一次执行要读任务、读关联、
// 记进展、改状态，会话里一轮对话的 8 轮不够用。接口层建 Runner 时填进 Budget。
const DefaultRunSteps = 30

// runStoppedSummary 是手动停止的执行记录的总结（P0-O2）。停止不撤回已经做过的操作，这一点要写给人看。
const runStoppedSummary = "已手动停止，已经执行的操作不会撤回。"

// PrepareFunc 照会话对话的口径备好 Runner（服务商、模型、授权、技能、当前对象），由接口层提供。
type PrepareFunc func(ctx context.Context, ag *domain.Agent, session *domain.AgentSession) (*Runner, error)

// Dispatcher 把事件和定时任务变成 Agent 的执行。零值不能用，用 NewDispatcher。
type Dispatcher struct {
	st  store.Store
	log *slog.Logger
	// Prepare 由 api.New 接上；为 nil 时执行记录直接记失败。
	Prepare PrepareFunc
	Timeout time.Duration

	wg sync.WaitGroup
	// mu 护着 cancels：在跑的执行的 run id → 取消这次执行上下文的函数，手动停止（P0-O2）靠它。
	mu      sync.Mutex
	cancels map[string]context.CancelFunc
}

// NewDispatcher 建一个调度。st 要传外层包装过的 store：Agent 的写操作照常记审计、发事件。
func NewDispatcher(st store.Store, log *slog.Logger) *Dispatcher {
	if log == nil {
		log = slog.Default()
	}
	return &Dispatcher{st: st, log: log.With("component", "agent-trigger"), Timeout: DefaultRunTimeout,
		cancels: map[string]context.CancelFunc{}}
}

// Recover 把上次退出时还在跑的执行记录记为失败，启动时调一次。
func (d *Dispatcher) Recover(ctx context.Context) error {
	n, err := d.st.FailInterruptedAgentRuns(ctx, "执行中服务退出了，结果不确定，没有重跑")
	if err != nil {
		return err
	}
	if n > 0 {
		d.log.Warn("上次退出时没跑完的 Agent 执行记为失败", "count", n)
	}
	return nil
}

// HandleEvent 接事件总线（Bus.Tap），立刻返回，处理放到后台。
func (d *Dispatcher) HandleEvent(eventType string, payload []byte) {
	switch eventType {
	case eventObjectCreated, eventObjectUpdated, eventIMReceived:
	default:
		return
	}
	raw := append([]byte(nil), payload...)
	d.wg.Add(1)
	go func() {
		defer d.wg.Done()
		ctx := context.Background()
		var err error
		if eventType == eventIMReceived {
			err = d.onMessage(ctx, raw)
		} else {
			err = d.onTask(ctx, eventType, raw)
		}
		if err != nil {
			d.log.Warn("agent trigger failed", "event", eventType, "err", err)
		}
	}()
}

// Wait 等在途的处理和执行结束，最多等 timeout；等到了返回 true。进程退出和测试用。
func (d *Dispatcher) Wait(timeout time.Duration) bool {
	done := make(chan struct{})
	go func() {
		d.wg.Wait()
		close(done)
	}()
	select {
	case <-done:
		return true
	case <-time.After(timeout):
		return false
	}
}

// trigger 是一次要发起的执行。
type trigger struct {
	kind     string // task / im / schedule
	label    string // 给人看的触发说明
	sourceID string
	eventKey string
	objectID string // 会话挂在哪个对象下，空串是不挂
	title    string // 会话标题
	prompt   string // 交给 Agent 的第一句话
}

// onTask 处理任务新建和改动：只看 task 类型，改动只看分配（props）和标签。
func (d *Dispatcher) onTask(ctx context.Context, eventType string, raw []byte) error {
	var p struct {
		ID     string   `json:"id"`
		TypeID string   `json:"type_id"`
		Fields []string `json:"fields"`
	}
	if err := json.Unmarshal(raw, &p); err != nil {
		return err
	}
	if p.TypeID != "task" || p.ID == "" {
		return nil
	}
	if eventType == eventObjectUpdated && !slices.Contains(p.Fields, "props") && !slices.Contains(p.Fields, "tags") {
		return nil
	}
	o, err := d.st.GetObject(ctx, p.ID)
	if errors.Is(err, domain.ErrNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	if o.DeletedAt != nil || o.ArchivedAt != nil {
		return nil
	}
	agents, err := d.st.ListAgents(ctx)
	if err != nil {
		return err
	}
	assigned, _ := o.Props[PropAgentID].(string)
	for _, ag := range agents {
		if !ag.Enabled {
			continue
		}
		why, reason := taskMatch(ag, o, assigned)
		if why == "" {
			continue
		}
		t := trigger{
			kind: domain.TriggerTask, label: why + " · " + o.Ref, sourceID: o.ID, eventKey: "task:" + o.ID,
			objectID: o.ID, title: o.Ref + " " + o.Title,
			prompt: fmt.Sprintf("任务 %s「%s」%s。请按你的职责处理它：先用 get_object 读这条任务，再决定要做什么，做完用一两句话总结。",
				o.Ref, o.Title, reason),
		}
		if _, err := d.start(ctx, ag, t); err != nil {
			d.log.Warn("agent task trigger failed", "agent", ag.ID, "task", o.ID, "err", err)
		}
	}
	return nil
}

// taskMatch 回触发说明和给 Agent 的原因，没命中回空串。Agent 自己建的任务只认分配，不认标签，免得 Agent 之间互相派活停不下来。
func taskMatch(ag *domain.Agent, o *domain.Object, assigned string) (label, reason string) {
	for _, t := range ag.Triggers {
		if t.Kind != domain.TriggerTask {
			continue
		}
		m := t.Match
		if m == nil {
			m = &domain.TriggerMatch{Assigned: true}
		}
		if m.Assigned && assigned == ag.ID {
			return "任务分配给它", "分配给了你"
		}
		if o.Source == "agent" {
			continue
		}
		for _, tag := range m.Tags {
			if slices.Contains(o.Tags, tag) {
				return "任务带了标签「" + tag + "」", "带了标签「" + tag + "」"
			}
		}
	}
	return "", ""
}

// imEvent 是 im.message_received 的 payload，同 IM 插件的 Received。
type imEvent struct {
	MessageID      string  `json:"message_id"`
	Channel        string  `json:"channel"`
	ConnectorID    string  `json:"connector_id"`
	ConversationID *string `json:"conversation_id"`
	StakeholderID  *string `json:"stakeholder_id"`
	Relevance      string  `json:"relevance"`
}

var relevanceText = map[string]string{"me": "@我", "all": "@所有人", "dm": "私聊"}

func (d *Dispatcher) onMessage(ctx context.Context, raw []byte) error {
	var e imEvent
	if err := json.Unmarshal(raw, &e); err != nil {
		return err
	}
	if e.MessageID == "" {
		return nil
	}
	agents, err := d.st.ListAgents(ctx)
	if err != nil {
		return err
	}
	var hit []*domain.Agent
	for _, ag := range agents {
		if ag.Enabled && imMatch(ag, &e) {
			hit = append(hit, ag)
		}
	}
	if len(hit) == 0 {
		return nil
	}
	label := "收到 " + e.Channel + " 消息"
	var facts []string
	facts = append(facts, "渠道 "+e.Channel, "消息 id "+e.MessageID)
	if r := relevanceText[e.Relevance]; r != "" {
		label += " · " + r
		facts = append(facts, "和我的关系："+r)
	}
	if e.ConversationID != nil {
		facts = append(facts, "会话 "+*e.ConversationID)
	}
	if e.StakeholderID != nil {
		facts = append(facts, "发消息的联系人 "+*e.StakeholderID)
	}
	t := trigger{
		kind: domain.TriggerIM, label: label, sourceID: e.MessageID, eventKey: "im:" + e.MessageID,
		title:  label,
		prompt: "收到一条 IM 消息（" + strings.Join(facts, "，") + "）。请按你的职责判断要不要跟进、怎么跟进，做完用一两句话总结。",
	}
	for _, ag := range hit {
		if _, err := d.start(ctx, ag, t); err != nil {
			d.log.Warn("agent im trigger failed", "agent", ag.ID, "message", e.MessageID, "err", err)
		}
	}
	return nil
}

// imMatch：Agent 有一条 im 触发的条件都满足。条件为 nil 时什么消息都算。
func imMatch(ag *domain.Agent, e *imEvent) bool {
	for _, t := range ag.Triggers {
		if t.Kind != domain.TriggerIM {
			continue
		}
		m := t.Match
		if m == nil {
			return true
		}
		if m.ConnectorID != "" && m.ConnectorID != e.ConnectorID {
			continue
		}
		if m.Channel != "" && m.Channel != e.Channel {
			continue
		}
		if m.ConversationID != "" && (e.ConversationID == nil || *e.ConversationID != m.ConversationID) {
			continue
		}
		if m.OnlyMe && relevanceText[e.Relevance] == "" {
			continue
		}
		return true
	}
	return false
}

// StartAgent 是定时任务的 agent 动作（schedule.AgentStarter）：不看 Agent 上有没有配定时触发，
// 定时任务指过来就跑。按定时任务执行记录的 id 去重。
func (d *Dispatcher) StartAgent(ctx context.Context, q schedule.AgentRequest) (*schedule.AgentStarted, error) {
	ag, err := d.st.GetAgent(ctx, q.AgentID)
	if errors.Is(err, domain.ErrNotFound) {
		return nil, fmt.Errorf("Agent %s 不存在", q.AgentID)
	}
	if err != nil {
		return nil, err
	}
	if !ag.Enabled {
		return nil, fmt.Errorf("Agent「%s」已停用", ag.Name)
	}
	prompt := strings.TrimSpace(q.Prompt)
	if prompt == "" {
		prompt = fmt.Sprintf("定时任务「%s」到点了，按你的职责完成该做的事，做完用一两句话总结。", q.ScheduleName)
	}
	label := "定时 · " + q.ScheduleName
	run, err := d.start(ctx, ag, trigger{
		kind: domain.TriggerSchedule, label: label, sourceID: q.ScheduleID, eventKey: "schedule:" + q.RunID,
		title: label, prompt: prompt,
	})
	if err != nil {
		return nil, err
	}
	if run == nil {
		return nil, fmt.Errorf("这次定时执行已经交给过 Agent")
	}
	out := &schedule.AgentStarted{RunID: run.ID, AgentName: ag.Name}
	if run.Status == store.AgentRunFailed {
		out.Failed, out.Reason = true, run.Summary
	}
	return out, nil
}

// start 记执行记录、建会话、备好 Runner，在后台跑；已经触发过回 nil。
// 没跑起来（建会话失败、服务商不对）时执行记录记为失败，回这条记录，不回错误。
func (d *Dispatcher) start(ctx context.Context, ag *domain.Agent, t trigger) (*store.AgentRun, error) {
	run, err := d.st.CreateAgentRun(ctx, &store.AgentRun{
		AgentID: ag.ID, TriggerKind: t.kind, Trigger: t.label, SourceID: t.sourceID, EventKey: t.eventKey,
		Prompt: t.prompt,
	})
	if err != nil || run == nil {
		return nil, err
	}
	// 先把取消函数登记上，再慢慢建会话：接口看到记录是 running 后点停止，任何时刻都能取消到。
	runCtx, cancelRun := context.WithTimeout(context.Background(), d.Timeout)
	d.setCancel(run.ID, cancelRun)
	started := false
	defer func() {
		// 没起后台执行（下面任一步失败）就自己清理，否则交给 execute 收尾。
		if !started {
			d.clearCancel(run.ID)
			cancelRun()
		}
	}()
	fail := func(reason string) (*store.AgentRun, error) {
		out, err := d.st.FinishAgentRun(ctx, run.ID, store.AgentRunFailed, reason)
		if err != nil {
			return nil, err
		}
		return out, nil
	}
	var objectID *string
	if t.objectID != "" {
		objectID = &t.objectID
	}
	session, err := d.st.CreateAgentSession(ctx, &domain.AgentSession{
		Title: oneLine(clipRunes(t.title, 60)), ObjectID: objectID, ProviderID: ag.ProviderID, Model: ag.Model, AgentID: &ag.ID,
	})
	if err != nil {
		return fail("建会话失败：" + err.Error())
	}
	if err := d.st.SetAgentRunSession(ctx, run.ID, session.ID); err != nil {
		return nil, err
	}
	run.SessionID = &session.ID
	if d.Prepare == nil {
		return fail("没跑起来：服务没接上 Agent 执行")
	}
	runner, err := d.Prepare(ctx, ag, session)
	if err != nil {
		return fail("没跑起来：" + err.Error())
	}
	runner.RunID = run.ID
	started = true
	d.wg.Add(1)
	go func() {
		defer d.wg.Done()
		defer d.clearCancel(run.ID)
		d.execute(runCtx, runner, run.ID, t.prompt)
	}()
	return run, nil
}

// setCancel 登记 run id 的取消函数。
func (d *Dispatcher) setCancel(runID string, cancel context.CancelFunc) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.cancels == nil {
		d.cancels = map[string]context.CancelFunc{}
	}
	d.cancels[runID] = cancel
}

// clearCancel 去掉登记；执行结束或没跑起来时调。
func (d *Dispatcher) clearCancel(runID string) {
	d.mu.Lock()
	defer d.mu.Unlock()
	delete(d.cancels, runID)
}

// Stop 停止一次在跑的执行（P0-O2）：取消它的上下文，执行收尾记 canceled。
// 这条记录不是本进程在跑的回 false。
func (d *Dispatcher) Stop(runID string) bool {
	d.mu.Lock()
	cancel, ok := d.cancels[runID]
	d.mu.Unlock()
	if ok {
		cancel()
	}
	return ok
}

// Retry 按一条失败或停止的执行记录再跑一次（P0-O2）：新建一条记录和新会话，提示词沿用原来的，
// 触发说明加「（重试）」；event_key 留空，不受去重唯一索引约束。
func (d *Dispatcher) Retry(ctx context.Context, run *store.AgentRun) (*store.AgentRun, error) {
	if run == nil {
		return nil, fmt.Errorf("没有可重试的执行记录")
	}
	if run.Status != store.AgentRunFailed && run.Status != store.AgentRunCanceled {
		return nil, fmt.Errorf("只有失败或已停止的执行才能重试")
	}
	prompt := strings.TrimSpace(run.Prompt)
	if prompt == "" {
		return nil, fmt.Errorf("这次执行没有留下提示词，不能重试")
	}
	ag, err := d.st.GetAgent(ctx, run.AgentID)
	if errors.Is(err, domain.ErrNotFound) {
		return nil, fmt.Errorf("Agent 已删除")
	}
	if err != nil {
		return nil, err
	}
	if !ag.Enabled {
		return nil, fmt.Errorf("Agent「%s」已停用", ag.Name)
	}
	return d.start(ctx, ag, trigger{
		kind: run.TriggerKind, label: run.Trigger + "（重试）", sourceID: run.SourceID, eventKey: "",
		title: "重试 · " + run.Trigger, prompt: prompt,
	})
}

func (d *Dispatcher) execute(ctx context.Context, runner *Runner, runID, prompt string) {
	_, err := runner.Run(ctx, prompt, func(StreamEvent) {})
	// 配置的模型客户端把取消/超时翻译成了人读的错误，上下文本身的状态更可靠：
	// 手动停止（Stop 取消 ctx）记 canceled，超时和其他失败仍记 failed。
	if err != nil && ctx.Err() == context.Canceled && !errors.Is(err, context.Canceled) {
		err = fmt.Errorf("执行被手动停止：%w", context.Canceled)
	}
	if err := SettleRun(context.Background(), d.st, runID, err); err != nil {
		d.log.Warn("save agent run failed", "run", runID, "err", err)
	}
}

// SettleRun 按这次执行里要确认的调用重算状态并写总结（同原型 SPEC-sessions-2.5）：还有等确认的为 waiting；
// 都处理完了，有调用且全部拒绝为 rejected，其余为 done。runErr 非 nil 时：手动停止（context.Canceled）记 canceled，
// 其余记失败。确认、拒绝接着跑完之后也调它。
func SettleRun(ctx context.Context, st store.Store, runID string, runErr error) error {
	if runErr != nil {
		if errors.Is(runErr, context.Canceled) {
			_, err := st.FinishAgentRun(ctx, runID, store.AgentRunCanceled, runStoppedSummary)
			return err
		}
		_, err := st.FinishAgentRun(ctx, runID, store.AgentRunFailed, clipRunes("执行失败："+runErr.Error(), summaryMax))
		return err
	}
	run, err := st.GetAgentRun(ctx, runID)
	if err != nil {
		return err
	}
	calls, err := st.ListRunToolCalls(ctx, runID)
	if err != nil {
		return err
	}
	status := store.AgentRunDone
	rejected := 0
	for _, c := range calls {
		switch c.State {
		case store.ToolCallPending:
			status = store.AgentRunWaiting
		case store.ToolCallRejected:
			rejected++
		}
	}
	if status == store.AgentRunDone && len(calls) > 0 && rejected == len(calls) {
		status = store.AgentRunRejected
	}
	summary := run.Summary
	if run.SessionID != nil {
		msgs, err := st.ListAgentMessages(ctx, *run.SessionID, 1)
		if err != nil {
			return err
		}
		if len(msgs) == 1 && msgs[0].Role == domain.RoleAssistant {
			summary = clipRunes(strings.TrimSpace(msgs[0].Content), summaryMax)
		}
	}
	_, err = st.FinishAgentRun(ctx, runID, status, summary)
	return err
}

// runRef 是要确认的调用上记的执行记录 id，人在会话里聊时为 nil。
func (r *Runner) runRef() *string {
	if r.RunID == "" {
		return nil
	}
	id := r.RunID
	return &id
}

// clipRunes 按字截断，超出的用省略号收尾。
func clipRunes(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n]) + "…"
}
