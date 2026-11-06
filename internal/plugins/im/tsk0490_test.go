package im

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"testing"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// TSK-0490：用户 2026-11-06 用 AI 协助存下的「忽略 ai-octok-platform 自动消息」v3 原稿保存时要被拦下或报出来；
// 修好的 v4（IM 过滤 + 顺序 1 + 拦截 + 单步标记忽略）能存、没有警告；AI 协助拿到 v3 这样的稿子会带着问题自动返修一轮。

// v3 原稿（去掉 id、版本、时间），会话写渠道编号
const flowV3 = `{"name":"忽略 ai-octok-platform 自动消息","desc":"","trigger":"im",
"fields":[{"key":"input","label":"输入内容","type":"textarea","required":true,"default":""}],
"steps":[{"key":"s1","name":"判断来源群组且未@我","kind":"decide","desc":"消息来源群组为 C0BNCBRL5C0 且消息中未 @ 我","after":[],"config":{},
  "cases":[{"key":"yes","label":"是"},{"key":"no","label":"否"}],"rule":"IM 消息来源群组 = C0BNCBRL5C0 且 消息中未 @ 我"},
 {"key":"s2","name":"设置忽略 IM 消息","kind":"auto","desc":"将该 IM 消息标记为忽略，不再继续处理","after":["s1"],"config":{"action":"ignore","target":"IM 消息"},"branch":{"of":"s1","case":"yes"}},
 {"key":"s3","name":"其他任务列入 IM 消息列表","kind":"auto","desc":"不满足忽略条件的任务，正常列入 IM 消息列表","after":["s1"],"config":{"action":"list","target":"IM 消息列表"},"branch":{"of":"s1","case":"no"}}],
"im":{"conversations":["C0BNCBRL5C0"],"relevance":["me","dm"],"relevance_mode":"exclude","order":1,"stop":false}}`

// v4：主会话手工修好的结构
const flowV4 = `{"name":"忽略 ai-octok-platform 自动消息","desc":"#ai-octok-platform（C0BNCBRL5C0）里除了 @我 的消息一律标为忽略","trigger":"im",
"im":{"conversations":["C0BNCBRL5C0"],"relevance":["me","dm"],"relevance_mode":"exclude","order":1,"stop":true},
"fields":[{"key":"message_id","label":"IM 消息","type":"text","required":true,"default":""}],
"steps":[{"key":"mark","name":"标记为忽略","kind":"im_mark_message","desc":"把这条消息标为忽略，不进待处理","after":[],"config":{"message":"{{message_id}}","state":"ignore"}}]}`

func setup0490(t *testing.T) sopEnv {
	t.Helper()
	e := setupSOP(t)
	exec(t, e.st.DB(), `INSERT INTO conversations (id, channel, external_id, kind, name, created_at, updated_at) VALUES
		('cv_octok', 'slack', 'C0BNCBRL5C0', 'group', '#ai-octok-platform', 'x', 'x')`)
	return e
}

func issuesOf(out map[string]any) []map[string]any {
	var raw []any
	if e, ok := out["error"].(map[string]any); ok {
		raw, _ = e["issues"].([]any)
	} else if d, ok := out["data"].(map[string]any); ok {
		raw, _ = d["issues"].([]any)
	}
	res := make([]map[string]any, 0, len(raw))
	for _, x := range raw {
		res = append(res, x.(map[string]any))
	}
	return res
}

func TestV3DraftBlockedOnSave(t *testing.T) {
	e := setup0490(t)
	code, out := call(t, e.h, "POST", "/api/sop/flows", flowV3)
	if code != 400 {
		t.Fatalf("v3 原稿不该存上：%d %v", code, out)
	}
	is := issuesOf(out)
	has := func(level, code string, n int) {
		t.Helper()
		got := 0
		for _, x := range is {
			if x["level"] == level && x["code"] == code {
				got++
			}
		}
		if got != n {
			t.Errorf("要 %d 条 %s/%s，实际 %d：%v", n, level, code, got, is)
		}
	}
	has("error", "rule_text", 1)      // 条件是一句话
	has("error", "input_unfilled", 1) // IM 触发下必填 input 没默认值
	has("warning", "auto_write", 2)   // auto 带 action/target
	msg := out["error"].(map[string]any)["message"].(string)
	if strings.Contains(msg, "自动执行节点") {
		t.Fatalf("message 只拼错误，警告逐条在 issues 里：%s", msg)
	}
}

