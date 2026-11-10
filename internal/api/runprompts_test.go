// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/store"
)

func TestRunPromptsDefaultsAndReplace(t *testing.T) {
	s, _, _, _ := terminalFixture(t)
	list := decodeEnvelope(t, do(s, "GET", "/api/run-prompts", ""))["data"].([]any)
	if len(list) != 6 {
		t.Fatalf("没设过应回内置六个角色：%v", list)
	}
	scenes := []string{}
	for _, x := range list {
		scenes = append(scenes, x.(map[string]any)["scene"].(string))
	}
	if strings.Join(scenes, ",") != "分类,产品经理工作台,研发评审,研发,测试设计,原型同步" {
		t.Fatalf("内置角色：%v", scenes)
	}
	pm := list[1].(map[string]any)
	if pm["default"] != true || !strings.Contains(pm["content"].(string), "PRD") || pm["permission"] != "accept_edits" {
		t.Fatalf("产品经理工作台应默认、允许改文件：%v", pm)
	}
	review := list[2].(map[string]any)
	if review["permission"] != "read_only" || review["dir_kind"] != "code" ||
		!strings.Contains(review["output"].(string), "pmw_finish_run") || !strings.Contains(review["output"].(string), `"verdict"`) {
		t.Fatalf("研发评审应只读并要求回报 verdict：%v", review)
	}

	w := do(s, "PUT", "/api/run-prompts", `{"items":[{"scene":" 视频博主 ","content":" 按口播稿出分镜 ","default":true},{"id":"rp_pm","scene":"产品经理工作台","content":"出 PRD"}]}`)
	if w.Code != http.StatusOK {
		t.Fatalf("保存：%d %s", w.Code, w.Body.String())
	}
	got := decodeEnvelope(t, do(s, "GET", "/api/run-prompts", ""))["data"].([]any)
	a := got[0].(map[string]any)
	if len(got) != 2 || a["scene"] != "视频博主" || a["content"] != "按口播稿出分镜" || !strings.HasPrefix(a["id"].(string), "rp_") {
		t.Fatalf("保存后（删掉的内置角色不补回）：%v", got)
	}
	if a["permission"] != "accept_edits" || a["dir_kind"] != "any" || a["output"] != "" {
		t.Fatalf("不带新字段按默认补：%v", a)
	}

	for name, body := range map[string]string{
		"场景空":    `{"items":[{"scene":"","content":"x"}]}`,
		"内容空":    `{"items":[{"scene":"a","content":" "}]}`,
		"场景重复":   `{"items":[{"scene":"a","content":"x"},{"scene":"a","content":"y"}]}`,
		"两条默认":   `{"items":[{"scene":"a","content":"x","default":true},{"scene":"b","content":"y","default":true}]}`,
		"id 不合法": `{"items":[{"id":"../x","scene":"a","content":"x"}]}`,
		"场景超长":   `{"items":[{"scene":"` + strings.Repeat("长", 41) + `","content":"x"}]}`,
		"权限不认识":  `{"items":[{"scene":"a","content":"x","permission":"bypass"}]}`,
		"目录不认识":  `{"items":[{"scene":"a","content":"x","dir_kind":"tmp"}]}`,
		"输出超长":   `{"items":[{"scene":"a","content":"x","output":"` + strings.Repeat("长", 2001) + `"}]}`,
	} {
		if w := do(s, "PUT", "/api/run-prompts", body); w.Code != http.StatusBadRequest {
			t.Errorf("%s 应 400，得到 %d", name, w.Code)
		}
	}
	// 空数组：一条都不要
	if w := do(s, "PUT", "/api/run-prompts", `{"items":[]}`); w.Code != http.StatusOK {
		t.Fatal(w.Body.String())
	}
	if got := decodeEnvelope(t, do(s, "GET", "/api/run-prompts", ""))["data"].([]any); len(got) != 0 {
		t.Fatalf("清空后应为空：%v", got)
	}
}

