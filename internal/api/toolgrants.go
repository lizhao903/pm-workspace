package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strings"

	"github.com/lizhao903/pm-workspace/internal/agent"
	"github.com/lizhao903/pm-workspace/internal/audit"
	"github.com/lizhao903/pm-workspace/internal/connector"
	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/plugin"
	"github.com/lizhao903/pm-workspace/internal/store"
)

// --- Agent 工具授权（AG-02a，0035）。实际档位 = min(Agent 授权, 连接器上限)，只读工具没有「需确认」 ---

// agentGrants 是 GET/PUT /api/agents/{id}/grants 的响应。
type agentGrants struct {
	AgentID string `json:"agent_id"`
	// Grants 是 Agent 自己的授权：全部内置能力（没开的为 off）加存着的连接器工具
	Grants map[string]string `json:"grants"`
	// Effective 是实际档位：Grants 的 key 加上挂着的连接器的全部工具
	Effective map[string]string `json:"effective"`
}

func (s *Server) handleGetAgentGrants(w http.ResponseWriter, r *http.Request) {
	a, err := s.st.GetAgent(r.Context(), r.PathValue("id"))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	out, err := s.agentGrantsView(r.Context(), a)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	respondData(w, http.StatusOK, out)
}

func (s *Server) handlePutAgentGrants(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	a, err := s.st.GetAgent(ctx, r.PathValue("id"))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	var req struct {
		Grants map[string]string `json:"grants"`
	}
	if err := decodeBody(r, &req); err != nil {
		s.fail(w, r, err)
		return
	}
	if req.Grants == nil {
		s.fail(w, r, validationf("grants 必填，是 {<key>: off|confirm|auto}"))
		return
	}
	next := map[string]string{}
	for k, m := range req.Grants {
		if err := s.checkGrant(ctx, k, m); err != nil {
			s.fail(w, r, err)
			return
		}
		if m != store.GrantOff {
			next[k] = m
		}
	}
	prev, err := s.st.AgentGrants(ctx, a.ID)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if err := s.st.SetAgentGrants(ctx, a.ID, next); err != nil {
		s.fail(w, r, err)
		return
	}
	// 审计记改了的 key 和新档位（权限配置不是凭证）
	changed := map[string]string{}
	for k, m := range next {
		if prev[k] != m {
			changed[k] = m
		}
	}
	for k := range prev {
		if _, ok := next[k]; !ok {
			changed[k] = store.GrantOff
		}
	}
	if len(changed) > 0 {
		s.auditConfig(r, "set_tool_grants", "agent", a.ID, "修改 Agent「"+a.Name+"」的工具授权",
			map[string]any{"changed": changed})
	}
	out, err := s.agentGrantsView(ctx, a)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	respondData(w, http.StatusOK, out)
}

// checkGrant 校验一条授权：key 是内置能力或挂得上的连接器工具，只读的不能设 confirm。
func (s *Server) checkGrant(ctx context.Context, key, mode string) error {
	if mode != store.GrantOff && mode != store.GrantConfirm && mode != store.GrantAuto {
		return validationf("「%s」的档位只能是 off、confirm、auto", key)
	}
	if ab, ok := agent.AbilityOf(key); ok {
		if !ab.Write && mode == store.GrantConfirm {
			return validationf("「%s」是只读的，没有需确认，只能 off 或 auto", ab.Label)
		}
		return nil
	}
	cid, tool, ok := parseConnKey(key)
	if !ok {
		return validationf("不认识的工具 key：%s", key)
	}
	if s.opt.Connectors == nil {
		return validationf("这台服务没有接连接器，不能授权 %s", key)
	}
	c, err := s.opt.Connectors.Get(ctx, cid)
	if errors.Is(err, domain.ErrNotFound) {
		return validationf("连接器 %s 不存在", cid)
	}
	if err != nil {
		return err
	}
	for _, t := range c.Tools {
		if t.Name == tool {
			if !t.Write && mode == store.GrantConfirm {
				return validationf("连接器「%s」的 %s 是只读的，没有需确认，只能 off 或 auto", c.Name, tool)
			}
			return nil
		}
	}
	return validationf("连接器「%s」没有工具 %s", c.Name, tool)
}

