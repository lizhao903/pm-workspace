package plugin

import (
	"context"
	"errors"

	"github.com/lizhao903/pm-workspace/internal/schedule"
)

// 随流程管理的定时任务（TSK-0463），见 docs/plugin-api.md 2.7。
// SOP 流程的触发方式选「定时」时，规则存在一条动作 sop、action.managed 为真的内核定时任务里，一个流程最多一条；
// 内核只转交给定时任务的 Store（schedule/flowsched.go），SOP 插件经 Core.SOP() 读写。别的插件只能读。

type (
	// SOPFlowSchedule 是随流程管理的那条定时任务，形状同 /api/schedules 的一项。
	SOPFlowSchedule = schedule.Schedule
	// SOPFlowScheduleInput 是保存它：名字（流程名）、规则、启停、是否认领用户手建的等价条目。
	SOPFlowScheduleInput = schedule.FlowScheduleInput
	// SOPFlowScheduleResult 是保存的结果。
	SOPFlowScheduleResult = schedule.FlowScheduleResult
	// SOPScheduleRule 是定时规则，同 /api/schedules 的 rule。
	SOPScheduleRule = schedule.Rule
)

// ErrNoSOPSchedules：内核没接定时任务（测试、精简的内核）。
var ErrNoSOPSchedules = errors.New("定时任务没有启用")

// ErrSOPScheduleForbidden：不是 SOP 插件，不能改随流程管理的定时任务。
var ErrSOPScheduleForbidden = errors.New("只有 SOP 编排插件能改随流程管理的定时任务")

// SOPSchedules 是随流程管理的定时任务的实现，*schedule.Store 满足它。
type SOPSchedules interface {
	FlowSchedule(ctx context.Context, flowID string) (*schedule.Schedule, error)
	FlowSchedules(ctx context.Context) (map[string]schedule.Schedule, error)
	SaveFlowSchedule(ctx context.Context, flowID string, in schedule.FlowScheduleInput) (*schedule.FlowScheduleResult, error)
	DeleteFlowSchedule(ctx context.Context, flowID string) (int, error)
	CheckRule(r schedule.Rule) (schedule.Rule, error)
}

type sopSchedulesBox struct{ s SOPSchedules }

// SetSOPSchedules 接上随流程管理的定时任务（schedule.Store），可以在 Start 之后调。
func (r *Registry) SetSOPSchedules(s SOPSchedules) { r.sopSchedules.Store(&sopSchedulesBox{s}) }

func (s sopService) schedules() (SOPSchedules, error) {
	if r := s.c.reg; r != nil {
		if b := r.sopSchedules.Load(); b != nil && b.s != nil {
			return b.s, nil
		}
	}
	return nil, ErrNoSOPSchedules
}

func (s sopService) writable() (SOPSchedules, error) {
	if s.c.id != SOPPluginID {
		return nil, ErrSOPScheduleForbidden
	}
	return s.schedules()
}

func (s sopService) FlowSchedule(ctx context.Context, flowID string) (*SOPFlowSchedule, error) {
	b, err := s.schedules()
	if err != nil {
		return nil, err
	}
	return b.FlowSchedule(ctx, flowID)
}

func (s sopService) FlowSchedules(ctx context.Context) (map[string]SOPFlowSchedule, error) {
	b, err := s.schedules()
	if err != nil {
		return nil, err
	}
	return b.FlowSchedules(ctx)
}

func (s sopService) SaveFlowSchedule(ctx context.Context, flowID string, in SOPFlowScheduleInput) (*SOPFlowScheduleResult, error) {
	b, err := s.writable()
	if err != nil {
		return nil, err
	}
	return b.SaveFlowSchedule(ctx, flowID, in)
}

func (s sopService) DeleteFlowSchedule(ctx context.Context, flowID string) (int, error) {
	b, err := s.writable()
	if err != nil {
		return 0, err
	}
	return b.DeleteFlowSchedule(ctx, flowID)
}

func (s sopService) CheckScheduleRule(r SOPScheduleRule) (SOPScheduleRule, error) {
	b, err := s.schedules()
	if err != nil {
		return r, err
	}
	return b.CheckRule(r)
}
