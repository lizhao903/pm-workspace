// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package plugin

import (
	"context"
	"errors"

	"github.com/lizhao903/pm-workspace/internal/agent"
	"github.com/lizhao903/pm-workspace/internal/domain"
)

// 模型、Agent、知识库句柄（SOP-01c），见 docs/plugin-api.md 2.0。
// 实现是 internal/agent 的 Service，cmd/pmw 用 SetAgent 接上；没接上时每个方法回 ErrNoAgent。

type (
	// CompleteRequest 是一次不带工具的补全，Provider 为空用默认服务商，Model 为空用服务商设置的模型；
	// Agent 给了就用这个 Agent 的服务商、模型、思考档位和指令，Provider / Model 忽略。
	CompleteRequest = agent.CompleteRequest
	// AgentRunRequest 让一个 Agent（id 或名称）在新会话里跑一轮。
	AgentRunRequest = agent.AgentRunRequest
	// AgentRunResult 是会话最新一条回复，Waiting 为真表示停在要人确认的调用上。
	AgentRunResult = agent.AgentRunResult
	// KBHit 是知识库检索命中的一段。
	KBHit = agent.KBHit
)

// 场景默认 Agent（CompleteRequest.Scenario）：没指定 Agent 和服务商时按场景找设置里选的 Agent，没选用默认服务商。
const (
	ScenarioSOPAssist  = agent.ScenarioSOPAssist
	ScenarioBackground = agent.ScenarioBackground
	// ThinkingOff 让补全明确不思考；结构化输出（如纪要 JSON）用它省时间。
	ThinkingOff = domain.ThinkingOff
)

// AgentService 是插件用模型和 Agent 的入口。
type AgentService interface {
	// Complete 用默认服务商补全一段提示词，回模型说的原文。
	Complete(ctx context.Context, req CompleteRequest) (string, error)
	// RunAgent 新建挂这个 Agent 的会话，按它的授权跑一轮；遇到要确认的工具不执行，回 Waiting。
	RunAgent(ctx context.Context, req AgentRunRequest) (AgentRunResult, error)
	// AgentState 看会话里最新一条回复，人在会话里确认后据此知道这一轮接着跑完了没有。
	AgentState(ctx context.Context, sessionID string) (AgentRunResult, error)
	// SearchKB 只在给的知识库里检索，回前 top 段。
	SearchKB(ctx context.Context, kbIDs []string, query string, top int) ([]KBHit, error)
}

// ErrNoAgent：注册表没接上模型和 Agent 的实现（测试里没接时）。
var ErrNoAgent = errors.New("模型和 Agent 还没接上")

type agentBox struct{ s AgentService }

// SetAgent 接上模型和 Agent 的实现，可以在 Start 之后调（用时现取）。
func (r *Registry) SetAgent(s AgentService) { r.agent.Store(&agentBox{s}) }

func (c *core) Agent() AgentService {
	if c.reg != nil {
		if b := c.reg.agent.Load(); b != nil && b.s != nil {
			return b.s
		}
	}
	return noAgent{}
}

type noAgent struct{}

func (noAgent) Complete(context.Context, CompleteRequest) (string, error) { return "", ErrNoAgent }
func (noAgent) RunAgent(context.Context, AgentRunRequest) (AgentRunResult, error) {
	return AgentRunResult{}, ErrNoAgent
}
func (noAgent) AgentState(context.Context, string) (AgentRunResult, error) {
	return AgentRunResult{}, ErrNoAgent
}
func (noAgent) SearchKB(context.Context, []string, string, int) ([]KBHit, error) {
	return nil, ErrNoAgent
}