// parseConnKey 拆 conn:<连接器 id>:<工具名>；工具名里可以再有冒号。
func parseConnKey(key string) (id, tool string, ok bool) {
	rest, ok := strings.CutPrefix(key, store.ConnGrantPrefix)
	if !ok {
		return "", "", false
	}
	id, tool, ok = strings.Cut(rest, ":")
	if !ok || id == "" || tool == "" {
		return "", "", false
	}
	return id, tool, true
}

func connKey(id, tool string) string { return store.ConnGrantPrefix + id + ":" + tool }

func (s *Server) agentGrantsView(ctx context.Context, a *domain.Agent) (*agentGrants, error) {
	p, err := s.agentPolicy(ctx, a)
	if err != nil {
		return nil, err
	}
	out := &agentGrants{AgentID: a.ID, Grants: map[string]string{}, Effective: map[string]string{}}
	for _, ab := range agent.Abilities {
		out.Grants[ab.Key] = store.GrantOff
	}
	for k, m := range p.Grants {
		out.Grants[k] = m
	}
	for k, m := range out.Grants {
		if _, ok := agent.AbilityOf(k); ok {
			eff := m
			if ab, _ := agent.AbilityOf(k); !ab.Write && eff == store.GrantConfirm {
				eff = store.GrantAuto
			}
			out.Effective[k] = eff
		} else {
			// 没挂上的连接器工具实际是关闭的，挂着的下面覆盖
			out.Effective[k] = store.GrantOff
		}
	}
	for _, c := range p.Conn {
		out.Effective[c.Key] = c.Mode
	}
	return out, nil
}

// agentPolicy 算出一个 Agent 的工具授权，交给 Runner；a 为 nil（没挂 Agent 的会话）时回 nil，行为不变。
// 连接器工具只算挂着（mcps 里）的、没暂停没断开、定义还在的实例；实际档位 = min(Agent 授权, 实例上的授权)。
func (s *Server) agentPolicy(ctx context.Context, a *domain.Agent) (*agent.Policy, error) {
	if a == nil {
		return nil, nil
	}
	grants, err := s.st.AgentGrants(ctx, a.ID)
	if err != nil {
		return nil, err
	}
	return s.policyFor(ctx, a, grants)
}

// policyFor 按给定的授权算 Policy；调试对话用没保存的授权（AG-02c）。
func (s *Server) policyFor(ctx context.Context, a *domain.Agent, grants map[string]string) (*agent.Policy, error) {
	p := &agent.Policy{Grants: grants}
	if s.opt.Connectors == nil {
		return p, nil
	}
	for _, id := range a.MCPs {
		c, err := s.opt.Connectors.Get(ctx, id)
		if errors.Is(err, domain.ErrNotFound) {
			continue
		}
		if err != nil {
			return nil, err
		}
		if !c.Available || c.Status == connector.StatusPaused || c.Status == connector.StatusDisconnected {
			continue
		}
		for _, t := range c.Tools {
			key := connKey(c.ID, t.Name)
			g := grants[key]
			if g == "" {
				g = store.GrantOff
			}
			mode := agent.MinMode(g, string(t.Mode))
			if !t.Write && mode == store.GrantConfirm {
				mode = store.GrantAuto
			}
			cid, tool := c.ID, t.Name
			p.Conn = append(p.Conn, agent.ConnTool{
				Name: agent.ConnToolName(c.Tool, t.Name), Key: key, ConnectorID: c.ID, ConnectorName: c.Name,
				Tool: t.Name, Desc: t.Desc, Write: t.Write, Mode: mode, Schema: t.Schema,
				Call: func(ctx context.Context, args string) (string, error) {
					out, err := s.opt.Connectors.CallTool(ctx, cid, tool, json.RawMessage(args))
					if err != nil {
						return "", errors.New(strings.TrimPrefix(err.Error(), domain.ErrConflict.Error()+": "))
					}
					return out, nil
				},
			})
		}
	}
	agent.UniqueConnNames(p.Conn)
	return p, nil
}

