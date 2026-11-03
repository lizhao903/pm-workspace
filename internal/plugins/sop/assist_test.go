package sop

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

const assistDraft = `{"name":"客户反馈转需求","desc":"","trigger":"manual","fields":[{"key":"text","label":"输入内容","type":"textarea"}],
"steps":[{"key":"s1","name":"AI 提炼诉求","kind":"ai","desc":"","after":[],"config":{}},
{"key":"s2","name":"建任务","kind":"task","desc":"","after":["s1"],"config":{"title":"跟进"}}]}`

// 假服务商：记下提示词，回固定的原文
func fakeModel(reply string, seen *[2]string) completer {
	return func(_ context.Context, system, user string) (string, error) {
		if seen != nil {
			*seen = [2]string{system, user}
		}
		return reply, nil
	}
}

func assistBody(msg, draft string, selected string) string {
	b, _ := json.Marshal(msg)
	s := `{"message":` + string(b) + `,"draft":` + draft
	if selected != "" {
		s += `,"selected":` + selected
	}
	return s + "}"
}

func TestAssistAddReview(t *testing.T) {
	// 模型在「AI 提炼诉求」后面插一个人工检查，原来接它的「建任务」改接新步骤
	model := "```json\n" + `{"text":"在「AI 提炼诉求」后面加一步「检查AI 提炼诉求」（人工检查）。","draft":{"name":"别的名字","steps":[
{"key":"s1","name":"AI 提炼诉求","kind":"ai","desc":"","after":[],"config":{}},
{"key":"s3","name":"检查AI 提炼诉求","kind":"review","desc":"","after":["s1"],"config":{}},
{"key":"s2","name":"建任务","kind":"task","desc":"","after":["s3"],"config":{"title":"跟进"}}]},"notes":[]}` + "\n```"
	var seen [2]string
	p := New()
	p.complete = fakeModel(model, &seen)
	_, h := setup(t, p)
	code, out := call(t, h, "POST", "/api/sop/assist", assistBody("在AI 提炼诉求之后加一个人工检查", assistDraft, "0"))
	if code != 200 {
		t.Fatalf("code=%d out=%v", code, out)
	}
	data := out["data"].(map[string]any)
	draft := data["draft"].(map[string]any)
	if draft["name"] != "客户反馈转需求" {
		t.Fatalf("草稿已有名称时要保留：%v", draft["name"])
	}
	steps := draft["steps"].([]any)
	if len(steps) != 3 || steps[1].(map[string]any)["kind"] != "review" {
		t.Fatalf("steps=%v", steps)
	}
	notes, _ := data["notes"].([]any)
	for _, n := range notes {
		if strings.HasPrefix(n.(string), "必须改") {
			t.Fatalf("返回的草稿应当通过校验：%v", data["notes"])
		}
	}
	// 返回的草稿能直接保存
	b, _ := json.Marshal(draft)
	if code, out := call(t, h, "POST", "/api/sop/flows", string(b)); code != 201 {
		t.Fatalf("保存返回的草稿 code=%d out=%v", code, out)
	}
	// 提示词里带节点类型目录、当前草稿和选中的步骤
	for _, want := range []string{`"kind":"subflow"`, `"label":"人工检查"`, "客户反馈转需求", "「AI 提炼诉求」"} {
		if !strings.Contains(seen[0], want) {
			t.Fatalf("提示词里没有 %s：\n%s", want, seen[0])
		}
	}
	if seen[1] != "在AI 提炼诉求之后加一个人工检查" {
		t.Fatalf("user=%q", seen[1])
	}
}