func TestV4SavesClean(t *testing.T) {
	e := setup0490(t)
	code, out := call(t, e.h, "POST", "/api/sop/flows", flowV4)
	if code != 201 {
		t.Fatalf("v4 要能存：%d %v", code, out)
	}
	if is := issuesOf(out); len(is) != 0 {
		t.Fatalf("v4 不该有问题：%v", is)
	}
	d := out["data"].(map[string]any)
	im := d["im"].(map[string]any)
	if fmt.Sprint(im["conversations"]) != "[cv_octok]" || im["order"] != float64(1) || im["stop"] != true {
		t.Fatalf("im=%v", im)
	}

	// 这一步能拿到的字段：IM 自动带入的，relevance 带取值说明
	code, out = call(t, e.h, "POST", "/api/sop/step-fields", `{"draft":`+flowV4+`,"step":"mark"}`)
	if code != 200 {
		t.Fatalf("step-fields %d %v", code, out)
	}
	groups := out["data"].([]any)
	g0 := groups[0].(map[string]any)
	if g0["source"] != "trigger" {
		t.Fatalf("第一组应当是触发方式带入的：%v", groups)
	}
	found := false
	for _, f := range g0["fields"].([]any) {
		m := f.(map[string]any)
		if m["path"] == "relevance" {
			found = len(m["values"].([]any)) == 4 && m["declared"] == true
		}
	}
	if !found {
		t.Fatalf("relevance 要带 4 个取值：%v", g0)
	}
}

func TestIMNodeTypesDeclared(t *testing.T) {
	e := setup0490(t)
	code, out := call(t, e.h, "GET", "/api/sop/node-types", "")
	if code != 200 {
		t.Fatal(code)
	}
	var mark map[string]any
	for _, x := range out["data"].([]any) {
		if m := x.(map[string]any); m["kind"] == NodeMarkMessage {
			mark = m
		}
	}
	if mark == nil || mark["label"] != "标记消息" || mark["outputs_open"] != false {
		t.Fatalf("im_mark_message=%v", mark)
	}
	var state, msg map[string]any
	for _, p := range mark["params"].([]any) {
		switch m := p.(map[string]any); m["key"] {
		case "state":
			state = m
		case "message":
			msg = m
		}
	}
	if state == nil || len(state["options"].([]any)) != 4 || state["required"] != true {
		t.Fatalf("state=%v", state)
	}
	if msg == nil || msg["default"] != "{{message_id}}" || msg["template"] != true {
		t.Fatalf("message=%v", msg)
	}
}

// 读取消息之后的条件：message.relevance 是声明过的字段，能存；写一个没声明的字段（message.at_me）存不上
func TestCondFieldMustExist(t *testing.T) {
	e := setup0490(t)
	flow := func(field string) string {
		return `{"name":"x","trigger":"im","fields":[],"steps":[
		 {"key":"read","name":"读","kind":"im_get_message","after":[]},
		 {"key":"d","name":"判断","kind":"decide","after":["read"],"cases":[{"key":"yes","label":"是"},{"key":"no","label":"否"}],
		  "cond":{"logic":"and","items":[{"field":"` + field + `","op":"eq","value":"@我"},{"field":"conversation_id","op":"eq","value":"cv_octok"}]}},
		 {"key":"m","name":"忽略","kind":"im_mark_message","after":["d"],"branch":{"of":"d","case":"no"},"config":{"state":"ignore"}}]}`
	}
	if code, out := call(t, e.h, "POST", "/api/sop/flows", flow("message.relevance")); code != 201 {
		t.Fatalf("声明过的字段要能存：%d %v", code, out)
	}
	code, out := call(t, e.h, "POST", "/api/sop/flows", flow("message.at_me"))
	if code != 400 {
		t.Fatalf("没声明的字段要拦：%d %v", code, out)
	}
	if is := issuesOf(out); len(is) != 1 || is[0]["code"] != "cond_field" || !strings.Contains(is[0]["text"].(string), "message.relevance") {
		t.Fatalf("要指出能用的字段：%v", is)
	}
}

