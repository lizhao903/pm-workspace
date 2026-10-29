package agent

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/store"
)

// StreamEvent 是吐给前端的 SSE 事件，字段与 web/src/lib/types.ts 的 AgentStreamEvent 一一对应。
// Size 用指针是为了让「0 字节的产物」和「这个事件没有 size」区分开——
// 用值加 omitempty 的话，写了个空文件前端会读到 undefined。
type StreamEvent struct {
	Type      string `json:"type"`
	Text      string `json:"text,omitempty"`
	Name      string `json:"name,omitempty"`
	Args      string `json:"args,omitempty"`
	Summary   string `json:"summary,omitempty"`
	ObjectID  string `json:"object_id,omitempty"`
	Path      string `json:"path,omitempty"`
	Size      *int64 `json:"size,omitempty"`
	SessionID string `json:"session_id,omitempty"`
	MessageID string `json:"message_id,omitempty"`
	Message   string `json:"message,omitempty"`

	// 以下三个只有 question 事件会填。
	ID       string           `json:"id,omitempty"`
	Question string           `json:"question,omitempty"`
	Options  []QuestionOption `json:"options,omitempty"`
	// Multi 用指针的理由和 Size 一样，但更要命：multi=false 是「单选」这条实打实的信息，
	// 用值加 omitempty 会把它整个丢掉，前端读到 undefined——而契约里 multi 是必填的。
	Multi *bool `json:"multi,omitempty"`
}

// QuestionOption 是一个备选答案。Detail 不是可选的摆设：
// 只有 label 的选项等于让用户猜「选这个会怎样」，校验在 parseOptions 里卡死。
type QuestionOption struct {
	Label  string `json:"label"`
	Detail string `json:"detail"`
}

// Question 是 ask_user 解析后的一次提问，一对一映射成一条 question 事件。
type Question struct {
	ID       string
	Question string
	Options  []QuestionOption
	Multi    bool
}

// toolAskUser 单独起个常量：Runner 要按名字把它和普通工具区别对待
// （不发 tool_call、不落 tool 消息、发完就收工），字面量散在两处容易改漏一处。
const toolAskUser = "ask_user"

// renderQuestion 把一次提问转成人读得懂的一段话。
//
// 它有两个去处，缺一不可：落库的 assistant 消息（历史回放时前端只有纯文本，
// question 事件早就不在了），以及模型自己的上下文（下一轮它得知道自己问过什么）。
// 顺带还兜住了「前端没把它渲染成按钮」——那时用户看到的仍然是一段看得懂的问题。
func renderQuestion(q *Question) string {
	var b strings.Builder
	b.WriteString("【需要你确认】")
	b.WriteString(q.Question)
	if q.Multi {
		b.WriteString("（可多选）")
	}
	b.WriteString("\n")
	for _, o := range q.Options {
		fmt.Fprintf(&b, "- %s：%s\n", o.Label, o.Detail)
	}
	return b.String()
}

// nudgePrompt 是模型查完资料却交白卷时推它的那一把。
//
// 写得很具体是有原因的：泛泛地说「请回答用户」，小模型往往回一句「好的，我明白了」了事。
// 把「不要再查了」和「按哪四块写」一起点明，它才落得下笔。
const nudgePrompt = "你已经把需要的资料读到了，但这一轮什么都没说。现在直接给用户答复：" +
	"不要再调 get_object 或 search_objects 去查了，你已经读过了。" +
	"按「拆成哪几步 / 每步的产出 / 前置依赖 / 风险在哪」把方案写出来。" +
	"如果有真正拿不准、库里也查不到的地方，就调一次 ask_user 问清楚。"

// maxTurns 限制「模型说话 → 调工具 → 再说话」的往返轮数。
// 没有上限的话，一个反复调同一个工具的模型能把会话拖到天荒地老，
// 每一轮都是真实的 token 和真实的写库。
const maxTurns = 8

// historyLimit 是喂回给模型的历史消息条数。本地小模型的上下文有限，
// 全量回灌会在长会话里挤掉系统提示词。
const historyLimit = 40

// Runner 把一次用户输入跑完：调模型、执行工具、把过程写进库、同时向外吐流式事件。
type Runner struct {
	Store   store.Store
	Chat    Chat
	Model   string
	Session *domain.AgentSession
	// Object 是用户此刻打开的工作对象，可以为 nil。只用来告诉模型「这个/这条」指谁；
	// 正文一律由它自己调 get_object 现取，理由见 currentObjectSection。
	Object *domain.Object
	// Agent 是会话挂的 Agent，可以为 nil；它的指令拼进系统提示词，见 agentSection。
	Agent *domain.Agent
}