func TestAssistCheckSkipsModel(t *testing.T) {
	p := New()
	p.complete = func(context.Context, string, string) (string, error) {
		t.Fatal("检查不该调模型")
		return "", nil
	}
	_, h := setup(t, p)

	code, out := call(t, h, "POST", "/api/sop/assist", assistBody("检查一下流程", assistDraft, ""))
	data, _ := out["data"].(map[string]any)
	if code != 200 || !strings.HasPrefix(data["text"].(string), "看了一遍，有 1 处要注意") {
		t.Fatalf("code=%d out=%v", code, out)
	}
	if n := data["notes"].([]any); n[0] != "建议：整个流程没有人工检查点，执行时不会停下来让人看输出" {
		t.Fatalf("notes=%v", n)
	}
	if _, ok := data["draft"]; ok {
		t.Fatal("检查不出草稿")
	}

	// 拦保存的问题算「必须改」
	bad := `{"name":"","steps":[{"key":"a","name":"调接口","kind":"http","config":{}},{"key":"b","name":"看","kind":"review","after":["a"]}]}`
	_, out = call(t, h, "POST", "/api/sop/assist", assistBody("有没有问题", bad, ""))
	notes := out["data"].(map[string]any)["notes"].([]any)
	if len(notes) != 2 || notes[0] != "必须改：还没有名称" || notes[1] != "必须改：「调接口」还没填「地址」" {
		t.Fatalf("notes=%v", notes)
	}

	good := `{"name":"审批","steps":[{"key":"a","name":"AI 起草","kind":"ai"},{"key":"b","name":"判断","kind":"decide","after":["a"],"cases":[{"key":"yes","label":"是"},{"key":"no","label":"否"}]},
{"key":"c","name":"通过","kind":"auto","after":["b"],"branch":{"of":"b","case":"yes"}},{"key":"d","name":"退回","kind":"auto","after":["b"],"branch":{"of":"b","case":"no"}}]}`
	_, out = call(t, h, "POST", "/api/sop/assist", assistBody("帮我检查", good, ""))
	data = out["data"].(map[string]any)
	if data["text"] != "流程结构没问题：每个判断的分支都有步骤，有人工检查点，依赖也都连上了。" {
		t.Fatalf("out=%v", out)
	}
	if n := data["notes"].([]any); n[0] != "4 个步骤：自动执行 2、AI 处理 1、条件分支 1" || n[1] != "「判断」分出 「是」「否」" {
		t.Fatalf("notes=%v", n)
	}
}

func TestAssistBadModelReply(t *testing.T) {
	for _, reply := range []string{
		"好的，我来加一个人工检查。",
		`{"text":"改好了","draft":{"steps":[`,
		`{"text":1}`,
		`{"text":"改好了","draft":{"steps":"不是数组"}}`,
		`{"text":"改好了","draft":["s1"]}`,
		`{"notes":[]}`,
	} {
		p := New()
		p.complete = fakeModel(reply, nil)
		_, h := setup(t, p)
		code, out := call(t, h, "POST", "/api/sop/assist", assistBody("加一个人工检查", assistDraft, ""))
		e, _ := out["error"].(map[string]any)
		if code != 422 || e["code"] != "bad_model_reply" || e["message"] == "" {
			t.Fatalf("reply=%q code=%d out=%v", reply, code, out)
		}
	}
}

func TestAssistDraftIssuesInNotes(t *testing.T) {
	// 模型回的草稿有校验问题：照常返回，问题放进 notes
	p := New()
	p.complete = fakeModel(`{"text":"加了一个接口调用","draft":{"steps":[{"key":"s1","name":"调接口","kind":"http","config":{}}]},"notes":["地址要你填"]}`, nil)
	_, h := setup(t, p)
	code, out := call(t, h, "POST", "/api/sop/assist", assistBody("调一下 CRM 接口", `{"name":"","steps":[]}`, ""))
	if code != 200 {
		t.Fatalf("code=%d out=%v", code, out)
	}
	notes := out["data"].(map[string]any)["notes"].([]any)
	want := []string{"地址要你填", "必须改：还没有名称", "必须改：「调接口」还没填「地址」", "建议：整个流程没有人工检查点，执行时不会停下来让人看输出"}
	if len(notes) != len(want) {
		t.Fatalf("notes=%v", notes)
	}
	for i := range want {
		if notes[i] != want[i] {
			t.Fatalf("notes=%v", notes)
		}
	}
}

func TestAssistValidation(t *testing.T) {
	p := New()
	p.complete = fakeModel(`{"text":"好"}`, nil)
	_, h := setup(t, p)
	for _, body := range []string{
		`{"draft":{}}`,
		`{"message":"  ","draft":{}}`,
		`{"message":"加一步","draft":"x"}`,
		`{"message":"加一步","draft":{"steps":{}}}`,
		assistBody("加一步", assistDraft, "5"),
	} {
		if code, out := call(t, h, "POST", "/api/sop/assist", body); code != 400 {
			t.Fatalf("body=%s code=%d out=%v", body, code, out)
		}
	}
	// 没有 draft 也能用：从一段话拆流程
	if code, out := call(t, h, "POST", "/api/sop/assist", `{"message":"收到报销单然后经理审批"}`); code != 200 || out["data"].(map[string]any)["text"] != "好" {
		t.Fatalf("code=%d out=%v", code, out)
	}
}

func TestAssistNoModel(t *testing.T) {
	// 没注入假服务商、注册表也没接模型：503，检查照常能用
	_, h := setup(t, New())
	code, out := call(t, h, "POST", "/api/sop/assist", assistBody("加一个人工检查", assistDraft, ""))
	if e, _ := out["error"].(map[string]any); code != 503 || e["code"] != "model_unavailable" {
		t.Fatalf("code=%d out=%v", code, out)
	}
	if code, _ := call(t, h, "POST", "/api/sop/assist", assistBody("检查一下", assistDraft, "")); code != 200 {
		t.Fatalf("检查 code=%d", code)
	}
}
