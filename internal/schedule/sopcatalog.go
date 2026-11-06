package schedule

import (
	"context"
	"encoding/json"
	"errors"
)

// SOP 流程目录（TSK-0480）：Agent 的 list_sops / get_sop / create_sop / update_sop 经插件注册表查、建、改 SOP 流程。
// 同「发起 SOP」钩子一样，SOP 编排是插件，类型放在这里（agent 不能 import internal/plugin），internal/plugin 起别名。
// SOP 插件登记的发起入口另外实现 SOPCatalog 才接得住；没实现或插件没在跑时，注册表回 ErrSOPUnavailable。

// SOPFlowBrief 是流程目录里的一项。
type SOPFlowBrief struct {
	ID      string
	Name    string
	Desc    string
	Trigger string // manual / im / schedule；老数据可能是别的文字
	Steps   int    // 步骤数
	Version int
}

// SOPFlowDoc 是一条流程的完整定义，Fields、StepDefs 同 GET /api/sop/flows/{id} 的 fields、steps。
type SOPFlowDoc struct {
	SOPFlowBrief
	Fields   json.RawMessage
	StepDefs json.RawMessage
}

// SOPNodeKind 是建流程时能用的一种节点：内置的和在跑的插件登记的。
type SOPNodeKind struct {
	Kind      string
	Label     string // 显示名，内置节点才有
	Group     string
	Branching bool
	Cases     []string // 分支节点的默认出口 key
	Required  []string // 必填的 config 项，形如「key（说明）」
}

// SOPSave 是新建或修改一条流程。ID 为空是新建；修改时只改 Body 里给了的字段。
// Body 的口径同 POST / PATCH /api/sop/flows 的请求体（name、desc、trigger、fields、steps、version），
// 校验也同那两个接口；Version 非 0 时按它做冲突检查。
type SOPSave struct {
	ID   string
	Body map[string]json.RawMessage
}

// SOPCatalog 是 SOP 插件发起入口可选实现的接口。错误文字给人看（Agent 原样回给模型）。
// GetSOP 认 id 也认名称；找不到时错误 errors.Is(err, ErrSOPNotFound)。
type SOPCatalog interface {
	ListSOPs(ctx context.Context) ([]SOPFlowBrief, error)
	GetSOP(ctx context.Context, ref string) (*SOPFlowDoc, error)
	SaveSOP(ctx context.Context, q SOPSave) (*SOPFlowDoc, error)
	SOPNodeKinds(ctx context.Context) ([]SOPNodeKind, error)
}

// ErrSOPNotFound：流程不存在。
var ErrSOPNotFound = errors.New("流程不存在")
