package store

import (
	"context"
	"time"
)

// Agent 执行记录（AG-01b4，0036），对应原型 web-next/src/agentdata.ts 的 AgentRun。

// 执行记录的状态。running 原型没有：后端异步执行，跑完才知道结果。
const (
	AgentRunRunning  = "running"
	AgentRunDone     = "done"
	AgentRunWaiting  = "waiting"
	AgentRunRejected = "rejected"
	AgentRunFailed   = "failed"
)

// DefaultAgentRunLimit 是执行记录列表不指定条数时的一页长度，同原型「先显示 50 条」。
const DefaultAgentRunLimit = 50

// AgentRun 是一次被触发的执行。SessionID 为 nil 是还没建出会话就失败了。
type AgentRun struct {
	ID          string     `json:"id"`
	AgentID     string     `json:"agent_id"`
	TriggerKind string     `json:"trigger_kind"`
	Trigger     string     `json:"trigger"`
	SourceID    string     `json:"source_id"`
	EventKey    string     `json:"event_key"`
	SessionID   *string    `json:"session_id"`
	Status      string     `json:"status"`
	Summary     string     `json:"summary"`
	StartedAt   time.Time  `json:"started_at"`
	FinishedAt  *time.Time `json:"finished_at"`
	// Pending 是还在等确认的调用数，查询时填
	Pending int `json:"pending"`
}

// AgentRunFilter 是列表条件，零值不过滤。Since、Until 按开始时间，两端都含。
type AgentRunFilter struct {
	AgentID  string
	Statuses []string
	Since    *time.Time
	Until    *time.Time
	Limit    int
	Offset   int
}

// AgentRunStore 是执行记录的读写。
type AgentRunStore interface {
	// CreateAgentRun 的 ID、时间由实现填，状态为 running。EventKey 非空且这个 Agent 已有同一个键时不插，回 nil, nil。
	CreateAgentRun(ctx context.Context, r *AgentRun) (*AgentRun, error)
	GetAgentRun(ctx context.Context, id string) (*AgentRun, error)
	// ListAgentRuns 等确认的在前，其余按开始时间倒序；total 不含 Limit、Offset。
	ListAgentRuns(ctx context.Context, f AgentRunFilter) ([]*AgentRun, int, error)
	SetAgentRunSession(ctx context.Context, id, sessionID string) error
	// FinishAgentRun 写状态和总结；running 以外的状态记结束时间。
	FinishAgentRun(ctx context.Context, id, status, summary string) (*AgentRun, error)
	// ListRunToolCalls 是这次执行里要人确认的调用，先记的在前。
	ListRunToolCalls(ctx context.Context, runID string) ([]*AgentToolCall, error)
	// FailInterruptedAgentRuns 把上次退出时还在 running 的记为失败，回条数。
	FailInterruptedAgentRuns(ctx context.Context, summary string) (int, error)
}
