package agent

import (
	"context"
	"slices"
	"strings"
	"testing"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/schedule"
	"github.com/lizhao903/pm-workspace/internal/store"
)

type fakeSOPStarter struct {
	got []schedule.SOPRequest
	err error
}

func (f *fakeSOPStarter) StartSOP(_ context.Context, q schedule.SOPRequest) (*schedule.SOPStarted, error) {
	f.got = append(f.got, q)
	if f.err != nil {
		return nil, f.err
	}
	return &schedule.SOPStarted{RunID: "spr_1", FlowID: "sop_weekly", FlowName: "周会", Status: "waiting"}, nil
}

func useSOPStarter(t *testing.T, s schedule.SOPStarter) {
	SetSOPStarter(s)
	t.Cleanup(func() { SetSOPStarter(nil) })
}

// 验收（SOP-01d）：有 run_sop 授权时能发起，参数是流程 id 和输入；关闭时不给模型、硬调不执行。
func TestRunSOPTool(t *testing.T) {
	sops := &fakeSOPStarter{}
	useSOPStarter(t, sops)

	chat := &grantChat{script: []func(func(Event)){
		grantCall(toolRunSOP, `{"flow_id":"sop_weekly","input":{"topic":"复盘"}}`),
		grantSay("已经发起了。"),
	}}
	r, _, ctx := newRunner(t, chat)
	r.Agent = &domain.Agent{ID: "ag_sop", Name: "流程助手"}
	r.Policy = &Policy{Grants: map[string]string{RunSOPAbility: store.GrantAuto}}
	var evs []StreamEvent
	if _, err := r.Run(ctx, "走一遍周会流程", func(ev StreamEvent) { evs = append(evs, ev) }); err != nil {
		t.Fatal(err)
	}
	if !slices.Contains(grantToolNames(chat.reqs[0].Tools), toolRunSOP) {
		t.Fatal("开了授权应当给模型 run_sop")
	}
	if len(sops.got) != 1 {
		t.Fatalf("应发起一次：%+v", sops.got)
	}
	q := sops.got[0]
	if q.FlowID != "sop_weekly" || q.Input["topic"] != "复盘" || q.Source != "agent" || q.SourceID != "ag_sop" || q.SourceName != "流程助手" {
		t.Fatalf("请求 = %+v", q)
	}
	var summary string
	for _, ev := range evs {
		if ev.Type == "tool_result" {
			summary = ev.Summary
		}
	}
	if summary != "发起了 SOP「周会」，执行记录 spr_1" {
		t.Fatalf("tool_result = %q", summary)
	}
	ms := chat.reqs[1].Messages
	if m := ms[len(ms)-1]; !strings.Contains(m.Content, "spr_1") || !strings.Contains(m.Content, "人工检查点") {
		t.Fatalf("回给模型的结果 = %q", m.Content)
	}

	// 关闭：不给模型，硬调也不执行
	chat = &grantChat{script: []func(func(Event)){grantCall(toolRunSOP, `{"flow_id":"sop_weekly"}`), grantSay("没有权限。")}}
	r, _, ctx = newRunner(t, chat)
	r.Agent = &domain.Agent{ID: "ag_sop", Name: "流程助手"}
	r.Policy = &Policy{Grants: map[string]string{"read_tasks": store.GrantAuto}}
	evs = nil
	if _, err := r.Run(ctx, "走一遍周会流程", func(ev StreamEvent) { evs = append(evs, ev) }); err != nil {
		t.Fatal(err)
	}
	if slices.Contains(grantToolNames(chat.reqs[0].Tools), toolRunSOP) {
		t.Fatal("关闭的 run_sop 不该给模型")
	}
	if len(sops.got) != 1 {
		t.Fatalf("关闭了还发起了：%d", len(sops.got))
	}
}

// 需确认：发出 confirm 时不发起，确认后才发起；确认卡片写流程 id。
func TestRunSOPToolConfirm(t *testing.T) {
	sops := &fakeSOPStarter{}
	useSOPStarter(t, sops)
	chat := &grantChat{script: []func(func(Event)){grantCall(toolRunSOP, `{"flow_id":"sop_weekly"}`)}}
	r, st, ctx := newRunner(t, chat)
	r.Agent = &domain.Agent{ID: "ag_sop", Name: "流程助手"}
	r.Policy = &Policy{Grants: map[string]string{RunSOPAbility: store.GrantConfirm}}
	var confirm *StreamEvent
	if _, err := r.Run(ctx, "走一遍", func(ev StreamEvent) {
		if ev.Type == "confirm" {
			confirm = &ev
		}
	}); err != nil {
		t.Fatal(err)
	}
	if confirm == nil || confirm.Summary != "发起 SOP sop_weekly" || len(sops.got) != 0 {
		t.Fatalf("confirm = %+v，发起了 %d 次", confirm, len(sops.got))
	}
	tc, err := st.GetAgentToolCall(ctx, confirm.ID)
	if err != nil || tc.GrantKey != RunSOPAbility {
		t.Fatalf("待确认 = %+v %v", tc, err)
	}
	r.Chat = &grantChat{script: []func(func(Event)){grantSay("好了。")}}
	dec := &Decision{Call: tc, Approved: true}
	if _, err := r.Resume(ctx, dec, func(StreamEvent) {}); err != nil {
		t.Fatal(err)
	}
	if len(sops.got) != 1 || dec.Result != "发起了 SOP「周会」，执行记录 spr_1" {
		t.Fatalf("确认后：%d %q", len(sops.got), dec.Result)
	}
}

// 插件没启用、没挂 Agent 的会话、没接钩子。
func TestRunSOPToolUnavailable(t *testing.T) {
	sops := &fakeSOPStarter{err: schedule.ErrSOPUnavailable}
	useSOPStarter(t, sops)
	tb := NewToolbox(nil, nil)
	tb.withAgentSOP(&domain.Agent{ID: "ag_sop"})
	res := tb.Invoke(context.Background(), ToolCall{Name: toolRunSOP, Args: `{"flow_id":"sop_weekly"}`})
	if !strings.Contains(res.Content, "SOP 编排插件没启用") {
		t.Fatalf("插件停用：%+v", res)
	}
	if res := tb.Invoke(context.Background(), ToolCall{Name: toolRunSOP, Args: `{"flow_id":"sop_weekly","input":"不是对象"}`}); !strings.Contains(res.Content, "input 必须是对象") {
		t.Fatalf("input 不对：%+v", res)
	}

	// 没挂 Agent 的会话不给 run_sop
	plain := NewToolbox(nil, nil)
	plain.withAgentSOP(nil)
	if slices.Contains(grantToolNames(plain.Defs()), toolRunSOP) {
		t.Fatal("没挂 Agent 不该有 run_sop")
	}
	// 没接钩子也不给
	SetSOPStarter(nil)
	tb = NewToolbox(nil, nil)
	tb.withAgentSOP(&domain.Agent{ID: "ag_sop"})
	if slices.Contains(grantToolNames(tb.Defs()), toolRunSOP) {
		t.Fatal("没接钩子不该有 run_sop")
	}
}
