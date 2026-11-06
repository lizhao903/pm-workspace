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
	// IMTrigger 是触发方式为 im 时的过滤条件、执行顺序和拦截，一句给人看的话（TSK-0481）；不是 im 为空串
	IMTrigger string
	// Folder 是所在文件夹的名字（TSK-0482），没放进文件夹（未分类）为空串
	Folder string
}

// SOPFolderBrief 是流程库的一个文件夹（TSK-0482）。
type SOPFolderBrief struct {
	ID    string
	Name  string
	Count int // 里面的流程数
}

// SOPFolders 是全部文件夹（按新建先后）和未分类的流程数。
type SOPFolders struct {
	Folders       []SOPFolderBrief
	Uncategorized int
}

// SOPFlowDoc 是一条流程的完整定义，Fields、StepDefs 同 GET /api/sop/flows/{id} 的 fields、steps。
type SOPFlowDoc struct {
	SOPFlowBrief
	Fields   json.RawMessage
	StepDefs json.RawMessage
	// FolderCreated 是这次保存按 folder 的名字新建了文件夹（TSK-0482），只在 SaveSOP 的结果里有
	FolderCreated bool
	// Warnings 是保存校验的警告（存上了但要提醒的，TSK-0490），带「第 n 步：」；GetSOP 时是打开这条流程会看到的全部问题
	Warnings []string
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
// Body 的口径同 POST / PATCH /api/sop/flows 的请求体（name、desc、trigger、fields、steps、version、folder_id），
// 校验也同那两个接口；Version 非 0 时按它做冲突检查。
// Body 另认 folder（TSK-0482）：文件夹名字或 id，空串或「未分类」是放回未分类，名字对不上已有文件夹时新建一个；给了 folder 就不看 folder_id。
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
	// ListSOPFolders 列流程库的文件夹和未分类的流程数（TSK-0482）
	ListSOPFolders(ctx context.Context) (SOPFolders, error)
	// SOPGuide 是给模型看的编排说明：节点目录（配置项、输出字段）、触发方式自动带入的字段、结构化条件和 IM 过滤的写法、文件夹（TSK-0490），
	// 和编辑器 AI 协助用的是同一份
	SOPGuide(ctx context.Context) (string, error)
}

// ErrSOPNotFound：流程不存在。
var ErrSOPNotFound = errors.New("流程不存在")

// SOPTest 是一次调试（TSK-0491，Agent 的 test_sop）：FlowID 认 id 也认名称；MessageID、Input 都不给时
// IM 触发的流程取最近一次执行的消息，其余用输入字段的默认值。
type SOPTest struct {
	FlowID     string
	MessageID  string
	Input      map[string]any
	SkipModels bool
}

// SOPDebugger 是 SOP 插件发起入口可选实现的调试接口（TSK-0491）：Agent 的 test_sop、explain_im_trigger 经它。
// 回给模型看的一段文字；只读，不建执行、不写库。
type SOPDebugger interface {
	TestSOP(ctx context.Context, q SOPTest) (string, error)
	ExplainIMTrigger(ctx context.Context, messageID string) (string, error)
}
