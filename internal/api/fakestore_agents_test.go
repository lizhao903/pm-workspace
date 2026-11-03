package api

import (
	"context"
	"encoding/json"
	"sort"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/idgen"
)

// Agent 配置的替身只够 handler 跑通；校验和默认值是 sqlite 实现的事，那边的测试管。
// agents 懒初始化，免得改 newFakeStore。

func (f *fakeStore) ListAgents(context.Context) ([]*domain.Agent, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]*domain.Agent, 0, len(f.agents))
	for _, a := range f.agents {
		c := *a
		out = append(out, &c)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt.After(out[j].CreatedAt) })
	return out, nil
}

func (f *fakeStore) GetAgent(_ context.Context, id string) (*domain.Agent, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	a, ok := f.agents[id]
	if !ok {
		return nil, notFoundf("agent not found")
	}
	c := *a
	return &c, nil
}

func (f *fakeStore) CreateAgent(_ context.Context, in domain.AgentInput) (*domain.Agent, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	a := &domain.Agent{ID: idgen.Prefixed("ag"), Enabled: true, Triggers: []domain.AgentTrigger{{Kind: domain.TriggerManual}}}
	applyFakeAgent(a, in)
	if f.agents == nil {
		f.agents = map[string]*domain.Agent{}
	}
	f.agents[a.ID] = a
	c := *a
	return &c, nil
}

func (f *fakeStore) UpdateAgent(_ context.Context, id string, in domain.AgentInput) (*domain.Agent, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	a, ok := f.agents[id]
	if !ok {
		return nil, notFoundf("agent not found")
	}
	applyFakeAgent(a, in)
	c := *a
	return &c, nil
}

func (f *fakeStore) DeleteAgent(_ context.Context, id string) (*domain.Agent, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	a, ok := f.agents[id]
	if !ok {
		return nil, notFoundf("agent not found")
	}
	delete(f.agents, id)
	return a, nil
}

func (f *fakeStore) CountAgentSessions(_ context.Context, agentID string) (int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := 0
	for _, s := range f.sessions {
		if s.AgentID != nil && *s.AgentID == agentID {
			n++
		}
	}
	return n, nil
}

func applyFakeAgent(a *domain.Agent, in domain.AgentInput) {
	set := func(dst *string, v *string) {
		if v != nil {
			*dst = *v
		}
	}
	set(&a.Name, in.Name)
	set(&a.Desc, in.Desc)
	set(&a.Color, in.Color)
	set(&a.ProviderID, in.ProviderID)
	set(&a.Model, in.Model)
	set(&a.Instructions, in.Instructions)
	if in.Thinking != nil {
		a.Thinking = *in.Thinking
	}
	if in.Enabled != nil {
		a.Enabled = *in.Enabled
	}
	if in.Triggers != nil {
		a.Triggers = *in.Triggers
	}
}

func (f *fakeStore) AgentSetting(_ context.Context, key string) (json.RawMessage, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.agentSettings[key], nil
}

func (f *fakeStore) SetAgentSetting(_ context.Context, key string, v json.RawMessage) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.agentSettings == nil {
		f.agentSettings = map[string]json.RawMessage{}
	}
	f.agentSettings[key] = v
	return nil
}
