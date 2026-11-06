package plugin

import (
	"context"
	"errors"
	"fmt"
	"runtime/debug"
	"slices"
	"strings"
)

// SOP 节点扩展点（SOP-03a），见 docs/plugin-api.md 2.7。
// 内核只存登记：别的插件登记节点类型和 Run，SOP 插件经 Core.SOP() 取到节点目录、执行插件节点；
// 节点挂起后，提供它的插件经 Core.SOP().Resume 唤醒，由 SOP 插件登记的 SOPEngine 接住。
// 停用的插件不在节点目录里，用到它的步骤执行时失败（ErrNodeUnavailable），流程定义不动。

// ErrWaiting：Run 返回它（可以包一层说明原因）表示步骤挂起，等插件之后调 SOP().Resume 唤醒。
var ErrWaiting = errors.New("等外部事件")

// ErrNodeUnavailable：提供这个节点的插件没在跑，SOP 插件拿它的文字写进步骤的失败原因。
var ErrNodeUnavailable = errors.New("提供这个节点的插件已停用")

// ErrNoSOPEngine：SOP 编排插件没在跑，Resume 没人接。
var ErrNoSOPEngine = errors.New("SOP 编排插件没在运行")

// SOPPluginID 是唯一能登记 SOPEngine 的插件。
const SOPPluginID = "sop"

// SOPNodeField 是节点必填的一个配置项，Label 用在保存校验的提示里。
type SOPNodeField struct {
	Key   string `json:"key"`
	Label string `json:"label"`
}

// SOPNodeDef 是插件登记的一个节点类型。颜色、图标、配置表单的样子在前端（SopNodeView）；
// 节点做什么、认哪些配置、输出哪些字段在 Spec（TSK-0490），保存校验、编辑器的字段候选、AI 协助和 Agent 的节点目录都用它。
type SOPNodeDef struct {
	Kind     string         // = 清单 provides.sop_nodes 里的一项，以 <插件 id>_ 开头
	Group    string         // 节点面板里的分组，空为「插件」
	Required []SOPNodeField // 保存时校验的必填配置项；Spec.Params 里 Required 的也算
	// Spec 是节点的声明（TSK-0490）。没声明（Params、Outputs 都是 nil）的节点：配置不查多余的键，输出当作未知
	Spec SOPNodeSpec
	// Run 拿到上游输入和节点配置，返回输出字段；返回 ErrWaiting 表示挂起等外部事件（例：等对方回复）。
	// c 是提供节点的插件自己的 Core。
	Run func(ctx context.Context, c Core, in SOPNodeInput) (map[string]any, error)
}

// SOPNodeInput 是一次执行的上下文。挂起后唤醒要用 RunID 和 Step。
type SOPNodeInput struct {
	RunID   string
	FlowID  string
	Step    string // 步骤 key
	Attempt int    // 第几次尝试，从 1 起，重试、退回重做会加 1；服务重启后重跑同一次尝试不加，节点可按它去重
	Input   map[string]any
	Config  map[string]string
}

// SOPNode 是节点目录里的一项，Source 是提供它的插件 id。
type SOPNode struct {
	Kind     string
	Group    string
	Required []SOPNodeField
	Source   string
	Spec     SOPNodeSpec
}

// SOPNodeSpec 是节点的声明（TSK-0490）：名字、做什么、认哪些配置、输出哪些字段。
// 输出默认是「输入原样往下传，再加上 Outputs 这几个字段」（插件节点几乎都是 with(input, …)）。
type SOPNodeSpec struct {
	Label string
	Desc  string
	// Params 是认的配置项，顺序即表单顺序；nil 是没声明（不查多余的键），空切片是这个节点不认任何配置
	Params []SOPParam
	// Outputs 是这一步加到输出里的字段；nil 是没声明（下游引用字段时只给警告），空切片是只透传
	Outputs []SOPOutput
}

// SOPParam 是节点的一个配置项。
type SOPParam struct {
	Key      string `json:"key"`
	Label    string `json:"label"`
	Desc     string `json:"desc,omitempty"`
	Required bool   `json:"required"`
	// Default 是留空时按什么算（执行时的口径），新建节点时编辑器也填它
	Default string `json:"default,omitempty"`
	// Template 是值里能写 {{字段}}，执行时按输入渲染
	Template bool `json:"template"`
	// Options 是固定的可选值；Source 是要现取的选项（会话、项目、Agent……），都没有是自由填写
	Options []SOPOption `json:"options,omitempty"`
	Source  string      `json:"source,omitempty"`
}

// SOPOption 是一个可选值或取值说明。
type SOPOption struct {
	Value string `json:"value"`
	Label string `json:"label"`
}

