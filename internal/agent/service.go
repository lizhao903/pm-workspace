package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"

	"github.com/lizhao903/pm-workspace/internal/connector"
	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/kb"
	"github.com/lizhao903/pm-workspace/internal/store"
)

// --- 给插件句柄用的入口（SOP-01c）：补全、按 Agent 的授权跑一轮、看会话最新回复、搜知识库 ---
// 插件经 internal/plugin 的 Core.Agent() 拿，cmd/pmw 接上。口径同 internal/api 的对话接口：
// 服务商、授权、技能按 Agent 当前的配置算；要确认的工具不执行，这一轮停下，等人在会话里确认。

// ServiceConnectors 是连接器实例的读和调用，*connector.Store 满足；为 nil 时 Agent 没有连接器工具。
type ServiceConnectors interface {
	Get(ctx context.Context, id string) (*connector.Connector, error)
	CallTool(ctx context.Context, id, tool string, args json.RawMessage) (string, error)
}

// Service 是插件句柄背后的实现。
type Service struct {
	// Store 用外层包装过的（审计、事件），Agent 的写操作和对话接口里的一样记
	Store      store.Store
	Connectors ServiceConnectors
	// PluginSkills 是在跑的插件登记的技能，Agent 挂了它们时要能取到；nil 时只有内置和自定义技能
	PluginSkills func() []store.Skill
	// NewChat 按服务商建模型客户端，nil 时用 New；测试用它换成假的
	NewChat func(kind, baseURL, apiKey string) (Chat, error)
}

// CompleteRequest 是一次不带工具的补全。Model 为空用默认服务商的模型。
type CompleteRequest struct {
	System string
	Prompt string
	Model  string
}

// AgentRunRequest 让一个 Agent 跑一轮。Agent 是 id 或名称；Title 是新会话的标题。
type AgentRunRequest struct {
	Agent  string
	Prompt string
	Title  string
}

// AgentRunResult 是一轮跑完（或停下等确认）时会话的样子。
type AgentRunResult struct {
	AgentID   string
	AgentName string
	SessionID string
	// MessageID、Reply 是会话里最新一条 Agent 回复
	MessageID string
	Reply     string
	// Waiting 为真表示这一轮停在要确认的调用上，Pending 是给人看的一句话，CallIDs 是待确认调用的 id（RunAgent 才有）
	Waiting bool
	Pending string
	CallIDs []string
}

// KBHit 是知识库检索命中的一段。
type KBHit = kb.SearchHit

// ErrNoProvider：库里没有可用的模型服务商。
var ErrNoProvider = errors.New("还没有配置模型服务商，先在设置 > 模型里加一个")

// confirmMark 是 renderConfirm 写进回复的标记，看会话最新回复是不是还在等确认用。
const confirmMark = "【等你确认】"

func (s *Service) chat(kind, baseURL, key string) (Chat, error) {
	if s.NewChat != nil {
		return s.NewChat(kind, baseURL, key)
	}
	return New(kind, baseURL, key)
}

// provider 按 id 取服务商；id 为空取默认的，没有默认的取第一个启用的。
func (s *Service) provider(ctx context.Context, id string) (*domain.AgentProvider, error) {
	if id = strings.TrimSpace(id); id != "" {
		return s.Store.GetProvider(ctx, id)
	}
	list, err := s.Store.ListProviders(ctx)
	if err != nil {
		return nil, err
	}
	for _, p := range list {
		if p.IsDefault && p.Enabled {
			return p, nil
		}
	}
	for _, p := range list {
		if p.Enabled {
			return p, nil
		}
	}
	return nil, ErrNoProvider
}

// client 备好模型客户端和模型名，model 为空用服务商的。
func (s *Service) client(ctx context.Context, providerID, model string) (Chat, string, error) {
	p, err := s.provider(ctx, providerID)
	if err != nil {
		return nil, "", err
	}
	key, err := s.Store.ProviderAPIKey(ctx, p.ID)
	if err != nil {
		return nil, "", err
	}
	c, err := s.chat(p.Kind, p.BaseURL, key)
	if err != nil {
		return nil, "", err
	}
	if model = strings.TrimSpace(model); model == "" {
		model = p.Model
	}
	if model == "" {
		return nil, "", fmt.Errorf("服务商「%s」没有设置模型", p.Name)
	}
	return c, model, nil
}

