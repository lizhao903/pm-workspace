package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"slices"
	"strings"
	"testing"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/schedule"
	"github.com/lizhao903/pm-workspace/internal/store"
)

// TSK-0480：会话 ags_06gtxj0d159ynhvd 里「SOP 编排助手」编 flow_id、同参重试、调满 8 轮后执行器兜底「好的，已经处理完了」。

// fakeCatalog 同时是发起入口和流程目录。
type fakeCatalog struct {
	fakeSOPStarter
	flows []schedule.SOPFlowBrief
	saved []schedule.SOPSave
	err   error
}

func (f *fakeCatalog) ListSOPs(context.Context) ([]schedule.SOPFlowBrief, error) { return f.flows, nil }

func (f *fakeCatalog) GetSOP(_ context.Context, ref string) (*schedule.SOPFlowDoc, error) {
	for _, x := range f.flows {
		if x.ID == ref || x.Name == ref {
			return &schedule.SOPFlowDoc{SOPFlowBrief: x, Fields: json.RawMessage(`[]`), StepDefs: json.RawMessage(`[{"key":"a","kind":"auto"}]`)}, nil
		}
	}
	return nil, fmt.Errorf("流程 %s 不存在：%w", ref, schedule.ErrSOPNotFound)
}

func (f *fakeCatalog) SaveSOP(_ context.Context, q schedule.SOPSave) (*schedule.SOPFlowDoc, error) {
	f.saved = append(f.saved, q)
	if f.err != nil {
		return nil, f.err
	}
	var name, trig string
	_ = json.Unmarshal(q.Body["name"], &name)
	_ = json.Unmarshal(q.Body["trigger"], &trig)
	return &schedule.SOPFlowDoc{SOPFlowBrief: schedule.SOPFlowBrief{ID: "sop_new", Name: name, Trigger: trig, Steps: 2, Version: 1}}, nil
}

func (f *fakeCatalog) SOPNodeKinds(context.Context) ([]schedule.SOPNodeKind, error) {
	return []schedule.SOPNodeKind{{Kind: "decide", Label: "条件分支", Branching: true, Cases: []string{"yes", "no"}},
		{Kind: "im_mark_message", Required: []string{"state（标记为）"}}}, nil
}

func sopRunner(t *testing.T, chat Chat, grants map[string]string) (*Runner, *fakeCatalog, context.Context) {
	cat := &fakeCatalog{flows: []schedule.SOPFlowBrief{{ID: "sop_weekly", Name: "周会", Trigger: "manual", Steps: 3, Version: 2}}}
	useSOPStarter(t, cat)
	r, _, ctx := newRunner(t, chat)
	r.Agent = &domain.Agent{ID: "ag_sop", Name: "SOP 编排助手"}
	r.Policy = &Policy{Grants: grants}
	return r, cat, ctx
}

func lastToolContent(req Request) string {
	ms := req.Messages
	return ms[len(ms)-1].Content
}

// run_sop 传编出来的 flow_id：不发起，回给模型的结果里列出真实流程，给人看的 summary 仍是一句话。
func TestRunSOPUnknownFlowListsCandidates(t *testing.T) {
	chat := &grantChat{script: []func(func(Event)){grantCall(toolRunSOP, `{"flow_id":"workflow_default"}`), grantSay("没有这个流程。")}}
	r, cat, ctx := sopRunner(t, chat, map[string]string{RunSOPAbility: store.GrantAuto})
	var evs []StreamEvent
	if _, err := r.Run(ctx, "建个流程", func(ev StreamEvent) { evs = append(evs, ev) }); err != nil {
		t.Fatal(err)
	}
	if len(cat.got) != 0 {
		t.Fatalf("不存在的流程不该发起：%+v", cat.got)
	}
	got := lastToolContent(chat.reqs[1])
	for _, want := range []string{"workflow_default 不存在", "flow_id=sop_weekly", "名称=周会", "不要编"} {
		if !strings.Contains(got, want) {
			t.Errorf("回给模型的结果缺 %q：\n%s", want, got)
		}
	}
	for _, ev := range evs {
		if ev.Type == "tool_result" && (ev.Summary != "run_sop 执行失败：流程 workflow_default 不存在") {
			t.Errorf("summary = %q", ev.Summary)
		}
	}
}

