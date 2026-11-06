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

// --- 流程目录（TSK-0480）：Agent 的 list_sops / get_sop / create_sop / update_sop 经注册表交给 SOP 插件 ---

type (
	// SOPCatalog 是发起入口可选实现的流程目录，见 schedule.SOPCatalog。
	SOPCatalog = schedule.SOPCatalog
	// SOPFlowBrief 是目录里的一项。
	SOPFlowBrief = schedule.SOPFlowBrief
	// SOPFlowDoc 是一条流程的完整定义。
	SOPFlowDoc = schedule.SOPFlowDoc
	// SOPNodeKind 是建流程能用的一种节点。
	SOPNodeKind = schedule.SOPNodeKind
	// SOPSave 是新建或修改一条流程。
	SOPSave = schedule.SOPSave
	// SOPFolders 是流程库的文件夹和未分类的流程数（TSK-0482）。
	SOPFolders = schedule.SOPFolders
	// SOPFolderBrief 是一个文件夹。
	SOPFolderBrief = schedule.SOPFolderBrief
)

// ErrSOPNotFound：流程目录里找不到这条流程（errors.Is 判断）。
var ErrSOPNotFound = schedule.ErrSOPNotFound

// sopCatalog 是在跑的、登记了发起入口且实现了 SOPCatalog 的那个；没有回 ErrNoSOPStarter。
func (r *Registry) sopCatalog() (SOPCatalog, *entry, error) {
	if r == nil {
		return nil, nil, ErrNoSOPStarter
	}
	for _, id := range r.order {
		e := r.entries[id]
		a := e.active.Load()
		if a == nil || a.sopStarter == nil {
			continue
		}
		if c, ok := a.sopStarter.(SOPCatalog); ok {
			return c, e, nil
		}
		return nil, nil, ErrNoSOPStarter
	}
	return nil, nil, ErrNoSOPStarter
}

// catalogCall 调一次流程目录，插件 panic 转成错误。
func catalogCall[T any](r *Registry, fn func(c SOPCatalog) (T, error)) (out T, err error) {
	c, e, err := r.sopCatalog()
	if err != nil {
		return out, err
	}
	defer func() {
		if v := recover(); v != nil {
			e.core.log.Error("plugin sop catalog panic", "panic", v, "stack", string(debug.Stack()))
			err = fmt.Errorf("读写 SOP 流程出错")
		}
	}()
	return fn(c)
}

// ListSOPs 列全部流程，按新建时间。满足 schedule.SOPCatalog。
func (r *Registry) ListSOPs(ctx context.Context) ([]SOPFlowBrief, error) {
	return catalogCall(r, func(c SOPCatalog) ([]SOPFlowBrief, error) { return c.ListSOPs(ctx) })
}

// GetSOP 按 id 或名称取一条流程。
func (r *Registry) GetSOP(ctx context.Context, ref string) (*SOPFlowDoc, error) {
	return catalogCall(r, func(c SOPCatalog) (*SOPFlowDoc, error) { return c.GetSOP(ctx, ref) })
}

// SaveSOP 新建或修改一条流程。
func (r *Registry) SaveSOP(ctx context.Context, q SOPSave) (*SOPFlowDoc, error) {
	return catalogCall(r, func(c SOPCatalog) (*SOPFlowDoc, error) { return c.SaveSOP(ctx, q) })
}

// SOPNodeKinds 是建流程能用的节点。
func (r *Registry) SOPNodeKinds(ctx context.Context) ([]SOPNodeKind, error) {
	return catalogCall(r, func(c SOPCatalog) ([]SOPNodeKind, error) { return c.SOPNodeKinds(ctx) })
}

// SOPGuide 是给模型看的编排说明（TSK-0490）。
func (r *Registry) SOPGuide(ctx context.Context) (string, error) {
	return catalogCall(r, func(c SOPCatalog) (string, error) { return c.SOPGuide(ctx) })
}

// ListSOPFolders 列流程库的文件夹和未分类的流程数（TSK-0482）。
func (r *Registry) ListSOPFolders(ctx context.Context) (SOPFolders, error) {
	return catalogCall(r, func(c SOPCatalog) (SOPFolders, error) { return c.ListSOPFolders(ctx) })
}

// --- 调试（TSK-0491）：Agent 的 test_sop、explain_im_trigger 经注册表交给 SOP 插件 ---

type (
	// SOPTest 是一次调试的参数，见 schedule.SOPTest。
	SOPTest = schedule.SOPTest
	// SOPCatalogDebugger 是发起入口可选实现的调试接口，见 schedule.SOPDebugger。
	SOPCatalogDebugger = schedule.SOPDebugger
)

// sopDebugger 是在跑的、登记了发起入口且实现了 SOPDebugger 的那个；没有回 ErrNoSOPStarter。
func (r *Registry) sopDebugger() (schedule.SOPDebugger, *entry, error) {
	if r == nil {
		return nil, nil, ErrNoSOPStarter
	}
	for _, id := range r.order {
		e := r.entries[id]
		a := e.active.Load()
		if a == nil || a.sopStarter == nil {
			continue
		}
		if d, ok := a.sopStarter.(schedule.SOPDebugger); ok {
			return d, e, nil
		}
		return nil, nil, ErrNoSOPStarter
	}
	return nil, nil, ErrNoSOPStarter
}

func debugCall(r *Registry, fn func(d schedule.SOPDebugger) (string, error)) (out string, err error) {
	d, e, err := r.sopDebugger()
	if err != nil {
		return "", err
	}
	defer func() {
		if v := recover(); v != nil {
			e.core.log.Error("plugin sop debugger panic", "panic", v, "stack", string(debug.Stack()))
			err = fmt.Errorf("调试 SOP 出错")
		}
	}()
	return fn(d)
}

// TestSOP 调试一条流程（不真写）。满足 schedule.SOPDebugger。
func (r *Registry) TestSOP(ctx context.Context, q SOPTest) (string, error) {
	return debugCall(r, func(d schedule.SOPDebugger) (string, error) { return d.TestSOP(ctx, q) })
}

// ExplainIMTrigger 模拟一条消息触发 IM 流程（不真发起）。
func (r *Registry) ExplainIMTrigger(ctx context.Context, messageID string) (string, error) {
	return debugCall(r, func(d schedule.SOPDebugger) (string, error) { return d.ExplainIMTrigger(ctx, messageID) })
}
