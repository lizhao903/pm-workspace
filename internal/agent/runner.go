package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
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
	// Skills 是 Agent 挂的技能，按挂载顺序，取不到的已经跳过；拼在 Agent 指令后面，见 skillSection。
	Skills []store.Skill
	// Policy 是 Agent 的工具授权（AG-02a），nil 是没挂 Agent 的老会话，行为不变，见 grants.go。
	Policy *Policy
	// RunID 是这一轮属于哪条执行记录（AG-01b4），空串是人在会话里聊；要确认的调用记上它
	RunID string
	// Debug 非 nil 是调试对话（AG-02c）：不写会话和消息，历史从它来，见 debug.go。
	Debug *Debug
	// Thinking 是思考档位，空串时取 Agent.Thinking，都没有按 default（不带思考参数），见 thinking.go。
	Thinking string
	// Budget 非 nil 是无人值守的执行（任务交给 Agent，TSK-0460）：步数按它算、用完就失败，不再按 maxTurns 软收尾。
	// Run 和之后的 Resume 共用同一份，所以等确认前后的步数合起来算。
	Budget *Budget
	// Unattended 为真时没有人在旁边答问题：不给模型 ask_user，硬调也只回一句「不能提问」。
	Unattended bool
}

// Budget 是一次无人值守执行的步数上限，每调一次模型算一步。
type Budget struct {
	MaxSteps int
	Used     int
}

// BudgetError 是步数用完了模型还要接着调：这次执行失败，原因写给人看。
type BudgetError struct{ MaxSteps int }

func (e *BudgetError) Error() string {
	return fmt.Sprintf("超过步数上限（%d 步）还没做完，已停下。已经执行的操作不会撤回；可以调大步数上限后续跑，或者把任务拆小", e.MaxSteps)
}

// take 记一步，用完了回 *BudgetError；nil 不限。
func (b *Budget) take() error {
	if b == nil {
		return nil
	}
	if b.Used >= b.MaxSteps {
		return &BudgetError{MaxSteps: b.MaxSteps}
	}
	b.Used++
	return nil
}

// unattendedAsk 是无人值守时模型硬调 ask_user 回给它的话。
const unattendedAsk = "这次是无人值守的执行，没有人能回答问题，ask_user 不可用。按你能确定的部分做完，拿不准的写进最后的结论里。"

// tools 是这一轮给模型的工具：按授权过滤，无人值守时去掉 ask_user。
func (r *Runner) tools(tb *Toolbox) []ToolDef {
	defs := r.Policy.Tools(tb.Defs())
	if !r.Unattended {
		return defs
	}
	out := defs[:0:0]
	for _, d := range defs {
		if d.Name != toolAskUser {
			out = append(out, d)
		}
	}
	return out
}

// thinking 是这一轮用的思考档位：显式给的优先，再看挂的 Agent。
func (r *Runner) thinking() string {
	if r.Thinking != "" {
		return r.Thinking
	}
	if r.Agent != nil {
		return r.Agent.Thinking
	}
	return ""
}

// Run 处理一条用户消息，返回最终落库的 assistant 消息 id。
//
// emit 会被同步调用，调用方负责往 SSE 里写并 Flush。这里不并发调用 emit，
// 所以调用方不需要加锁。
func (r *Runner) Run(ctx context.Context, userText string, emit func(StreamEvent)) (string, error) {
	return r.run(ctx, userText, nil, emit)
}

// Resume 接着跑被确认卡片打断的那一轮：先执行（确认）或回绝（拒绝）那次调用，再让模型接着说。
// 不落新的用户消息；d.Result 回来时是给人看的执行结果。
func (r *Runner) Resume(ctx context.Context, d *Decision, emit func(StreamEvent)) (string, error) {
	return r.run(ctx, "", d, emit)
}

