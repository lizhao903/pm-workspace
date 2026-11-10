// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// 假 Agent：第 1 次 Complete 回纪要 JSON，第 2 次回候选 JSON，不联网、不依赖本机 Ollama。
type fakeMinutesAgent struct {
	mu    sync.Mutex
	calls []string
}

const fakeMinutesJSON = `{
  "summary_md": "# 会议摘要\n\n会上确认官网改版范围，Q4 上线。",
  "conclusions": ["Q4 上线新版官网", "方案下周给出"],
  "actions": [{"title": "出改版方案", "detail": "下周给方案", "owner": "张三", "due": "2026-11-20", "project": "官网改版", "confidence": 0.92, "kind": "task"}],
  "projects": [{"name": "官网改版", "confidence": 0.88, "reason": "多次提到"}],
  "goals": [{"title": "Q4 上线新版官网", "confidence": 0.8, "reason": "明确结论"}],
  "questions": [{"question": "预算多少？", "why": "会里没说", "confidence": 0.3}],
  "diagrams": {
    "flow": {"title": "讨论脉络", "nodes": [{"id": "n1", "label": "现状", "kind": "start"}, {"id": "n2", "label": "Q4 上线", "kind": "end"}], "edges": [{"from": "n1", "to": "n2", "label": "决定"}]},
    "tree": {"title": "项目树", "root": {"label": "官网改版", "children": [{"label": "方案"}, {"label": "上线"}]}}
  },
  "generated_at": "2026-11-10T15:00:00+08:00",
  "model": "fake"
}`

const fakeExtractJSON = `{
  "projects": [{"name": "官网改版", "confidence": 0.9, "reason": "会上反复提到"}],
  "tasks": [
    {"title": "出改版方案", "detail": "下周给方案", "owner": "张三", "due": "2026-11-20", "project": "官网改版", "confidence": 0.92, "kind": "task"},
    {"title": "确认预算", "detail": "预算还没定", "confidence": 0.35, "kind": "task"}
  ],
  "goals": [{"title": "Q4 上线新版官网", "confidence": 0.8, "reason": "明确结论"}],
  "questions": [{"question": "预算多少？", "why": "会里没说", "confidence": 0.3}]
}`

func (f *fakeMinutesAgent) Complete(_ context.Context, req plugin.CompleteRequest) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, req.Prompt)
	switch {
	case strings.Contains(req.Prompt, "候选"):
		return fakeExtractJSON, nil
	case strings.Contains(req.Prompt, "会议纪要"):
		return fakeMinutesJSON, nil
	}
	return "", errors.New("假 Agent 不认识的提示词")
}

func (f *fakeMinutesAgent) RunAgent(context.Context, plugin.AgentRunRequest) (plugin.AgentRunResult, error) {
	return plugin.AgentRunResult{}, errors.New("假 Agent 不支持跑一轮")
}

func (f *fakeMinutesAgent) AgentState(context.Context, string) (plugin.AgentRunResult, error) {
	return plugin.AgentRunResult{}, errors.New("假 Agent 不支持查状态")
}

func (f *fakeMinutesAgent) SearchKB(context.Context, []string, string, int) ([]plugin.KBHit, error) {
	return nil, nil
}

func (f *fakeMinutesAgent) callCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.calls)
}