// Complete 用默认服务商补全一段提示词，回模型说的原文。
func (s *Service) Complete(ctx context.Context, req CompleteRequest) (string, error) {
	c, model, err := s.client(ctx, "", req.Model)
	if err != nil {
		return "", err
	}
	var msgs []Message
	if strings.TrimSpace(req.System) != "" {
		msgs = append(msgs, Message{Role: RoleSystem, Content: req.System})
	}
	msgs = append(msgs, Message{Role: domain.RoleUser, Content: req.Prompt})
	var b strings.Builder
	if err := c.Stream(ctx, Request{Model: model, Messages: msgs}, func(ev Event) {
		if ev.Kind == EventDelta {
			b.WriteString(ev.Text)
		}
	}); err != nil {
		return "", err
	}
	return b.String(), nil
}

// findAgent 按 id 找，找不到再按名称找；停用的不能跑。
func (s *Service) findAgent(ctx context.Context, ref string) (*domain.Agent, error) {
	ref = strings.TrimSpace(ref)
	if ref == "" {
		return nil, fmt.Errorf("没有指定 Agent")
	}
	a, err := s.Store.GetAgent(ctx, ref)
	if errors.Is(err, domain.ErrNotFound) {
		list, lerr := s.Store.ListAgents(ctx)
		if lerr != nil {
			return nil, lerr
		}
		i := slices.IndexFunc(list, func(x *domain.Agent) bool { return x.Name == ref })
		if i < 0 {
			return nil, fmt.Errorf("Agent「%s」不存在", ref)
		}
		a, err = list[i], nil
	}
	if err != nil {
		return nil, err
	}
	if !a.Enabled {
		return nil, fmt.Errorf("Agent「%s」已停用", a.Name)
	}
	return a, nil
}

// policy 同 internal/api 的 agentPolicy：连接器工具只算挂着的、没暂停没断开、定义还在的实例，
// 实际档位 = min(Agent 授权, 实例上的授权)。
func (s *Service) policy(ctx context.Context, a *domain.Agent) (*Policy, error) {
	grants, err := s.Store.AgentGrants(ctx, a.ID)
	if err != nil {
		return nil, err
	}
	p := &Policy{Grants: grants}
	if s.Connectors == nil {
		return p, nil
	}
	for _, id := range a.MCPs {
		c, err := s.Connectors.Get(ctx, id)
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
			key := store.ConnGrantPrefix + c.ID + ":" + t.Name
			g := grants[key]
			if g == "" {
				g = store.GrantOff
			}
			mode := MinMode(g, string(t.Mode))
			if !t.Write && mode == store.GrantConfirm {
				mode = store.GrantAuto
			}
			cid, tool, conns := c.ID, t.Name, s.Connectors
			p.Conn = append(p.Conn, ConnTool{
				Name: ConnToolName(c.Tool, t.Name), Key: key, ConnectorID: c.ID, ConnectorName: c.Name,
				Tool: t.Name, Desc: t.Desc, Write: t.Write, Mode: mode,
				Call: func(ctx context.Context, args string) (string, error) {
					out, err := conns.CallTool(ctx, cid, tool, json.RawMessage(args))
					if err != nil {
						return "", errors.New(strings.TrimPrefix(err.Error(), domain.ErrConflict.Error()+": "))
					}
					return out, nil
				},
			})
		}
	}
	return p, nil
}

// skills 是 Agent 挂的技能，按挂载顺序，取不到的跳过；口径同 internal/api 的 agentSkills。
func (s *Service) skills(ctx context.Context, a *domain.Agent) []store.Skill {
	var out []store.Skill
	for _, id := range a.Skills {
		if k, ok := BuiltinSkill(id); ok {
			out = append(out, k)
			continue
		}
		found := false
		if s.PluginSkills != nil {
			for _, k := range s.PluginSkills() {
				if k.ID == id {
					out, found = append(out, k), true
					break
				}
			}
		}
		if found {
			continue
		}
		if k, err := s.Store.GetSkill(ctx, id); err == nil {
			out = append(out, *k)
		}
	}
	return out
}

