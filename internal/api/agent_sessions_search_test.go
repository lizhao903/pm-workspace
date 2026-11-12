// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package api

import (
	"context"
	"net/http"
	"strings"
	"testing"

	"github.com/lizhao903/pm-workspace/internal/domain"
)

// --- S-1 会话归属与检索 + S-2 会话追加要求（HTTP 层） ---

// createObject 走 POST /api/objects 建一个对象，回 data。
func createObjectForSessionTest(t *testing.T, s *Server, body string) map[string]any {
	t.Helper()
	w := do(s, "POST", "/api/objects", body)
	mustCode(t, w, http.StatusCreated, "create object "+w.Body.String())
	return envelopeData(t, w)
}

// createSessionForTest 走 POST /api/agent/sessions 建会话，回 data。
func createSessionForTest(t *testing.T, s *Server, body string) map[string]any {
	t.Helper()
	w := do(s, "POST", "/api/agent/sessions", body)
	mustCode(t, w, http.StatusCreated, "create session "+w.Body.String())
	return envelopeData(t, w)
}

func listSessionsForTest(t *testing.T, s *Server, target string) []map[string]any {
	t.Helper()
	w := do(s, "GET", target, "")
	mustCode(t, w, http.StatusOK, target)
	raw := envelopeList(t, w)
	out := make([]map[string]any, 0, len(raw))
	for _, item := range raw {
		out = append(out, item.(map[string]any))
	}
	return out
}

// q 搜标题和消息正文，可和 object_id / unscoped 组合；列表项带最后一条消息。
func TestAgentSessionListSearch(t *testing.T) {
	s, st, _ := newAgentServer(t)
	ctx := context.Background()
	task := createObjectForSessionTest(t, s, `{"type_id":"task","title":"检索任务"}`)
	taskID := task["id"].(string)
	a := createSessionForTest(t, s, `{"title":"Deploy 讨论","object_id":"`+taskID+`"}`)
	b := createSessionForTest(t, s, `{"title":"闲聊","object_id":"`+taskID+`"}`)
	if _, err := st.AppendAgentMessage(ctx, &domain.AgentMessage{
		SessionID: b["id"].(string), Role: domain.RoleUser, Content: "Deploy 流程怎么走",
	}); err != nil {
		t.Fatal(err)
	}
	global := createSessionForTest(t, s, `{"title":"Deploy 全局"}`)

	// 标题命中 + 消息正文命中
	items := listSessionsForTest(t, s, "/api/agent/sessions?object_id="+taskID+"&q=deploy")
	ids := map[string]bool{}
	for _, item := range items {
		ids[item["id"].(string)] = true
	}
	if len(items) != 2 || !ids[a["id"].(string)] || !ids[b["id"].(string)] {
		t.Fatalf("q=deploy = %v", ids)
	}
	// 列表项带最后一条消息（b 有一条消息，a 没有）
	var foundB, foundA map[string]any
	for _, item := range items {
		switch item["id"] {
		case b["id"]:
			foundB = item
		case a["id"]:
			foundA = item
		}
	}
	if foundB == nil || foundB["last_message"] != "Deploy 流程怎么走" || foundB["last_message_at"] == nil || foundB["last_message_at"] == "" {
		t.Fatalf("b 的最后消息 = %v", foundB)
	}
	if foundA == nil || foundA["last_message"] != nil && foundA["last_message"] != "" {
		t.Fatalf("a 没有消息，不该有 last_message：%v", foundA)
	}
	// 换 scope：unscoped + q 只搜全局会话
	items = listSessionsForTest(t, s, "/api/agent/sessions?unscoped=true&q=deploy")
	if len(items) != 1 || items[0]["id"] != global["id"] {
		t.Fatalf("unscoped + q = %v", items)
	}
	// 没有 scope 仍是空列表，哪怕给了 q
	if items := listSessionsForTest(t, s, "/api/agent/sessions?q=deploy"); len(items) != 0 {
		t.Fatalf("没有 scope 应回空列表：%v", items)
	}
	// 不带 q 时是原来的语义
	if items := listSessionsForTest(t, s, "/api/agent/sessions?object_id="+taskID); len(items) != 2 {
		t.Fatalf("object_id 列表 = %v", items)
	}
}