// Run 处理一条用户消息，返回最终落库的 assistant 消息 id。
//
// emit 会被同步调用，调用方负责往 SSE 里写并 Flush。这里不并发调用 emit，
// 所以调用方不需要加锁。
func (r *Runner) Run(ctx context.Context, userText string, emit func(StreamEvent)) (string, error) {
	tb := NewToolbox(r.Store, r.Session)

	types, err := r.Store.ListObjectTypes(ctx)
	if err != nil {
		return "", fmt.Errorf("读取对象类型失败")
	}

	// 先把用户这条消息落库，再开始跑模型：中途失败或用户关掉页面时，
	// 至少「我说过这句话」是留下来的。
	if _, err := r.Store.AppendAgentMessage(ctx, &domain.AgentMessage{
		SessionID: r.Session.ID,
		Role:      domain.RoleUser,
		Content:   userText,
	}); err != nil {
		return "", fmt.Errorf("保存用户消息失败")
	}

	msgs, err := r.buildHistory(ctx, types)
	if err != nil {
		return "", err
	}

	var finalText strings.Builder
	// usedTools / nudged 支撑下面那次「推一把」。真机上 qwen3.5:4b 有大约一半的概率
	// 读完 get_object 之后交白卷——一轮只有 thinking、没有正文也没有工具调用。
	// 用户问的是「这个需求怎么推进」，收场却是一句「好的，已经处理完了」。
	usedTools, nudged := false, false

	for turn := 0; turn < maxTurns; turn++ {
		var text strings.Builder
		var calls []ToolCall

		err := r.Chat.Stream(ctx, Request{
			Model:    r.Model,
			Messages: msgs,
			Tools:    tb.Defs(),
		}, func(ev Event) {
			switch ev.Kind {
			case EventDelta:
				text.WriteString(ev.Text)
				emit(StreamEvent{Type: "delta", Text: ev.Text})
			case EventToolCall:
				calls = append(calls, ev.Call)
			}
		})
		if err != nil {
			return "", err
		}

		// 没有工具调用，这一轮就是最终回答。
		if len(calls) == 0 {
			finalText.WriteString(text.String())
			// 除非它查完资料一个字都没说——那不是回答，是交白卷。推它一把再给一轮。
			// 只推一次：推不动就认了，否则一个一直沉默的模型能把轮数全耗在这上面。
			if usedTools && !nudged && strings.TrimSpace(finalText.String()) == "" {
				nudged = true
				msgs = append(msgs, Message{Role: RoleSystem, Content: nudgePrompt})
				continue
			}
			break
		}
		usedTools = true

		// 把模型这一轮的发言（含它要调的工具）记进上下文，否则下一轮它看不到自己说过什么。
		msgs = append(msgs, Message{
			Role:      domain.RoleAssistant,
			Content:   text.String(),
			ToolCalls: calls,
		})
		if t := strings.TrimSpace(text.String()); t != "" {
			finalText.WriteString(t)
			finalText.WriteString("\n")
		}

		asked := false
		for _, call := range calls {
			// ask_user 不走 tool_call：它不是一次数据操作，界面上该出现的是一张问题卡，
			// 不是「正在 ask_user…」那一行转圈后面再跟一张写着「已提问」的工具卡。
			if call.Name != toolAskUser {
				emit(StreamEvent{Type: "tool_call", Name: call.Name, Args: call.Args})
			}

			res := tb.Invoke(ctx, call)

			// ask_user 被打回（选项缺 detail、问题写成了开场白……）时，这条结果是给**模型**的
			// 重填指令，不是给用户看的东西。放它走普通路径的话，界面上会冒出一张
			// 「工具 ask_user / ask_user 执行失败：…」的卡片——把内部管道摊给用户看，
			// 而他既看不懂也做不了什么。只回灌给模型，让它下一轮改对。
			if call.Name == toolAskUser && res.Question == nil {
				msgs = append(msgs, Message{
					Role:       domain.RoleTool,
					Content:    res.Content,
					ToolCallID: call.ID,
					ToolName:   call.Name,
				})
				continue
			}

			if q := res.Question; q != nil {
				asked = true
				emit(StreamEvent{
					Type: "question", ID: q.ID, Question: q.Question,
					Options: q.Options, Multi: &q.Multi,
				})
				// 问题文本并进最终回复，但**不**落 tool 消息：两边都记的话，
				// 历史回放时同一个问题会出现两遍。
				finalText.WriteString(renderQuestion(q))
				msgs = append(msgs, Message{
					Role:       domain.RoleTool,
					Content:    res.Content,
					ToolCallID: call.ID,
					ToolName:   call.Name,
				})
				continue
			}

			// 工具调用连同参数一起落库，界面据此回放「Agent 当时做了什么」。
			if _, err := r.Store.AppendAgentMessage(ctx, &domain.AgentMessage{
				SessionID: r.Session.ID,
				Role:      domain.RoleTool,
				Content:   res.Summary,
				ToolName:  call.Name,
				ToolArgs:  call.Args,
			}); err != nil {
				return "", fmt.Errorf("保存工具调用记录失败")
			}

			emit(StreamEvent{
				Type: "tool_result", Name: call.Name,
				Summary: res.Summary, ObjectID: res.ObjectID,
			})
			if a := res.Artifact; a != nil {
				// 发相对路径，不是 a.Path。0012 之后 Path 存的是绝对路径，
				// 直接发出去会让对话里出现一长串 /Users/…/ 前缀——而用户刚刚
				// 就是在这个目录里让它写的文件，前缀对他没有任何信息量。
				size := a.Size
				emit(StreamEvent{Type: "artifact", Path: a.RelPath, Size: &size})
			}

			msgs = append(msgs, Message{
				Role:       domain.RoleTool,
				Content:    res.Content,
				ToolCallID: call.ID,
				ToolName:   call.Name,
			})
		}

		// 问出口了就收工。不在这里等回答是有意的：答案走用户的下一条普通消息，
		// 流挂着等的话，用户切个页面或者关掉抽屉，这个连接就永远悬在那里了。
		if asked {
			break
		}

		// 轮数用尽仍在调工具：告诉模型别再调了，让它用已有结果收个尾。
		if turn == maxTurns-1 {
			msgs = append(msgs, Message{
				Role:    RoleSystem,
				Content: "已达到本轮工具调用上限，请不要再调用任何工具，直接用一两句话总结你已经完成的事情。",
			})
		}
	}

	final := strings.TrimSpace(finalText.String())
	if final == "" {
		// 模型只调了工具没说话时兜一句，否则对话框里会留一个空气泡。
		final = "好的，已经处理完了。"
		emit(StreamEvent{Type: "delta", Text: final})
	}

	saved, err := r.Store.AppendAgentMessage(ctx, &domain.AgentMessage{
		SessionID: r.Session.ID,
		Role:      domain.RoleAssistant,
		Content:   final,
	})
	if err != nil {
		return "", fmt.Errorf("保存回复失败")
	}
	return saved.ID, nil
}