// RunAgent 新建一个挂这个 Agent 的会话，按它的授权跑一轮。遇到要确认的工具，这一轮停下，
// 回 Waiting；人在会话里确认后对话接口接着跑，之后用 AgentState 看最新回复。
func (s *Service) RunAgent(ctx context.Context, req AgentRunRequest) (AgentRunResult, error) {
	a, err := s.findAgent(ctx, req.Agent)
	if err != nil {
		return AgentRunResult{}, err
	}
	c, model, err := s.client(ctx, a.ProviderID, a.Model)
	if err != nil {
		return AgentRunResult{}, err
	}
	p, err := s.provider(ctx, a.ProviderID)
	if err != nil {
		return AgentRunResult{}, err
	}
	policy, err := s.policy(ctx, a)
	if err != nil {
		return AgentRunResult{}, err
	}
	title := strings.TrimSpace(req.Title)
	if title == "" {
		title = titleOf(req.Prompt)
	}
	sess, err := s.Store.CreateAgentSession(ctx, &domain.AgentSession{
		Title: title, ProviderID: p.ID, Model: model, AgentID: &a.ID,
	})
	if err != nil {
		return AgentRunResult{}, err
	}
	out := AgentRunResult{AgentID: a.ID, AgentName: a.Name, SessionID: sess.ID}
	r := &Runner{Store: s.Store, Chat: c, Model: model, Session: sess, Agent: a, Skills: s.skills(ctx, a), Policy: policy}
	var pending []string
	msgID, err := r.Run(ctx, req.Prompt, func(ev StreamEvent) {
		if ev.Type == "confirm" {
			pending = append(pending, ev.Summary)
			out.CallIDs = append(out.CallIDs, ev.ID)
		}
	})
	if err != nil {
		return out, err
	}
	out.MessageID = msgID
	if m, err := s.lastReply(ctx, sess.ID); err == nil && m != nil {
		out.Reply = m.Content
	}
	if len(pending) > 0 {
		out.Waiting, out.Pending = true, strings.Join(pending, "；")
	}
	return out, nil
}

// AgentState 看会话里最新一条 Agent 回复；回复里还有确认卡片时 Waiting 为真。
func (s *Service) AgentState(ctx context.Context, sessionID string) (AgentRunResult, error) {
	sess, err := s.Store.GetAgentSession(ctx, sessionID)
	if err != nil {
		return AgentRunResult{}, err
	}
	out := AgentRunResult{SessionID: sess.ID}
	if sess.AgentID != nil {
		out.AgentID = *sess.AgentID
	}
	m, err := s.lastReply(ctx, sess.ID)
	if err != nil || m == nil {
		return out, err
	}
	out.MessageID, out.Reply = m.ID, m.Content
	out.Waiting = strings.Contains(m.Content, confirmMark)
	return out, nil
}

func (s *Service) lastReply(ctx context.Context, sessionID string) (*domain.AgentMessage, error) {
	msgs, err := s.Store.ListAgentMessages(ctx, sessionID, historyLimit)
	if err != nil {
		return nil, err
	}
	for i := len(msgs) - 1; i >= 0; i-- {
		if msgs[i].Role == domain.RoleAssistant {
			return msgs[i], nil
		}
	}
	return nil, nil
}

// SearchKB 只在给的这些知识库里检索，回前 top 段；不给知识库直接报错，不搜全部。
func (s *Service) SearchKB(ctx context.Context, kbIDs []string, query string, top int) ([]KBHit, error) {
	if len(kbIDs) == 0 {
		return nil, fmt.Errorf("没有指定知识库")
	}
	if strings.TrimSpace(query) == "" {
		return nil, fmt.Errorf("检索问题是空的")
	}
	_, hits, err := kb.Search(ctx, s.Store, kbIDs, query, top)
	return hits, err
}

// titleOf 用提示词的第一行当会话标题。
func titleOf(prompt string) string {
	t := strings.TrimSpace(prompt)
	if i := strings.IndexAny(t, "\n\r"); i >= 0 {
		t = t[:i]
	}
	if r := []rune(t); len(r) > 24 {
		return string(r[:24]) + "…"
	}
	if t == "" {
		return "新对话"
	}
	return t
}