// --- 要人确认的调用：确认后执行并接着跑这一轮，拒绝后把「用户拒绝了」交回模型 ---

func (s *Server) handleConfirmToolCall(w http.ResponseWriter, r *http.Request) {
	s.decideToolCall(w, r, true)
}

func (s *Server) handleRejectToolCall(w http.ResponseWriter, r *http.Request) {
	s.decideToolCall(w, r, false)
}

func (s *Server) decideToolCall(w http.ResponseWriter, r *http.Request, approved bool) {
	ctx := r.Context()
	flusher, ok := w.(http.Flusher)
	if !ok {
		s.fail(w, r, fmt.Errorf("response writer does not support streaming"))
		return
	}
	// 调试对话里的调用只在内存里（AG-02c）
	if agent.IsDebugCall(r.PathValue("id")) {
		s.decideDebugCall(w, r, flusher, approved)
		return
	}
	tc, err := s.st.GetAgentToolCall(ctx, r.PathValue("id"))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if tc.State != store.ToolCallPending {
		s.fail(w, r, conflictf("这次调用已经处理过了"))
		return
	}
	// 执行记录里的调用也记着它的会话（AG-01b4），确认后在那个会话里接着跑
	if tc.SessionID == nil {
		s.fail(w, r, conflictf("这次调用没有会话，不能接着跑"))
		return
	}
	session, err := s.st.GetAgentSession(ctx, *tc.SessionID)
	if errors.Is(err, domain.ErrNotFound) {
		s.fail(w, r, conflictf("会话已删除"))
		return
	}
	if err != nil {
		s.fail(w, r, err)
		return
	}
	ag, err := s.chatAgent(ctx, tc.AgentID)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	policy, err := s.agentPolicy(ctx, ag)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	// 确认时按当前授权再查一次：等确认的这段时间里被关掉的不执行
	if mode, _ := policy.ModeOf(tc.Tool); approved && mode == store.GrantOff {
		s.fail(w, r, conflictf("%s 已经没有授权了，不能执行，可以拒绝掉", tc.Tool))
		return
	}
	runner, err := s.resumeRunner(ctx, session, ag, policy)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if tc.RunID != nil {
		runner.RunID = *tc.RunID
	}
	state, action, verb := store.ToolCallRejected, "reject", "拒绝"
	if approved {
		state, action, verb = store.ToolCallConfirmed, "confirm", "确认"
	}
	if tc, err = s.st.DecideAgentToolCall(ctx, tc.ID, state); err != nil {
		s.fail(w, r, err)
		return
	}
	s.opt.Audit.Note(ctx, audit.Entry{
		Kind: audit.KindAgent, Action: action, TargetType: "agent_tool_call", TargetID: tc.ID,
		Summary: fmt.Sprintf("%s Agent「%s」的调用 %s", verb, ag.Name, tc.Tool),
		Detail:  map[string]any{"agent_id": ag.ID, "session_id": session.ID, "tool": tc.Tool, "grant_key": tc.GrantKey},
	})

	h := w.Header()
	h.Set("Content-Type", "text/event-stream; charset=utf-8")
	h.Set("Cache-Control", "no-cache")
	h.Set("Connection", "keep-alive")
	h.Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	flusher.Flush()
	emit := func(ev agent.StreamEvent) {
		writeSSE(w, ev)
		flusher.Flush()
	}

	runCtx, cancel := agentRunCtx(ctx)
	defer cancel()
	dec := &agent.Decision{Call: tc, Approved: approved}
	msgID, err := runner.Resume(runCtx, dec, emit)
	if dec.Result != "" {
		// 和流解耦：用户关掉页面时结果也要记下
		if e := s.st.SetAgentToolCallResult(runCtx, tc.ID, dec.Result); e != nil {
			s.log.Warn("save tool call result failed", "call", tc.ID, "err", e)
		}
	}
	// 执行记录按这次处理重算状态（AG-01b4）；连接断了也照样跑完，按真实结果算
	if tc.RunID != nil {
		if e := agent.SettleRun(runCtx, s.st, *tc.RunID, err); e != nil {
			s.log.Warn("settle agent run failed", "run", *tc.RunID, "err", e)
		}
	}
	if err != nil {
		s.log.Warn("agent resume failed", "session", session.ID, "call", tc.ID, "err", err)
		s.noteAgentFailure(runCtx, session.ID, err)
		emit(agent.StreamEvent{Type: "error", Message: err.Error()})
		return
	}
	emit(agent.StreamEvent{Type: "done", SessionID: session.ID, MessageID: msgID})
}

