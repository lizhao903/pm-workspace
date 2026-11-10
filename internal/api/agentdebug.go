// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package api

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/lizhao903/pm-workspace/internal/agent"
	"github.com/lizhao903/pm-workspace/internal/audit"
	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/store"
)

// --- Agent 调试对话（AG-02c）：用没保存的配置试，不写会话和消息；写工具照常执行，审计标 debug: true ---

// debugCalls 是调试里待确认的调用，只在进程内存里，重启就没了。
var debugCalls = agent.NewDebugCalls()

// maxDebugMessages 是一次调试带的消息上限，喂给模型的还会再截到最近 40 条。
const maxDebugMessages = 200

type debugMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

// debugChatReq 是 Agent 配置（同 PATCH 的字段）加授权、产物目录和这次调试的消息历史。
type debugChatReq struct {
	// AgentID 是正在编辑的 Agent，给了就以它存着的配置打底，body 里的字段覆盖；新建时不给
	AgentID string `json:"agent_id"`
	domain.AgentInput
	// Grants 同 PUT /api/agents/{id}/grants，不给时用存着的（新建时按 newAgent 只开两项只读）
	Grants   map[string]string `json:"grants"`
	Workdir  string            `json:"workdir"`
	Messages []debugMessage    `json:"messages"`
}

var debugAuditDetail = map[string]any{"debug": true}

func (s *Server) handleAgentDebugChat(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	var req debugChatReq
	if err := decodeBody(r, &req); err != nil {
		s.fail(w, r, err)
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		s.fail(w, r, fmt.Errorf("response writer does not support streaming"))
		return
	}
	history, last, err := debugHistory(req.Messages)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	ag, err := s.debugAgent(ctx, req)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	grants, err := s.debugGrants(ctx, req)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	runner, err := s.debugRunner(ctx, ag, grants, strings.TrimSpace(req.Workdir), history)
	if err != nil {
		s.fail(w, r, err)
		return
	}

	emit := startSSE(w, flusher)
	ctx = audit.WithDetail(ctx, debugAuditDetail)
	if _, err := runner.Run(ctx, last, emit); err != nil {
		if ctx.Err() != nil {
			return
		}
		s.log.Warn("agent debug chat failed", "agent", ag.ID, "provider", ag.ProviderID, "err", err)
		emit(agent.StreamEvent{Type: "error", Message: err.Error()})
		return
	}
	emit(agent.StreamEvent{Type: "done"})
}

// debugHistory 校验消息历史：只有 user / assistant，最后一条是要回的用户消息。
func debugHistory(in []debugMessage) ([]agent.Message, string, error) {
	if len(in) == 0 {
		return nil, "", validationf("messages 必填，最后一条是这次要发的用户消息")
	}
	if len(in) > maxDebugMessages {
		return nil, "", validationf("messages 最多 %d 条，先清空调试对话", maxDebugMessages)
	}
	out := make([]agent.Message, 0, len(in)-1)
	for i, m := range in {
		if m.Role != domain.RoleUser && m.Role != domain.RoleAssistant {
			return nil, "", validationf("第 %d 条消息的 role 只能是 user 或 assistant", i+1)
		}
		if i == len(in)-1 {
			if m.Role != domain.RoleUser || strings.TrimSpace(m.Content) == "" {
				return nil, "", validationf("最后一条消息要是用户说的话，不能为空")
			}
			break
		}
		if strings.TrimSpace(m.Content) == "" {
			continue
		}
		out = append(out, agent.Message{Role: m.Role, Content: m.Content})
	}
	return out, in[len(in)-1].Content, nil
}

// debugAgent 拼出这次调试用的配置：存着的打底，body 覆盖。停用的照常能调（SPEC-settings-9.42）。
func (s *Server) debugAgent(ctx context.Context, req debugChatReq) (*domain.Agent, error) {
	ag := &domain.Agent{}
	if id := strings.TrimSpace(req.AgentID); id != "" {
		saved, err := s.st.GetAgent(ctx, id)
		if err != nil {
			return nil, err
		}
		ag = saved
	}
	in := req.AgentInput
	if in.Name != nil {
		ag.Name = strings.TrimSpace(*in.Name)
	}
	if in.Desc != nil {
		ag.Desc = *in.Desc
	}
	if in.ProviderID != nil {
		ag.ProviderID = strings.TrimSpace(*in.ProviderID)
	}
	if in.Model != nil {
		ag.Model = strings.TrimSpace(*in.Model)
	}
	if in.Instructions != nil {
		ag.Instructions = *in.Instructions
	}
	if in.Skills != nil {
		ag.Skills = *in.Skills
	}
	if in.MCPs != nil {
		ag.MCPs = *in.MCPs
	}
	if in.KBs != nil {
		ag.KBs = *in.KBs
	}
	if ag.Name == "" {
		ag.Name = "新 Agent"
	}
	if ag.ProviderID == "" {
		return nil, validationf("服务商还没选")
	}
	return ag, nil
}