// SOPOutput 是输出里的一个字段。Path 用模板写法（a.b、a[0].b）；路径里 {key} 换成同名配置项的值（没填用 Default），
// 比如 AI 处理的 {output}。Type 是 string、number、bool、object、list、any。
// object、list 下面没列子字段的，子字段都算存在；列了子字段的只认列出来的，除非 Open（下面还有没列全的，比如 Claude Code 回报的 result）。
type SOPOutput struct {
	Path    string      `json:"path"`
	Type    string      `json:"type"`
	Label   string      `json:"label"`
	Values  []SOPOption `json:"values,omitempty"`
	Example string      `json:"example,omitempty"`
	Open    bool        `json:"open,omitempty"`
}

// WithSOPSpecs 包一层 Registrar：登记节点时按 kind 从 specs 里补上 Spec（插件把声明集中写在一个文件里时用）。
func WithSOPSpecs(r Registrar, specs map[string]SOPNodeSpec) Registrar {
	return specRegistrar{Registrar: r, specs: specs}
}

type specRegistrar struct {
	Registrar
	specs map[string]SOPNodeSpec
}

func (s specRegistrar) SOPNode(d SOPNodeDef) {
	if sp, ok := s.specs[d.Kind]; ok && d.Spec.Params == nil && d.Spec.Outputs == nil && d.Spec.Label == "" {
		d.Spec = sp
	}
	s.Registrar.SOPNode(d)
}

// SOPEngine 是 SOP 插件登记的执行引擎入口。caller 是调 Resume 的插件 id，只能唤醒它自己提供的节点。
type SOPEngine interface {
	Resume(ctx context.Context, caller, runID, step string, output map[string]any) error
	// Fail 让挂起的步骤失败，reason 写进步骤的失败原因（SOP-02b，例：等回复超时）。
	Fail(ctx context.Context, caller, runID, step, reason string) error
}

// SOPService 是插件用的 SOP 句柄（Core.SOP()）。
type SOPService interface {
	// Schedules 是动作指向这个流程的定时任务，删流程前列出来；内核没接定时任务时为空（SOP-01d，soplaunch.go）。
	Schedules(ctx context.Context, flowID string) ([]SOPScheduleRef, error)
	// FlowSchedule、FlowSchedules、SaveFlowSchedule、DeleteFlowSchedule、CheckScheduleRule 是随流程管理的定时任务（TSK-0463，sopschedule.go）：
	// 流程触发方式选「定时」时规则存在这一条里。只有 SOP 插件能改；内核没接定时任务时回 ErrNoSOPSchedules。
	FlowSchedule(ctx context.Context, flowID string) (*SOPFlowSchedule, error)
	FlowSchedules(ctx context.Context) (map[string]SOPFlowSchedule, error)
	SaveFlowSchedule(ctx context.Context, flowID string, in SOPFlowScheduleInput) (*SOPFlowScheduleResult, error)
	DeleteFlowSchedule(ctx context.Context, flowID string) (int, error)
	CheckScheduleRule(r SOPScheduleRule) (SOPScheduleRule, error)
	// Nodes 是在跑的插件登记的节点，按插件登记顺序、登记顺序。
	Nodes() []SOPNode
	// Provider 是清单 provides.sop_nodes 里声明了 kind 的插件 id（不管装没装、启没启用）。
	Provider(kind string) (string, bool)
	// RunNode 用提供节点的插件执行一次；插件没在跑回 ErrNodeUnavailable，panic 转成错误。
	RunNode(ctx context.Context, kind string, in SOPNodeInput) (map[string]any, error)
	// Resume 唤醒挂起的步骤，output 是这一步的输出。SOP 插件没在跑回 ErrNoSOPEngine。
	Resume(ctx context.Context, runID, step string, output map[string]any) error
	// Fail 让挂起的步骤失败，reason 是给人看的原因，校验同 Resume（SOP-02b）。
	Fail(ctx context.Context, runID, step, reason string) error
	// InstallFlow 写入本插件的内置流程（id 以 sop_<插件 id>_ 开头），已有不动；回是不是新写的（VID-03d，sopflow.go）。
	InstallFlow(ctx context.Context, t SOPFlowTemplate) (bool, error)
	// RemoveFlow 撤下本插件没被改过的内置流程，回删没删和留下的原因（VID-03d，sopflow.go）。
	RemoveFlow(ctx context.Context, id string) (bool, string, error)
}

func (c *core) SOP() SOPService { return sopService{c} }

type sopService struct{ c *core }

