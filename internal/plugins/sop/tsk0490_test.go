// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package sop

import (
	"context"
	"encoding/json"
	"fmt"
	"slices"
	"strings"
	"testing"
)

// TSK-0490：结构化条件、旧规则的兼容、按声明查的校验分级、这一步能拿到的字段。

func TestEvalCond(t *testing.T) {
	in := Json{"relevance": "me", "tags": []any{"bug", "ui"}, "n": float64(3), "empty": "", "obj": map[string]any{}}
	cases := []struct {
		c    Cond
		want bool
	}{
		{Cond{Items: []CondItem{{"relevance", "eq", "me"}}}, true},
		{Cond{Items: []CondItem{{"relevance", "ne", "me"}}}, false},
		{Cond{Items: []CondItem{{"tags", "contains", "ui"}}}, true},
		{Cond{Items: []CondItem{{"tags", "not_contains", "u"}}}, true}, // 列表按整项比
		{Cond{Items: []CondItem{{"n", "eq", "3"}}}, true},
		{Cond{Items: []CondItem{{"empty", "empty", ""}, {"missing", "empty", ""}, {"obj", "empty", ""}}}, true},
		{Cond{Items: []CondItem{{"relevance", "not_empty", ""}}}, true},
		{Cond{Logic: "and", Items: []CondItem{{"relevance", "eq", "me"}, {"n", "eq", "4"}}}, false},
		{Cond{Logic: "or", Items: []CondItem{{"relevance", "eq", "dm"}, {"n", "eq", "3"}}}, true},
		{Cond{Logic: "or", Items: []CondItem{{"relevance", "eq", "dm"}, {"n", "eq", "4"}}}, false},
	}
	for i, c := range cases {
		if got := evalCond(&c.c, in); got != c.want {
			t.Errorf("第 %d 条 %s：%v", i+1, condText(&c.c), got)
		}
	}
	// 值写成数字、布尔值也认
	var it CondItem
	if err := json.Unmarshal([]byte(`{"field":"ok","op":"eq","value":true}`), &it); err != nil || it.Value != "true" {
		t.Fatalf("%v %v", it, err)
	}
	if err := json.Unmarshal([]byte(`{"field":"ok","op":"eq","value":{"a":1}}`), &it); err == nil {
		t.Fatal("对象当值要报错")
	}
}

func TestLegacyCond(t *testing.T) {
	c, ok := legacyCond(`extracted.预算 等于 ""`)
	if !ok || c.Items[0] != (CondItem{"extracted.预算", "eq", ""}) {
		t.Fatalf("%v %v", c, ok)
	}
	c, ok = legacyCond("result.verdict 不包含 「reject」")
	if !ok || c.Items[0] != (CondItem{"result.verdict", "not_contains", "reject"}) {
		t.Fatalf("%v %v", c, ok)
	}
	if _, ok := legacyCond("IM 消息来源群组 = C0BNCBRL5C0 且 消息中未 @ 我"); ok {
		t.Fatal("一句话不能当旧规则")
	}
	// 换算前后结论一样
	for _, r := range []string{"a 等于 x", "a 不等于 x", "a 包含 x", "a 不包含 x"} {
		for _, v := range []any{"x", "xy", "z", []any{"x"}} {
			in := Json{"a": v}
			old, _ := evalRule(r, in)
			c, _ := legacyCond(r)
			if evalCond(c, in) != old {
				t.Errorf("%s 对 %v 不一致", r, v)
			}
		}
	}
	// AI 协助、Agent 存的草稿：旧规则换成 cond，一句话的留着交给校验
	got := string(normalizeSteps(json.RawMessage(`[{"key":"a","kind":"decide","rule":"x 等于 1"},{"key":"b","kind":"decide","rule":"看着办"}]`)))
	if !strings.Contains(got, `"cond":{"logic":"and","items":[{"field":"x","op":"eq","value":"1"}]}`) || !strings.Contains(got, `"rule":"看着办"`) ||
		strings.Contains(got, `"rule":"x 等于 1"`) {
		t.Fatal(got)
	}
}

func codes(issues []Issue) []string {
	out := make([]string, len(issues))
	for i, x := range issues {
		out[i] = x.Level + "/" + x.Code
	}
	return out
}

func checkOf(t *testing.T, body string) []Issue {
	t.Helper()
	var raw map[string]json.RawMessage
	if err := json.Unmarshal([]byte(body), &raw); err != nil {
		t.Fatal(err)
	}
	f := Flow{Fields: json.RawMessage(`[]`), Steps: json.RawMessage(`[]`)}
	_, err := apply(&f, raw, nodeType)
	if ce, ok := err.(*checkError); ok {
		return ce.issues
	}
	if err != nil {
		t.Fatal(err)
	}
	return checkFlow(&f, nodeType)
}