func TestRunPromptsRoleFieldsRoundTrip(t *testing.T) {
	s, _, _, _ := terminalFixture(t)
	w := do(s, "PUT", "/api/run-prompts", `{"items":[{"scene":"评审","content":"看一遍","permission":"read_only","output":" 回报 verdict ","dir_kind":"prd"}]}`)
	if w.Code != http.StatusOK {
		t.Fatalf("%d %s", w.Code, w.Body.String())
	}
	a := decodeEnvelope(t, do(s, "GET", "/api/run-prompts", ""))["data"].([]any)[0].(map[string]any)
	if a["permission"] != "read_only" || a["output"] != "回报 verdict" || a["dir_kind"] != "prd" {
		t.Fatalf("新字段应原样存回：%v", a)
	}
}

// 旧数据（AUTO-03 之前保存的，没有新字段、没记过见过哪些内置）：用户的内容不动，只把新内置角色补在后面。
func TestRunPromptsLegacyDataMergesBuiltins(t *testing.T) {
	s, f, _, _ := terminalFixture(t)
	legacy := `[{"id":"rp_pm","scene":"产品经理工作台","content":"我改过的","default":true},
		{"id":"rp_research","scene":"资料调研","content":"只读调研","default":false},
		{"id":"rp_x","scene":"研发评审","content":"我自己的评审","default":false}]`
	if err := f.SetAgentSetting(t.Context(), runPromptsKey, json.RawMessage(legacy)); err != nil {
		t.Fatal(err)
	}
	got := decodeEnvelope(t, do(s, "GET", "/api/run-prompts", ""))["data"].([]any)
	ids := []string{}
	for _, x := range got {
		ids = append(ids, x.(map[string]any)["id"].(string))
	}
	// rp_dev 是旧内置、用户删过 → 不补；rp_review 场景名和用户自己的撞了 → 不补
	if strings.Join(ids, ",") != "rp_pm,rp_research,rp_x,rp_classify,rp_testdesign,rp_protosync" {
		t.Fatalf("合并结果：%v", ids)
	}
	pm, research := got[0].(map[string]any), got[1].(map[string]any)
	if pm["content"] != "我改过的" || pm["permission"] != "accept_edits" || pm["dir_kind"] != "any" {
		t.Fatalf("用户改过的内置角色不能被覆盖：%v", pm)
	}
	if research["permission"] != "read_only" {
		t.Fatalf("旧内置的资料调研按只读补：%v", research)
	}
	for _, x := range got[3:] {
		if x.(map[string]any)["default"] == true {
			t.Fatalf("补进来的不抢默认：%v", x)
		}
	}

	// 保存一次后，删掉的内置角色不再补回
	if w := do(s, "PUT", "/api/run-prompts", `{"items":[{"id":"rp_pm","scene":"产品经理工作台","content":"我改过的"}]}`); w.Code != http.StatusOK {
		t.Fatal(w.Body.String())
	}
	if got := decodeEnvelope(t, do(s, "GET", "/api/run-prompts", ""))["data"].([]any); len(got) != 1 {
		t.Fatalf("保存后删掉的内置角色不该补回：%v", got)
	}
	// 以后新加的内置角色（不在见过的名单里）照样补
	if err := f.SetAgentSetting(t.Context(), runPromptsSeenKey, json.RawMessage(`["rp_pm","rp_dev"]`)); err != nil {
		t.Fatal(err)
	}
	if got := decodeEnvelope(t, do(s, "GET", "/api/run-prompts", ""))["data"].([]any); len(got) != 5 {
		t.Fatalf("没见过的内置角色应补上：%v", got)
	}
}

// allTaskStatuses 给夹具的任务类型补齐真实的六个状态（0002_seed_types）。
func allTaskStatuses(f *fakeStore) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.types["task"].Statuses = nil
	for _, k := range []string{"todo", "doing", "review", "blocked", "done", "cancelled"} {
		f.types["task"].Statuses = append(f.types["task"].Statuses, domain.Status{Key: k, Label: k})
	}
}