// 查、建、改 SOP 的工具跟着 read_sop / write_sop 授权走；trigger 是对象，不认的键照常保存、写明没存上。
// 新建没有 flow_id（会话里模型拿已有流程的 id 去「新建」），修改必须带 version。
func TestSOPCatalogTools(t *testing.T) {
	chat := &grantChat{script: []func(func(Event)){
		grantCall(toolListSOPs, `{}`),
		grantCall(toolCreateSOP, `{"flow_id":"sop_weekly","name":"群消息忽略","trigger":{"type":"im","conversation":"C0BNCBRL5C0","priority":1},"steps":"[{\"key\":\"a\",\"kind\":\"decide\",\"rule\":\"relevance 不等于 me\"}]"}`),
		grantCall(toolUpdateSOP, `{"flow_id":"sop_weekly","desc":"改说明"}`),
		grantCall(toolUpdateSOP, `{"flow_id":"周会","version":2,"desc":"改说明"}`),
		grantSay("建好了。"),
	}}
	r, cat, ctx := sopRunner(t, chat, map[string]string{ReadSOPAbility: store.GrantAuto, WriteSOPAbility: store.GrantAuto})
	var evs []StreamEvent
	if _, err := r.Run(ctx, "建一个流程", func(ev StreamEvent) { evs = append(evs, ev) }); err != nil {
		t.Fatal(err)
	}
	names := grantToolNames(chat.reqs[0].Tools)
	for _, n := range []string{toolListSOPs, toolGetSOP, toolCreateSOP, toolUpdateSOP} {
		if !slices.Contains(names, n) {
			t.Errorf("开了授权应当给模型 %s：%v", n, names)
		}
	}
	if slices.Contains(names, toolRunSOP) {
		t.Error("没开 run_sop 不该给")
	}
	if got := lastToolContent(chat.reqs[1]); !strings.Contains(got, "flow_id=sop_weekly") {
		t.Errorf("list_sops = %q", got)
	}
	if len(cat.saved) != 2 {
		t.Fatalf("应保存两次（新建一次、带 version 的修改一次）：%+v", cat.saved)
	}
	if u := cat.saved[1]; u.ID != "周会" || string(u.Body["version"]) != "2" || string(u.Body["desc"]) != `"改说明"` {
		t.Fatalf("修改请求 = %+v", u)
	}
	if got := lastToolContent(chat.reqs[3]); !strings.Contains(got, "version 是必填的") {
		t.Errorf("修改不带 version 应拦下：%q", got)
	}
	q := cat.saved[0]
	if q.ID != "" || string(q.Body["trigger"]) != `"im"` || !strings.HasPrefix(string(q.Body["steps"]), `[{`) {
		t.Fatalf("保存请求 = id %q body %v", q.ID, map[string]string{"trigger": string(q.Body["trigger"]), "steps": string(q.Body["steps"])})
	}
	// TSK-0481：conversation 当 conversations 映射进 im（一个值写成字符串也认），priority 仍不认
	if im := string(q.Body["im"]); im != `{"conversations":["C0BNCBRL5C0"]}` {
		t.Errorf("im = %s", im)
	}
	got := lastToolContent(chat.reqs[2])
	if !strings.Contains(got, "trigger 里的 priority 现在还不支持") || !strings.Contains(got, "没有存上") || !strings.Contains(got, "如实说明") {
		t.Errorf("不认的触发条件要写明没存上：%q", got)
	}

	// 只开了查：没有 create_sop / update_sop，硬调不执行
	chat = &grantChat{script: []func(func(Event)){grantCall(toolCreateSOP, `{"name":"x","steps":[{"key":"a","kind":"auto"}]}`), grantSay("没有权限。")}}
	r, cat, ctx = sopRunner(t, chat, map[string]string{ReadSOPAbility: store.GrantAuto})
	if _, err := r.Run(ctx, "建一个流程", func(StreamEvent) {}); err != nil {
		t.Fatal(err)
	}
	if names := grantToolNames(chat.reqs[0].Tools); slices.Contains(names, toolCreateSOP) || slices.Contains(names, toolUpdateSOP) || !slices.Contains(names, toolGetSOP) {
		t.Errorf("只开 read_sop 时的工具 = %v", names)
	}
	if len(cat.saved) != 0 {
		t.Error("没授权的 create_sop 不该执行")
	}
}

func TestOutcomeFooterClipped(t *testing.T) {
	var o outcome
	long := "create_object 执行失败：" + strings.Repeat("很长的校验报错；", 100)
	for i := 0; i < 7; i++ {
		o.note(ToolCall{Name: "x", Args: fmt.Sprintf(`{"i":%d}`, i)}, ToolResult{Failed: true, Summary: fmt.Sprintf("%d %s", i, long)}, true)
	}
	f := o.footer()
	if !strings.HasPrefix(f, "【执行情况】本轮有 7 次调用没成功：") || !strings.Contains(f, "等 7 条") || len([]rune(f)) > 1000 {
		t.Fatalf("footer（%d 字）= %q", len([]rune(f)), f)
	}
}

