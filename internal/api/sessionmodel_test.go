package api

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/lizhao903/pm-workspace/internal/domain"
)

// lastUpstream 取上游最近一次请求的模型和全部消息正文
func lastUpstream(t *testing.T, cc *capturedChat) (string, string) {
	t.Helper()
	cc.mu.Lock()
	defer cc.mu.Unlock()
	if len(cc.bodies) == 0 {
		t.Fatal("上游一次请求都没收到")
	}
	var req struct {
		Model    string `json:"model"`
		Messages []struct {
			Content string `json:"content"`
		} `json:"messages"`
	}
	if err := json.Unmarshal(cc.bodies[len(cc.bodies)-1], &req); err != nil {
		t.Fatal(err)
	}
	var all strings.Builder
	for _, m := range req.Messages {
		all.WriteString(m.Content + "\n")
	}
	return req.Model, all.String()
}

// sessionMessages 读会话消息
func sessionMessages(t *testing.T, s *Server, sid string) []map[string]any {
	t.Helper()
	w := do(s, http.MethodGet, "/api/agent/sessions/"+sid+"/messages", "")
	mustCode(t, w, http.StatusOK, "messages")
	var out []map[string]any
	for _, x := range envelopeList(t, w) {
		out = append(out, x.(map[string]any))
	}
	return out
}

