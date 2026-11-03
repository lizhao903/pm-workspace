package plugin

import (
	"context"
	"fmt"
	"runtime/debug"
	"slices"

	"github.com/lizhao903/pm-workspace/internal/schedule"
)

// 「发起 SOP」钩子（SOP-01d），见 docs/plugin-api.md 2.7。
// SOP 编排是插件，内核不直接调它：SOP 插件用 Registrar.SOPStarter 登记入口，定时任务的 sop 动作和
// Agent 的 run_sop 工具经 Registry.StartSOP 起执行。没有在跑的插件登记时回 ErrNoSOPStarter。
// 请求和结果的类型定义在 internal/schedule（agent、schedule 都不能 import 本包），这里起别名。

type (
	// SOPStartRequest 是发起一次执行：流程 id（也认流程名）、输入、发起方。
	SOPStartRequest = schedule.SOPRequest
	// SOPStarted 是发起的结果，不等跑完；Status 是发起时的运行状态。
	SOPStarted = schedule.SOPStarted
	// SOPScheduleRef 是动作指向某个流程的定时任务 {ID, Name}。
	SOPScheduleRef = schedule.SOPRef
)

// ErrNoSOPStarter：没有在跑的插件登记发起入口（SOP 编排插件没装或停用）。
var ErrNoSOPStarter = schedule.ErrSOPUnavailable

// SOPModule 是能登记发起入口的功能模块：清单 provides.modules 里要有它。
const SOPModule = "sop"

// SOPStarter 是 SOP 插件登记的发起入口。
type SOPStarter interface {
	StartSOP(ctx context.Context, q SOPStartRequest) (*SOPStarted, error)
}

func (c *collector) SOPStarter(st SOPStarter) {
	switch {
	case !slices.Contains(c.e.m.Provides.Modules, SOPModule):
		c.add("只有 provides.modules 含 %s 的插件能登记发起 SOP 的入口", SOPModule)
	case st == nil:
		c.add("发起 SOP 的入口是 nil")
	case c.a.sopStarter != nil:
		c.add("发起 SOP 的入口重复登记")
	default:
		if other := c.e.core.reg.sopStarterOwner(c.e.m.ID); other != "" {
			c.add("发起 SOP 的入口已由插件 %s 登记，同一时间只能有一个", other)
			return
		}
		c.a.sopStarter = st
	}
}

// sopStarterOwner 是除 except 外已登记发起入口、正在跑的插件 id，没有为空串。
func (r *Registry) sopStarterOwner(except string) string {
	if r == nil {
		return ""
	}
	for _, id := range r.order {
		if id == except {
			continue
		}
		if a := r.entries[id].active.Load(); a != nil && a.sopStarter != nil {
			return id
		}
	}
	return ""
}

// StartSOP 交给登记了发起入口、正在跑的插件起一条执行；没有时回 ErrNoSOPStarter，插件 panic 转成错误。
// 满足 schedule.SOPStarter，cmd/pmw 把注册表接给定时任务和 Agent。
func (r *Registry) StartSOP(ctx context.Context, q SOPStartRequest) (out *SOPStarted, err error) {
	for _, id := range r.order {
		e := r.entries[id]
		a := e.active.Load()
		if a == nil || a.sopStarter == nil {
			continue
		}
		defer func() {
			if v := recover(); v != nil {
				e.core.log.Error("plugin sop starter panic", "panic", v, "stack", string(debug.Stack()))
				out, err = nil, fmt.Errorf("发起 SOP 出错")
			}
		}()
		return a.sopStarter.StartSOP(ctx, q)
	}
	return nil, ErrNoSOPStarter
}

type sopRefsBox struct {
	fn func(ctx context.Context, flowID string) ([]SOPScheduleRef, error)
}

// SetSOPRefs 接上查「指向流程的定时任务」的实现（schedule.Store.SOPRefs），可以在 Start 之后调。
func (r *Registry) SetSOPRefs(fn func(ctx context.Context, flowID string) ([]SOPScheduleRef, error)) {
	r.sopRefs.Store(&sopRefsBox{fn})
}

func (s sopService) Schedules(ctx context.Context, flowID string) ([]SOPScheduleRef, error) {
	if r := s.c.reg; r != nil {
		if b := r.sopRefs.Load(); b != nil && b.fn != nil {
			return b.fn(ctx, flowID)
		}
	}
	return []SOPScheduleRef{}, nil
}
