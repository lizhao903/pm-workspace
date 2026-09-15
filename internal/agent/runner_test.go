package agent

import (
	"context"
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/store/sqlite"
)

// scriptedChat 按剧本一轮吐一段。turns 记录被调了几次——
// 「提问之后本轮就结束」这条契约，断言的正是它没有第二次。
type scriptedChat struct {
	script []func(on func(Event))
	turns  int
}

func (c *scriptedChat) Stream(_ context.Context, _ Request, on func(Event)) error {
	i := c.turns
	c.turns++
	if i < len(c.script) {
		c.script[i](on)
	}
	return nil
}

func newRunner(t *testing.T, chat Chat) (*Runner, *sqlite.Store, context.Context) {
	t.Helper()
	ctx := context.Background()
	st, err := sqlite.Open(ctx, filepath.Join(t.TempDir(), "w.db"))
	if err != nil {
		t.Fatalf("开库: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	sess, err := st.CreateAgentSession(ctx, &domain.AgentSession{Title: "测试", Workdir: newWorkdir(t)})
	if err != nil {
		t.Fatalf("建会话: %v", err)
	}
	return &Runner{Store: st, Chat: chat, Model: "m", Session: sess}, st, ctx
}

func askCall(question string) func(on func(Event)) {
	args, _ := json.Marshal(map[string]any{
		"question": question,
		"options": []any{
			map[string]any{"label": "只做云端", "detail": "本期只覆盖 web 后台"},
			map[string]any{"label": "两端都做", "detail": "范围翻倍，要拉本地端一起排期"},
		},
	})
	return func(on func(Event)) {
		on(Event{Kind: EventDelta, Text: "有一点拿不准。"})
		on(Event{Kind: EventToolCall, Call: ToolCall{ID: "c1", Name: toolAskUser, Args: string(args)}})
	}
}

// TestRunnerQuestionEndsTurn 是 question 契约的核心：
// 发出 question 之后本轮就结束，流不挂在那里等回答。
// 如果哪天有人把它「优化」成阻塞等待，这条会红。
func TestRunnerQuestionEndsTurn(t *testing.T) {
	chat := &scriptedChat{script: []func(func(Event)){
		askCall("这个需求只做云端还是本地端也要跟？"),
		// 第二轮的剧本故意留着：一旦被执行，turns 就会是 2。
		func(on func(Event)) { on(Event{Kind: EventDelta, Text: "不该跑到这里"}) },
	}}
	r, st, ctx := newRunner(t, chat)

	var evs []StreamEvent
	msgID, err := r.Run(ctx, "这个需求怎么推进？", func(ev StreamEvent) { evs = append(evs, ev) })
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if chat.turns != 1 {
		t.Errorf("提问后又跑了 %d 轮，本该在第 1 轮就收工", chat.turns)
	}

	var q *StreamEvent
	for i := range evs {
		switch evs[i].Type {
		case "question":
			q = &evs[i]
		case "tool_call", "tool_result":
			if evs[i].Name == toolAskUser {
				t.Errorf("ask_user 不该发 %s 事件——界面上该出现的是问题卡", evs[i].Type)
			}
		}
	}
	if q == nil {
		t.Fatalf("没有发出 question 事件，收到的是 %v", kinds(evs))
	}
	if !strings.HasPrefix(q.ID, "q_") || len(q.Options) != 2 {
		t.Errorf("question 事件形状不对：%+v", q)
	}
	// multi 必须真的出现在 JSON 里。用值加 omitempty 的话 false 会被整个丢掉，
	// 前端读到 undefined——而契约里 multi 是必填的。
	raw, _ := json.Marshal(q)
	if !strings.Contains(string(raw), `"multi":false`) {
		t.Errorf("multi=false 没进 JSON：%s", raw)
	}

	// 降级路径：问题文本必须也落进 assistant 消息，否则历史回放时这一问就没了。
	msgs, err := st.ListAgentMessages(ctx, r.Session.ID, 0)
	if err != nil {
		t.Fatalf("读历史: %v", err)
	}
	var saved string
	for _, m := range msgs {
		if m.ID == msgID {
			saved = m.Content
		}
	}
	for _, want := range []string{"只做云端还是本地端", "只做云端", "本期只覆盖 web 后台"} {
		if !strings.Contains(saved, want) {
			t.Errorf("落库的回复里缺 %q：\n%s", want, saved)
		}
	}
}

// TestRunnerNormalToolContinues 是上一条的对照组：
// 普通工具调用之后必须接着跑，别把「结束本轮」误伤到所有工具上。
func TestRunnerNormalToolContinues(t *testing.T) {
	chat := &scriptedChat{script: []func(func(Event)){
		func(on func(Event)) {
			on(Event{Kind: EventToolCall, Call: ToolCall{ID: "c1", Name: "list_types", Args: "{}"}})
		},
		func(on func(Event)) { on(Event{Kind: EventDelta, Text: "一共有这几种类型。"}) },
	}}
	r, _, ctx := newRunner(t, chat)
	if _, err := r.Run(ctx, "有哪些类型？", func(StreamEvent) {}); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if chat.turns != 2 {
		t.Errorf("普通工具之后只跑了 %d 轮，应该继续到第 2 轮", chat.turns)
	}
}

func kinds(evs []StreamEvent) []string {
	out := make([]string, 0, len(evs))
	for _, e := range evs {
		out = append(out, e.Type)
	}
	return out
}
