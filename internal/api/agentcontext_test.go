// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package api

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/lizhao903/pm-workspace/internal/domain"
)

// --- 会话上下文治理（S-2，0057） ---

// doSessionContext 直接调 handler：路由由 Lead 在 server.go 统一加，
// 这里测的是 handler 的协议本身，不依赖注册顺序。
func doSessionContext(s *Server, id string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodGet, "/api/agent/sessions/"+id+"/context", nil)
	req.SetPathValue("id", id)
	w := httptest.NewRecorder()
	s.handleAgentSessionContext(w, req)
	return w
}

// 上下文面板：全部消息正序返回，超出 40 条的旧消息标 dropped，sent_chars 是真正会发出去的正文长度。
func TestAgentSessionContext(t *testing.T) {
	s, st, _ := newAgentServer(t)
	ctx := context.Background()
	sess := envelopeData(t, do(s, "POST", "/api/agent/sessions", `{"title":"长会话"}`))
	id := sess["id"].(string)

	var last *domain.AgentMessage
	for i := 0; i < 45; i++ {
		m, err := st.AppendAgentMessage(ctx, &domain.AgentMessage{
			SessionID: id, Role: domain.RoleUser, Content: fmt.Sprintf("msg-%02d", i),
		})
		if err != nil {
			t.Fatal(err)
		}
		last = m
	}
	d := envelopeData(t, doSessionContext(s, id))
	w, ok := d["messages"].([]any)
	if !ok || len(w) != 45 {
		t.Fatalf("messages = %v", d["messages"])
	}
	if d["session_id"] != id || d["history_limit"].(float64) != 40 || d["total_messages"].(float64) != 45 || d["dropped_count"].(float64) != 5 {
		t.Fatalf("汇总字段 = %v", d)
	}
	for i, raw := range w {
		m := raw.(map[string]any)
		wantDropped := i < 5
		if m["dropped"] != wantDropped {
			t.Fatalf("第 %d 条 dropped = %v，想要 %v", i, m["dropped"], wantDropped)
		}
		if m["role"] != "user" || m["content"] != fmt.Sprintf("msg-%02d", i) {
			t.Fatalf("第 %d 条 = %v", i, m)
		}
		if i == 44 && m["id"] != last.ID {
			t.Fatalf("最后一条 id = %v，想要 %s", m["id"], last.ID)
		}
	}
	// 只算没被丢掉的那 40 条：每条 6 个字符
	if d["sent_chars"].(float64) != 240 || d["approx_tokens"].(float64) != 120 {
		t.Fatalf("sent_chars / approx_tokens = %v / %v", d["sent_chars"], d["approx_tokens"])
	}
	// 追加要求跟着回显
	do(s, "PATCH", "/api/agent/sessions/"+id, `{"instruction":"这次只讨论前端"}`)
	if d := envelopeData(t, doSessionContext(s, id)); d["instruction"] != "这次只讨论前端" {
		t.Fatalf("instruction = %v", d["instruction"])
	}
	// 不存在的会话 404
	mustCode(t, doSessionContext(s, "ags_nope"), http.StatusNotFound, "context missing")
}

// 空会话：没有消息、没有追加要求时字段是零值而不是 null。
func TestAgentSessionContextEmpty(t *testing.T) {
	s, _, _ := newAgentServer(t)
	sess := envelopeData(t, do(s, "POST", "/api/agent/sessions", `{"title":"空会话"}`))
	d := envelopeData(t, doSessionContext(s, sess["id"].(string)))
	if d["total_messages"].(float64) != 0 || d["dropped_count"].(float64) != 0 ||
		d["sent_chars"].(float64) != 0 || d["approx_tokens"].(float64) != 0 || d["instruction"] != "" {
		t.Fatalf("空会话 = %v", d)
	}
	if msgs, ok := d["messages"].([]any); !ok || len(msgs) != 0 {
		t.Fatalf("messages = %v，想要空数组", d["messages"])
	}
}

// 长消息按 utf8 字符数算，不按字节：
func TestAgentSessionContextCountsRunes(t *testing.T) {
	s, st, _ := newAgentServer(t)
	ctx := context.Background()
	sess := envelopeData(t, do(s, "POST", "/api/agent/sessions", `{"title":"中文"}`))
	id := sess["id"].(string)
	if _, err := st.AppendAgentMessage(ctx, &domain.AgentMessage{
		SessionID: id, Role: domain.RoleAssistant, Content: strings.Repeat("字", 101),
	}); err != nil {
		t.Fatal(err)
	}
	d := envelopeData(t, doSessionContext(s, id))
	if d["sent_chars"].(float64) != 101 || d["approx_tokens"].(float64) != 51 {
		t.Fatalf("sent_chars / approx_tokens = %v / %v", d["sent_chars"], d["approx_tokens"])
	}
}
