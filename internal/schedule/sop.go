// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package schedule

import (
	"context"
	"errors"
	"fmt"
)

// 动作 sop（SOP-01d）：SOP 编排是插件，内核不直接调它，经插件注册表的「发起 SOP」钩子起执行。
// Agent 的 run_sop 工具也走同一个钩子，所以请求和结果的类型放在这里，internal/plugin 起别名。

// ErrSOPUnavailable：SOP 编排插件没启用（没装、停用，或没登记发起入口）。
var ErrSOPUnavailable = errors.New("SOP 编排插件没启用")

// sopUnavailableText 是 SOP 插件没启用时执行记录的文字。
const sopUnavailableText = "没执行：SOP 编排插件没启用"

// SOPRequest 是发起一次 SOP 执行。Input 没给的字段取流程的默认值，必填的空着回错误；不逐步确认。
type SOPRequest struct {
	FlowID     string // 流程 id，也认流程名
	Input      map[string]any
	Source     string // 谁发起的：schedule / agent
	SourceID   string // 定时任务 id、Agent id
	SourceName string
	// ObjectID 是这次执行关联的工作对象（SOP-06）：Agent 在挂着任务的会话里发起时是那条任务，没有为空。
	ObjectID string
}

// SOPStarted 是发起的结果，不等它跑完。Status 是发起时的运行状态，人工检查点等人时是 waiting。
type SOPStarted struct {
	RunID    string
	FlowID   string
	FlowName string
	Status   string
}

// SOPStarter 发起一次 SOP 执行。插件没启用回 ErrSOPUnavailable，其余错误的文字给人看。
type SOPStarter interface {
	StartSOP(ctx context.Context, q SOPRequest) (*SOPStarted, error)
}

// SOPRef 是动作指向某个 SOP 流程的定时任务，删流程前列出来。
// Managed 是随流程管理的那一条（TSK-0463）：删流程时跟着删，不拦。
type SOPRef struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Managed bool   `json:"managed"`
}

// SOPRefs 是动作 sop 指向这个流程的定时任务，按新建时间倒序；停用的也算。
func (s *Store) SOPRefs(ctx context.Context, flowID string) ([]SOPRef, error) {
	rows, err := s.db.R.QueryContext(ctx,
		`SELECT `+cols+` FROM schedules ORDER BY created_at DESC, rowid DESC`)
	if err != nil {
		return nil, fmt.Errorf("list schedules: %w", err)
	}
	defer func() { _ = rows.Close() }()
	out := []SOPRef{}
	for rows.Next() {
		sc, err := scan(rows)
		if err != nil {
			return nil, err
		}
		if sc.Action.Kind == ActionSOP && sc.Action.SOPID == flowID {
			out = append(out, SOPRef{ID: sc.ID, Name: sc.Name, Managed: sc.Action.Managed})
		}
	}
	return out, rows.Err()
}

// startSOP 发起 SOP 执行，不等它跑完；结果文字写运行 id。
func (r *Runner) startSOP(ctx context.Context, sc *Schedule) runResult {
	got, err := r.SOPs.StartSOP(ctx, SOPRequest{
		FlowID: sc.Action.SOPID, Input: map[string]any{}, Source: "schedule", SourceID: sc.ID, SourceName: sc.Name,
	})
	switch {
	case errors.Is(err, ErrSOPUnavailable):
		return runResult{status: RunUnsupported, text: sopUnavailableText}
	case err != nil:
		return runResult{status: RunFailed, text: "没执行：" + err.Error()}
	}
	return runResult{status: RunOK, text: fmt.Sprintf("发起了 SOP「%s」，执行记录 %s", got.FlowName, got.RunID)}
}
