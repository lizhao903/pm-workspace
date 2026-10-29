package schedule

import (
	"context"
	"errors"
	"fmt"
	"maps"
	"time"
)

// 插件登记的动作（VID-06a），见 docs/plugin-api.md 2.12。
// kind 以插件 id 开头（如 video_publish），清单 provides.schedule_actions 里登记；内核不认识这些 kind，
// 保存时的校验和到点的执行都交给插件注册表。参数和 kind 平铺在 action 里（同原型 ScheduleAction），原样存。
// 请求和结果的类型放在这里，internal/plugin 起别名（同 SOP）。

// ErrActionUnknown：没有插件在清单里声明这个动作（没装，或者 kind 写错）。
var ErrActionUnknown = errors.New("没有插件提供这个动作")

// ErrActionUnavailable：声明了这个动作的插件没在跑（停用、没启动起来）。
var ErrActionUnavailable = errors.New("提供这个动作的插件没启用")

// PluginActionRequest 是到点交给插件的一次执行。RunID 是这次执行记录的 id，插件按它去重。
type PluginActionRequest struct {
	Kind         string
	ScheduleID   string
	ScheduleName string
	RunID        string
	At           time.Time // 计划时刻，手动执行为点按钮的时刻
	Manual       bool
	Params       map[string]any
}

// PluginActionResult 是执行的结果。Text 写进执行记录，空时写「执行了 <kind>」；ObjectID、Ref 是产出的对象，可以空。
type PluginActionResult struct {
	Text     string
	ObjectID string
	Ref      string
}

// PluginActions 是插件动作的校验和执行，cmd/pmw 接插件注册表。
// 没有插件声明回 ErrActionUnknown，插件没在跑回 ErrActionUnavailable（都可以包一层说明），其余错误的文字给人看。
type PluginActions interface {
	// ValidateScheduleAction 校验参数，返回要存的参数（插件可以去空白、补默认值）。
	ValidateScheduleAction(ctx context.Context, kind string, params map[string]any) (map[string]any, error)
	RunScheduleAction(ctx context.Context, q PluginActionRequest) (*PluginActionResult, error)
}

// SetPluginActions 接上插件动作；没接时只认 task / sop / agent。在调度器 Start 之前调。
func (s *Store) SetPluginActions(p PluginActions) { s.plugins = p }

// builtinKind 是内核自己的三种动作。
func builtinKind(kind string) bool {
	return kind == ActionTask || kind == ActionSOP || kind == ActionAgent
}

// checkPluginAction 把校验交给插件；kind 没人认时报的错和没接插件时一样。
func (s *Store) checkPluginAction(ctx context.Context, a Action) (Action, error) {
	if a.Kind == "" || s.plugins == nil {
		return a, a.Validate()
	}
	params, err := s.plugins.ValidateScheduleAction(ctx, a.Kind, maps.Clone(a.Params))
	switch {
	case errors.Is(err, ErrActionUnknown):
		return a, invalid("action.kind must be task / sop / agent or a plugin action, got %q", a.Kind)
	case errors.Is(err, ErrActionUnavailable):
		return a, invalid("action.kind %s: %s", a.Kind, err.Error())
	case err != nil:
		return a, invalid("action: %s", err.Error())
	}
	if params == nil {
		params = map[string]any{}
	}
	delete(params, "kind")
	a.Params = params
	return a, nil
}

// runPlugin 交给插件执行。插件停用时记失败、写明原因，定义不动，启用后下次照常。
func (r *Runner) runPlugin(ctx context.Context, sc *Schedule, run *Run, planned time.Time, manual bool) runResult {
	got, err := r.s.plugins.RunScheduleAction(ctx, PluginActionRequest{
		Kind: sc.Action.Kind, ScheduleID: sc.ID, ScheduleName: sc.Name, RunID: run.ID,
		At: planned, Manual: manual, Params: maps.Clone(sc.Action.Params),
	})
	if err != nil {
		return runResult{status: RunFailed, text: "没执行：" + err.Error()}
	}
	if got == nil {
		got = &PluginActionResult{}
	}
	text := got.Text
	if text == "" {
		text = fmt.Sprintf("执行了 %s", sc.Action.Kind)
	}
	return runResult{status: RunOK, text: text, objectID: got.ObjectID, ref: got.Ref}
}
