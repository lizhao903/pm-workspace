package api

import (
	"context"
	"errors"
	"net/http"
	"slices"
	"time"

	"github.com/lizhao903/pm-workspace/internal/agent"
	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/store"
)

// --- Agent 执行记录（AG-01b4，0036）：触发在 internal/agent/trigger.go，这里只读 ---

var agentRunStatuses = []string{store.AgentRunRunning, store.AgentRunDone, store.AgentRunWaiting, store.AgentRunRejected, store.AgentRunFailed}

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
			s.fail(w, r, validationf("invalid %q: expected running / done / waiting / rejected / failed", "status"))
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
func (s *Server) agentRunner(ctx context.Context, ag *domain.Agent, session *domain.AgentSession) (*agent.Runner, error) {
	policy, err := s.agentPolicy(ctx, ag)
	if err != nil {
		return nil, err
	}
	return s.resumeRunner(ctx, session, ag, policy)
}