func TestStepWarnings(t *testing.T) {
	got := stepWarnings(json.RawMessage(`[{"key":"s1","name":"读","kind":"im_get_message"},
		{"key":"s2","name":"判断","kind":"decide","config":{"rule":"relevance 等于 me"}},
		{"key":"s3","name":"人选","kind":"decide","after":["s2"]},
		{"key":"s4","name":"忽略","kind":"im_mark_message"},
		{"key":"s5","name":"好的","kind":"decide","rule":"relevance 不等于 me","after":["s1"]},
		{"key":"s6","name":"分支下","kind":"auto","branch":{"of":"s5","case":"yes"}}]`))
	want := []string{
		"第 2 步「判断」的 rule 写在了 config 里，要写在步骤上（和 kind 同级）",
		"第 2 步「判断」没有 after 也不在分支下，会和第 1 步同时开始",
		"第 3 步「人选」是条件分支但没有 rule，执行到这里会停下等人手动选",
		"第 4 步「忽略」没有 after 也不在分支下，会和第 1 步同时开始",
	}
	if !slices.Equal(got, want) {
		t.Fatalf("提醒 = %q", got)
	}
}

func TestSOPTriggerArg(t *testing.T) {
	cases := []struct {
		in      any
		typ     string
		ignored []string
		err     bool
	}{
		{nil, "", nil, false},
		{"im", "im", nil, false},
		{`{"type":"schedule","rule":{"kind":"daily"}}`, "schedule", nil, false},
		// TSK-0481：会话（含别名 conversation_id）、与我的关系、顺序、拦截认了；only_me 这类别的键仍报没存上
		{map[string]any{"type": "im", "only_me": false, "conversation_id": "cv_1"}, "im", []string{"only_me"}, false},
		{map[string]any{"type": "im", "conversations": []any{"C0BNCBRL5C0"}, "relevance": []any{"me"}, "relevance_mode": "exclude", "order": 1.0, "stop": true}, "im", nil, false},
		{map[string]any{"type": "cron"}, "", nil, true},
		{map[string]any{"conversation_id": "cv_1"}, "", nil, true},
		{42.0, "", nil, true},
	}
	for _, c := range cases {
		got, ignored, err := sopTrigger(c.in)
		if (err != nil) != c.err {
			t.Errorf("%v：err = %v", c.in, err)
			continue
		}
		typ := ""
		if got != nil {
			typ = got.Type
		}
		if typ != c.typ || !slices.Equal(ignored, c.ignored) {
			t.Errorf("%v：type %q ignored %v", c.in, typ, ignored)
		}
	}
}

// 调满 8 轮工具后再给一轮收尾；模型这一轮没说话、调用又有失败时，回复如实写执行情况，不再是「好的，已经处理完了」。
func TestRunnerWrapUpAfterMaxTurns(t *testing.T) {
	var script []func(func(Event))
	for i := 0; i < maxTurns; i++ {
		// 每轮换一个标题，免得被同参重试拦下
		script = append(script, grantCall("create_object", fmt.Sprintf(`{"type_id":"task","title":"流程 %d","status":"planning"}`, i)))
	}
	// 收尾轮：还想调工具、也没说话
	script = append(script, grantCall("create_object", `{"type_id":"task","title":"还要建"}`))
	chat := &grantChat{script: script}
	r, st, ctx := newRunner(t, chat)
	msgID, err := r.Run(ctx, "创建SOP", func(StreamEvent) {})
	if err != nil {
		t.Fatal(err)
	}
	if len(chat.reqs) != maxTurns+1 {
		t.Fatalf("应当调 %d 次模型（%d 轮工具 + 1 轮收尾），实际 %d", maxTurns+1, maxTurns, len(chat.reqs))
	}
	last := chat.reqs[maxTurns].Messages
	if m := last[len(last)-1]; m.Role != RoleSystem || !strings.Contains(m.Content, "上限") {
		t.Fatalf("收尾轮的最后一条应是「已达上限请总结」：%+v", m)
	}
	items, _, _ := st.ListObjects(ctx, domain.ObjectFilter{Query: "还要建"})
	if len(items) != 0 {
		t.Fatal("收尾轮调的工具不该执行")
	}
	reply := savedContent(t, r, msgID)
	if strings.Contains(reply, "已经处理完了") {
		t.Fatalf("不该谎报完成：%q", reply)
	}
	for _, want := range []string{"【执行情况】本轮有 8 次调用没成功：create_object 执行失败", "这一轮没有改动任何数据", "allowed: todo, doing"} {
		if !strings.Contains(reply, want) {
			t.Errorf("回复缺 %q：%q", want, reply)
		}
	}
}

