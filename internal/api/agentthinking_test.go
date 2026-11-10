// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package api

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

// 0045：Agent 的思考档位跟着会话走到上游请求；场景默认 Agent 的读写和删除影响。
func TestAgentThinkingInChat(t *testing.T) {
	s, st, cc := newAgentServer(t)
	pid := firstProviderID(t, st)
	a := createAgent(t, s, `{"name":"分诊","provider_id":"`+pid+`","thinking":"off"}`)
	if a["thinking"] != "off" {
		t.Fatalf("thinking = %v", a["thinking"])
	}
	mustCode(t, do(s, "PATCH", "/api/agents/"+a["id"].(string), `{"thinking":"max"}`), http.StatusBadRequest, "bad thinking")

	w := do(s, "POST", "/api/agent/sessions", `{"agent_id":"`+a["id"].(string)+`"}`)
	mustCode(t, w, http.StatusCreated, "create session")
	sid := envelopeData(t, w)["id"].(string)
	mustCode(t, do(s, "POST", "/api/agent/chat", `{"session_id":"`+sid+`","message":"这条消息归哪类"}`), http.StatusOK, "chat")
	var body map[string]any
	_ = json.Unmarshal(cc.bodies[len(cc.bodies)-1], &body)
	if v, has := body["think"]; !has || v != false {
		t.Fatalf("Ollama 请求应带 think:false：%v", body)
	}

	// 改回 default：不带 think
	mustCode(t, do(s, "PATCH", "/api/agents/"+a["id"].(string), `{"thinking":"default"}`), http.StatusOK, "patch default")
	mustCode(t, do(s, "POST", "/api/agent/chat", `{"session_id":"`+sid+`","message":"再来"}`), http.StatusOK, "chat 2")
	body = nil
	_ = json.Unmarshal(cc.bodies[len(cc.bodies)-1], &body)
	if _, has := body["think"]; has {
		t.Fatalf("default 不该带 think：%v", body)
	}
}

func TestAgentScenarios(t *testing.T) {
	s, st, _ := newAgentServer(t)
	pid := firstProviderID(t, st)
	id := createAgent(t, s, `{"name":"助手","provider_id":"`+pid+`"}`)["id"].(string)

	w := do(s, "GET", "/api/agents/scenarios", "")
	mustCode(t, w, http.StatusOK, "list")
	if !strings.Contains(w.Body.String(), `"key":"sop_assist"`) || !strings.Contains(w.Body.String(), `"key":"background"`) ||
		!strings.Contains(w.Body.String(), `"agent_id":""`) {
		t.Fatalf("场景列表 %s", w.Body.String())
	}
	mustCode(t, do(s, "PATCH", "/api/agents/scenarios", `{"nope":""}`), http.StatusBadRequest, "unknown scenario")
	mustCode(t, do(s, "PATCH", "/api/agents/scenarios", `{"background":"ag_nope"}`), http.StatusBadRequest, "unknown agent")
	mustCode(t, do(s, "PATCH", "/api/agents/scenarios", `{}`), http.StatusBadRequest, "empty")
	w = do(s, "PATCH", "/api/agents/scenarios", `{"sop_assist":"`+id+`"}`)
	mustCode(t, w, http.StatusOK, "patch")
	if !strings.Contains(w.Body.String(), `"agent_id":"`+id+`"`) {
		t.Fatalf("改完 %s", w.Body.String())
	}

	// 删除影响里列出场景
	w = do(s, "GET", "/api/agents/"+id+"/impact", "")
	mustCode(t, w, http.StatusOK, "impact")
	if !strings.Contains(w.Body.String(), `"key":"scenarios"`) || !strings.Contains(w.Body.String(), "SOP 编排助手") {
		t.Fatalf("影响 %s", w.Body.String())
	}
	mustCode(t, do(s, "PATCH", "/api/agents/scenarios", `{"sop_assist":""}`), http.StatusOK, "clear")
}