// resumeRunner 照 handleAgentChat 的口径备好 Runner：按 Agent 当前的服务商和模型跑。
func (s *Server) resumeRunner(ctx context.Context, session *domain.AgentSession, ag *domain.Agent, policy *agent.Policy) (*agent.Runner, error) {
	var err error
	if ag.ProviderID != session.ProviderID || ag.Model != session.Model {
		if session, err = s.st.UpdateAgentSession(ctx, session.ID, nil, nil, &ag.ProviderID, &ag.Model); err != nil {
			return nil, err
		}
	}
	provider, err := s.resolveProvider(ctx, session.ProviderID)
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
	model := session.Model
	if model == "" {
		model = provider.Model
	}
	if model == "" {
		return nil, validationf("该供应商尚未设置模型，请先在设置页填写模型名")
	}
	var object *domain.Object
	if session.ObjectID != nil {
		object = s.currentObject(ctx, *session.ObjectID)
	}
	return &agent.Runner{
		Store: s.st, Chat: chat, Model: model, Session: session,
		Object: object, Agent: ag, Skills: s.agentSkills(ctx, ag), Policy: policy,
	}, nil
}

// --- 删连接器：挂着它的 Agent 卸下，conn:<id>:* 授权清掉 ---

// agentMountImpact 是连接器影响检查里的 agent_mounts 一项：mcps 里有它或有开着的 conn:<id>:* 授权的 Agent。
func (s *Server) agentMountImpact(ctx context.Context, c *connector.Connector) ([]connectorImpactItem, error) {
	agents, err := s.st.ListAgents(ctx)
	if err != nil {
		return nil, err
	}
	prefix := store.ConnGrantPrefix + c.ID + ":"
	var parts []string
	for _, a := range agents {
		g, err := s.st.AgentGrants(ctx, a.ID)
		if err != nil {
			return nil, err
		}
		var tools []string
		for k, m := range g {
			if t, ok := strings.CutPrefix(k, prefix); ok && m != store.GrantOff {
				tools = append(tools, t)
			}
		}
		mounted := false
		for _, id := range a.MCPs {
			mounted = mounted || id == c.ID
		}
		if !mounted && len(tools) == 0 {
			continue
		}
		sort.Strings(tools)
		if len(tools) > 0 {
			parts = append(parts, fmt.Sprintf("「%s」（失去 %s 工具）", a.Name, strings.Join(tools, "、")))
		} else {
			parts = append(parts, "「"+a.Name+"」")
		}
	}
	if len(parts) == 0 {
		return nil, nil
	}
	return []connectorImpactItem{{Source: "core", Key: "agent_mounts", Count: len(parts), Effect: plugin.ImpactDetach,
		Text: fmt.Sprintf("%d 个 Agent 会卸下这个连接器：%s", len(parts), strings.Join(parts, "、"))}}, nil
}
