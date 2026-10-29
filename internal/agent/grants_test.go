package agent

import (
	"context"
	"errors"
	"slices"
	"strings"
	"sync"
	"testing"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/store"
)

// grantChat 按剧本一轮吐一段，并记下每一轮收到的请求（工具列表、消息）。
type grantChat struct {
	mu     sync.Mutex
	script []func(on func(Event))
	reqs   []Request
}

func (c *grantChat) Stream(_ context.Context, req Request, on func(Event)) error {
	c.mu.Lock()
	i := len(c.reqs)
	c.reqs = append(c.reqs, req)
	c.mu.Unlock()
	if i < len(c.script) {
		c.script[i](on)
	}
	return nil
}

func grantToolNames(defs []ToolDef) []string {
	out := make([]string, len(defs))
	for i, d := range defs {
		out[i] = d.Name
	}
	return out
}

func grantCall(name, args string) func(on func(Event)) {
	return func(on func(Event)) {
		on(Event{Kind: EventToolCall, Call: ToolCall{ID: "c_" + name, Name: name, Args: args}})
	}
}

func grantSay(text string) func(on func(Event)) {
	return func(on func(Event)) { on(Event{Kind: EventDelta, Text: text}) }
}

func TestMinModeAndConnToolName(t *testing.T) {
	cases := [][3]string{
		{"auto", "confirm", "confirm"}, {"confirm", "auto", "confirm"}, {"auto", "auto", "auto"},
		{"off", "auto", "off"}, {"confirm", "off", "off"}, {"weird", "auto", "off"},
	}
	for _, c := range cases {
		if got := MinMode(c[0], c[1]); got != c[2] {
			t.Errorf("MinMode(%s, %s) = %s，应为 %s", c[0], c[1], got, c[2])
		}
	}
	if got := ConnToolName("fake", "create.item"); got != "fake__create_item" {
		t.Errorf("ConnToolName = %s", got)
	}
	if got := ConnToolName("fake", strings.Repeat("x", 80)); len(got) != 64 {
		t.Errorf("名字没截到 64：%d", len(got))
	}
}

// 关闭的工具不在给模型的工具列表里；只读能力设 confirm 按 auto 算；连接器工具只给没关闭的。
func TestPolicyToolsFilter(t *testing.T) {
	p := &Policy{
		Grants: map[string]string{"read_tasks": "confirm"},
		Conn: []ConnTool{
			{Name: "fake__list_items", Tool: "list_items", Mode: "auto"},
			{Name: "fake__create_item", Tool: "create_item", Write: true, Mode: "off"},
		},
	}
	tb := NewToolbox(nil, &domain.AgentSession{})
	got := grantToolNames(p.Tools(tb.Defs()))
	for _, want := range []string{"search_objects", "get_object", "list_types", "ask_user", "fake__list_items"} {
		if !slices.Contains(got, want) {
			t.Errorf("工具列表里没有 %s：%v", want, got)
		}
	}
	for _, no := range []string{"create_object", "update_object", "write_file", "fake__create_item"} {
		if slices.Contains(got, no) {
			t.Errorf("关闭的 %s 出现在工具列表里：%v", no, got)
		}
	}
	if m, key := p.ModeOf("get_object"); m != "auto" || key != "read_tasks" {
		t.Errorf("只读能力的 confirm 应按 auto 算，得到 %s %s", m, key)
	}
	// 没挂 Agent 的老会话：工具全给
	var nilP *Policy
	if len(nilP.Tools(tb.Defs())) != len(tb.Defs()) {
		t.Error("nil Policy 不该过滤工具")
	}
}

// 验收：假服务商硬调关闭的工具，不执行，工具结果是「没有授权」。
func TestRunnerDeniesUnauthorizedTool(t *testing.T) {
	chat := &grantChat{script: []func(func(Event)){
		grantCall("create_object", `{"type_id":"task","title":"硬调建的任务"}`),
		grantSay("好的，我没有权限建任务。"),
	}}
	r, st, ctx := newRunner(t, chat)
	r.Agent = &domain.Agent{ID: "ag_test", Name: "测试"}
	r.Policy = &Policy{Grants: map[string]string{"read_tasks": "auto"}}

	var evs []StreamEvent
	if _, err := r.Run(ctx, "建个任务", func(ev StreamEvent) { evs = append(evs, ev) }); err != nil {
		t.Fatal(err)
	}
	if slices.Contains(grantToolNames(chat.reqs[0].Tools), "create_object") {
		t.Fatal("关闭的 create_object 不该给模型")
	}
	objs, _, err := st.ListObjects(ctx, domain.ObjectFilter{Query: "硬调建的任务"})
	if err != nil {
		t.Fatal(err)
	}
	if len(objs) != 0 {
		t.Fatalf("没授权的工具被执行了：%d 条", len(objs))
	}
	var denied bool
	for _, ev := range evs {
		if ev.Type == "tool_result" && strings.Contains(ev.Summary, "没有授权") {
			denied = true
		}
	}
	if !denied {
		t.Errorf("没有「没有授权」的 tool_result：%+v", evs)
	}
	last := chat.reqs[1].Messages
	if m := last[len(last)-1]; m.Role != domain.RoleTool || !strings.Contains(m.Content, "没有授权") {
		t.Errorf("回给模型的工具结果 = %+v", m)
	}
}

