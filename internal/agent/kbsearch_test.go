package agent

import (
	"context"
	"encoding/json"
	"strings"
	"sync"
	"testing"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/kb"
	"github.com/lizhao903/pm-workspace/internal/store"
)

// recordingChat 按剧本一轮吐一段，并记下每轮收到的请求。
type recordingChat struct {
	mu     sync.Mutex
	script []func(on func(Event))
	reqs   []Request
}

func (c *recordingChat) Stream(_ context.Context, req Request, on func(Event)) error {
	c.mu.Lock()
	i := len(c.reqs)
	c.reqs = append(c.reqs, req)
	c.mu.Unlock()
	if i < len(c.script) {
		c.script[i](on)
	}
	return nil
}

func kbCall(id string, args map[string]any) func(on func(Event)) {
	b, _ := json.Marshal(args)
	return func(on func(Event)) {
		on(Event{Kind: EventToolCall, Call: ToolCall{ID: id, Name: toolKbSearch, Args: string(b)}})
	}
}

func hasTool(req Request, name string) bool {
	for _, d := range req.Tools {
		if d.Name == name {
			return true
		}
	}
	return false
}

// 挂了知识库的 Agent 对话时能调 kb_search，只搜得到挂着的库；指定没挂的库被拒绝。没挂库的 Agent 没有这个工具。
func TestKbSearchOnlyMountedKBs(t *testing.T) {
	chat := &recordingChat{script: []func(func(Event)){
		kbCall("c1", map[string]any{"query": "审计日志保留多久"}),
		kbCall("c2", map[string]any{"query": "审计日志保留多久", "kb_id": "kb_other"}),
		func(on func(Event)) { on(Event{Kind: EventDelta, Text: "保留 180 天。"}) },
	}}
	r, st, ctx := newRunner(t, chat)

	sv := &kb.Service{St: st}
	mk := func(name, title, text string) *store.KnowledgeBase {
		k, err := st.CreateKnowledgeBase(ctx, store.KbInput{Name: &name})
		if err != nil {
			t.Fatal(err)
		}
		if d, err := sv.Add(ctx, k, kb.AddInput{Type: store.KbSrcNote, Title: title, Text: text}); err != nil || d.Status != store.KbIndexed {
			t.Fatalf("加笔记 = %+v, %v", d, err)
		}
		return k
	}
	mine := mk("合规", "合规口径备忘", "审计日志至少保留 180 天，欧盟租户按合同可以更长。")
	mk("别人的", "另一份审计说明", "审计日志保留 30 天就删。")

	r.Agent = &domain.Agent{ID: "ag_x", Name: "助手", KBs: []string{mine.ID}}
	if _, err := r.Run(ctx, "审计日志保留多久？", func(StreamEvent) {}); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if len(chat.reqs) != 3 || !hasTool(chat.reqs[0], toolKbSearch) {
		t.Fatalf("第一轮应当带 kb_search：%d 轮", len(chat.reqs))
	}
	toolMsg := func(req Request, id string) string {
		for _, m := range req.Messages {
			if m.Role == domain.RoleTool && m.ToolCallID == id {
				return m.Content
			}
		}
		t.Fatalf("找不到 %s 的工具结果", id)
		return ""
	}
	first := toolMsg(chat.reqs[1], "c1")
	if !strings.Contains(first, "合规口径备忘") || !strings.Contains(first, "180 天") || strings.Contains(first, "30 天") {
		t.Errorf("只该命中挂着的库：\n%s", first)
	}
	second := toolMsg(chat.reqs[2], "c2")
	if !strings.Contains(second, "没有挂在这个 Agent 上") || strings.Contains(second, "30 天") {
		t.Errorf("指定没挂的库应当被拒绝：\n%s", second)
	}

	// 没挂知识库的 Agent 不给这个工具
	plain := &recordingChat{script: []func(func(Event)){func(on func(Event)) { on(Event{Kind: EventDelta, Text: "好"}) }}}
	r2 := &Runner{Store: st, Chat: plain, Model: "m", Session: r.Session, Agent: &domain.Agent{ID: "ag_y", Name: "空"}}
	if _, err := r2.Run(ctx, "你好", func(StreamEvent) {}); err != nil {
		t.Fatal(err)
	}
	if hasTool(plain.reqs[0], toolKbSearch) {
		t.Error("没挂知识库的 Agent 不该有 kb_search")
	}
}