// TestRecordingPluginMinutesE2E：M4a 全链路：项目 → 录音 → 手写转写稿 → 生成纪要（假 Agent）→ 文件 →
// 项目候选挂项目 → 任务候选确认建任务 → 幂等 409 → 忽略剩余候选 → SOP 未启用时 409。
func TestRecordingPluginMinutesE2E(t *testing.T) {
	s, reg := newRecordingServer(t)
	agent := &fakeMinutesAgent{}
	reg.SetAgent(agent)

	// 已有项目，候选按名字应能匹配上。
	pw := do(s, http.MethodPost, "/api/objects", `{"type_id":"project","title":"官网改版"}`)
	if pw.Code != http.StatusCreated {
		t.Fatalf("建项目 = %d：%s", pw.Code, pw.Body.String())
	}
	proj := envelopeData(t, pw)
	projectID, _ := proj["id"].(string)
	if projectID == "" {
		t.Fatalf("建项目失败：%v", proj)
	}

	// 建录音并直接写转写稿（不跑 whisper，测的是纪要流水线）。
	cw := do(s, http.MethodPost, "/api/recording/recordings", `{"title":"官网改版评审","project_id":"`+projectID+`"}`)
	if cw.Code != http.StatusCreated {
		t.Fatalf("新建录音 = %d：%s", cw.Code, cw.Body.String())
	}
	rec := envelopeData(t, cw)
	id, _ := rec["id"].(string)
	mustOK(t, s, http.MethodPatch, "/api/recording/recordings/"+id, `{"transcript":"张三：官网改版 Q4 上线。李四：方案下周给。"}`)

	// 生成纪要：202 + 后台 summarize。
	w := do(s, http.MethodPost, "/api/recording/recordings/"+id+"/minutes", "")
	if w.Code != http.StatusAccepted {
		t.Fatalf("生成纪要 = %d：%s", w.Code, w.Body.String())
	}

	// 等后台生成完（纪要 + 候选）。
	deadline := time.Now().Add(30 * time.Second)
	var detail map[string]any
	for {
		detail = mustOK(t, s, http.MethodGet, "/api/recording/recordings/"+id, "")
		if detail["status"] == "ready" && detail["has_minutes"] == true {
			if todos, _ := detail["todos"].([]any); len(todos) > 0 {
				break
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("30 秒没生成完纪要，状态 %v，job=%v", detail["status"], detail["job"])
		}
		time.Sleep(300 * time.Millisecond)
	}
	if agent.callCount() < 2 {
		t.Fatalf("假 Agent 应该被调 2 次（纪要+候选），实际 %d", agent.callCount())
	}

	// 纪要字段。
	minutes, _ := detail["minutes"].(map[string]any)
	if minutes == nil || !strings.Contains(minutes["summary_md"].(string), "会议摘要") {
		t.Fatalf("纪要不对：%v", detail["minutes"])
	}
	diagrams, _ := minutes["diagrams"].(map[string]any)
	if diagrams == nil {
		t.Fatalf("没有图表：%v", minutes)
	}
	flow, _ := diagrams["flow"].(map[string]any)
	if nodes, _ := flow["nodes"].([]any); len(nodes) != 2 {
		t.Fatalf("流程图节点不对：%v", flow)
	}
	// 项目候选匹配到了已有项目。
	projects, _ := minutes["projects"].([]any)
	if len(projects) == 0 {
		t.Fatalf("没有项目候选：%v", minutes)
	}
	if p, _ := projects[0].(map[string]any); p["project_id"] != projectID {
		t.Fatalf("项目候选没匹配到已有项目：%v", p)
	}

	// 文件清单 + 下载。
	files := mustList(t, s, "/api/recording/recordings/"+id+"/files")
	byName := map[string]map[string]any{}
	for _, f := range files {
		m, _ := f.(map[string]any)
		name, _ := m["name"].(string)
		byName[name] = m
	}
	for _, want := range []string{"transcript.md", "minutes.md", "minutes.json", "diagrams/flow.mmd", "diagrams/tree.mmd"} {
		if byName[want] == nil {
			t.Fatalf("文件清单里没有 %s：%v", want, byName)
		}
	}
	if b := byName["minutes.md"]["bytes"].(float64); b <= 0 {
		t.Fatalf("minutes.md 是空文件：%v", byName["minutes.md"])
	}
	mw := do(s, http.MethodGet, "/api/recording/recordings/"+id+"/files/minutes.md", "")
	if mw.Code != http.StatusOK || !strings.Contains(mw.Body.String(), "会议摘要") {
		t.Fatalf("下载 minutes.md = %d：%s", mw.Code, mw.Body.String())
	}
	// 嵌套文件名整段 %2F 编码后也要能下载（Go mux 单段路由既定的用法）。
	fw := do(s, http.MethodGet, "/api/recording/recordings/"+id+"/files/diagrams%2Fflow.mmd", "")
	if fw.Code != http.StatusOK || !strings.Contains(fw.Body.String(), "flowchart") {
		t.Fatalf("下载 diagrams/flow.mmd = %d：%s", fw.Code, clipForTest(fw.Body.String()))
	}
	assertError(t, do(s, http.MethodGet, "/api/recording/recordings/"+id+"/files/nope.md", ""), http.StatusNotFound, "not_found")

	// 候选：项目、任务、目标都在。
	todos, _ := detail["todos"].([]any)
	var projectTodo, taskTodo, lowTodo map[string]any
	for _, x := range todos {
		m, _ := x.(map[string]any)
		switch {
		case m["kind"] == "project":
			projectTodo = m
		case m["kind"] == "task" && m["title"] == "出改版方案":
			taskTodo = m
		case m["kind"] == "task":
			lowTodo = m
		}
	}
	if projectTodo == nil || taskTodo == nil || lowTodo == nil {
		t.Fatalf("候选不全：%v", todos)
	}

	// 确认项目候选：录音挂到项目。
	idx := func(m map[string]any) string { return jsonInt(m["index"]) }
	confirmedProj := mustOK(t, s, http.MethodPost, "/api/recording/recordings/"+id+"/todos/"+idx(projectTodo)+"/confirm", "{}")
	if confirmedProj["status"] != "confirmed" {
		t.Fatalf("确认项目候选 = %v", confirmedProj)
	}
	detail = mustOK(t, s, http.MethodGet, "/api/recording/recordings/"+id, "")
	if detail["project_id"] != projectID {
		t.Fatalf("确认后录音没挂项目：%v", detail["project_id"])
	}

	// 确认任务候选：建任务、挂项目、关联录音。
	confirmedTask := mustOK(t, s, http.MethodPost, "/api/recording/recordings/"+id+"/todos/"+idx(taskTodo)+"/confirm", "{}")
	if confirmedTask["status"] != "confirmed" || confirmedTask["object_id"] == "" || confirmedTask["object_ref"] == "" {
		t.Fatalf("确认任务候选 = %v", confirmedTask)
	}
	task := mustOK(t, s, http.MethodGet, "/api/objects/"+confirmedTask["object_id"].(string), "")
	if task["type_id"] != "task" || task["project_id"] != projectID {
		t.Fatalf("建出来的任务不对：%v", task)
	}
	if props, _ := task["props"].(map[string]any); props["recording_id"] != id {
		t.Fatalf("任务没关联录音：%v", task["props"])
	}
	// 重复确认幂等失败。
	assertError(t, do(s, http.MethodPost, "/api/recording/recordings/"+id+"/todos/"+idx(taskTodo)+"/confirm", "{}"),
		http.StatusConflict, "conflict")

	// 忽略低置信度候选。
	ignored := mustOK(t, s, http.MethodPost, "/api/recording/recordings/"+id+"/todos/"+idx(lowTodo)+"/ignore", "")
	if ignored["status"] != "ignored" {
		t.Fatalf("忽略候选 = %v", ignored)
	}

	// SOP 编排插件没启用时发起纪要 SOP 回 409。
	assertError(t, do(s, http.MethodPost, "/api/recording/recordings/"+id+"/sop", `{}`),
		http.StatusConflict, "conflict")
}

// jsonInt 把 JSON 数字（float64）转成不带小数的字符串。
func jsonInt(v any) string {
	switch n := v.(type) {
	case float64:
		return strconv.Itoa(int(n))
	case string:
		return n
	}
	return ""
}

// mustList 取返回 envelope 的 data 数组（列表接口）。
// clipForTest 截断错误里的大段响应，避免日志刷屏。
func clipForTest(s string) string {
	if len(s) > 200 {
		return s[:200] + "…"
	}
	return s
}

func mustList(t *testing.T, s *Server, path string) []any {
	t.Helper()
	w := do(s, http.MethodGet, path, "")
	if w.Code != http.StatusOK {
		t.Fatalf("GET %s = %d：%s", path, w.Code, w.Body.String())
	}
	var body struct {
		Data []any `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("解析 %s 响应：%v", path, err)
	}
	return body.Data
}