// TSK-0720 验收：会话跟随 Agent 默认 → 会话里换模型只影响本会话、后续消息用新模型、插切换提示、每条回复记模型 →
// 回复中不能换 → 改回跟随 Agent 默认。
func TestSessionModelSwitch(t *testing.T) {
	s, st, cc := newAgentServer(t)
	ctx := context.Background()
	pid := firstProviderID(t, st)
	base, err := st.GetProvider(ctx, pid)
	if err != nil {
		t.Fatal(err)
	}
	p2, err := st.CreateProvider(ctx, &domain.AgentProvider{Name: "第二家", Kind: domain.ProviderOllama, BaseURL: base.BaseURL, Model: "p2-default", Enabled: true}, "")
	if err != nil {
		t.Fatal(err)
	}
	off, err := st.CreateProvider(ctx, &domain.AgentProvider{Name: "停用的", Kind: domain.ProviderOllama, BaseURL: base.BaseURL, Model: "x", Enabled: false}, "")
	if err != nil {
		t.Fatal(err)
	}
	agentID := createAgent(t, s, `{"name":"周报助手","provider_id":"`+pid+`","model":"m1"}`)["id"].(string)
	w := do(s, http.MethodPost, "/api/agent/sessions", `{"agent_id":"`+agentID+`"}`)
	mustCode(t, w, http.StatusCreated, "create session")
	sid := envelopeData(t, w)["id"].(string)
	get := func() *domain.AgentSession {
		t.Helper()
		got, err := st.GetAgentSession(ctx, sid)
		if err != nil {
			t.Fatal(err)
		}
		return got
	}

	// 没换过：跟着 Agent 的默认走，Agent 改了，会话读出来马上就是新的
	mustCode(t, do(s, http.MethodPatch, "/api/agents/"+agentID, `{"model":"m2"}`), http.StatusOK, "patch agent")
	if g := get(); g.ModelOverride || g.ProviderID != pid || g.Model != "m2" {
		t.Fatalf("跟随 Agent：%+v", g)
	}
	mustCode(t, do(s, http.MethodPost, "/api/agent/chat", `{"session_id":"`+sid+`","message":"第一句"}`), http.StatusOK, "chat 1")
	if m, _ := lastUpstream(t, cc); m != "m2" {
		t.Errorf("上游模型 = %q，期望 Agent 当前的 m2", m)
	}

	// 回复中不能换
	_, done := s.turns.start(ctx, sid)
	w = do(s, http.MethodPatch, "/api/agent/sessions/"+sid, `{"provider_id":"`+p2.ID+`","model":"x1"}`)
	done()
	mustCode(t, w, http.StatusConflict, "switch while running")

	// 换到第二家：只改这个会话，记切换提示
	for name, body := range map[string]string{
		"服务商不存在":  `{"provider_id":"apv_nope","model":"x"}`,
		"服务商停用":   `{"provider_id":"` + off.ID + `","model":"x"}`,
		"跟随时又给模型": `{"model_override":false,"model":"x"}`,
		"类型不对":    `{"model_override":"no"}`,
	} {
		mustCode(t, do(s, http.MethodPatch, "/api/agent/sessions/"+sid, body), http.StatusBadRequest, name)
	}
	w = do(s, http.MethodPatch, "/api/agent/sessions/"+sid, `{"provider_id":"`+p2.ID+`","model":"x1"}`)
	mustCode(t, w, http.StatusOK, "switch")
	if d := envelopeData(t, w); d["model_override"] != true || d["provider_id"] != p2.ID || d["model"] != "x1" {
		t.Fatalf("换完 = %v", d)
	}
	if a, _ := st.GetAgent(ctx, agentID); a.ProviderID != pid || a.Model != "m2" {
		t.Errorf("Agent 的默认不该动：%s %s", a.ProviderID, a.Model)
	}
	msgs := sessionMessages(t, s, sid)
	last := msgs[len(msgs)-1]
	if last["role"] != domain.RoleNotice || !strings.Contains(last["content"].(string), "已切换到 第二家 · x1") {
		t.Fatalf("最后一条应是切换提示：%v", last)
	}
	// 同样的值再 PATCH 一次不重复记
	mustCode(t, do(s, http.MethodPatch, "/api/agent/sessions/"+sid, `{"provider_id":"`+p2.ID+`","model":"x1"}`), http.StatusOK, "same")
	if n := len(sessionMessages(t, s, sid)); n != len(msgs) {
		t.Errorf("没变化不该再记提示：%d → %d", len(msgs), n)
	}

	// Agent 再改默认，换过的会话不跟
	mustCode(t, do(s, http.MethodPatch, "/api/agents/"+agentID, `{"model":"m3"}`), http.StatusOK, "patch agent 2")
	if g := get(); !g.ModelOverride || g.Model != "x1" {
		t.Fatalf("换过的会话不跟 Agent：%+v", g)
	}
	mustCode(t, do(s, http.MethodPost, "/api/agent/chat", `{"session_id":"`+sid+`","message":"第二句"}`), http.StatusOK, "chat 2")
	m, all := lastUpstream(t, cc)
	if m != "x1" {
		t.Errorf("上游模型 = %q，期望会话选的 x1", m)
	}
	if strings.Contains(all, "已切换到") {
		t.Error("切换提示不该进模型的上下文")
	}
	// 每条回复记下当时的模型，历史不重算
	var replies []string
	for _, x := range sessionMessages(t, s, sid) {
		if x["role"] == domain.RoleAssistant {
			replies = append(replies, x["provider_id"].(string)+"/"+x["model"].(string))
		}
	}
	if strings.Join(replies, ",") != pid+"/m2,"+p2.ID+"/x1" {
		t.Errorf("回复上记的模型 = %v", replies)
	}

	// 改回跟随 Agent 默认
	w = do(s, http.MethodPatch, "/api/agent/sessions/"+sid, `{"model_override":false}`)
	mustCode(t, w, http.StatusOK, "follow")
	if d := envelopeData(t, w); d["model_override"] != false || d["provider_id"] != pid || d["model"] != "m3" {
		t.Fatalf("跟随后 = %v", d)
	}
	msgs = sessionMessages(t, s, sid)
	if c := msgs[len(msgs)-1]["content"].(string); !strings.Contains(c, "已切换到 本机 · m3（跟随 Agent 默认）") {
		t.Errorf("跟随提示 = %q", c)
	}

	// 只改标题不动模型；标题和模型一起改两样都生效
	w = do(s, http.MethodPatch, "/api/agent/sessions/"+sid, `{"title":"新标题","model":"m9"}`)
	mustCode(t, w, http.StatusOK, "title+model")
	if d := envelopeData(t, w); d["title"] != "新标题" || d["model"] != "m9" || d["model_override"] != true {
		t.Errorf("标题加模型 = %v", d)
	}

	// 不挂 Agent 的会话不认 model_override，换模型照常
	w = do(s, http.MethodPost, "/api/agent/sessions", `{"provider_id":"`+pid+`","model":"q"}`)
	mustCode(t, w, http.StatusCreated, "plain session")
	plain := envelopeData(t, w)["id"].(string)
	mustCode(t, do(s, http.MethodPatch, "/api/agent/sessions/"+plain, `{"model_override":true}`), http.StatusBadRequest, "plain override")
	w = do(s, http.MethodPatch, "/api/agent/sessions/"+plain, `{"provider_id":"`+p2.ID+`"}`)
	mustCode(t, w, http.StatusOK, "plain switch")
	if d := envelopeData(t, w); d["model"] != "p2-default" || d["model_override"] != false {
		t.Errorf("只换服务商取它的默认模型：%v", d)
	}
}
