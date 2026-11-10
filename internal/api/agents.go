// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/lizhao903/pm-workspace/internal/agent"
	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/plugin"
	"github.com/lizhao903/pm-workspace/internal/schedule"
)

// --- Agent 配置（AG-01b1，0032）。校验和默认值在 store，这里只转协议、记审计、做删除前检查 ---

func (s *Server) handleListAgents(w http.ResponseWriter, r *http.Request) {
	items, err := s.st.ListAgents(r.Context())
	if err != nil {
		s.fail(w, r, err)
		return
	}
	respondList(w, items, Meta{Total: len(items)})
}

func (s *Server) handleGetAgent(w http.ResponseWriter, r *http.Request) {
	a, err := s.st.GetAgent(r.Context(), r.PathValue("id"))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	respondData(w, http.StatusOK, a)
}

func (s *Server) handleCreateAgent(w http.ResponseWriter, r *http.Request) {
	var in domain.AgentInput
	if err := decodeBody(r, &in); err != nil {
		s.fail(w, r, err)
		return
	}
	a, err := s.st.CreateAgent(r.Context(), in)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	s.syncAIMembers(r.Context())
	s.auditConfig(r, "create", "agent", a.ID, "新建 Agent「"+a.Name+"」",
		map[string]any{"name": a.Name, "provider_id": a.ProviderID, "model": a.Model, "enabled": a.Enabled})
	respondData(w, http.StatusCreated, a)
}

func (s *Server) handleUpdateAgent(w http.ResponseWriter, r *http.Request) {
	body, err := readBody(r)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	keys, err := patchKeys(body)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	var in domain.AgentInput
	if err := json.Unmarshal(body, &in); err != nil {
		s.fail(w, r, validationf("malformed JSON body: %v", err))
		return
	}
	a, err := s.st.UpdateAgent(r.Context(), r.PathValue("id"), in)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	fields := map[string]bool{}
	for k := range keys {
		fields[k] = agentFields[k]
	}
	detail := map[string]any{"fields": givenFields(fields)}
	if fields["enabled"] {
		detail["enabled"] = a.Enabled
	}
	s.syncAIMembers(r.Context())
	s.auditConfig(r, "update", "agent", a.ID, "修改 Agent「"+a.Name+"」", detail)
	respondData(w, http.StatusOK, a)
}

// agentFields 是 PATCH 认的字段，审计只记这些名字；其余键（比如前端带上的 id、abilities）忽略。
var agentFields = map[string]bool{
	"name": true, "desc": true, "color": true, "avatar": true, "provider_id": true, "model": true,
	"instructions": true, "skills": true, "mcps": true, "kbs": true, "triggers": true, "thinking": true, "enabled": true,
}

func (s *Server) handleDeleteAgent(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	a, err := s.st.GetAgent(ctx, r.PathValue("id"))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	imp, err := s.agentImpact(ctx, a)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if len(imp.Blocks) > 0 {
		texts := make([]string, len(imp.Blocks))
		for i, b := range imp.Blocks {
			texts[i] = b.Text
		}
		s.fail(w, r, conflictf("不能删除：%s", strings.Join(texts, "；")))
		return
	}
	out, err := s.st.DeleteAgent(ctx, a.ID)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	s.syncAIMembers(r.Context())
	s.auditConfig(r, "delete", "agent", out.ID, "删除 Agent「"+out.Name+"」",
		map[string]any{"name": out.Name, "provider_id": out.ProviderID, "model": out.Model})
	respondData(w, http.StatusOK, out)
}

// --- 删除前的影响检查，口径同原型 agentPlan（SPEC-settings-9.29、9.30） ---

type agentImpactItem struct {
	Key    string `json:"key"`
	Count  int    `json:"count"`
	Text   string `json:"text"`
	Effect string `json:"effect,omitempty"`
}

type agentImpactResult struct {
	AgentID string `json:"agent_id"`
	// Blocks 非空时 DELETE 回 409，前端显示「不能删除：<原因>」
	Blocks []agentImpactItem `json:"blocks"`
	// Items 是删了之后的连带影响，前端列进确认框
	Items []agentImpactItem `json:"items"`
}

func (s *Server) handleAgentImpact(w http.ResponseWriter, r *http.Request) {
	a, err := s.st.GetAgent(r.Context(), r.PathValue("id"))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	out, err := s.agentImpact(r.Context(), a)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	respondData(w, http.StatusOK, out)
}

