// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package api

import (
	"context"
	"errors"
	"net/http"
	"sort"
	"sync"
)

// 会话里正在跑的一轮对话（含确认后接着跑）。一轮对话和浏览器连接脱钩（见 agentRunCtx），
// 关掉页面也停不下来；Agent 陷进循环时要能从界面上停掉，所以按会话记下取消函数。
// 一个会话同时只有一轮在跑的情况居多；同一会话又起一轮（另一个页面）时两轮都记，停止时一起停。

// errStoppedByUser 是手动停止时 context 的 cause，用来和超时、出错区分。
var errStoppedByUser = errors.New("stopped by user")

type activeTurns struct {
	mu   sync.Mutex
	seq  int
	runs map[string]map[int]context.CancelCauseFunc
}

func (a *activeTurns) start(parent context.Context, sessionID string) (context.Context, func()) {
	ctx, cancel := context.WithCancelCause(parent)
	a.mu.Lock()
	if a.runs == nil {
		a.runs = map[string]map[int]context.CancelCauseFunc{}
	}
	a.seq++
	id := a.seq
	if a.runs[sessionID] == nil {
		a.runs[sessionID] = map[int]context.CancelCauseFunc{}
	}
	a.runs[sessionID][id] = cancel
	a.mu.Unlock()
	return ctx, func() {
		a.mu.Lock()
		delete(a.runs[sessionID], id)
		if len(a.runs[sessionID]) == 0 {
			delete(a.runs, sessionID)
		}
		a.mu.Unlock()
		cancel(nil)
	}
}

// stop 停掉这个会话所有在跑的轮次，回停了几轮。
func (a *activeTurns) stop(sessionID string) int {
	a.mu.Lock()
	defer a.mu.Unlock()
	n := 0
	for _, c := range a.runs[sessionID] {
		c(errStoppedByUser)
		n++
	}
	return n
}

func (a *activeTurns) list() []string {
	a.mu.Lock()
	defer a.mu.Unlock()
	out := make([]string, 0, len(a.runs))
	for id := range a.runs {
		out = append(out, id)
	}
	sort.Strings(out)
	return out
}

// stoppedByUser 判断这一轮是不是被手动停掉的。
func stoppedByUser(ctx context.Context) bool {
	return errors.Is(context.Cause(ctx), errStoppedByUser)
}

// handleStopAgentSession 停掉会话里正在跑的一轮：已经执行的工具调用不撤回，
// 会话里记一句「已手动停止」。没有在跑的回 200 + stopped:0，不算错。
func (s *Server) handleStopAgentSession(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if _, err := s.st.GetAgentSession(r.Context(), id); err != nil {
		s.fail(w, r, err)
		return
	}
	n := s.turns.stop(id)
	if n > 0 {
		s.log.Info("agent session stopped by user", "session", id, "turns", n)
	}
	respondData(w, http.StatusOK, map[string]any{"session_id": id, "stopped": n})
}

// running 这个会话有没有正在跑的一轮
func (a *activeTurns) running(sessionID string) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return len(a.runs[sessionID]) > 0
}

// handleRunningAgentSessions 列出正在跑的会话 id，界面据此显示「停止」。
func (s *Server) handleRunningAgentSessions(w http.ResponseWriter, r *http.Request) {
	respondData(w, http.StatusOK, map[string]any{"session_ids": s.turns.list()})
}
