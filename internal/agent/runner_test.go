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

// TestRunnerNudgesSilentModel 盯的是真机上一半概率会踩到的坑：
// 模型查完资料那一轮交白卷（只有 thinking，没正文也没工具调用），
// 用户问「这个需求怎么推进」，收场却是一句「好的，已经处理完了」。
// 推一把之后它该接着说人话。
func TestRunnerNudgesSilentModel(t *testing.T) {
	chat := &scriptedChat{script: []func(func(Event)){
		func(on func(Event)) {
			on(Event{Kind: EventToolCall, Call: ToolCall{ID: "c1", Name: "list_types", Args: "{}"}})
		},
		func(func(Event)) {}, // 交白卷
		func(on func(Event)) { on(Event{Kind: EventDelta, Text: "方案如下：第一步…"}) },
	}}
	r, st, ctx := newRunner(t, chat)
	msgID, err := r.Run(ctx, "这个需求怎么推进？", func(StreamEvent) {})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if chat.turns != 3 {
		t.Errorf("跑了 %d 轮，应该是 3 轮（查 → 白卷 → 推一把之后的回答）", chat.turns)
	}

	msgs, err := st.ListAgentMessages(ctx, r.Session.ID, 0)
	if err != nil {
		t.Fatalf("读历史: %v", err)
	}
	for _, m := range msgs {
		if m.ID != msgID {
			continue
		}
		if strings.Contains(m.Content, "已经处理完了") {
			t.Errorf("还是收在那句没用的兜底上：%s", m.Content)
		}
		if !strings.Contains(m.Content, "方案如下") {
			t.Errorf("推完那一轮的正文没落库：%s", m.Content)
		}
	}
}

// TestRunnerNudgesOnlyOnce 是上一条的刹车：一直沉默的模型不能把轮数全耗在推它上面。
func TestRunnerNudgesOnlyOnce(t *testing.T) {
	chat := &scriptedChat{script: []func(func(Event)){
		func(on func(Event)) {
			on(Event{Kind: EventToolCall, Call: ToolCall{ID: "c1", Name: "list_types", Args: "{}"}})
		},
		func(func(Event)) {}, func(func(Event)) {}, func(func(Event)) {},
	}}
	r, _, ctx := newRunner(t, chat)
	if _, err := r.Run(ctx, "问题", func(StreamEvent) {}); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if chat.turns != 3 {
		t.Errorf("跑了 %d 轮，只该推一次（查 → 白卷 → 推 → 还是白卷就收）", chat.turns)
	}
}

// TestRunnerHidesRejectedAskUser 盯的是一次真机上看见的界面泄漏：
// ask_user 被打回时，界面上冒出一张「工具 ask_user / ask_user 执行失败：…」的卡片。
// 那条文字是给模型的重填指令，用户既看不懂也做不了什么，不该出现在对话里。
func TestRunnerHidesRejectedAskUser(t *testing.T) {
	bad, _ := json.Marshal(map[string]any{
		"question": "有几个问题要先厘清：", // 冒号结尾，会被打回
		"options": []any{
			map[string]any{"label": "A", "detail": "选 A 的代价"},
			map[string]any{"label": "B", "detail": "选 B 的代价"},
		},
	})
	chat := &scriptedChat{script: []func(func(Event)){
		func(on func(Event)) {
			on(Event{Kind: EventToolCall, Call: ToolCall{ID: "c1", Name: toolAskUser, Args: string(bad)}})
		},
		askCall("那就问一个能答的：只做云端还是两端都做？"),
	}}
	r, st, ctx := newRunner(t, chat)

	var evs []StreamEvent
	if _, err := r.Run(ctx, "怎么推进？", func(ev StreamEvent) { evs = append(evs, ev) }); err != nil {
		t.Fatalf("Run: %v", err)
	}
	for _, ev := range evs {
		if ev.Name == toolAskUser {
			t.Errorf("被打回的 ask_user 漏到界面上了：%s / %s", ev.Type, ev.Summary)
		}
	}
	// 打回之后模型改对了，第二次要正常发出去
	var qs int
	for _, ev := range evs {
		if ev.Type == "question" {
			qs++
		}
	}
	if qs != 1 {
		t.Errorf("改对之后的提问没发出来，question 事件 %d 个", qs)
	}

	// 库里也不该留下那条失败记录
	msgs, err := st.ListAgentMessages(ctx, r.Session.ID, 0)
	if err != nil {
		t.Fatalf("读历史: %v", err)
	}
	for _, m := range msgs {
		if strings.Contains(m.Content, "ask_user 执行失败") {
			t.Errorf("打回记录落库了：%s", m.Content)
		}
	}
}