func (s *Server) agentImpact(ctx context.Context, a *domain.Agent) (*agentImpactResult, error) {
	out := &agentImpactResult{AgentID: a.ID, Blocks: []agentImpactItem{}, Items: []agentImpactItem{}}
	if s.opt.Schedules != nil {
		list, err := s.opt.Schedules.List(ctx)
		if err != nil {
			return nil, err
		}
		var names []string
		for _, sc := range list {
			if sc.Action.Kind == schedule.ActionAgent && sc.Action.AgentID == a.ID {
				names = append(names, "「"+sc.Name+"」")
			}
		}
		if len(names) > 0 {
			out.Blocks = append(out.Blocks, agentImpactItem{Key: "schedules", Count: len(names),
				Text: fmt.Sprintf("定时任务%s交给它执行，先改掉或删掉这些定时任务", strings.Join(names, "、"))})
		}
	}
	// 还在等确认的调用拦删除（AG-02a），执行记录里的归 AG-01b4
	if p, err := s.st.CountPendingToolCalls(ctx, a.ID); err != nil {
		return nil, err
	} else if p > 0 {
		out.Blocks = append(out.Blocks, agentImpactItem{Key: "pending_calls", Count: p,
			Text: fmt.Sprintf("还有 %d 处操作等你确认（会话里），先处理完", p)})
	}
	// 被选作场景默认 Agent 的，删了场景退回默认服务商（0045）
	scenes, err := agent.ListScenarios(ctx, s.st)
	if err != nil {
		return nil, err
	}
	var used []string
	for _, sc := range scenes {
		if sc.AgentID == a.ID {
			used = append(used, "「"+sc.Label+"」")
		}
	}
	if len(used) > 0 {
		out.Items = append(out.Items, agentImpactItem{Key: "scenarios", Count: len(used), Effect: plugin.ImpactFallback,
			Text: fmt.Sprintf("%s的默认 Agent 是它，删了改回用默认服务商和模型", strings.Join(used, "、"))})
	}
	// 负责人是它的对象（TSK-0500）：名册里那条归档，负责人保留
	if m, err := s.st.GetAIMember(ctx, domain.AIKindAgent, a.ID); err == nil && m.OwnedCount > 0 {
		out.Items = append(out.Items, agentImpactItem{Key: "owned", Count: m.OwnedCount, Effect: plugin.ImpactKeep,
			Text: fmt.Sprintf("%d 条事项的负责人是它，负责人保留，显示为已归档的 AI 成员", m.OwnedCount)})
	}
	n, err := s.st.CountAgentSessions(ctx, a.ID)
	if err != nil {
		return nil, err
	}
	if n > 0 {
		out.Items = append(out.Items, agentImpactItem{Key: "sessions", Count: n, Effect: plugin.ImpactKeep,
			Text: fmt.Sprintf("%d 个会话和它们的产出保留，显示为已删除的 Agent", n)})
	}
	return out, nil
}

// --- 会话挂 Agent ---

// chatAgent 取会话挂的 Agent 并确认能发消息：删了或停用了回 409。
func (s *Server) chatAgent(ctx context.Context, id string) (*domain.Agent, error) {
	a, err := s.st.GetAgent(ctx, id)
	if errors.Is(err, domain.ErrNotFound) {
		return nil, conflictf("Agent 已删除")
	}
	if err != nil {
		return nil, err
	}
	if !a.Enabled {
		return nil, conflictf("Agent 已停用")
	}
	return a, nil
}

// --- 场景默认 Agent（0045）：SOP 编排助手、其他后台调用各选一个 Agent，见 internal/agent/scenario.go ---

func (s *Server) handleListAgentScenarios(w http.ResponseWriter, r *http.Request) {
	list, err := agent.ListScenarios(r.Context(), s.st)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	respondList(w, list, Meta{Total: len(list)})
}

// handlePatchAgentScenarios 收 {"<场景>": "<Agent id 或空串>"}，只改给了的场景；回改完后的全部场景。
func (s *Server) handlePatchAgentScenarios(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	var in map[string]*string
	if err := decodeBody(r, &in); err != nil {
		s.fail(w, r, err)
		return
	}
	if len(in) == 0 {
		s.fail(w, r, validationf("没有要改的场景"))
		return
	}
	for k, v := range in {
		if !agent.IsScenario(k) {
			s.fail(w, r, validationf("没有这个场景：%s", k))
			return
		}
		if v == nil {
			s.fail(w, r, validationf("场景 %s 的值要是 Agent id 或空串", k))
			return
		}
		if id := strings.TrimSpace(*v); id != "" {
			if _, err := s.st.GetAgent(ctx, id); errors.Is(err, domain.ErrNotFound) {
				s.fail(w, r, validationf("Agent %s 不存在", id))
				return
			} else if err != nil {
				s.fail(w, r, err)
				return
			}
		}
	}
	detail := map[string]any{}
	for k, v := range in {
		if err := agent.SetScenarioAgent(ctx, s.st, k, *v); err != nil {
			s.fail(w, r, err)
			return
		}
		detail[k] = strings.TrimSpace(*v)
	}
	s.auditConfig(r, "update", "agent_scenarios", "scenarios", "修改场景默认 Agent", detail)
	s.handleListAgentScenarios(w, r)
}
