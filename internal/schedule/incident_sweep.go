// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package schedule

import (
	"context"
	"fmt"
	"strings"
)

// 动作 incident_sweep「运行异常巡检」（INC-01a）：内核动作，不属于插件。
// 到点把满足条件、状态未处理、还没有任务的运行异常各建一条交给 Claude Code 修的任务。
// 运行异常在 internal/incident，它实现 IncidentSweeper，cmd/pmw 接到 Runner.Incidents；
// 请求和结果的类型放在这里，免得 schedule 依赖 incident。

// IncidentSweepRequest 是一次巡检。MinLevel 是 error（只看错误）或 warn（警告和错误都看），MinCount 是次数下限。
type IncidentSweepRequest struct {
	MinLevel     string
	MinCount     int
	ScheduleID   string
	ScheduleName string
	RunID        string
}

// SweptTask 是巡检建出来的一条任务。
type SweptTask struct {
	IncidentID string
	ObjectID   string
	Ref        string
}

// IncidentSweepResult 是巡检结果：Created 建了的，Skipped 是未处理、没任务但级别或次数不够的条数，
// Held 是够格但留给用户自己处理的条数（修复任务被删过、或是 Claude Code 执行失败），Failed 是没建成的原因（给人看）。
type IncidentSweepResult struct {
	Created []SweptTask
	Skipped int
	Held    int
	Failed  []string
}

// IncidentSweeper 执行巡检。
type IncidentSweeper interface {
	SweepIncidents(ctx context.Context, q IncidentSweepRequest) (*IncidentSweepResult, error)
}

// incidentUnavailableText 是没接运行异常时执行记录的文字。
const incidentUnavailableText = "没执行：运行异常模块没接上"

// sweepIncidents 跑一次巡检，结果写进执行记录：建了几条、跳过几条；一条都没建成而有失败的记 failed。
func (r *Runner) sweepIncidents(ctx context.Context, sc *Schedule, run *Run) runResult {
	got, err := r.Incidents.SweepIncidents(ctx, IncidentSweepRequest{
		MinLevel: sc.Action.MinLevel, MinCount: sc.Action.MinCount, ScheduleID: sc.ID, ScheduleName: sc.Name, RunID: run.ID,
	})
	if err != nil {
		return runResult{status: RunFailed, text: "没执行：" + err.Error()}
	}
	return sweepResult(got)
}

func sweepResult(got *IncidentSweepResult) runResult {
	if got == nil {
		got = &IncidentSweepResult{}
	}
	var parts []string
	res := runResult{status: RunOK}
	if n := len(got.Created); n > 0 {
		refs := make([]string, 0, n)
		for _, t := range got.Created {
			refs = append(refs, t.Ref)
		}
		parts = append(parts, fmt.Sprintf("建了 %d 条修复任务 %s", n, strings.Join(refs, "、")))
		res.objectID, res.ref = got.Created[0].ObjectID, got.Created[0].Ref
	} else if len(got.Failed) == 0 {
		parts = append(parts, "没有要处理的运行异常")
	}
	if got.Held > 0 {
		parts = append(parts, fmt.Sprintf("%d 条留给你处理（修复任务被删过，或是 Claude Code 执行失败）", got.Held))
	}
	if got.Skipped > 0 {
		parts = append(parts, fmt.Sprintf("跳过 %d 条（级别或次数不够）", got.Skipped))
	}
	if n := len(got.Failed); n > 0 {
		parts = append(parts, fmt.Sprintf("%d 条没建成：%s", n, strings.Join(got.Failed, "；")))
		if len(got.Created) == 0 {
			res.status = RunFailed
		}
	}
	res.text = strings.Join(parts, "，")
	return res
}