// 模型自己说了「已经处理完了」也盖不掉：有成功有失败时写明实际改动。同参重试不执行。
func TestRunnerFooterAndRepeatedFailure(t *testing.T) {
	chat := &grantChat{script: []func(func(Event)){
		grantCall("create_object", `{"type_id":"task","title":"SOP 流程","status":"planning","priority":"P2"}`),
		// 键序不同、参数相同：不再执行
		grantCall("create_object", `{"priority":"P2","status":"planning","title":"SOP 流程","type_id":"task"}`),
		grantCall("create_object", `{"type_id":"task","title":"SOP 流程","status":"doing"}`),
		grantSay("好的，已经处理完了。"),
	}}
	r, _, ctx := newRunner(t, chat)
	msgID, err := r.Run(ctx, "创建SOP", func(StreamEvent) {})
	if err != nil {
		t.Fatal(err)
	}
	if got := lastToolContent(chat.reqs[2]); !strings.Contains(got, "参数完全一样") {
		t.Errorf("同参重试应被拦下：%q", got)
	}
	reply := savedContent(t, r, msgID)
	for _, want := range []string{"好的，已经处理完了。\n\n【执行情况】本轮有 2 次调用没成功", "没有再执行", "实际改动只有：已创建 TSK-"} {
		if !strings.Contains(reply, want) {
			t.Errorf("回复缺 %q：%q", want, reply)
		}
	}

	// 全部成功：不加执行情况
	chat = &grantChat{script: []func(func(Event)){grantCall("list_types", `{}`), grantSay("有六种类型。")}}
	r, _, ctx = newRunner(t, chat)
	msgID, err = r.Run(ctx, "有哪些类型", func(StreamEvent) {})
	if err != nil {
		t.Fatal(err)
	}
	if reply := savedContent(t, r, msgID); reply != "有六种类型。" {
		t.Errorf("没有失败时回复不该多东西：%q", reply)
	}
}

// 模型只调了工具没说话：兜底按实际结果写。
func TestRunnerFallbackByOutcome(t *testing.T) {
	chat := &grantChat{script: []func(func(Event)){grantCall("create_object", `{"type_id":"task","title":"记一下"}`)}}
	r, _, ctx := newRunner(t, chat)
	msgID, err := r.Run(ctx, "记一下", func(StreamEvent) {})
	if err != nil {
		t.Fatal(err)
	}
	if reply := savedContent(t, r, msgID); !strings.HasPrefix(reply, "这一轮做了：已创建 TSK-") {
		t.Errorf("兜底 = %q", reply)
	}
	chat = &grantChat{script: []func(func(Event)){grantCall("list_types", `{}`)}}
	r, _, ctx = newRunner(t, chat)
	msgID, err = r.Run(ctx, "看看", func(StreamEvent) {})
	if err != nil {
		t.Fatal(err)
	}
	if reply := savedContent(t, r, msgID); reply != "查过了，这一轮没有改动任何数据。" {
		t.Errorf("兜底 = %q", reply)
	}
}

func savedContent(t *testing.T, r *Runner, id string) string {
	t.Helper()
	msgs, err := r.Store.ListAgentMessages(context.Background(), r.Session.ID, 0)
	if err != nil {
		t.Fatal(err)
	}
	for _, m := range msgs {
		if m.ID == id {
			return m.Content
		}
	}
	t.Fatalf("没找到消息 %s", id)
	return ""
}

// TSK-0481：trigger 里 IM 的过滤、顺序、拦截映射成保存请求的 im；别名 conversation_id、逗号隔开的一串都认，调用方的参数不改。
func TestSOPTriggerIMKeys(t *testing.T) {
	in := map[string]any{"type": "im", "conversation_id": "C0BNCBRL5C0, cv_2", "relevance": "me", "relevance_mode": "exclude", "order": 1.0, "stop": true}
	got, ignored, err := sopTrigger(in)
	if err != nil || len(ignored) != 0 {
		t.Fatalf("err %v ignored %v", err, ignored)
	}
	b, _ := json.Marshal(got.IM)
	if string(b) != `{"conversations":["C0BNCBRL5C0","cv_2"],"order":1,"relevance":["me"],"relevance_mode":"exclude","stop":true}` {
		t.Fatalf("im = %s", b)
	}
	if _, ok := in["conversation_id"]; !ok {
		t.Fatal("不该改调用方的参数")
	}
	// 只有 type：不带 im，免得把已有的条件清掉
	got, _, _ = sopTrigger(map[string]any{"type": "im"})
	if len(got.IM) != 0 {
		t.Fatalf("没给条件时 im 应为空：%v", got.IM)
	}
}
