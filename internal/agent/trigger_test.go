// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package agent

import (
	"context"
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/schedule"
	"github.com/lizhao903/pm-workspace/internal/store"
	"github.com/lizhao903/pm-workspace/internal/store/sqlite"
)

// triggerFixture 是真库加一个调度；每次执行用 script 生成一个新的假模型，跑的次数记在 runs。
type triggerFixture struct {
	t      *testing.T
	ctx    context.Context
	st     *sqlite.Store
	d      *Dispatcher
	script func() []func(func(Event))
	runs   int
}

func newTriggerFixture(t *testing.T) *triggerFixture {
	t.Helper()
	ctx := context.Background()
	st, err := sqlite.Open(ctx, filepath.Join(t.TempDir(), "w.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	f := &triggerFixture{t: t, ctx: ctx, st: st, d: NewDispatcher(st, nil)}
	f.script = func() []func(func(Event)) { return []func(func(Event)){grantSay("看过了，没什么要做的。")} }
	f.d.Prepare = func(ctx context.Context, ag *domain.Agent, s *domain.AgentSession) (*Runner, error) {
		f.runs++
		grants, err := st.AgentGrants(ctx, ag.ID)
		if err != nil {
			return nil, err
		}
		var obj *domain.Object
		if s.ObjectID != nil {
			obj, _ = st.GetObject(ctx, *s.ObjectID)
		}
		return &Runner{Store: st, Chat: &grantChat{script: f.script()}, Model: "m", Session: s, Object: obj,
			Agent: ag, Policy: &Policy{Grants: grants}}, nil
	}
	return f
}

func (f *triggerFixture) agent(name string, triggers ...domain.AgentTrigger) *domain.Agent {
	f.t.Helper()
	p, err := f.st.CreateProvider(f.ctx, &domain.AgentProvider{Name: "本机", Kind: domain.ProviderOllama,
		BaseURL: "http://127.0.0.1:1", Model: "m", Enabled: true}, "")
	if err != nil {
		f.t.Fatal(err)
	}
	ag, err := f.st.CreateAgent(f.ctx, domain.AgentInput{Name: &name, ProviderID: &p.ID, Triggers: &triggers})
	if err != nil {
		f.t.Fatal(err)
	}
	return ag
}

func (f *triggerFixture) fire(eventType string, payload any) {
	f.t.Helper()
	raw, _ := json.Marshal(payload)
	f.d.HandleEvent(eventType, raw)
	if !f.d.Wait(5 * time.Second) {
		f.t.Fatal("执行没跑完")
	}
}

func (f *triggerFixture) agentRuns(agentID string) []*store.AgentRun {
	f.t.Helper()
	rs, _, err := f.st.ListAgentRuns(f.ctx, store.AgentRunFilter{AgentID: agentID})
	if err != nil {
		f.t.Fatal(err)
	}
	return rs
}

func (f *triggerFixture) task(title string, props map[string]any, tags ...string) *domain.Object {
	f.t.Helper()
	o, err := f.st.CreateObject(f.ctx, &domain.Object{TypeID: "task", Title: title, Props: props, Tags: tags}, store.DefaultActor)
	if err != nil {
		f.t.Fatal(err)
	}
	return o
}

// 任务分配给 Agent：跑一次，记录为 done，会话挂在任务下；同一任务再来事件不重复跑；停用的不触发。
func TestTaskTriggerAssigned(t *testing.T) {
	f := newTriggerFixture(t)
	ag := f.agent("任务助手", domain.AgentTrigger{Kind: domain.TriggerTask})
	other := f.agent("旁观者", domain.AgentTrigger{Kind: domain.TriggerManual})

	o := f.task("整理演示环境", map[string]any{PropAgentID: ag.ID})
	f.fire(eventObjectCreated, map[string]any{"id": o.ID, "type_id": "task"})
	rs := f.agentRuns(ag.ID)
	if len(rs) != 1 {
		t.Fatalf("应跑一次：%d", len(rs))
	}
	r := rs[0]
	if r.Status != store.AgentRunDone || r.TriggerKind != domain.TriggerTask || r.SourceID != o.ID ||
		!strings.Contains(r.Trigger, "任务分配给它") || r.Summary != "看过了，没什么要做的。" || r.FinishedAt == nil {
		t.Fatalf("执行记录 = %+v", r)
	}
	if !strings.Contains(r.Prompt, o.Ref) || !strings.Contains(r.Prompt, "整理演示环境") {
		t.Fatalf("提示词没落库：%q", r.Prompt)
	}
	s, err := f.st.GetAgentSession(f.ctx, *r.SessionID)
	if err != nil || s.ObjectID == nil || *s.ObjectID != o.ID || s.AgentID == nil || *s.AgentID != ag.ID {
		t.Fatalf("会话 = %+v，%v", s, err)
	}
	if len(f.agentRuns(other.ID)) != 0 {
		t.Fatal("没配任务触发的不该跑")
	}

	// 改动同一任务（改标签、props）再发事件：同一事件键不重复
	f.fire(eventObjectUpdated, map[string]any{"id": o.ID, "type_id": "task", "fields": []string{"props"}})
	if n := len(f.agentRuns(ag.ID)); n != 1 || f.runs != 1 {
		t.Fatalf("重复触发了：%d 条，跑了 %d 次", n, f.runs)
	}
	// 只改了标题的不看
	o2 := f.task("另一条", nil)
	if _, err := f.st.UpdateObject(f.ctx, o2.ID, domain.ObjectPatch{Props: &map[string]any{PropAgentID: ag.ID}}, store.DefaultActor); err != nil {
		t.Fatal(err)
	}
	f.fire(eventObjectUpdated, map[string]any{"id": o2.ID, "type_id": "task", "fields": []string{"title"}})
	if n := len(f.agentRuns(ag.ID)); n != 1 {
		t.Fatalf("改标题不该触发：%d", n)
	}

	// 停用后不再触发
	off := false
	if _, err := f.st.UpdateAgent(f.ctx, ag.ID, domain.AgentInput{Enabled: &off}); err != nil {
		t.Fatal(err)
	}
	f.fire(eventObjectUpdated, map[string]any{"id": o2.ID, "type_id": "task", "fields": []string{"props"}})
	if n := len(f.agentRuns(ag.ID)); n != 1 {
		t.Fatalf("停用的 Agent 被触发了：%d", n)
	}
}

// 标签命中也触发；Agent 自己建的任务不认标签。
func TestTaskTriggerTags(t *testing.T) {
	f := newTriggerFixture(t)
	ag := f.agent("标签助手", domain.AgentTrigger{Kind: domain.TriggerTask, Match: &domain.TriggerMatch{Tags: []string{"Agent"}}})
	o := f.task("带标签", nil, "Agent")
	f.fire(eventObjectCreated, map[string]any{"id": o.ID, "type_id": "task"})
	byAgent, err := f.st.CreateObject(f.ctx, &domain.Object{TypeID: "task", Title: "Agent 建的", Source: "agent", Tags: []string{"Agent"}}, store.DefaultActor)
	if err != nil {
		t.Fatal(err)
	}
	f.fire(eventObjectCreated, map[string]any{"id": byAgent.ID, "type_id": "task"})
	rs := f.agentRuns(ag.ID)
	if len(rs) != 1 || rs[0].SourceID != o.ID || !strings.Contains(rs[0].Trigger, "标签「Agent」") {
		t.Fatalf("执行记录 = %+v", rs)
	}
}

// IM 消息：按条件命中，同一条消息重放不重复。
func TestIMTrigger(t *testing.T) {
	f := newTriggerFixture(t)
	mine := f.agent("分诊", domain.AgentTrigger{Kind: domain.TriggerIM, Match: &domain.TriggerMatch{OnlyMe: true}})
	tg := f.agent("只看 telegram", domain.AgentTrigger{Kind: domain.TriggerIM, Match: &domain.TriggerMatch{Channel: "telegram"}})
	cv := "cv_1"
	msg := map[string]any{"message_id": "msg_1", "channel": "slack", "connector_id": "", "conversation_id": cv, "relevance": "me"}
	f.fire(eventIMReceived, msg)
	f.fire(eventIMReceived, msg)
	rs := f.agentRuns(mine.ID)
	if len(rs) != 1 || rs[0].Status != store.AgentRunDone || rs[0].SourceID != "msg_1" || rs[0].TriggerKind != domain.TriggerIM ||
		!strings.Contains(rs[0].Trigger, "@我") {
		t.Fatalf("执行记录 = %+v", rs)
	}
	if len(f.agentRuns(tg.ID)) != 0 {
		t.Fatal("渠道不对的不该跑")
	}
	// 与我无关的不触发只看与我相关的
	f.fire(eventIMReceived, map[string]any{"message_id": "msg_2", "channel": "slack", "relevance": ""})
	if n := len(f.agentRuns(mine.ID)); n != 1 {
		t.Fatalf("与我无关的触发了：%d", n)
	}
}

// 需确认的调用让执行记录停在 waiting，确认后接着跑完变 done，拒绝变 rejected。
func TestRunWaitsForConfirm(t *testing.T) {
	for _, approved := range []bool{true, false} {
		f := newTriggerFixture(t)
		ag := f.agent("建任务的", domain.AgentTrigger{Kind: domain.TriggerIM})
		if err := f.st.SetAgentGrants(f.ctx, ag.ID, map[string]string{"write_tasks": "confirm", "read_tasks": "auto"}); err != nil {
			t.Fatal(err)
		}
		f.script = func() []func(func(Event)) {
			return []func(func(Event)){grantCall("create_object", `{"type_id":"task","title":"开通试点账号"}`), grantSay("不该跑到这里")}
		}
		f.fire(eventIMReceived, map[string]any{"message_id": "msg_9", "channel": "slack", "relevance": "dm"})
		rs := f.agentRuns(ag.ID)
		if len(rs) != 1 || rs[0].Status != store.AgentRunWaiting || rs[0].Pending != 1 || rs[0].FinishedAt == nil {
			t.Fatalf("应停在 waiting：%+v", rs)
		}
		run := rs[0]
		calls, err := f.st.ListRunToolCalls(f.ctx, run.ID)
		if err != nil || len(calls) != 1 || calls[0].RunID == nil || *calls[0].RunID != run.ID || *calls[0].SessionID != *run.SessionID {
			t.Fatalf("待确认的调用 = %+v，%v", calls, err)
		}
		// 等确认的排在比它新的已完成记录前面
		f.script = func() []func(func(Event)) { return []func(func(Event)){grantSay("不用跟进。")} }
		f.fire(eventIMReceived, map[string]any{"message_id": "msg_10", "channel": "slack"})
		if all := f.agentRuns(ag.ID); len(all) != 2 || all[0].ID != run.ID {
			t.Fatalf("等确认的应置顶：%+v", all)
		}

		// 照接口层的做法：决定、接着跑、重算
		state := map[bool]string{true: store.ToolCallConfirmed, false: store.ToolCallRejected}[approved]
		tc, err := f.st.DecideAgentToolCall(f.ctx, calls[0].ID, state)
		if err != nil {
			t.Fatal(err)
		}
		sess, _ := f.st.GetAgentSession(f.ctx, *run.SessionID)
		grants, _ := f.st.AgentGrants(f.ctx, ag.ID)
		r := &Runner{Store: f.st, Chat: &grantChat{script: []func(func(Event)){grantSay("建好了。")}}, Model: "m",
			Session: sess, Agent: ag, Policy: &Policy{Grants: grants}, RunID: *tc.RunID}
		_, err = r.Resume(f.ctx, &Decision{Call: tc, Approved: approved}, func(StreamEvent) {})
		if err := SettleRun(f.ctx, f.st, run.ID, err); err != nil {
			t.Fatal(err)
		}
		got, _ := f.st.GetAgentRun(f.ctx, run.ID)
		want := map[bool]string{true: store.AgentRunDone, false: store.AgentRunRejected}[approved]
		if got.Status != want || got.Pending != 0 || got.Summary != "建好了。" {
			t.Fatalf("处理后 = %+v，想要 %s", got, want)
		}
	}
}

// 定时任务的 agent 动作：不看 Agent 上有没有配定时触发；停用、不存在回错误；没跑起来记失败。
func TestStartAgentFromSchedule(t *testing.T) {
	f := newTriggerFixture(t)
	ag := f.agent("周报助手", domain.AgentTrigger{Kind: domain.TriggerManual})
	got, err := f.d.StartAgent(f.ctx, schedule.AgentRequest{AgentID: ag.ID, ScheduleID: "sch_1", ScheduleName: "写周报", RunID: "srn_1"})
	if err != nil || got.Failed || got.AgentName != "周报助手" {
		t.Fatalf("发起 = %+v，%v", got, err)
	}
	f.d.Wait(5 * time.Second)
	r, err := f.st.GetAgentRun(f.ctx, got.RunID)
	if err != nil || r.Status != store.AgentRunDone || r.TriggerKind != domain.TriggerSchedule || r.Trigger != "定时 · 写周报" || r.SourceID != "sch_1" {
		t.Fatalf("执行记录 = %+v，%v", r, err)
	}
	if _, err := f.d.StartAgent(f.ctx, schedule.AgentRequest{AgentID: ag.ID, ScheduleID: "sch_1", RunID: "srn_1"}); err == nil {
		t.Fatal("同一次定时执行不该发起两次")
	}
	if _, err := f.d.StartAgent(f.ctx, schedule.AgentRequest{AgentID: "ag_none", RunID: "srn_2"}); err == nil || !strings.Contains(err.Error(), "不存在") {
		t.Fatalf("不存在：%v", err)
	}
	off := false
	if _, err := f.st.UpdateAgent(f.ctx, ag.ID, domain.AgentInput{Enabled: &off}); err != nil {
		t.Fatal(err)
	}
	if _, err := f.d.StartAgent(f.ctx, schedule.AgentRequest{AgentID: ag.ID, RunID: "srn_3"}); err == nil || !strings.Contains(err.Error(), "已停用") {
		t.Fatalf("停用：%v", err)
	}

	// 没跑起来：记失败
	on := true
	if _, err := f.st.UpdateAgent(f.ctx, ag.ID, domain.AgentInput{Enabled: &on}); err != nil {
		t.Fatal(err)
	}
	f.d.Prepare = nil
	got, err = f.d.StartAgent(f.ctx, schedule.AgentRequest{AgentID: ag.ID, ScheduleName: "写周报", RunID: "srn_4"})
	if err != nil || !got.Failed || got.Reason == "" {
		t.Fatalf("没跑起来 = %+v，%v", got, err)
	}
}

// 启动时把上次没跑完的记为失败。
func TestRecoverInterruptedRuns(t *testing.T) {
	f := newTriggerFixture(t)
	ag := f.agent("x", domain.AgentTrigger{Kind: domain.TriggerManual})
	r, err := f.st.CreateAgentRun(f.ctx, &store.AgentRun{AgentID: ag.ID, TriggerKind: domain.TriggerIM, EventKey: "im:m"})
	if err != nil || r.Status != store.AgentRunRunning {
		t.Fatalf("%+v，%v", r, err)
	}
	if err := f.d.Recover(f.ctx); err != nil {
		t.Fatal(err)
	}
	got, _ := f.st.GetAgentRun(f.ctx, r.ID)
	if got.Status != store.AgentRunFailed || got.FinishedAt == nil || !strings.Contains(got.Summary, "服务退出") {
		t.Fatalf("%+v", got)
	}
}

// --- 停止 / 重试（P0-O2，0056） ---

// hangChat 一次模型调用一直不返回，直到执行上下文被取消：模拟一次能跑很久的执行。
type hangChat struct{ started chan struct{} }

func (c *hangChat) Stream(ctx context.Context, _ Request, _ func(Event)) error {
	select {
	case c.started <- struct{}{}:
	default:
	}
	<-ctx.Done()
	return ctx.Err()
}

// waitRuns 等执行记录出现到至少 n 条，回列表。
func (f *triggerFixture) waitRuns(agentID string, n int) []*store.AgentRun {
	f.t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		rs := f.agentRuns(agentID)
		if len(rs) >= n {
			return rs
		}
		if time.Now().After(deadline) {
			f.t.Fatalf("等执行记录超时：想要 %d 条，只有 %d 条", n, len(rs))
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// 手动停止：登记过取消函数的执行被取消，收尾记 canceled（不是 failed），总结说明已经做的操作不撤回。
func TestDispatcherStopRun(t *testing.T) {
	f := newTriggerFixture(t)
	ag := f.agent("跑长活的", domain.AgentTrigger{Kind: domain.TriggerIM})
	chat := &hangChat{started: make(chan struct{}, 1)}
	f.d.Prepare = func(ctx context.Context, ag *domain.Agent, s *domain.AgentSession) (*Runner, error) {
		return &Runner{Store: f.st, Chat: chat, Model: "m", Session: s, Agent: ag, Policy: &Policy{Grants: map[string]string{}}}, nil
	}
	f.d.HandleEvent(eventIMReceived, mustJSON(t, map[string]any{"message_id": "msg_stop", "channel": "slack"}))
	rs := f.waitRuns(ag.ID, 1)
	select {
	case <-chat.started:
	case <-time.After(5 * time.Second):
		t.Fatal("执行没开始调模型")
	}
	if !f.d.Stop(rs[0].ID) {
		t.Fatal("在跑的应该能停")
	}
	if !f.d.Wait(5 * time.Second) {
		t.Fatal("停止后执行没结束")
	}
	got, err := f.st.GetAgentRun(f.ctx, rs[0].ID)
	if err != nil || got.Status != store.AgentRunCanceled || got.FinishedAt == nil ||
		got.Summary != "已手动停止，已经执行的操作不会撤回。" {
		t.Fatalf("停止后 = %+v，%v", got, err)
	}
	if f.d.Stop(got.ID) {
		t.Fatal("已经结束的不再能停")
	}
	// 停止是收尾成 canceled，不是失败
	if got.Status == store.AgentRunFailed {
		t.Fatal("停止不该记失败")
	}
	// 提示词落库了，重试用得上
	if !strings.Contains(got.Prompt, "IM 消息") {
		t.Fatalf("提示词没落库：%q", got.Prompt)
	}
}

// 重试：失败 / 停止的记录新建一条记录和新会话，提示词沿用、触发说明加（重试）、event_key 留空；跑完按新执行收尾。
func TestDispatcherRetryRun(t *testing.T) {
	f := newTriggerFixture(t)
	ag := f.agent("重试助手", domain.AgentTrigger{Kind: domain.TriggerManual})
	orig, err := f.st.CreateAgentRun(f.ctx, &store.AgentRun{
		AgentID: ag.ID, TriggerKind: domain.TriggerIM, Trigger: "收到 slack 消息", SourceID: "msg_1",
		EventKey: "im:msg_1", Prompt: "处理这条消息",
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.st.FinishAgentRun(f.ctx, orig.ID, store.AgentRunFailed, "执行失败：boom"); err != nil {
		t.Fatal(err)
	}
	orig, _ = f.st.GetAgentRun(f.ctx, orig.ID)

	next, err := f.d.Retry(f.ctx, orig)
	if err != nil || next == nil {
		t.Fatalf("重试 = %+v，%v", next, err)
	}
	if next.ID == orig.ID || next.Status != store.AgentRunRunning {
		t.Fatalf("应新建一条 running 的：%+v", next)
	}
	if next.Prompt != "处理这条消息" || next.EventKey != "" || next.SourceID != "msg_1" ||
		next.TriggerKind != domain.TriggerIM || next.Trigger != "收到 slack 消息（重试）" {
		t.Fatalf("新记录 = %+v", next)
	}
	if next.SessionID == nil || *next.SessionID == "" {
		t.Fatalf("没建新会话：%+v", next)
	}
	sess, err := f.st.GetAgentSession(f.ctx, *next.SessionID)
	if err != nil || !strings.HasPrefix(sess.Title, "重试 · ") || sess.AgentID == nil || *sess.AgentID != ag.ID {
		t.Fatalf("新会话 = %+v，%v", sess, err)
	}
	if !f.d.Wait(5 * time.Second) {
		t.Fatal("重试的执行没跑完")
	}
	done, _ := f.st.GetAgentRun(f.ctx, next.ID)
	if done.Status != store.AgentRunDone || done.Summary != "看过了，没什么要做的。" {
		t.Fatalf("重试执行完 = %+v", done)
	}

	// 成功的、没有提示词的不能重试
	if _, err := f.d.Retry(f.ctx, done); err == nil {
		t.Fatal("done 的不该能重试")
	}
	empty, _ := f.st.CreateAgentRun(f.ctx, &store.AgentRun{AgentID: ag.ID, TriggerKind: domain.TriggerIM, Trigger: "没有提示词"})
	empty, _ = f.st.FinishAgentRun(f.ctx, empty.ID, store.AgentRunCanceled, "")
	if _, err := f.d.Retry(f.ctx, empty); err == nil || !strings.Contains(err.Error(), "提示词") {
		t.Fatalf("没有提示词：%v", err)
	}
	// Agent 停用
	off := false
	if _, err := f.st.UpdateAgent(f.ctx, ag.ID, domain.AgentInput{Enabled: &off}); err != nil {
		t.Fatal(err)
	}
	if _, err := f.d.Retry(f.ctx, orig); err == nil || !strings.Contains(err.Error(), "已停用") {
		t.Fatalf("停用：%v", err)
	}
}

// 超时和手动停止不是一回事：超时仍记 failed，不能混成 canceled。
func TestDispatcherTimeoutStillFailed(t *testing.T) {
	f := newTriggerFixture(t)
	ag := f.agent("超时的", domain.AgentTrigger{Kind: domain.TriggerIM})
	f.d.Timeout = 20 * time.Millisecond
	f.d.Prepare = func(ctx context.Context, ag *domain.Agent, s *domain.AgentSession) (*Runner, error) {
		return &Runner{Store: f.st, Chat: &hangChat{started: make(chan struct{}, 1)}, Model: "m", Session: s, Agent: ag,
			Policy: &Policy{Grants: map[string]string{}}}, nil
	}
	f.fire(eventIMReceived, map[string]any{"message_id": "msg_timeout", "channel": "slack"})
	rs := f.agentRuns(ag.ID)
	if len(rs) != 1 || rs[0].Status != store.AgentRunFailed || !strings.Contains(rs[0].Summary, "执行失败") {
		t.Fatalf("超时应记失败：%+v", rs)
	}
}

// mustJSON 把 payload 编成事件总线要的字节。
func mustJSON(t *testing.T, v any) []byte {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return b
}