// buildHistory 拼出送给模型的消息列表：系统提示词 + 最近若干轮对话。
//
// 历史里的 tool 消息回灌的是给人看的 Summary 而不是给模型的 Content：
// 落库时只存了 Summary，而且对后续轮次来说「上次建了 TSK-0009」这个信息量已经够了，
// 不值得为了完整回放再单独存一份模型视角的内容。
func (r *Runner) buildHistory(ctx context.Context, types []*domain.ObjectType) ([]Message, error) {
	past, err := r.Store.ListAgentMessages(ctx, r.Session.ID, historyLimit)
	if err != nil {
		return nil, fmt.Errorf("读取历史消息失败")
	}

	out := []Message{{
		Role:    RoleSystem,
		Content: BuildSystemPrompt(types, time.Now(), r.Object) + agentSection(r.Agent),
	}}
	for _, m := range past {
		switch m.Role {
		case domain.RoleUser:
			out = append(out, Message{Role: domain.RoleUser, Content: m.Content})
		case domain.RoleAssistant:
			if strings.TrimSpace(m.Content) != "" {
				out = append(out, Message{Role: domain.RoleAssistant, Content: m.Content})
			}
		case domain.RoleTool:
			// 转述成 user 视角的一句事实：历史里的 tool 消息已经没有配对的 tool_call 了，
			// 直接按 tool 角色塞回去，OpenAI 会因为「找不到对应的 tool_call_id」而拒绝整个请求。
			out = append(out, Message{
				Role:    domain.RoleUser,
				Content: fmt.Sprintf("（系统记录：之前 %s）", m.Content),
			})
		}
	}
	return out, nil
}