func TestDeclIssues(t *testing.T) {
	two := `"cases":[{"key":"yes","label":"是"},{"key":"no","label":"否"}]`
	cases := []struct {
		name string
		body string
		want []string
	}{
		{"旧规则只警告", `{"name":"x","fields":[{"key":"amount","label":"金额","type":"text"}],"steps":[{"key":"d","name":"判断","kind":"decide",` + two + `,"rule":"amount 等于 1"}]}`,
			[]string{"warning/legacy_rule"}},
		{"一句话拦", `{"name":"x","steps":[{"key":"d","name":"判断","kind":"decide",` + two + `,"rule":"金额大于五千"}]}`,
			[]string{"error/rule_text"}},
		{"cond 和 rule 都有", `{"name":"x","fields":[{"key":"a","label":"a","type":"text"}],"steps":[{"key":"d","name":"判断","kind":"decide",` + two + `,"rule":"a 等于 1","cond":{"items":[{"field":"a","op":"eq","value":"1"}]}}]}`,
			[]string{"error/cond"}},
		{"cond 写法不对", `{"name":"x","fields":[{"key":"a","label":"a","type":"text"}],"steps":[{"key":"d","name":"判断","kind":"decide",` + two + `,"cond":{"logic":"xor","items":[{"field":"a","op":"大于","value":"1"},{"field":"a","op":"contains"}]}}]}`,
			[]string{"error/cond", "error/cond", "error/cond"}},
		{"空条件", `{"name":"x","steps":[{"key":"d","name":"判断","kind":"decide",` + two + `,"cond":{"items":[]}}]}`,
			[]string{"error/cond"}},
		{"手动发起：发起方可能带进来，只警告", `{"name":"x","fields":[{"key":"a","label":"a","type":"text"}],"steps":[{"key":"d","name":"判断","kind":"decide",` + two + `,"cond":{"items":[{"field":"b","op":"eq","value":"1"}]}}]}`,
			[]string{"warning/cond_field"}},
		{"字段拿不到", `{"name":"x","trigger":"schedule","fields":[{"key":"a","label":"a","type":"text"}],"steps":[{"key":"d","name":"判断","kind":"decide",` + two + `,"cond":{"items":[{"field":"b","op":"eq","value":"1"}]}}]}`,
			[]string{"error/cond_field"}},
		{"上游输出的字段", `{"name":"x","steps":[{"key":"c","name":"写","kind":"claude_code","config":{"workdir":"/tmp","prompt":"x"}},{"key":"d","name":"判断","kind":"decide","after":["c"],` + two + `,"cond":{"items":[{"field":"result.verdict","op":"eq","value":"pass"},{"field":"result.items[0].kind","op":"not_empty"}]}}]}`,
			nil},
		{"AI 输出字段跟着配置", `{"name":"x","steps":[{"key":"a","name":"写","kind":"ai","config":{"output":"draft"}},{"key":"d","name":"判断","kind":"decide","after":["a"],` + two + `,"cond":{"items":[{"field":"draft","op":"contains","value":"好"}]}}]}`,
			nil},
		{"提取的字段", `{"name":"x","steps":[{"key":"e","name":"提","kind":"extract","config":{"fields":"金额、客户"}},{"key":"d","name":"判断","kind":"decide","after":["e"],` + two + `,"cond":{"items":[{"field":"extracted.客户","op":"empty"}]}}]}`,
			nil},
		{"下游拿不到分支后面的", `{"name":"x","trigger":"im","steps":[{"key":"d","name":"判断","kind":"decide",` + two + `,"cond":{"items":[{"field":"http.status","op":"eq","value":"200"}]}},{"key":"h","name":"调","kind":"http","after":["d"],"config":{"url":"http://x"}}]}`,
			[]string{"error/cond_field"}},
		{"auto 带配置", `{"name":"x","steps":[{"key":"a","name":"甲","kind":"auto","config":{"action":"ignore"}}]}`,
			[]string{"warning/auto_write"}},
		{"auto 名字像写操作", `{"name":"x","steps":[{"key":"a","name":"标记为忽略","kind":"auto"}]}`,
			[]string{"warning/auto_write"}},
		{"不认的配置", `{"name":"x","steps":[{"key":"a","name":"甲","kind":"review","config":{"who":"我"}}]}`,
			[]string{"warning/unknown_config"}},
		{"不是条件节点写了条件", `{"name":"x","steps":[{"key":"a","name":"甲","kind":"review","rule":"a 等于 1"}]}`,
			[]string{"warning/unused_cond"}},
		{"IM 必填补不上", `{"name":"x","trigger":"im","fields":[{"key":"input","label":"输入","type":"text","required":true}],"steps":[{"key":"a","name":"甲","kind":"review"}]}`,
			[]string{"error/input_unfilled"}},
		{"IM 自带的字段不算", `{"name":"x","trigger":"im","fields":[{"key":"message_id","label":"消息","type":"text","required":true},{"key":"b","label":"b","type":"text","required":true,"default":"1"}],"steps":[{"key":"a","name":"甲","kind":"review"}]}`,
			nil},
		{"定时必填只警告", `{"name":"x","trigger":"schedule","fields":[{"key":"week","label":"周次","type":"text","required":true}],"steps":[{"key":"a","name":"甲","kind":"review"}]}`,
			[]string{"warning/input_unfilled"}},
	}
	for _, c := range cases {
		got := codes(checkOf(t, c.body))
		if !slices.Equal(got, c.want) && !(len(got) == 0 && len(c.want) == 0) {
			t.Errorf("%s：%v，问题：%v", c.name, got, checkOf(t, c.body))
		}
	}
}

