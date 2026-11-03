package plugin

import (
	"context"
	"fmt"
	"runtime/debug"
	"slices"
	"strings"

	"github.com/lizhao903/pm-workspace/internal/schedule"
)

// 定时任务动作扩展点（VID-06a），见 docs/plugin-api.md 2.12。
// 插件用 Registrar.ScheduleAction 登记一种动作，kind 在清单 provides.schedule_actions 里、以 <插件 id>_ 开头。
// 定时任务保存时经 Registry.ValidateScheduleAction 交给插件校验，到点经 Registry.RunScheduleAction 交给插件执行；
// 插件停用时校验和执行都回 ErrScheduleActionUnavailable，定时任务的定义不动，执行记录记失败。
// 请求和结果的类型定义在 internal/schedule，这里起别名。

type (
	// ScheduleActionInput 是到点的一次执行：定时任务、执行记录 id、计划时刻、是否手动、参数。
	ScheduleActionInput = schedule.PluginActionRequest
	// ScheduleActionResult 是执行结果：给人看的文字，和可选的产出对象。
	ScheduleActionResult = schedule.PluginActionResult
)

var (
	// ErrScheduleActionUnknown：没有插件在清单里声明这个动作。
	ErrScheduleActionUnknown = schedule.ErrActionUnknown
	// ErrScheduleActionUnavailable：声明它的插件没在跑。
	ErrScheduleActionUnavailable = schedule.ErrActionUnavailable
)

// ScheduleActionDef 是插件登记的一种定时任务动作。c 是提供动作的插件自己的 Core。
type ScheduleActionDef struct {
	Kind string // = 清单 provides.schedule_actions 里的一项，以 <插件 id>_ 开头
	// Validate 在新建、修改定时任务时校验参数（params 不含 kind），返回要存的参数；错误文字给人看，回 400。
	// 为 nil 时参数原样存。
	Validate func(ctx context.Context, c Core, params map[string]any) (map[string]any, error)
	// Run 到点执行一次，按 in.RunID 去重；返回错误记失败，文字写进执行记录。
	Run func(ctx context.Context, c Core, in ScheduleActionInput) (*ScheduleActionResult, error)
}

func (c *collector) ScheduleAction(d ScheduleActionDef) {
	id := c.e.m.ID
	switch {
	case !slices.Contains(c.e.m.Provides.ScheduleActions, d.Kind):
		c.add("定时任务动作不在清单 provides.schedule_actions 里：%s", d.Kind)
	case !strings.HasPrefix(d.Kind, id+"_"):
		c.add("定时任务动作 %s 必须以 %s_ 开头", d.Kind, id)
	case d.Run == nil:
		c.add("定时任务动作 %s 没有 Run", d.Kind)
	case slices.ContainsFunc(c.a.scheduleActions, func(o ScheduleActionDef) bool { return o.Kind == d.Kind }):
		c.add("定时任务动作重复：%s", d.Kind)
	default:
		c.a.scheduleActions = append(c.a.scheduleActions, d)
	}
}

// scheduleAction 找声明了 kind 的插件和它登记的动作；没人声明回 ErrScheduleActionUnknown，没在跑回 ErrScheduleActionUnavailable。
func (r *Registry) scheduleAction(kind string) (*entry, ScheduleActionDef, error) {
	for _, id := range r.order {
		e := r.entries[id]
		if !slices.Contains(e.m.Provides.ScheduleActions, kind) {
			continue
		}
		if a := e.active.Load(); a != nil {
			if i := slices.IndexFunc(a.scheduleActions, func(d ScheduleActionDef) bool { return d.Kind == kind }); i >= 0 {
				return e, a.scheduleActions[i], nil
			}
		}
		return e, ScheduleActionDef{}, fmt.Errorf("%w：%s（%s）", ErrScheduleActionUnavailable, e.m.Name, id)
	}
	return nil, ScheduleActionDef{}, fmt.Errorf("%w：%s", ErrScheduleActionUnknown, kind)
}

// ValidateScheduleAction 交给提供动作的插件校验参数，panic 转成错误。满足 schedule.PluginActions。
func (r *Registry) ValidateScheduleAction(ctx context.Context, kind string, params map[string]any) (out map[string]any, err error) {
	e, d, err := r.scheduleAction(kind)
	if err != nil {
		return nil, err
	}
	if d.Validate == nil {
		return params, nil
	}
	defer func() {
		if v := recover(); v != nil {
			e.core.log.Error("plugin schedule action validate panic", "kind", kind, "panic", v, "stack", string(debug.Stack()))
			out, err = nil, fmt.Errorf("校验动作 %s 出错", kind)
		}
	}()
	return d.Validate(ctx, e.core, params)
}

// RunScheduleAction 交给提供动作的插件执行一次，panic 转成错误。满足 schedule.PluginActions。
func (r *Registry) RunScheduleAction(ctx context.Context, q ScheduleActionInput) (out *ScheduleActionResult, err error) {
	e, d, err := r.scheduleAction(q.Kind)
	if err != nil {
		return nil, err
	}
	defer func() {
		if v := recover(); v != nil {
			e.core.log.Error("plugin schedule action panic", "kind", q.Kind, "panic", v, "stack", string(debug.Stack()))
			out, err = nil, fmt.Errorf("动作 %s 执行出错", q.Kind)
		}
	}()
	return d.Run(ctx, e.core, q)
}