// project_id：项目里对象的会话 ∪ 项目 props.session_ids 里列的会话；unscoped 被忽略。
func TestAgentSessionListByProject(t *testing.T) {
	s, _, _ := newAgentServer(t)
	listed := createSessionForTest(t, s, `{"title":"项目页里的全局会话"}`)
	proj := createObjectForSessionTest(t, s, `{"type_id":"project","title":"试点项目","props":{"session_ids":["`+listed["id"].(string)+`"]}}`)
	projID := proj["id"].(string)
	task := createObjectForSessionTest(t, s, `{"type_id":"task","title":"项目里的任务","project_id":"`+projID+`"}`)
	inProject := createSessionForTest(t, s, `{"title":"任务会话","object_id":"`+task["id"].(string)+`"}`)
	other := createSessionForTest(t, s, `{"title":"别的全局会话"}`)

	ids := func(items []map[string]any) map[string]bool {
		out := map[string]bool{}
		for _, item := range items {
			out[item["id"].(string)] = true
		}
		return out
	}
	items := listSessionsForTest(t, s, "/api/agent/sessions?project_id="+projID)
	got := ids(items)
	if len(items) != 2 || !got[inProject["id"].(string)] || !got[listed["id"].(string)] {
		t.Fatalf("project_id 列表 = %v", got)
	}
	if got[other["id"].(string)] {
		t.Fatal("不该带别的全局会话")
	}
	// 给了 project_id 时 unscoped 不算数
	items = listSessionsForTest(t, s, "/api/agent/sessions?unscoped=true&project_id="+projID)
	if len(items) != 2 {
		t.Fatalf("unscoped + project_id = %v", items)
	}
	// 不存在的项目 404；不是项目的对象也 404
	mustCode(t, do(s, "GET", "/api/agent/sessions?project_id=obj_nope", ""), http.StatusNotFound, "missing project")
	mustCode(t, do(s, "GET", "/api/agent/sessions?project_id="+task["id"].(string), ""), http.StatusNotFound, "not a project")
}

// 会话追加要求（S-2）：建时带、PATCH 改 / 清空、超长 400、非字符串 400。
func TestAgentSessionInstructionHTTP(t *testing.T) {
	s, _, _ := newAgentServer(t)
	sess := createSessionForTest(t, s, `{"title":"带要求的会话","instruction":"  这次只讨论前端  "}`)
	sid := sess["id"].(string)
	if sess["instruction"] != "这次只讨论前端" {
		t.Fatalf("建时会话 instruction = %v", sess["instruction"])
	}
	// 列表里也带
	items := listSessionsForTest(t, s, "/api/agent/sessions?unscoped=true")
	if len(items) != 1 || items[0]["instruction"] != "这次只讨论前端" {
		t.Fatalf("列表 instruction = %v", items)
	}
	// PATCH 改 / 清空
	if d := envelopeData(t, do(s, "PATCH", "/api/agent/sessions/"+sid, `{"instruction":"改成只讨论后端"}`)); d["instruction"] != "改成只讨论后端" {
		t.Fatalf("改 instruction = %v", d)
	}
	if d := envelopeData(t, do(s, "PATCH", "/api/agent/sessions/"+sid, `{"instruction":""}`)); d["instruction"] != "" {
		t.Fatalf("清空 instruction = %v", d)
	}
	// 空白也算清空
	do(s, "PATCH", "/api/agent/sessions/"+sid, `{"instruction":"只讨论前端"}`)
	if d := envelopeData(t, do(s, "PATCH", "/api/agent/sessions/"+sid, `{"instruction":"   "}`)); d["instruction"] != "" {
		t.Fatalf("空白 instruction = %v", d)
	}
	// 超长 400，整条 PATCH 都不生效（标题也不该改）
	long := strings.Repeat("字", 2001)
	mustCode(t, do(s, "PATCH", "/api/agent/sessions/"+sid, `{"title":"不该生效","instruction":"`+long+`"}`), http.StatusBadRequest, "too long")
	if items := listSessionsForTest(t, s, "/api/agent/sessions?unscoped=true"); items[0]["title"] != "带要求的会话" {
		t.Fatalf("超长时标题被改了：%v", items[0]["title"])
	}
	// 非字符串 400
	mustCode(t, do(s, "PATCH", "/api/agent/sessions/"+sid, `{"instruction":123}`), http.StatusBadRequest, "not a string")
	// POST 超长 400，且不建会话
	mustCode(t, do(s, "POST", "/api/agent/sessions", `{"instruction":"`+long+`"}`), http.StatusBadRequest, "create too long")
	if items := listSessionsForTest(t, s, "/api/agent/sessions?unscoped=true"); len(items) != 1 {
		t.Fatalf("超长 POST 不该建会话：%v", items)
	}
	// 没给 instruction 的 PATCH 不影响已有值
	do(s, "PATCH", "/api/agent/sessions/"+sid, `{"instruction":"保留这个"}`)
	if d := envelopeData(t, do(s, "PATCH", "/api/agent/sessions/"+sid, `{"title":"改个名"}`)); d["instruction"] != "保留这个" || d["title"] != "改个名" {
		t.Fatalf("只改标题 = %v", d)
	}
}
