// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package api

import (
	"context"
	"errors"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/lizhao903/pm-workspace/internal/agent"
	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/store"
)

// --- Agent 执行记录（AG-01b4，0036）：触发在 internal/agent/trigger.go；P0-O2 起可停止 / 重试 ---

var agentRunStatuses = []string{store.AgentRunRunning, store.AgentRunDone, store.AgentRunWaiting, store.AgentRunRejected, store.AgentRunFailed, store.AgentRunCanceled}

// agentRunDetail 是一条执行记录连同它的调用：calls 是会话里的工具调用记录，tool_calls 是要人确认的调用。
type agentRunDetail struct {
	*store.AgentRun
	Calls     []agentRunCall         `json:"calls"`
	ToolCalls []*store.AgentToolCall `json:"tool_calls"`
}

type agentRunCall struct {
	Tool    string    `json:"tool"`
	Args    string    `json:"args"`
	Summary string    `json:"summary"`
	At      time.Time `json:"at"`
}

func (s *Server) handleListAgentRuns(w http.ResponseWriter, r *http.Request) {
	p := newParams(r)
	f := store.AgentRunFilter{AgentID: p.str("agent")}
	for _, st := range p.csv("status") {
		if !slices.Contains(agentRunStatuses, st) {
			s.fail(w, r, validationf("invalid %q: expected running / done / waiting / rejected / failed / canceled", "status"))
			return
		}
		f.Statuses = append(f.Statuses, st)
	}
	var err error
	if f.Since, err = p.timeAt("since", dayStart); err != nil {
		s.fail(w, r, err)
		return
	}
	if f.Until, err = p.timeAt("until", dayEnd); err != nil {
		s.fail(w, r, err)
		return
	}
	if f.Limit, err = p.limit("limit", store.DefaultAgentRunLimit, 500); err != nil {
		s.fail(w, r, err)
		return
	}
	if f.Offset, err = p.intRange("offset", 0, 0, 1<<30); err != nil {
		s.fail(w, r, err)
		return
	}
	items, total, err := s.st.ListAgentRuns(r.Context(), f)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	respondList(w, items, Meta{Total: total, Limit: f.Limit, Offset: f.Offset})
}

func (s *Server) handleGetAgentRun(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	run, err := s.st.GetAgentRun(ctx, r.PathValue("id"))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	out := agentRunDetail{AgentRun: run, Calls: []agentRunCall{}}
	if out.ToolCalls, err = s.st.ListRunToolCalls(ctx, run.ID); err != nil {
		s.fail(w, r, err)
		return
	}
	if run.SessionID != nil {
		msgs, err := s.st.ListAgentMessages(ctx, *run.SessionID, 0)
		if err != nil && !errors.Is(err, domain.ErrNotFound) {
			s.fail(w, r, err)
			return
		}
		for _, m := range msgs {
			if m.Role == domain.RoleTool {
				out.Calls = append(out.Calls, agentRunCall{Tool: m.ToolName, Args: m.ToolArgs, Summary: m.Content, At: m.CreatedAt})
			}
		}
	}
	respondData(w, http.StatusOK, out)
}

// agentRunner 是触发执行用的 Runner，口径同确认后接着跑（resumeRunner）：按 Agent 当前的服务商、模型、授权、技能。
// 触发执行是无人值守的（P0-O2）：没有人在旁边答问题，所以不给 ask_user，步数按 DefaultRunSteps 计。
func (s *Server) agentRunner(ctx context.Context, ag *domain.Agent, session *domain.AgentSession) (*agent.Runner, error) {
	policy, err := s.agentPolicy(ctx, ag)
	if err != nil {
		return nil, err
	}
	runner, err := s.resumeRunner(ctx, session, ag, policy)
	if err != nil {
		return nil, err
	}
	runner.Unattended = true
	runner.Budget = &agent.Budget{MaxSteps: agent.DefaultRunSteps}
	return runner, nil
}

// --- 停止 / 重试触发执行（P0-O2，0056） ---

// agentRunStop 是 POST /api/agent-runs/{id}/stop 的响应。
type agentRunStop struct {
	RunID  string `json:"run_id"`
	Status string `json:"status"`
}

// handleStopAgentRun 停止一次还在跑的触发执行：取消它的上下文，执行收尾记 canceled。
func (s *Server) handleStopAgentRun(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	run, err := s.st.GetAgentRun(ctx, r.PathValue("id"))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if run.Status != store.AgentRunRunning {
		s.fail(w, r, conflictf("这次执行已经结束了，无需停止"))
		return
	}
	if s.opt.AgentRuns == nil || !s.opt.AgentRuns.Stop(run.ID) {
		s.fail(w, r, conflictf("这次执行已经结束或不在本进程里跑，停不下来"))
		return
	}
	respondData(w, http.StatusOK, agentRunStop{RunID: run.ID, Status: store.AgentRunCanceled})
}

// handleRetryAgentRun 按一条失败或停止的执行记录再跑一次：新建记录和新会话，异步执行。
func (s *Server) handleRetryAgentRun(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	run, err := s.st.GetAgentRun(ctx, r.PathValue("id"))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if run.Status != store.AgentRunFailed && run.Status != store.AgentRunCanceled {
		s.fail(w, r, conflictf("只有失败或已停止的执行才能重试"))
		return
	}
	if strings.TrimSpace(run.Prompt) == "" {
		s.fail(w, r, conflictf("这次执行没有留下提示词，不能重试"))
		return
	}
	// Agent 删除 / 停用按 409 回，和触发执行的口径一致；下面的 Retry 只处理剩下的意外错误。
	if _, err := s.chatAgent(ctx, run.AgentID); err != nil {
		s.fail(w, r, err)
		return
	}
	if s.opt.AgentRuns == nil {
		s.fail(w, r, conflictf("这个实例没接上 Agent 触发调度，不能重试"))
		return
	}
	next, err := s.opt.AgentRuns.Retry(ctx, run)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	sessionID := ""
	if next.SessionID != nil {
		sessionID = *next.SessionID
	}
	respondData(w, http.StatusAccepted, map[string]any{"run": next, "session_id": sessionID})
}