func TestCondDecideRuns(t *testing.T) {
	_, h := setup(t, New())
	id := newFlow(t, h, `{"name":"分流","fields":[{"key":"relevance","label":"关系","type":"text"},{"key":"conversation_id","label":"会话","type":"text"}],"steps":[
		{"key":"d","name":"判断","kind":"decide","after":[],"cases":[{"key":"yes","label":"是"},{"key":"no","label":"否"}],
		 "cond":{"logic":"and","items":[{"field":"conversation_id","op":"eq","value":"cv_1"},{"field":"relevance","op":"ne","value":"me"}]}},
		{"key":"y","name":"忽略","kind":"review","after":["d"],"branch":{"of":"d","case":"yes"}},
		{"key":"n","name":"照常","kind":"review","after":["d"],"branch":{"of":"d","case":"no"}}]}`)
	run := startRun(t, h, id, `{"input":{"conversation_id":"cv_1","relevance":""}}`)
	run = waitStatus(t, h, run["id"].(string), "waiting")
	d := step(run, "d")
	if d["route"] != "yes" || d["route_reason"] != "条件「conversation_id 等于 cv_1 且 relevance 不等于 me」成立" {
		t.Fatalf("%v %v", d["route"], d["route_reason"])
	}
	run = startRun(t, h, id, `{"input":{"conversation_id":"cv_1","relevance":"me"}}`)
	run = waitStatus(t, h, run["id"].(string), "waiting")
	if d := step(run, "d"); d["route"] != "no" {
		t.Fatalf("%v", d)
	}
}

// 已有流程：旧规则照旧执行；GET 一条带 issues（旧写法的警告），打开不受影响
func TestLegacyRuleStillRunsAndWarns(t *testing.T) {
	_, h := setup(t, New())
	id := newFlow(t, h, `{"name":"旧","fields":[{"key":"amount","label":"金额","type":"text"}],"steps":[
		{"key":"d","name":"判断","kind":"decide","after":[],"cases":[{"key":"yes","label":"是"},{"key":"no","label":"否"}],"rule":"amount 等于 1"},
		{"key":"y","name":"甲","kind":"review","after":["d"],"branch":{"of":"d","case":"yes"}}]}`)
	code, out := call(t, h, "GET", "/api/sop/flows/"+id, "")
	if code != 200 {
		t.Fatal(code)
	}
	is := out["data"].(map[string]any)["issues"].([]any)
	if len(is) != 1 || is[0].(map[string]any)["code"] != "legacy_rule" || !strings.Contains(is[0].(map[string]any)["text"].(string), "amount 等于 1") {
		t.Fatalf("%v", is)
	}
	run := startRun(t, h, id, `{"input":{"amount":"1"}}`)
	run = waitStatus(t, h, run["id"].(string), "waiting")
	if d := step(run, "d"); d["route"] != "yes" || d["route_reason"] != "规则「amount 等于 1」成立" {
		t.Fatalf("%v", d)
	}
	// 列表也带体检问题（TSK-0498 起，同详情）
	_, out = call(t, h, "GET", "/api/sop/flows", "")
	li := out["data"].([]any)[0].(map[string]any)["issues"].([]any)
	if len(li) != 1 || li[0].(map[string]any)["code"] != "legacy_rule" || li[0].(map[string]any)["step"] != float64(0) {
		t.Fatalf("列表 issues = %v", li)
	}
}

func TestNodeTypesAndTriggers(t *testing.T) {
	_, h := setup(t, New())
	_, out := call(t, h, "GET", "/api/sop/node-types", "")
	for _, x := range out["data"].([]any) {
		m := x.(map[string]any)
		if m["label"] == "" || m["params"] == nil || m["outputs"] == nil || m["outputs_open"] != false {
			t.Errorf("内置节点 %v 要有声明", m["kind"])
		}
	}
	code, out := call(t, h, "GET", "/api/sop/triggers", "")
	if code != 200 || len(out["data"].([]any)) != 3 {
		t.Fatalf("%d %v", code, out)
	}
	im := out["data"].([]any)[1].(map[string]any)
	if im["key"] != "im" || len(im["outputs"].([]any)) != 7 || im["auto"] != true {
		t.Fatalf("%v", im)
	}
}

