// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package pluginhost

// host.agent.run（docs/plugin-spec-v2.md 7.x）：插件用宿主配好的模型服务商 / Agent 跑一次 LLM。
// 需要清单声明并获授 agent:run（普通权限，安装时确认）。本批只做不带工具的单轮补全：
// preset_id 是 Agent 的 id 或名称（用它的服务商、模型、指令），不给用默认服务商；tools 不支持，给了忽略。
// 2026-11-23 实现：此前规范里有、broker 没有。

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/lizhao903/pm-workspace/internal/agent"
)

// AgentCompleter 是宿主需要的模型能力（*agent.Service 满足）。
type AgentCompleter interface {
	Complete(ctx context.Context, req agent.CompleteRequest) (string, error)
}

type agentBox struct{ a AgentCompleter }

// SetAgent 接上模型服务（Agent 服务在宿主之后才建，晚绑定）。
func (h *Host) SetAgent(a AgentCompleter) {
	h.agent.Store(&agentBox{a})
}

const (
	agentPromptMax      = 64 << 10
	agentDefaultTimeout = 120 * time.Second
	agentMaxTimeout     = 5 * time.Minute
)

func (p *pluginProcess) agentRun(ctx context.Context, params json.RawMessage) (any, error) {
	if rerr := p.requirePermission("agent:run"); rerr != nil {
		return nil, rerr
	}
	var in struct {
		Prompt    string `json:"prompt"`
		System    string `json:"system"`
		PresetID  string `json:"preset_id"`
		TimeoutMS int    `json:"timeout_ms"`
		Thinking  string `json:"thinking"`
	}
	if err := json.Unmarshal(params, &in); err != nil {
		return nil, rpcErrorf("invalid_params", "host.agent.run 参数不合法：%v", err)
	}
	if strings.TrimSpace(in.Prompt) == "" {
		return nil, rpcErrorf("invalid_params", "host.agent.run 需要 prompt")
	}
	if len(in.Prompt)+len(in.System) > agentPromptMax {
		return nil, rpcErrorf("validation", "提示词超过 %d 字节", agentPromptMax)
	}
	var a AgentCompleter
	if p.host != nil {
		if b := p.host.agent.Load(); b != nil {
			a = b.a
		}
	}
	if a == nil {
		return nil, rpcErrorf("unavailable", "宿主没有接模型服务，host.agent.run 不可用")
	}
	timeout := agentDefaultTimeout
	if in.TimeoutMS > 0 {
		timeout = time.Duration(in.TimeoutMS) * time.Millisecond
		if timeout > agentMaxTimeout {
			timeout = agentMaxTimeout
		}
	}
	runCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	out, err := a.Complete(runCtx, agent.CompleteRequest{
		System:   in.System,
		Prompt:   in.Prompt,
		Agent:    strings.TrimSpace(in.PresetID),
		Scenario: agent.ScenarioBackground,
		Thinking: strings.TrimSpace(in.Thinking),
	})
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) {
			return nil, rpcErrorf("unavailable", "模型 %d 秒内没有回复", int(timeout/time.Second))
		}
		return nil, rpcErrorf("unavailable", "模型调用失败：%v", err)
	}
	p.host.log.Info("外部插件调用模型", "plugin", p.id, "agent", in.PresetID, "prompt_bytes", len(in.Prompt), "reply_bytes", len(out))
	runID, _ := randomHex(6)
	return map[string]any{
		"run_id":  "arn_" + runID,
		"status":  "done",
		"summary": firstLine(out, 120),
		"result":  out,
	}, nil
}

func firstLine(s string, max int) string {
	s = strings.TrimSpace(s)
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		s = s[:i]
	}
	if r := []rune(s); len(r) > max {
		return string(r[:max]) + "…"
	}
	return s
}
