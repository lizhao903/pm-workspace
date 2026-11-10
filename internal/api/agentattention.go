// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"slices"
	"sort"
	"strings"
	"time"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/store"
)

// --- 等确认聚合（P0-O3）：今日页、菜单红点、会话列表圆点、刷新后恢复确认卡共用一个只读接口 ---
//
// 只读、不新增鉴权；路由由 server.go 统一挂到 GET /api/agent/attention。

// attentionLimit 与 store 侧一致：pending_calls、waiting_runs 各最多 100 条。
const attentionLimit = 100

// agentAttention 是 GET /api/agent/attention 的响应。
type agentAttention struct {
	// Total 等于 pending_calls 的条数（菜单红点、今日页「需要你处理」的合计）；waiting_runs 不并进来。
	Total        int                     `json:"total"`
	PendingCalls []agentAttentionCall    `json:"pending_calls"`
	WaitingRuns  []agentAttentionWaiting `json:"waiting_runs"`
}

// agentAttentionCall 是一条等人确认的调用。call_id 是 agent_tool_calls 的主键（atc_…），
// 确认、拒绝按它调 /api/agent/tool-calls/{id}/confirm|reject，前端恢复确认卡也拿它配 id。
// session_id 是字符串：会话已被删掉时回空串，但调用本身还在等确认，所以照常列出来。
type agentAttentionCall struct {
	CallID       string    `json:"call_id"`
	SessionID    string    `json:"session_id"`
	SessionTitle string    `json:"session_title"`
	AgentID      string    `json:"agent_id"`
	AgentName    string    `json:"agent_name"`
	Tool         string    `json:"tool"`
	Args         string    `json:"args"`
	Summary      string    `json:"summary"`
	At           time.Time `json:"at"`
}

// agentAttentionWaiting 是一条停在等确认的执行记录。session_id 同 pending_calls 用字符串（没有会话时空串），
// 两边的类型保持一致，前端不用为 null 单独写分支。
type agentAttentionWaiting struct {
	RunID        string    `json:"run_id"`
	AgentID      string    `json:"agent_id"`
	AgentName    string    `json:"agent_name"`
	Trigger      string    `json:"trigger"`
	SessionID    string    `json:"session_id"`
	SessionTitle string    `json:"session_title"`
	Since        time.Time `json:"since"`
}

func (s *Server) handleAgentAttention(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	sessionID := newParams(r).str("session_id")

	calls, err := s.st.ListPendingToolCalls(ctx, sessionID)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	runs, _, err := s.st.ListAgentRuns(ctx, store.AgentRunFilter{
		Statuses: []string{store.AgentRunWaiting},
		Limit:    attentionLimit,
	})
	if err != nil {
		s.fail(w, r, err)
		return
	}
	// AgentRunFilter 没有会话条件；waiting 的运行通常个位数，先取一页再按会话筛。
	// 执行记录契约是按 started_at 升序，列表接口是降序，这里再排一次。
	if sessionID != "" {
		runs = slices.DeleteFunc(runs, func(run *store.AgentRun) bool {
			return run.SessionID == nil || *run.SessionID != sessionID
		})
	}
	sort.SliceStable(runs, func(i, j int) bool { return runs[i].StartedAt.Before(runs[j].StartedAt) })

	names, err := s.agentNameByID(ctx)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	ids := make([]string, 0, len(calls)+len(runs))
	for _, c := range calls {
		if c.SessionID != nil {
			ids = append(ids, *c.SessionID)
		}
	}
	for _, run := range runs {
		if run.SessionID != nil {
			ids = append(ids, *run.SessionID)
		}
	}
	titles, err := s.agentSessionTitleByID(ctx, ids)
	if err != nil {
		s.fail(w, r, err)
		return
	}

	out := agentAttention{
		Total:        len(calls),
		PendingCalls: make([]agentAttentionCall, 0, len(calls)),
		WaitingRuns:  make([]agentAttentionWaiting, 0, len(runs)),
	}
	for _, c := range calls {
		item := agentAttentionCall{
			CallID:    c.ID,
			AgentID:   c.AgentID,
			AgentName: names[c.AgentID],
			Tool:      c.Tool,
			Args:      c.Args,
			Summary:   attentionCallSummary(c.Tool, c.Args),
			At:        c.CreatedAt,
		}
		if c.SessionID != nil {
			item.SessionID = *c.SessionID
			item.SessionTitle = titles[*c.SessionID]
		}
		out.PendingCalls = append(out.PendingCalls, item)
	}
	for _, run := range runs {
		item := agentAttentionWaiting{
			RunID:     run.ID,
			AgentID:   run.AgentID,
			AgentName: names[run.AgentID],
			Trigger:   run.Trigger,
			Since:     run.StartedAt,
		}
		if run.SessionID != nil {
			item.SessionID = *run.SessionID
			item.SessionTitle = titles[*run.SessionID]
		}
		out.WaitingRuns = append(out.WaitingRuns, item)
	}
	respondData(w, http.StatusOK, out)
}

// agentNameByID 批量补 Agent 名：已删除的 Agent 不在列表里，用它 id 查出来是空串。
func (s *Server) agentNameByID(ctx context.Context) (map[string]string, error) {
	list, err := s.st.ListAgents(ctx)
	if err != nil {
		return nil, err
	}
	out := make(map[string]string, len(list))
	for _, a := range list {
		out[a.ID] = a.Name
	}
	return out, nil
}

// agentSessionTitleByID 批量补会话标题。会话删了不是整体失败：卡片上标题空着，调用本身照常能确认。
func (s *Server) agentSessionTitleByID(ctx context.Context, ids []string) (map[string]string, error) {
	out := make(map[string]string, len(ids))
	for _, id := range ids {
		if id == "" {
			continue
		}
		if _, ok := out[id]; ok {
			continue
		}
		sess, err := s.st.GetAgentSession(ctx, id)
		if errors.Is(err, domain.ErrNotFound) {
			out[id] = ""
			continue
		}
		if err != nil {
			return nil, err
		}
		out[id] = sess.Title
	}
	return out, nil
}

// attentionCallSummary 是一次调用给人看的一句话，口径尽量贴近 Agent 落库的「等待确认：…」那条消息。
// 这里拿不到 Agent 的连接器策略，连接器工具（名字是 <定义>__<工具>）回退成「调用 <工具名>」。
func attentionCallSummary(tool, args string) string {
	var m map[string]any
	_ = json.Unmarshal([]byte(args), &m)
	str := func(key string) string {
		s, _ := m[key].(string)
		return strings.Join(strings.Fields(s), " ")
	}
	switch tool {
	case "create_object":
		if title := str("title"); title != "" {
			return "新建「" + title + "」"
		}
	case "update_object":
		if ref := str("ref"); ref != "" {
			return "修改 " + ref
		}
	case "append_progress":
		if ref := str("ref"); ref != "" {
			return "给 " + ref + " 记进展"
		}
	case "write_file":
		if path := str("path"); path != "" {
			return "写文件 " + path
		}
	case "run_sop":
		if id := str("flow_id"); id != "" {
			return "发起 SOP " + id
		}
	case "create_sop":
		if name := str("name"); name != "" {
			return "新建 SOP「" + name + "」"
		}
	case "update_sop":
		if id := str("flow_id"); id != "" {
			return "修改 SOP " + id
		}
	}
	return "调用 " + tool
}