func TestBuiltinSpecsComplete(t *testing.T) {
	for _, nt := range NodeTypes {
		sp, ok := builtinSpecs[nt.Kind]
		if !ok || sp.Label == "" || sp.Params == nil || sp.Outputs == nil {
			t.Errorf("内置节点 %s 没声明全", nt.Kind)
			continue
		}
		// 必填和声明一致
		var req []string
		for _, p := range sp.Params {
			if p.Required {
				req = append(req, p.Key)
			}
		}
		var want []string
		for _, r := range nt.Required {
			want = append(want, r.Key)
		}
		if !slices.Equal(req, want) {
			t.Errorf("%s 必填 %v，声明 %v", nt.Kind, want, req)
		}
	}
	if len(builtinSpecs) != len(NodeTypes) {
		t.Errorf("声明 %d 个，节点 %d 个", len(builtinSpecs), len(NodeTypes))
	}
}

func TestStepFields(t *testing.T) {
	_, h := setup(t, New())
	draft := `{"trigger":"im","fields":[{"key":"message_id","label":"消息","type":"text"},{"key":"note","label":"备注","type":"select","options":[{"value":"a","label":"甲"}]}],"steps":[
		{"key":"c","name":"评审","kind":"claude_code","config":{"workdir":"/tmp","prompt":"x"}},
		{"key":"l","name":"回退","kind":"loopback","after":["c"],"config":{"target":"c"},"cases":[{"key":"pass","label":"通过"},{"key":"over","label":"超限"}]},
		{"key":"e","name":"收","kind":"end","after":["l"],"config":{"outputs":"summary, note"}},
		{"key":"s","name":"后","kind":"review","after":["e"]}]}`
	get := func(stepKey string) []any {
		t.Helper()
		code, out := call(t, h, "POST", "/api/sop/step-fields", `{"draft":`+draft+`,"step":"`+stepKey+`"}`)
		if code != 200 {
			t.Fatalf("%d %v", code, out)
		}
		return out["data"].([]any)
	}
	paths := func(groups []any) []string {
		var out []string
		for _, g := range groups {
			for _, f := range g.(map[string]any)["fields"].([]any) {
				out = append(out, f.(map[string]any)["path"].(string))
			}
		}
		return out
	}
	start := paths(get("__start"))
	if !slices.Contains(start, "relevance") || !slices.Contains(start, "note") || len(slices.DeleteFunc(slices.Clone(start), func(x string) bool { return x != "message_id" })) != 1 {
		t.Fatalf("开始：%v", start)
	}
	c := get("c")
	if g := c[len(c)-1].(map[string]any); g["source"] != "loopback" {
		t.Fatalf("回退目标要多 feedback：%v", c)
	}
	if l := paths(get("l")); !slices.Contains(l, "result.verdict") || !slices.Contains(l, "feedback") {
		t.Fatalf("回退：%v", l)
	}
	if s := paths(get("s")); !slices.Equal(s, []string{"note", "summary"}) {
		t.Fatalf("结束挑了字段，往下只剩这两个：%v", s)
	}
	if code, _ := call(t, h, "POST", "/api/sop/step-fields", `{"draft":`+draft+`,"step":"nope"}`); code != 400 {
		t.Fatal("没有的步骤 400")
	}
}

// 模型第一次回的 JSON 不完整（小模型常漏括号）：带着原因重回一次，第二次好了就用第二次的
func TestAssistRetriesBadJSON(t *testing.T) {
	var users []string
	replies := []string{`{"text":"好","draft":{"name":"x","steps":[{"key":"a","name":"看","kind":"review"}]}`,
		`{"text":"好","draft":{"name":"x","steps":[{"key":"a","name":"看","kind":"review"}]}}`}
	p := New()
	p.complete = func(_ context.Context, _, user string) (string, error) {
		users = append(users, user)
		r := replies[0]
		replies = replies[1:]
		return r, nil
	}
	_, h := setup(t, p)
	code, out := call(t, h, "POST", "/api/sop/assist", assistBody("加一个人工检查", `{"name":"","steps":[]}`, ""))
	if code != 200 || len(users) != 2 || !strings.Contains(users[1], "回的不是合法的草稿") {
		t.Fatalf("%d %v %q", code, out, users)
	}
	if !strings.Contains(fmt.Sprint(out["data"].(map[string]any)["notes"]), "返修了 1 轮，已改好") {
		t.Fatalf("%v", out)
	}
}
