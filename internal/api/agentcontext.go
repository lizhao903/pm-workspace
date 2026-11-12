// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package api

import (
	"net/http"
	"time"
	"unicode/utf8"
)

// --- 会话上下文治理（S-2，0057）：看一轮对话实际会喂给模型多少历史、丢了哪些 ---

// agentContextHistoryLimit 是 runner 每轮喂回模型的历史消息条数
// （internal/agent 的 historyLimit，同一口径）。两边分开定义是刻意的：
// api 包不为一个数字去 import agent（agent 的依赖比 api 多，容易绕成循环）。
const agentContextHistoryLimit = 40

// agentSessionContext 是 GET /api/agent/sessions/{id}/context 的响应。
// 界面用它告诉用户「这条会话的上下文还剩多少、前面的哪些不会再发给模型」。
type agentSessionContext struct {
	SessionID string `json:"session_id"`
	// Instruction 是会话当前的追加要求（S-2）：上下文面板用它回显已保存的内容，
	// 否则刷新页面后输入框是空的，用户会以为没存上。
	Instruction   string                `json:"instruction"`
	HistoryLimit  int                   `json:"history_limit"`
	TotalMessages int                   `json:"total_messages"`
	DroppedCount  int                   `json:"dropped_count"`
	SentChars     int                   `json:"sent_chars"`
	ApproxTokens  int                   `json:"approx_tokens"`
	Messages      []agentContextMessage `json:"messages"`
}

// agentContextMessage 是一条历史消息在「模型实际会看到什么」这个视角下的样子。
// content 原样给出（不做截断）：要判断它占了多少字，截断后的长度就是错的。
type agentContextMessage struct {
	ID        string    `json:"id"`
	Role      string    `json:"role"`
	Content   string    `json:"content"`
	ToolName  string    `json:"tool_name"`
	ToolArgs  string    `json:"tool_args"`
	CreatedAt time.Time `json:"created_at"`
	// Dropped 为真：这条在超出 history_limit 的旧消息里，runner 不会再发给模型。
	Dropped bool `json:"dropped"`
}

// handleAgentSessionContext 说明这条会话下一轮实际会带哪些历史：全部消息按时间正序返回，
// 超出 history_limit 的（最早的）标 dropped；sent_chars 是真正会进模型上下文的正文长度。
//
// approx_tokens 只是粗估（utf8 字符数 / 2）：中文大约 1 字 1 token，英文和 JSON 参数
// 大约 4 字符 1 token，取中间值 2，让两种场景都不至于差一个数量级。精确值要按模型分词器算，
// 这里只用来在界面上提示「上下文快满了」。工具有结果、模型有思考，都不含在这个估计里。
func (s *Server) handleAgentSessionContext(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	id := r.PathValue("id")
	sess, err := s.st.GetAgentSession(ctx, id)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	msgs, err := s.st.ListAgentMessages(ctx, id, 0)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	dropped := len(msgs) - agentContextHistoryLimit
	if dropped < 0 {
		dropped = 0
	}
	out := agentSessionContext{
		SessionID:     sess.ID,
		Instruction:   sess.Instruction,
		HistoryLimit:  agentContextHistoryLimit,
		TotalMessages: len(msgs),
		DroppedCount:  dropped,
		Messages:      make([]agentContextMessage, 0, len(msgs)),
	}
	for i, m := range msgs {
		d := i < dropped
		if !d {
			out.SentChars += utf8.RuneCountInString(m.Content)
		}
		out.Messages = append(out.Messages, agentContextMessage{
			ID:        m.ID,
			Role:      m.Role,
			Content:   m.Content,
			ToolName:  m.ToolName,
			ToolArgs:  m.ToolArgs,
			CreatedAt: m.CreatedAt,
			Dropped:   d,
		})
	}
	out.ApproxTokens = (out.SentChars + 1) / 2 // ceil(sent_chars / 2)
	respondData(w, http.StatusOK, out)
}
