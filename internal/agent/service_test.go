package agent

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"testing"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/kb"
	"github.com/lizhao903/pm-workspace/internal/store"
	"github.com/lizhao903/pm-workspace/internal/store/sqlite"
)

// 给插件句柄用的入口（SOP-01c）：假服务商、真库。

func newService(t *testing.T, chat Chat) (*Service, *sqlite.Store, context.Context) {
	t.Helper()
	ctx := context.Background()
	st, err := sqlite.Open(ctx, filepath.Join(t.TempDir(), "s.db"))
	if err != nil {
		t.Fatalf("开库: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	s := &Service{Store: st, NewChat: func(kind, baseURL, key string) (Chat, error) { return chat, nil }}
	return s, st, ctx
}

func addProvider(t *testing.T, st *sqlite.Store, ctx context.Context) *domain.AgentProvider {
	t.Helper()
	p, err := st.CreateProvider(ctx, &domain.AgentProvider{Name: "本机", Kind: domain.ProviderOllama,
		BaseURL: "http://127.0.0.1:1", Model: "m0", Enabled: true, IsDefault: true}, "")
	if err != nil {
		t.Fatal(err)
	}
	return p
}

func TestServiceComplete(t *testing.T) {
	chat := &recordingChat{script: []func(func(Event)){grantSay("第一"), grantSay("第二")}}
	s, st, ctx := newService(t, chat)
	if _, err := s.Complete(ctx, CompleteRequest{Prompt: "hi"}); !errors.Is(err, ErrNoProvider) {
		t.Fatalf("没有服务商应当 ErrNoProvider：%v", err)
	}
	addProvider(t, st, ctx)
	out, err := s.Complete(ctx, CompleteRequest{System: "你是助手", Prompt: "hi"})
	if err != nil || out != "第一" {
		t.Fatalf("Complete = %q, %v", out, err)
	}
	if _, err := s.Complete(ctx, CompleteRequest{Prompt: "hi", Model: "m1"}); err != nil {
		t.Fatal(err)
	}
	r0, r1 := chat.reqs[0], chat.reqs[1]
	if r0.Model != "m0" || r1.Model != "m1" || len(r0.Tools) != 0 {
		t.Fatalf("模型 %s %s，工具 %d", r0.Model, r1.Model, len(r0.Tools))
	}
	if r0.Messages[0].Role != RoleSystem || r0.Messages[1].Content != "hi" || r1.Messages[0].Role != domain.RoleUser {
		t.Fatalf("消息 %+v %+v", r0.Messages, r1.Messages)
	}
}

func TestServiceRunAgentWaitsForConfirm(t *testing.T) {
	chat := &recordingChat{script: []func(func(Event)){
		grantCall("create_object", `{"type":"task","title":"回访周屿"}`),
		grantSay("好的，不建了。"),
	}}
	s, st, ctx := newService(t, chat)
	p := addProvider(t, st, ctx)
	name, model, on := "客服助手", "m2", true
	a, err := st.CreateAgent(ctx, domain.AgentInput{Name: &name, ProviderID: &p.ID, Model: &model, Enabled: &on})
	if err != nil {
		t.Fatal(err)
	}
	if err := st.SetAgentGrants(ctx, a.ID, map[string]string{"write_tasks": store.GrantConfirm}); err != nil {
		t.Fatal(err)
	}

	res, err := s.RunAgent(ctx, AgentRunRequest{Agent: "客服助手", Prompt: "建一条回访", Title: "SOP · 回访"})
	if err != nil {
		t.Fatal(err)
	}
	if !res.Waiting || res.AgentID != a.ID || len(res.CallIDs) != 1 || !strings.Contains(res.Pending, "回访周屿") || res.SessionID == "" {
		t.Fatalf("应当停在确认：%+v", res)
	}
	if chat.reqs[0].Model != "m2" || !hasTool(chat.reqs[0], "create_object") {
		t.Fatalf("按 Agent 的模型和授权跑：%s", chat.reqs[0].Model)
	}
	sess, err := st.GetAgentSession(ctx, res.SessionID)
	if err != nil || sess.AgentID == nil || *sess.AgentID != a.ID || sess.Title != "SOP · 回访" {
		t.Fatalf("会话 %+v %v", sess, err)
	}
	cur, err := s.AgentState(ctx, res.SessionID)
	if err != nil || !cur.Waiting || cur.MessageID != res.MessageID {
		t.Fatalf("还在等确认：%+v %v", cur, err)
	}

	// 人在会话里拒绝（对话接口的做法），这一轮接着跑完
	tc, err := st.DecideAgentToolCall(ctx, res.CallIDs[0], store.ToolCallRejected)
	if err != nil {
		t.Fatal(err)
	}
	r := &Runner{Store: st, Chat: chat, Model: "m2", Session: sess, Agent: a, Policy: &Policy{Grants: map[string]string{"write_tasks": store.GrantConfirm}}}
	if _, err := r.Resume(ctx, &Decision{Call: tc}, func(StreamEvent) {}); err != nil {
		t.Fatal(err)
	}
	cur, err = s.AgentState(ctx, res.SessionID)
	if err != nil || cur.Waiting || cur.MessageID == res.MessageID || cur.Reply != "好的，不建了。" {
		t.Fatalf("确认后应当有新回复：%+v %v", cur, err)
	}

	// 找不到、停用的 Agent 不跑
	if _, err := s.RunAgent(ctx, AgentRunRequest{Agent: "没有这个"}); err == nil || !strings.Contains(err.Error(), "不存在") {
		t.Fatalf("不存在的 Agent：%v", err)
	}
	off := false
	if _, err := st.UpdateAgent(ctx, a.ID, domain.AgentInput{Enabled: &off}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.RunAgent(ctx, AgentRunRequest{Agent: a.ID}); err == nil || !strings.Contains(err.Error(), "已停用") {
		t.Fatalf("停用的 Agent：%v", err)
	}
}

func TestServiceSearchKBOnlyGivenKBs(t *testing.T) {
	s, st, ctx := newService(t, nil)
	sv := &kb.Service{St: st}
	mk := func(name, title, text string) *store.KnowledgeBase {
		k, err := st.CreateKnowledgeBase(ctx, store.KbInput{Name: &name})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := sv.Add(ctx, k, kb.AddInput{Type: store.KbSrcNote, Title: title, Text: text}); err != nil {
			t.Fatal(err)
		}
		return k
	}
	mine := mk("合规", "合规口径备忘", "审计日志至少保留 180 天。")
	mk("别人的", "另一份审计说明", "审计日志保留 30 天就删。")
	hits, err := s.SearchKB(ctx, []string{mine.ID}, "审计日志保留多久", 5)
	if err != nil || len(hits) == 0 {
		t.Fatalf("检索 %v %v", hits, err)
	}
	for _, h := range hits {
		if h.KbID != mine.ID || strings.Contains(h.Text, "30 天") {
			t.Fatalf("只该命中给的库：%+v", h)
		}
	}
	if _, err := s.SearchKB(ctx, nil, "审计", 5); err == nil {
		t.Fatal("不给知识库应当报错，不搜全部")
	}
}

func TestConfirmMarkMatchesRender(t *testing.T) {
	if !strings.Contains(renderConfirm("新建「x」"), confirmMark) {
		t.Fatal("confirmMark 要和 renderConfirm 写的一致")
	}
}