func (r *Runner) run(ctx context.Context, userText string, dec *Decision, emit func(StreamEvent)) (string, error) {
	tb := NewToolbox(r.Store, r.Session)
	tb.withAgentKBs(r.Agent)
	tb.withAgentSOP(r.Agent)

	types, err := r.Store.ListObjectTypes(ctx)
	if err != nil {
		return "", fmt.Errorf("读取对象类型失败")
	}

	// 先把用户这条消息落库，再开始跑模型：中途失败或用户关掉页面时，
	// 至少「我说过这句话」是留下来的。
	if dec == nil {
		if _, err := r.record(ctx, &domain.AgentMessage{
			SessionID: r.Session.ID,
			Role:      domain.RoleUser,
			Content:   userText,
		}); err != nil {
			return "", fmt.Errorf("保存用户消息失败")
		}
	}

	var note string
	if dec != nil {
		if note, err = r.applyDecision(ctx, tb, dec, emit); err != nil {
			return "", err
		}
	}

	msgs, err := r.buildHistory(ctx, types)
	if err != nil {
		return "", err
	}
	if note != "" {
		msgs = append(msgs, Message{Role: RoleSystem, Content: note})
	}

	var finalText strings.Builder
	// usedTools / nudged 支撑下面那次「推一把」。真机上 qwen3.5:4b 有大约一半的概率
	// 读完 get_object 之后交白卷——一轮只有 thinking、没有正文也没有工具调用。
	// 用户问的是「这个需求怎么推进」，收场却是一句「好的，已经处理完了」。
	usedTools, nudged := false, false

	limit := maxTurns
	if r.Budget != nil {
		limit = math.MaxInt
	}
	for turn := 0; turn < limit; turn++ {
		if err := r.Budget.take(); err != nil {
			return "", err
		}
		var text strings.Builder
		var calls []ToolCall
		var thinking []json.RawMessage

		err := r.Chat.Stream(ctx, Request{
			Model:    r.Model,
			Messages: msgs,
			Tools:    r.tools(tb),
			Thinking: r.thinking(),
		}, func(ev Event) {
			switch ev.Kind {
			case EventThinkingBlock:
				thinking = append(thinking, ev.Raw)
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
			Thinking:  thinking,
		})
		if t := strings.TrimSpace(text.String()); t != "" {
			finalText.WriteString(t)
			finalText.WriteString("\n")
		}

		asked, confirming := false, false
		for _, call := range calls {
			if r.Unattended && call.Name == toolAskUser {
				msgs = append(msgs, Message{Role: domain.RoleTool, Content: unattendedAsk, ToolCallID: call.ID, ToolName: call.Name})
				continue
			}
			// 需确认的不执行：记下来、发 confirm 事件，本轮结束后等人点（AG-02a）
			mode, key := r.Policy.ModeOf(call.Name)
			if mode == store.GrantConfirm {
				brief, err := r.requestConfirm(ctx, call, key, emit)
				if err != nil {
					return "", err
				}
				confirming = true
				finalText.WriteString(renderConfirm(brief))
				msgs = append(msgs, Message{
					Role: domain.RoleTool, Content: "已交给用户确认，确认前不会执行。",
					ToolCallID: call.ID, ToolName: call.Name,
				})
				continue
			}

			// ask_user 不走 tool_call：它不是一次数据操作，界面上该出现的是一张问题卡，
			// 不是「正在 ask_user…」那一行转圈后面再跟一张写着「已提问」的工具卡。
			if call.Name != toolAskUser {
				emit(StreamEvent{Type: "tool_call", Name: call.Name, Args: call.Args})
			}

			var res ToolResult
			if mode == store.GrantOff {
				res = deniedResult(call.Name)
			} else {
				res = r.invoke(ctx, tb, call)
			}

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
			if _, err := r.record(ctx, &domain.AgentMessage{
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
		if asked || confirming {
			break
		}

		// 轮数用尽仍在调工具：告诉模型别再调了，让它用已有结果收个尾。
		if r.Budget == nil && turn == maxTurns-1 {
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

	saved, err := r.record(ctx, &domain.AgentMessage{
		SessionID: r.Session.ID,
		Role:      domain.RoleAssistant,
		Content:   final,
	})
	if err != nil {
		return "", fmt.Errorf("保存回复失败")
	}
	if r.Debug != nil {
		// 确认后接着跑要带上这一轮的回复
		for _, id := range r.Debug.held {
			r.Debug.Calls.setHistory(id, r.debugTranscript())
		}
	}
	return saved.ID, nil
}

// record 落一条消息；调试对话不落库，只记进内存，回的消息没有 id。
func (r *Runner) record(ctx context.Context, m *domain.AgentMessage) (*domain.AgentMessage, error) {
	if r.Debug == nil {
		return r.Store.AppendAgentMessage(ctx, m)
	}
	if h, ok := historyMessage(m); ok {
		r.Debug.log = append(r.Debug.log, h)
	}
	return m, nil
}

// buildHistory 拼出送给模型的消息列表：系统提示词 + 最近若干轮对话。
//
// 历史里的 tool 消息回灌的是给人看的 Summary 而不是给模型的 Content：
// 落库时只存了 Summary，而且对后续轮次来说「上次建了 TSK-0009」这个信息量已经够了，
// 不值得为了完整回放再单独存一份模型视角的内容。
func (r *Runner) buildHistory(ctx context.Context, types []*domain.ObjectType) ([]Message, error) {
	out := []Message{{
		Role:    RoleSystem,
		Content: BuildSystemPrompt(types, time.Now(), r.Object) + sourceSection(r.Session) + agentSection(r.Agent) + skillSection(r.Skills),
	}}
	if r.Debug != nil {
		past := r.debugTranscript()
		if len(past) > historyLimit {
			past = past[len(past)-historyLimit:]
		}
		return append(out, past...), nil
	}
	past, err := r.Store.ListAgentMessages(ctx, r.Session.ID, historyLimit)
	if err != nil {
		return nil, fmt.Errorf("读取历史消息失败")
	}
	for _, m := range past {
		if h, ok := historyMessage(m); ok {
			out = append(out, h)
		}
	}
	return out, nil
}
