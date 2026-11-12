// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package schedule

import (
	"context"
	"slices"
	"strings"
)

// 随流程管理的定时任务（TSK-0463）：SOP 流程的触发方式选「定时」时，规则存在一条动作 sop、action.managed 为真的定时任务里，
// 一个流程最多一条。流程编辑经插件句柄（Core.SOP() 的 SaveFlowSchedule 等）建、改、删它；定时任务页看到、改到的是同一条，
// 只是动作改不了（Update 里拦）。删流程时它跟着删，不像用户手建的那样拦下删除。
// 用户在定时任务页手建、指向同一个流程的条目 managed 为假，和它互不影响。

// FlowScheduleInput 是保存随流程管理的定时任务：Name 是流程名；Rule 为 nil 时不改规则，还没有这一条时也不新建；
// Enabled 为 nil 时不改，新建时为启用。
// Adopt 为真时，还没有这一条、而用户手建了一条规则等价的指向这个流程的定时任务，就认领那一条（标成随流程管理，启停、名字照旧），
// 不另建，免得同一时刻执行两次；旧触发方式 daily、weekly 迁移时用。
type FlowScheduleInput struct {
	Name    string
	Rule    *Rule
	Enabled *bool
	Adopt   bool
}

// FlowScheduleResult 是保存的结果：Schedule 为 nil 表示没有这一条（没给规则）；Adopted 是认领了用户手建的那一条。
type FlowScheduleResult struct {
	Schedule *Schedule
	Created  bool
	Adopted  bool
}

// FlowSchedule 是随这个流程管理的定时任务，没有回 nil。
func (s *Store) FlowSchedule(ctx context.Context, flowID string) (*Schedule, error) {
	all, err := s.FlowSchedules(ctx)
	if err != nil {
		return nil, err
	}
	if sc, ok := all[flowID]; ok {
		return &sc, nil
	}
	return nil, nil
}

// FlowSchedules 是全部随流程管理的定时任务，按流程 id；万一一个流程有多条，取最早建的那条。
func (s *Store) FlowSchedules(ctx context.Context) (map[string]Schedule, error) {
	all, err := s.List(ctx)
	if err != nil {
		return nil, err
	}
	out := map[string]Schedule{}
	for _, sc := range all {
		if !managedSOP(sc.Action) {
			continue
		}
		if cur, ok := out[sc.Action.SOPID]; ok && !sc.CreatedAt.Before(cur.CreatedAt) {
			continue
		}
		out[sc.Action.SOPID] = sc
	}
	return out, nil
}

func managedSOP(a Action) bool { return a.Kind == ActionSOP && a.Managed }

// SaveFlowSchedule 新建或修改随这个流程管理的定时任务。规则不对回 ErrValidation。
func (s *Store) SaveFlowSchedule(ctx context.Context, flowID string, in FlowScheduleInput) (*FlowScheduleResult, error) {
	s.flowMu.Lock()
	defer s.flowMu.Unlock()
	cur, err := s.FlowSchedule(ctx, flowID)
	if err != nil {
		return nil, err
	}
	if cur != nil {
		p := Patch{Rule: in.Rule, Enabled: in.Enabled}
		if in.Name != "" && in.Name != cur.Name {
			p.Name = &in.Name
		}
		if p.Rule == nil && p.Enabled == nil && p.Name == nil {
			return &FlowScheduleResult{Schedule: cur}, nil
		}
		sc, err := s.Update(ctx, cur.ID, p)
		if err != nil {
			return nil, err
		}
		return &FlowScheduleResult{Schedule: sc}, nil
	}
	if in.Rule == nil {
		return &FlowScheduleResult{}, nil
	}
	rule, err := s.CheckRule(*in.Rule)
	if err != nil {
		return nil, err
	}
	if in.Adopt {
		mine, err := s.equivalentSOPSchedule(ctx, flowID, rule)
		if err != nil {
			return nil, err
		}
		if mine != nil {
			sc, err := s.markManaged(ctx, mine)
			if err != nil {
				return nil, err
			}
			return &FlowScheduleResult{Schedule: sc, Adopted: true}, nil
		}
	}
	sc, err := s.create(ctx, Input{Name: in.Name, Enabled: in.Enabled, Rule: rule, Action: Action{Kind: ActionSOP, SOPID: flowID, Managed: true}})
	if err != nil {
		return nil, err
	}
	return &FlowScheduleResult{Schedule: sc, Created: true}, nil
}

// DeleteFlowSchedule 删掉随这个流程管理的定时任务（有多条的全删），回删了几条。
func (s *Store) DeleteFlowSchedule(ctx context.Context, flowID string) (int, error) {
	s.flowMu.Lock()
	defer s.flowMu.Unlock()
	all, err := s.List(ctx)
	if err != nil {
		return 0, err
	}
	n := 0
	for _, sc := range all {
		if managedSOP(sc.Action) && sc.Action.SOPID == flowID {
			if err := s.Delete(ctx, sc.ID); err != nil {
				return n, err
			}
			n++
		}
	}
	return n, nil
}

// equivalentSOPSchedule 是用户手建的、指向这个流程、规则和 r 等价的定时任务，最早建的那条；没有回 nil。
func (s *Store) equivalentSOPSchedule(ctx context.Context, flowID string, r Rule) (*Schedule, error) {
	all, err := s.List(ctx)
	if err != nil {
		return nil, err
	}
	var out *Schedule
	for i := range all {
		sc := &all[i]
		if sc.Action.Kind != ActionSOP || sc.Action.Managed || sc.Action.SOPID != flowID || !SameRule(sc.Rule, r) {
			continue
		}
		if out == nil || sc.CreatedAt.Before(out.CreatedAt) {
			out = sc
		}
	}
	return out, nil
}

// markManaged 把一条用户手建的 sop 定时任务标成随流程管理，规则、名字、启停不动。
func (s *Store) markManaged(ctx context.Context, sc *Schedule) (*Schedule, error) {
	a := sc.Action
	a.Managed = true
	_, actionJSON, err := encode(sc.Rule, a)
	if err != nil {
		return nil, err
	}
	if _, err := s.db.W.ExecContext(ctx, `UPDATE schedules SET action = ?, updated_at = ? WHERE id = ?`,
		actionJSON, ts(s.now()), sc.ID); err != nil {
		return nil, err
	}
	return s.Get(ctx, sc.ID)
}

// SameRule 说两条规则是不是同一个时间表：只比这个频率用到的字段（同前端 ruleKey）；cron 比去掉多余空白后的原文。
func SameRule(a, b Rule) bool {
	a, b = a.Normalize(), b.Normalize()
	if a.Freq != b.Freq {
		return false
	}
	switch a.Freq {
	case FreqOnce:
		return a.Date == b.Date && a.Time == b.Time
	case FreqWeekly:
		return a.Time == b.Time && slices.Equal(a.Weekdays, b.Weekdays)
	case FreqMonthly:
		return a.Time == b.Time && a.Day == b.Day
	case FreqCron:
		return slices.Equal(strings.Fields(a.Cron), strings.Fields(b.Cron))
	}
	return a.Time == b.Time
}