func TestRunPromptPresetInPrompt(t *testing.T) {
	s, f, task, _ := terminalFixture(t)
	allTaskStatuses(f)
	p := decodeEnvelope(t, do(s, "GET", "/api/objects/"+task.ID+"/run/prompt?preset_id=rp_pm", ""))["data"].(map[string]any)["prompt"].(string)
	if !strings.Contains(p, "## 执行要求（产品经理工作台）\n请按用户要求输出 PRD 文档，更新产品原型，同步后回复用户消息。") {
		t.Fatalf("预览应有执行要求一节:\n%s", p)
	}
	assertError(t, do(s, "GET", "/api/objects/"+task.ID+"/run/prompt?preset_id=rp_nope", ""), http.StatusBadRequest, "validation")

	// 终端发起：提示词带执行要求，任务改成进行中
	w := do(s, "POST", "/api/objects/"+task.ID+"/run/terminal", `{"preset_id":"rp_dev"}`)
	if w.Code != http.StatusCreated {
		t.Fatalf("%d %s", w.Code, w.Body.String())
	}
	var resp struct {
		Data TerminalHandoff `json:"data"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	b, _ := os.ReadFile(resp.Data.PromptFile)
	if !strings.Contains(string(b), "## 执行要求（研发）") || !strings.Contains(string(b), "输出要求：\n结束时用 pmw_finish_run") {
		t.Fatalf("终端提示词应有执行要求:\n%s", b)
	}
	if o, _ := f.GetObject(t.Context(), task.ID); o.Status != "doing" {
		t.Fatalf("交给终端后任务应是进行中，得到 %q", o.Status)
	}
	assertError(t, do(s, "POST", "/api/objects/"+task.ID+"/run/terminal", `{"preset_id":"rp_nope"}`), http.StatusBadRequest, "validation")

	// 只读角色：提示词写明不改文件，带输出要求
	p = decodeEnvelope(t, do(s, "GET", "/api/objects/"+task.ID+"/run/prompt?preset_id=rp_review", ""))["data"].(map[string]any)["prompt"].(string)
	for _, want := range []string{"## 执行要求（研发评审）", "这个角色只读：不要创建、修改或删除任何文件", `"verdict": "pass 或 reject"`} {
		if !strings.Contains(p, want) {
			t.Fatalf("只读角色的提示词应有 %q:\n%s", want, p)
		}
	}
	if strings.Contains(decodeEnvelope(t, do(s, "GET", "/api/objects/"+task.ID+"/run/prompt?preset_id=rp_pm", ""))["data"].(map[string]any)["prompt"].(string), "这个角色只读") {
		t.Fatal("允许改文件的角色不该写只读")
	}
}

func TestMarkDoingRules(t *testing.T) {
	s, f, task, _ := terminalFixture(t)
	allTaskStatuses(f)
	for from, want := range map[string]string{"todo": "doing", "review": "doing", "blocked": "doing", "done": "done", "cancelled": "cancelled"} {
		st := from
		if _, err := f.UpdateObject(t.Context(), task.ID, domain.ObjectPatch{Status: &st}, store.DefaultActor); err != nil {
			t.Fatal(err)
		}
		o, _ := f.GetObject(t.Context(), task.ID)
		s.markDoing(t.Context(), httptest.NewRequest("POST", "/", nil), o, runExecutor{})
		if o, _ = f.GetObject(t.Context(), task.ID); o.Status != want {
			t.Errorf("%s 交出后应是 %s，得到 %s", from, want, o.Status)
		}
	}
	// 不是任务的不动
	prj, _ := f.GetObject(t.Context(), *task.ProjectID)
	s.markDoing(t.Context(), httptest.NewRequest("POST", "/", nil), prj, runExecutor{})
	if p, _ := f.GetObject(t.Context(), prj.ID); p.Status == "doing" {
		t.Error("项目不该被改成进行中")
	}
}

func TestPromptHasIMSource(t *testing.T) {
	s, f, task, _ := terminalFixture(t)
	f.mu.Lock()
	f.objs[task.ID].Props = map[string]any{domain.PropSourceRef: map[string]any{
		"message_id": "imm_1", "channel": "slack", "conversation": "acme-产品", "sender": "Lucy", "text": "对话框图片能点开放大吗", "reply_on_done": true}}
	f.mu.Unlock()
	p := decodeEnvelope(t, do(s, "GET", "/api/objects/"+task.ID+"/run/prompt", ""))["data"].(map[string]any)["prompt"].(string)
	for _, want := range []string{"## 来源消息", "Lucy", "对话框图片能点开放大吗", "工作台会把这次执行的结论回复到这条消息里"} {
		if !strings.Contains(p, want) {
			t.Fatalf("提示词应有 %q:\n%s", want, p)
		}
	}
}