func (s sopService) Nodes() []SOPNode {
	out := []SOPNode{}
	r := s.c.reg
	if r == nil {
		return out
	}
	for _, id := range r.order {
		a := r.entries[id].active.Load()
		if a == nil {
			continue
		}
		for _, d := range a.sopNodes {
			out = append(out, SOPNode{Kind: d.Kind, Group: d.Group, Required: slices.Clone(d.Required), Source: id, Spec: d.Spec})
		}
	}
	return out
}

func (s sopService) Provider(kind string) (string, bool) {
	r := s.c.reg
	if r == nil {
		return "", false
	}
	for _, id := range r.order {
		if slices.Contains(r.entries[id].m.Provides.SOPNodes, kind) {
			return id, true
		}
	}
	return "", false
}

func (s sopService) RunNode(ctx context.Context, kind string, in SOPNodeInput) (out map[string]any, err error) {
	r := s.c.reg
	if r == nil {
		return nil, ErrNodeUnavailable
	}
	for _, id := range r.order {
		e := r.entries[id]
		a := e.active.Load()
		if a == nil {
			continue
		}
		i := slices.IndexFunc(a.sopNodes, func(d SOPNodeDef) bool { return d.Kind == kind })
		if i < 0 {
			continue
		}
		defer func() {
			if v := recover(); v != nil {
				e.core.log.Error("plugin sop node panic", "kind", kind, "panic", v, "stack", string(debug.Stack()))
				out, err = nil, fmt.Errorf("节点 %s 执行出错", kind)
			}
		}()
		return a.sopNodes[i].Run(ctx, e.core, in)
	}
	return nil, ErrNodeUnavailable
}

func (s sopService) Resume(ctx context.Context, runID, step string, output map[string]any) error {
	eng, err := s.engine()
	if err != nil {
		return err
	}
	return eng.Resume(ctx, s.c.id, runID, step, output)
}

func (s sopService) Fail(ctx context.Context, runID, step, reason string) error {
	eng, err := s.engine()
	if err != nil {
		return err
	}
	return eng.Fail(ctx, s.c.id, runID, step, reason)
}

func (s sopService) engine() (SOPEngine, error) {
	r := s.c.reg
	if r == nil {
		return nil, ErrNoSOPEngine
	}
	e, ok := r.entries[SOPPluginID]
	if !ok {
		return nil, ErrNoSOPEngine
	}
	a := e.active.Load()
	if a == nil || a.sopEngine == nil {
		return nil, ErrNoSOPEngine
	}
	return a.sopEngine, nil
}

func (c *collector) SOPNode(d SOPNodeDef) {
	d.Group = strings.TrimSpace(d.Group)
	if d.Group == "" {
		d.Group = "插件"
	}
	if d.Required == nil {
		d.Required = []SOPNodeField{}
	}
	id := c.e.m.ID
	switch {
	case !slices.Contains(c.e.m.Provides.SOPNodes, d.Kind):
		c.add("SOP 节点不在清单 provides.sop_nodes 里：%s", d.Kind)
	case !strings.HasPrefix(d.Kind, id+"_"):
		c.add("SOP 节点 %s 必须以 %s_ 开头", d.Kind, id)
	case d.Run == nil:
		c.add("SOP 节点 %s 没有 Run", d.Kind)
	case slices.ContainsFunc(c.a.sopNodes, func(o SOPNodeDef) bool { return o.Kind == d.Kind }):
		c.add("SOP 节点重复：%s", d.Kind)
	default:
		for _, f := range d.Required {
			if strings.TrimSpace(f.Key) == "" || strings.TrimSpace(f.Label) == "" {
				c.add("SOP 节点 %s 的必填配置项要有 key 和 label", d.Kind)
				return
			}
		}
		// 声明里必填的配置项也进 Required，保存校验只看 Required（TSK-0490）
		for _, p := range d.Spec.Params {
			if strings.TrimSpace(p.Key) == "" || strings.TrimSpace(p.Label) == "" {
				c.add("SOP 节点 %s 的配置项要有 key 和 label", d.Kind)
				return
			}
			if p.Required && !slices.ContainsFunc(d.Required, func(f SOPNodeField) bool { return f.Key == p.Key }) {
				d.Required = append(d.Required, SOPNodeField{Key: p.Key, Label: p.Label})
			}
		}
		c.a.sopNodes = append(c.a.sopNodes, d)
	}
}

func (c *collector) SOPEngine(e SOPEngine) {
	switch {
	case c.e.m.ID != SOPPluginID:
		c.add("只有 SOP 编排插件能登记执行引擎")
	case e == nil:
		c.add("SOP 执行引擎是 nil")
	case c.a.sopEngine != nil:
		c.add("SOP 执行引擎重复登记")
	default:
		c.a.sopEngine = e
	}
}