// 验收：需确认的写工具发出 confirm 后本轮结束；确认后执行并继续，拒绝后不执行。
func TestRunnerConfirmThenResume(t *testing.T) {
	for _, approved := range []bool{true, false} {
		title := "待确认的任务"
		if !approved {
			title = "被拒绝的任务"
		}
		chat := &grantChat{script: []func(func(Event)){
			grantCall("create_object", `{"type_id":"task","title":"`+title+`"}`),
			grantSay("不该跑到这里"),
		}}
		r, st, ctx := newRunner(t, chat)
		r.Agent = &domain.Agent{ID: "ag_test", Name: "测试"}
		r.Policy = &Policy{Grants: map[string]string{"write_tasks": "confirm"}}

		var evs []StreamEvent
		if _, err := r.Run(ctx, "建个任务", func(ev StreamEvent) { evs = append(evs, ev) }); err != nil {
			t.Fatal(err)
		}
		if len(chat.reqs) != 1 {
			t.Fatalf("发出 confirm 后又跑了 %d 轮", len(chat.reqs))
		}
		var confirm *StreamEvent
		for i := range evs {
			if evs[i].Type == "confirm" {
				confirm = &evs[i]
			}
			if evs[i].Type == "tool_call" {
				t.Errorf("需确认的调用不该发 tool_call")
			}
		}
		if confirm == nil || confirm.ID == "" || confirm.Name != "create_object" || !strings.Contains(confirm.Summary, title) {
			t.Fatalf("confirm 事件 = %+v", confirm)
		}
		objs, _, _ := st.ListObjects(ctx, domain.ObjectFilter{Query: title})
		if len(objs) != 0 {
			t.Fatal("确认前就执行了")
		}
		tc, err := st.GetAgentToolCall(ctx, confirm.ID)
		if err != nil || tc.State != store.ToolCallPending || tc.GrantKey != "write_tasks" || *tc.SessionID != r.Session.ID {
			t.Fatalf("待确认的调用 = %+v，%v", tc, err)
		}

		chat2 := &grantChat{script: []func(func(Event)){grantSay("处理完了。")}}
		r.Chat = chat2
		if _, err := st.DecideAgentToolCall(ctx, tc.ID, map[bool]string{true: "confirmed", false: "rejected"}[approved]); err != nil {
			t.Fatal(err)
		}
		dec := &Decision{Call: tc, Approved: approved}
		evs = nil
		if _, err := r.Resume(ctx, dec, func(ev StreamEvent) { evs = append(evs, ev) }); err != nil {
			t.Fatal(err)
		}
		objs, _, _ = st.ListObjects(ctx, domain.ObjectFilter{Query: title})
		if approved && len(objs) != 1 {
			t.Fatalf("确认后没有执行：%d 条", len(objs))
		}
		if !approved && len(objs) != 0 {
			t.Fatal("拒绝后仍然执行了")
		}
		if len(chat2.reqs) != 1 {
			t.Fatalf("确认或拒绝后模型应接着跑一轮，跑了 %d 轮", len(chat2.reqs))
		}
		ms := chat2.reqs[0].Messages
		note := ms[len(ms)-1]
		want := "用户确认了"
		if !approved {
			want = "用户拒绝了"
		}
		if note.Role != RoleSystem || !strings.Contains(note.Content, want) {
			t.Errorf("交回模型的说明 = %+v", note)
		}
		if !strings.Contains(dec.Result, map[bool]string{true: "已创建", false: "用户拒绝了"}[approved]) {
			t.Errorf("Result = %q", dec.Result)
		}
	}
}

// 连接器工具：自动的经 Call 调对方；没实现 Call 的回「还不能调用」。
func TestRunnerConnectorToolCall(t *testing.T) {
	var gotArgs string
	chat := &grantChat{script: []func(func(Event)){
		func(on func(Event)) {
			on(Event{Kind: EventToolCall, Call: ToolCall{ID: "a", Name: "fake__list_items", Args: `{"q":"x"}`}})
			on(Event{Kind: EventToolCall, Call: ToolCall{ID: "b", Name: "fake__get_item", Args: `{}`}})
			on(Event{Kind: EventToolCall, Call: ToolCall{ID: "c", Name: "fake__boom", Args: `{}`}})
		},
		grantSay("好了。"),
	}}
	r, _, ctx := newRunner(t, chat)
	r.Agent = &domain.Agent{ID: "ag_test", Name: "测试"}
	r.Policy = &Policy{Conn: []ConnTool{
		{Name: "fake__list_items", ConnectorName: "测试连接器", Tool: "list_items", Mode: "auto",
			Call: func(_ context.Context, args string) (string, error) { gotArgs = args; return `{"items":[]}`, nil }},
		{Name: "fake__get_item", ConnectorName: "测试连接器", Tool: "get_item", Mode: "auto"},
		{Name: "fake__boom", ConnectorName: "测试连接器", Tool: "boom", Mode: "auto",
			Call: func(context.Context, string) (string, error) { return "", errors.New("对方挂了") }},
	}}
	if _, err := r.Run(ctx, "列一下", func(StreamEvent) {}); err != nil {
		t.Fatal(err)
	}
	if gotArgs != `{"q":"x"}` {
		t.Errorf("参数没原样交给连接器：%q", gotArgs)
	}
	var contents []string
	for _, m := range chat.reqs[1].Messages {
		if m.Role == domain.RoleTool {
			contents = append(contents, m.Content)
		}
	}
	joined := strings.Join(contents, "\n")
	for _, want := range []string{`{"items":[]}`, "这个连接器的工具还不能调用", "对方挂了"} {
		if !strings.Contains(joined, want) {
			t.Errorf("工具结果里没有 %q：%v", want, contents)
		}
	}
}