// debugGrants 取这次调试的授权：body 给了就校验后用它，没给用存着的，新建时同 newAgent。
func (s *Server) debugGrants(ctx context.Context, req debugChatReq) (map[string]string, error) {
	if req.Grants != nil {
		out := map[string]string{}
		for k, m := range req.Grants {
			if err := s.checkGrant(ctx, k, m); err != nil {
				return nil, err
			}
			if m != store.GrantOff {
				out[k] = m
			}
		}
		return out, nil
	}
	if id := strings.TrimSpace(req.AgentID); id != "" {
		return s.st.AgentGrants(ctx, id)
	}
	return map[string]string{"read_tasks": store.GrantAuto, "read_contacts": store.GrantAuto}, nil
}

// debugRunner 备好不落库的 Runner；会话是个空壳，只带产物目录。
func (s *Server) debugRunner(ctx context.Context, ag *domain.Agent, grants map[string]string, workdir string, history []agent.Message) (*agent.Runner, error) {
	provider, err := s.st.GetProvider(ctx, ag.ProviderID)
	if errors.Is(err, domain.ErrNotFound) {
		return nil, validationf("服务商 %s 不存在", ag.ProviderID)
	}
	if err != nil {
		return nil, err
	}
	key, err := s.st.ProviderAPIKey(ctx, provider.ID)
	if err != nil {
		return nil, err
	}
	chat, err := agent.New(provider.Kind, provider.BaseURL, key)
	if err != nil {
		return nil, validationf("%v", err)
	}
	model := ag.Model
	if model == "" {
		model = provider.Model
	}
	if model == "" {
		return nil, validationf("该供应商尚未设置模型，请先在设置页填写模型名")
	}
	policy, err := s.policyFor(ctx, ag, grants)
	if err != nil {
		return nil, err
	}
	return &agent.Runner{
		Store: s.st, Chat: chat, Model: model,
		Session: &domain.AgentSession{ProviderID: provider.ID, Model: model, Workdir: workdir},
		Agent:   ag, Skills: s.agentSkills(ctx, ag), Policy: policy,
		Debug: &agent.Debug{History: history, Calls: debugCalls},
	}, nil
}

// decideDebugCall 确认或拒绝调试里的调用：按当时的配置快照接着跑，不查 Agent 现在的状态。
func (s *Server) decideDebugCall(w http.ResponseWriter, r *http.Request, flusher http.Flusher, approved bool) {
	ctx := r.Context()
	c, ok := debugCalls.Get(r.PathValue("id"))
	if !ok {
		s.fail(w, r, notFoundf("调试里的这次调用不存在或已过期"))
		return
	}
	ag := c.Agent
	runner, err := s.debugRunner(ctx, &ag, c.Grants, c.Workdir, c.History)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if !debugCalls.Take(c.ID) {
		s.fail(w, r, conflictf("这次调用已经处理过了"))
		return
	}
	ctx = audit.WithDetail(ctx, debugAuditDetail)
	action, verb := "reject", "拒绝"
	if approved {
		action, verb = "confirm", "确认"
	}
	s.opt.Audit.Note(ctx, audit.Entry{
		Kind: audit.KindAgent, Action: action, TargetType: "agent_tool_call", TargetID: c.ID,
		Summary: fmt.Sprintf("%s Agent「%s」调试里的调用 %s", verb, ag.Name, c.Tool),
		Detail:  map[string]any{"agent_id": ag.ID, "session_id": nil, "tool": c.Tool, "grant_key": c.GrantKey},
	})

	emit := startSSE(w, flusher)
	dec := &agent.Decision{Approved: approved, Call: &store.AgentToolCall{
		ID: c.ID, AgentID: ag.ID, CallID: c.CallID, Tool: c.Tool, GrantKey: c.GrantKey, Args: c.Args,
	}}
	if _, err := runner.Resume(ctx, dec, emit); err != nil {
		if ctx.Err() != nil {
			return
		}
		s.log.Warn("agent debug resume failed", "call", c.ID, "err", err)
		emit(agent.StreamEvent{Type: "error", Message: err.Error()})
		return
	}
	emit(agent.StreamEvent{Type: "done"})
}

// startSSE 写流的响应头，回逐条写事件的函数。
func startSSE(w http.ResponseWriter, flusher http.Flusher) func(agent.StreamEvent) {
	h := w.Header()
	h.Set("Content-Type", "text/event-stream; charset=utf-8")
	h.Set("Cache-Control", "no-cache")
	h.Set("Connection", "keep-alive")
	h.Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	flusher.Flush()
	return func(ev agent.StreamEvent) {
		writeSSE(w, ev)
		flusher.Flush()
	}
}