// 假模型：按顺序回 replies，记下每次的提示词
type scriptedAgent struct {
	plugin.AgentService
	mu      sync.Mutex
	replies []string
	seen    []plugin.CompleteRequest
}

func (a *scriptedAgent) Complete(_ context.Context, req plugin.CompleteRequest) (string, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.seen = append(a.seen, req)
	r := a.replies[0]
	if len(a.replies) > 1 {
		a.replies = a.replies[1:]
	}
	return r, nil
}

func TestAssistRepairsV3IntoV4(t *testing.T) {
	e := setup0490(t)
	var v3, v4 map[string]any
	_ = json.Unmarshal([]byte(flowV3), &v3)
	_ = json.Unmarshal([]byte(flowV4), &v4)
	reply := func(text string, d map[string]any) string {
		b, _ := json.Marshal(map[string]any{"text": text, "draft": d, "notes": []string{}})
		return string(b)
	}
	ag := &scriptedAgent{replies: []string{reply("按你的要求生成了流程", v3), reply("改成用 IM 过滤加标记忽略", v4)}}
	e.r.SetAgent(ag)
	ask := "把 C0BNCBRL5C0 这个会话群组中的消息（除去@我的），统一设置成忽略，优先于其他工作流执行"
	b, _ := json.Marshal(map[string]any{"message": ask, "draft": map[string]any{"name": "", "trigger": "manual", "fields": []any{}, "steps": []any{}}})
	code, out := call(t, e.h, "POST", "/api/sop/assist", string(b))
	if code != 200 {
		t.Fatalf("%d %v", code, out)
	}
	if len(ag.seen) != 2 {
		t.Fatalf("v3 有错，要自动返修一轮：调了 %d 次", len(ag.seen))
	}
	// 提示词：节点目录有插件节点和输出、条件写法、IM 过滤顺序拦截
	sys := ag.seen[0].System
	for _, want := range []string{"im_mark_message「标记消息」", "marked.state", "\"cond\"", "relevance_mode", "\"order\": 1, \"stop\": true", "message_id（string）"} {
		if !strings.Contains(sys, want) {
			t.Errorf("提示词里没有 %s", want)
		}
	}
	// 返修那一轮带着问题
	if u := ag.seen[1].Prompt; !strings.Contains(u, "是一句话") || !strings.Contains(u, "自动执行节点") || !strings.Contains(u, ask) {
		t.Fatalf("返修提示：%s", u)
	}
	d := out["data"].(map[string]any)
	draft := d["draft"].(map[string]any)
	im := draft["im"].(map[string]any)
	if draft["trigger"] != "im" || fmt.Sprint(im["conversations"]) != "[cv_octok]" || fmt.Sprint(im["relevance"]) != "[me dm]" ||
		im["relevance_mode"] != "exclude" || im["order"] != float64(1) || im["stop"] != true {
		t.Fatalf("草稿要等价 v4：%v", draft)
	}
	steps := draft["steps"].([]any)
	if len(steps) != 1 || steps[0].(map[string]any)["kind"] != NodeMarkMessage {
		t.Fatalf("steps=%v", steps)
	}
	notes := fmt.Sprint(d["notes"])
	if !strings.Contains(notes, "自动让模型返修了 1 轮，已改好") || strings.Contains(notes, "必须改") {
		t.Fatalf("notes=%v", d["notes"])
	}
	// 草稿能直接存
	draft["im"] = im
	bb, _ := json.Marshal(draft)
	if code, out := call(t, e.h, "POST", "/api/sop/flows", string(bb)); code != 201 {
		t.Fatalf("存草稿 %d %v", code, out)
	}
}
