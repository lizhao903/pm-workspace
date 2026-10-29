package store

import (
	"context"
	"time"
)

// Agent 工具授权（AG-02a，0035），对应原型 web-next/src/agentdata.ts 的 Agent.abilities 和 ToolCall。
// key 是内置能力（ABILITIES 的 key）或 conn:<连接器 id>:<工具名>；没有记录的 key 就是关闭。

// 授权档位，顺序 关闭 < 需确认 < 自动。
const (
	GrantOff     = "off"
	GrantConfirm = "confirm"
	GrantAuto    = "auto"
)

// 要人确认的调用的状态。
const (
	ToolCallPending   = "pending"
	ToolCallConfirmed = "confirmed"
	ToolCallRejected  = "rejected"
)

// ConnGrantPrefix 是连接器工具授权 key 的前缀：conn:<连接器 id>:<工具名>。
const ConnGrantPrefix = "conn:"

// AgentToolCall 是一次要人确认的调用。SessionID、RunID 二选一，执行记录归 AG-01b4。
type AgentToolCall struct {
	ID        string     `json:"id"`
	AgentID   string     `json:"agent_id"`
	SessionID *string    `json:"session_id"`
	RunID     *string    `json:"run_id"`
	CallID    string     `json:"call_id"`
	Tool      string     `json:"tool"`
	GrantKey  string     `json:"grant_key"`
	Args      string     `json:"args"`
	State     string     `json:"state"`
	Result    string     `json:"result"`
	CreatedAt time.Time  `json:"created_at"`
	DecidedAt *time.Time `json:"decided_at"`
}

// ToolGrantStore 是工具授权和要人确认的调用的读写。key 和档位的校验在接口层（要查连接器），这里只管存。
type ToolGrantStore interface {
	// AgentGrants 是这个 Agent 存着的授权 key -> confirm / auto，没有的就是关闭。
	AgentGrants(ctx context.Context, agentID string) (map[string]string, error)
	// SetAgentGrants 整组换掉；档位为 off 的不存。Agent 不存在回 ErrNotFound。
	SetAgentGrants(ctx context.Context, agentID string, grants map[string]string) error
	// DetachConnector 在一个事务里把连接器从所有 Agent 的 mcps 里摘掉、删掉 conn:<id>:* 授权，
	// 回受影响的 Agent id（按 Agent 新建的在前）。
	DetachConnector(ctx context.Context, connectorID string) ([]string, error)

	// CreateAgentToolCall 的 ID、时间、状态由实现填，状态为 pending。
	CreateAgentToolCall(ctx context.Context, c *AgentToolCall) (*AgentToolCall, error)
	GetAgentToolCall(ctx context.Context, id string) (*AgentToolCall, error)
	// DecideAgentToolCall 把 pending 改成 confirmed 或 rejected，只能改一次：已经决定过回 ErrConflict。
	DecideAgentToolCall(ctx context.Context, id, state string) (*AgentToolCall, error)
	// SetAgentToolCallResult 记执行结果。
	SetAgentToolCallResult(ctx context.Context, id, result string) error
	// CountPendingToolCalls 数这个 Agent 还在等确认的调用，删除前的影响检查用。
	CountPendingToolCalls(ctx context.Context, agentID string) (int, error)
}
