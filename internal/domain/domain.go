// Package domain 定义工作台的领域模型。这是前后端与各层之间的契约，改动需同步 web/src/lib/types.ts。
package domain

import (
	"strings"
	"time"
)

// Status 是某个工作对象类型下允许的状态。
type Status struct {
	Key      string `json:"key"`
	Label    string `json:"label"`
	Color    string `json:"color"`
	Terminal bool   `json:"terminal"`
	// Description 是给人看的说明，设置的枚举值页里填；老数据没有。
	Description string `json:"description,omitempty"`
}

// ObjectType 是工作对象分类的第一层：类型（需求/待办/项目/文档/资源/笔记，可自定义）。
type ObjectType struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	Plural    string    `json:"plural"`
	RefPrefix string    `json:"ref_prefix"`
	Icon      string    `json:"icon"`
	Color     string    `json:"color"`
	Builtin   bool      `json:"builtin"`
	SortOrder int       `json:"sort_order"`
	Statuses  []Status  `json:"statuses"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

type ObjectTypePatch struct {
	Name      *string   `json:"name"`
	Plural    *string   `json:"plural"`
	RefPrefix *string   `json:"ref_prefix"`
	Icon      *string   `json:"icon"`
	Color     *string   `json:"color"`
	SortOrder *int      `json:"sort_order"`
	Statuses  *[]Status `json:"statuses"`
}

// Category 是工作对象分类的第二层：类型内的层级分类（归属维度，单选）。
type Category struct {
	ID          string    `json:"id"`
	TypeID      string    `json:"type_id"`
	ParentID    *string   `json:"parent_id"`
	Name        string    `json:"name"`
	Slug        string    `json:"slug"`
	Path        string    `json:"path"`
	Depth       int       `json:"depth"`
	Color       string    `json:"color"`
	Description string    `json:"description"`
	SortOrder   int       `json:"sort_order"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`

	// 以下为查询时计算字段，不落库。
	Count      int         `json:"count"`       // 直接挂在该分类下的对象数
	TotalCount int         `json:"total_count"` // 含子树
	Children   []*Category `json:"children,omitempty"`
}

type CategoryPatch struct {
	Name        *string `json:"name"`
	Slug        *string `json:"slug"`
	Color       *string `json:"color"`
	Description *string `json:"description"`
	SortOrder   *int    `json:"sort_order"`
}

// Object 是统一的工作对象（单表多态），type_id 决定它是需求还是待办。
type Object struct {
	ID       string `json:"id"`
	TypeID   string `json:"type_id"`
	Ref      string `json:"ref"`
	Title    string `json:"title"`
	Body     string `json:"body"`
	Status   string `json:"status"`
	Priority string `json:"priority"`
	// Owner 是 0010 之前的自由文本负责人，**只读**。新写入一律走 OwnerID。
	// 留着它有两个用处：迁移判断错了还能对着原始值改；OwnerID 为空而它非空时，
	// 界面仍显示得出个人名来，不会因为漏迁某条就变成一片空白。
	Owner      string         `json:"owner"`
	OwnerID    *string        `json:"owner_id"`
	CategoryID *string        `json:"category_id"`
	ProjectID  *string        `json:"project_id"`
	Source     string         `json:"source"`
	Props      map[string]any `json:"props"`
	// Workdir 是该对象的专属工作区目录。主要用在 project 上：切到某个项目时，
	// Agent 与 Claude Code 的产物落到它自己的目录，而不是全都堆在一处。
	// 任务没设时向上取所属项目的。
	Workdir     string     `json:"workdir"`
	DueAt       *time.Time `json:"due_at"`
	StartedAt   *time.Time `json:"started_at"`
	CompletedAt *time.Time `json:"completed_at"`
	ArchivedAt  *time.Time `json:"archived_at"`
	DeletedAt   *time.Time `json:"deleted_at"`
	CreatedAt   time.Time  `json:"created_at"`
	UpdatedAt   time.Time  `json:"updated_at"`

	// 以下为查询时填充的展示字段，不落 objects 表。
	Tags          []string `json:"tags"`
	CategoryName  string   `json:"category_name,omitempty"`
	CategoryPath  string   `json:"category_path,omitempty"`
	CategoryColor string   `json:"category_color,omitempty"`
	ProjectTitle  string   `json:"project_title,omitempty"`
	LinkCount     int      `json:"link_count"`
	// OwnerName 是 OwnerID 指向的干系人名字；OwnerID 为空时回退到 Owner 文本。
	// 列表要显示人名，而按 id 逐行回查是 N+1——这个字段由 store 一次 JOIN 填好。
	OwnerName string `json:"owner_name,omitempty"`
	// OwnerAIKind / OwnerAIRef 是负责人为 AI 成员时它的类型与引用（TSK-0500，0051）：
	// agent + Agent id，或 cli + 执行器（claude / deepseek）；负责人是人或没有负责人时都不出现。
	OwnerAIKind string `json:"owner_ai_kind,omitempty"`
	OwnerAIRef  string `json:"owner_ai_ref,omitempty"`
	// Participants 只带渲染需要的三个字段。列表里一行可能有好几个参与人，
	// 每个都带上 email/note/时间戳的话，一次 50 行的查询会凭空多搬几十 KB。
	Participants []StakeholderRef `json:"participants"`
}

// StakeholderRef 是干系人的展示投影：够画一个头像加一个名字，仅此而已。
type StakeholderRef struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Color string `json:"color"`
}

// Stakeholder 是干系人名册里的一个人。
//
// 没有软删列，只有 ArchivedAt——和 DictItem 同一个道理：人一旦被历史对象引用过，
// 删掉就会在列表里留下一个查不出来源的空位。离职的人归档即可。
type Stakeholder struct {
	ID         string     `json:"id"`
	Name       string     `json:"name"`
	Role       string     `json:"role"`
	Email      string     `json:"email"`
	Note       string     `json:"note"`
	Color      string     `json:"color"`
	SortOrder  int        `json:"sort_order"`
	ArchivedAt *time.Time `json:"archived_at"`
	CreatedAt  time.Time  `json:"created_at"`
	UpdatedAt  time.Time  `json:"updated_at"`

	// 联系人字段（0026），对照原型 Contact。Group 是分组显示名，不约束取值；
	// Photo 是 data:image/ URL，空串按名字生成头像；LastContactAt 为 nil 表示没联系过。
	Group         string     `json:"group"`
	Company       string     `json:"company"`
	Title         string     `json:"title"`
	Phone         string     `json:"phone"`
	Tags          []string   `json:"tags"`
	Photo         string     `json:"photo"`
	Starred       bool       `json:"starred"`
	LastContactAt *time.Time `json:"last_contact_at"`

	// AIKind / AIRef 标出名册里的 AI 成员（TSK-0500，0051）：'' 是人；agent 是工作台 Agent，
	// AIRef 是 Agent id；cli 是命令行执行器，AIRef 是 claude / deepseek。由工作台自动维护，
	// 新建、PATCH 都不收这两个字段。
	AIKind string `json:"ai_kind"`
	AIRef  string `json:"ai_ref"`

	// 以下为查询时填充的展示字段，不落 stakeholders 表。
	// OwnedCount / ParticipatingCount 是删除前的确认依据，也是名册页上的「他手上有多少事」。
	OwnedCount         int `json:"owned_count"`
	ParticipatingCount int `json:"participating_count"`
}

// AI 成员的类型（Stakeholder.AIKind）。
const (
	AIKindAgent = "agent" // 工作台 Agent，AIRef 是 agents.id
	AIKindCLI   = "cli"   // 命令行执行器，AIRef 是 RunHarnessClaude / RunHarnessDeepSeek
)

// AIMember 是名册里一条 AI 成员应有的样子，SyncAIMembers 按它建、改名、复岗。
type AIMember struct {
	Kind  string
	Ref   string
	Name  string
	Color string
	Note  string
}

type StakeholderPatch struct {
	Name      *string `json:"name"`
	Role      *string `json:"role"`
	Email     *string `json:"email"`
	Note      *string `json:"note"`
	Color     *string `json:"color"`
	SortOrder *int    `json:"sort_order"`
	Archived  *bool   `json:"archived"`

	Group   *string   `json:"group"`
	Company *string   `json:"company"`
	Title   *string   `json:"title"`
	Phone   *string   `json:"phone"`
	Tags    *[]string `json:"tags"`
	Photo   *string   `json:"photo"`
	Starred *bool     `json:"starred"`
	// LastContactAt 双指针：外层 nil 不改，内层 nil 清空（回到「没联系过」）。
	LastContactAt **time.Time `json:"last_contact_at"`
}

type ObjectPatch struct {
	Title    *string `json:"title"`
	Body     *string `json:"body"`
	Status   *string `json:"status"`
	Priority *string `json:"priority"`
	// OwnerID 单指针即可：空串就是「没有负责人」的合法取值，store 落库时写 NULL。
	// 不用双指针是因为 owner_id 没有「空串」和「未设置」的语义差别——
	// 和 CategoryID 不同，那边的 "" 是个非法 id，必须靠 null 才能表达「清空」。
	OwnerID *string `json:"owner_id"`
	// ParticipantIDs 是全量替换，不是增量：nil = 不改，空切片 = 清空。
	// 增量语义（add/remove）在 PATCH 上表达不了「删到一个不剩」和「没提这个字段」的差别。
	ParticipantIDs *[]string       `json:"participant_ids"`
	CategoryID     **string        `json:"category_id"` // 双指针：区分「不改」与「置空」
	ProjectID      **string        `json:"project_id"`
	Source         *string         `json:"source"`
	Props          *map[string]any `json:"props"`
	// Workdir 单指针即可：空串本身就是「没有工作区」的合法取值，不需要区分 null 和 ""。
	Workdir  *string     `json:"workdir"`
	DueAt    **time.Time `json:"due_at"`
	Tags     *[]string   `json:"tags"`
	Archived *bool       `json:"archived"`
}

// ObjectFilter 是列表查询条件。零值表示不过滤。
type ObjectFilter struct {
	TypeIDs         []string
	CategoryID      string
	CategorySubtree bool // true 时按 path 前缀匹配整棵子树
	Uncategorized   bool // 只要 category_id IS NULL 的对象，与 CategoryID 互斥
	Statuses        []string
	Priorities      []string
	Tags            []string
	// OwnerID 取代了 0010 之前的 Owner 文本匹配。一个语义只留一个定义——
	// 两种筛法并存的话，「示例甲、示例乙、示例丙」这条按文本能搜到、按 id 搜不到，
	// 同一个筛选器给出两种结果。
	OwnerID   string
	ProjectID string
	Query     string // 标题/正文 LIKE，M3 换 FTS5
	// DueAfter / DueBefore 成对使用才能表达「同一天到期」这种窗口。
	// 只有上界的话，「今日」会把所有逾期的也扫进来，和 Counts.Today 的口径对不上。
	DueAfter  *time.Time
	DueBefore *time.Time
	Overdue   bool
	// Stalled：N 天未更新且未进终态。counts.Stalled 就是这个口径，
	// 前端若只按 updated_at 排序而不过滤，会出现「徽标 2 / 列表 20 行」。
	Stalled bool
	// NotTerminal：排除处于终态的对象。「今日」「本周」这类待办视图要用它，
	// 否则今天到期但已完成的会混进列表，而 Counts 那边是排除终态的，两边又对不上。
	NotTerminal bool
	Inbox       bool // source='inbox' 或未分类
	// Sources 按 objects.source 精确匹配，多个之间是或。任务来源取值见 TaskSource* 常量。
	Sources []string
	// 以下按 props 筛（AUTO-05，stage.go）：Stages 是 props.stage 任一，"none" 表示没设阶段；
	// RequesterID 是 props.requester.contact_id；RequesterChannel + RequesterSenderID 成对按 IM 发送者筛；
	// SourceMessageID 是 props.source_ref.message_id。
	Stages            []string
	RequesterID       string
	RequesterChannel  string
	RequesterSenderID string
	SourceMessageID   string
	IncludeArchived   bool
	IncludeDeleted    bool
	Sort              string // updated_at|created_at|due_at|priority|title，前缀 - 表示倒序
	Limit             int
	Offset            int
}

type Tag struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	Color     string    `json:"color"`
	Count     int       `json:"count"`
	CreatedAt time.Time `json:"created_at"`
}

const (
	RelRelates    = "relates"
	RelBlocks     = "blocks"
	RelDuplicates = "duplicates"
	RelParent     = "parent"
	RelReferences = "references"
)

type Link struct {
	ID        string    `json:"id"`
	FromID    string    `json:"from_id"`
	ToID      string    `json:"to_id"`
	Relation  string    `json:"relation"`
	Note      string    `json:"note"`
	CreatedAt time.Time `json:"created_at"`
}

// LinkView 是带对端对象摘要的关联，供详情面板直接渲染。
type LinkView struct {
	Link
	Direction string  `json:"direction"` // out|in
	Peer      *Object `json:"peer"`
}

type Revision struct {
	ID       string `json:"id"`
	ObjectID string `json:"object_id"`
	Field    string `json:"field"`
	OldValue string `json:"old_value"`
	NewValue string `json:"new_value"`
	// Actor 是库里 revisions.actor 的原文。带会话标识时形如 "claude-code#<session>"，
	// 拆开的两段放在 ActorName / SessionID 里，见 SplitActor。
	Actor     string    `json:"actor"`
	Source    string    `json:"source"`
	CreatedAt time.Time `json:"created_at"`

	// 以下为读取时由 Actor 拆出来的派生字段，不落库。
	ActorName string `json:"actor_name"`
	SessionID string `json:"session_id"`
}

// Counts 驱动左侧栏徽标。
type Counts struct {
	// ByType 的 key 是 object_types.id。
	ByType map[string]int `json:"by_type"`
	// ByStatus 的 key 是复合形式 "<type_id>:<status>"（如 "requirement:doing"）。
	// 不能用裸 status key：不同类型的状态集有重名（需求和待办都有 doing），
	// 跨类型聚合出来的数字没有业务含义。
	ByStatus map[string]int `json:"by_status"`
	// UncategorizedByType 的 key 是 object_types.id，值为该类型下 category_id IS NULL 的对象数。
	// 侧栏「未分类」行要这个数字，否则它的徽标空着，和旁边有数字的分类行放一起像 bug。
	UncategorizedByType map[string]int `json:"uncategorized_by_type"`
	Inbox               int            `json:"inbox"`
	Today               int            `json:"today"`
	Week                int            `json:"week"`
	Overdue             int            `json:"overdue"`
	Stalled             int            `json:"stalled"` // 14 天未更新且未终态
	Total               int            `json:"total"`
}

// ShortcutGroup 是快捷访问页的分组。
type ShortcutGroup struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	Color     string    `json:"color"`
	Collapsed bool      `json:"collapsed"`
	SortOrder int       `json:"sort_order"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`

	// 查询时填充，不落库。
	Items []*Shortcut `json:"items,omitempty"`
}

type ShortcutGroupPatch struct {
	Name      *string `json:"name"`
	Color     *string `json:"color"`
	Collapsed *bool   `json:"collapsed"`
	SortOrder *int    `json:"sort_order"`
}

// 快捷入口的三种跳转目标。
const (
	ShortcutURL      = "url"      // 外部链接，支持 {{变量}}
	ShortcutInternal = "internal" // 工作台内部导航，nav 字段存 NavSelection JSON
	ShortcutCommand  = "command"  // 触发动作，如 quick-capture:requirement
)

// Shortcut 是一条快捷入口。
type Shortcut struct {
	ID          string     `json:"id"`
	GroupID     *string    `json:"group_id"`
	Label       string     `json:"label"`
	TargetKind  string     `json:"target_kind"`
	URL         string     `json:"url"`
	Nav         string     `json:"nav"`
	Command     string     `json:"command"`
	Icon        string     `json:"icon"`
	Color       string     `json:"color"`
	Description string     `json:"description"`
	OpenIn      string     `json:"open_in"`
	Pinned      bool       `json:"pinned"`
	SortOrder   int        `json:"sort_order"`
	LastUsedAt  *time.Time `json:"last_used_at"`
	UseCount    int        `json:"use_count"`
	CreatedAt   time.Time  `json:"created_at"`
	UpdatedAt   time.Time  `json:"updated_at"`
}

type ShortcutPatch struct {
	GroupID     **string `json:"group_id"`
	Label       *string  `json:"label"`
	TargetKind  *string  `json:"target_kind"`
	URL         *string  `json:"url"`
	Nav         *string  `json:"nav"`
	Command     *string  `json:"command"`
	Icon        *string  `json:"icon"`
	Color       *string  `json:"color"`
	Description *string  `json:"description"`
	OpenIn      *string  `json:"open_in"`
	Pinned      *bool    `json:"pinned"`
	SortOrder   *int     `json:"sort_order"`
}

// ---- 字典：把原本硬编码的枚举（优先级、关联关系）变成可配置数据 ----

const (
	ScopeGlobal = "global" // 全局枚举
	ScopeType   = "type"   // 按工作对象类型隔离
)

const (
	DictPriority     = "priority"
	DictLinkRelation = "link_relation"
	// DictArtifactPlatform 是产物所在平台的名单（Confluence / 飞书 / 本地文件 …）。
	// 走字典而不是 Go 里的常量：这份名单一定会变，而用户在设置里改一次
	// 比每次都等一个版本要合理。meta.hosts 是域名特征，界面粘链接时据此自动选平台。
	DictArtifactPlatform = "artifact_platform"
	// DictArtifactKind 是产物种类（文档、原型、提交……），落在 artifacts.kind（0031）。
	DictArtifactKind = "artifact_kind"
	// DictContactGroup 是联系人分组，key 就是显示名，落在 stakeholders.contact_group（多个用「、」连，0041）。
	DictContactGroup = "contact_group"
	// DictMsgStatus 是 IM 消息的处理状态，落在 im 插件的 im_messages.status（0041）。
	DictMsgStatus = "msg_status"
	// DictProjectRole 是项目干系人的角色，落在项目插件的 projects_stakeholders.role（0052，TSK-0718）。
	DictProjectRole = "project_role"
)

type Dictionary struct {
	ID          string    `json:"id"`
	Name        string    `json:"name"`
	Description string    `json:"description"`
	Scope       string    `json:"scope"`
	Builtin     bool      `json:"builtin"`
	SortOrder   int       `json:"sort_order"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`

	Items []*DictItem `json:"items,omitempty"` // with_items=true 时填充
}

// DictItem 的 Key 落在业务表里（如 objects.priority），一经创建不可改。
type DictItem struct {
	ID          string         `json:"id"`
	DictID      string         `json:"dict_id"`
	TypeID      *string        `json:"type_id"`
	Key         string         `json:"key"`
	Label       string         `json:"label"`
	Color       string         `json:"color"`
	Description string         `json:"description"`
	SortOrder   int            `json:"sort_order"`
	Meta        map[string]any `json:"meta"`
	ArchivedAt  *time.Time     `json:"archived_at"`
	CreatedAt   time.Time      `json:"created_at"`
	UpdatedAt   time.Time      `json:"updated_at"`

	Usage int `json:"usage"` // 被多少条业务数据引用，查询时按需填充
}

// DictItemPatch 不含 Key：枚举值一经创建不可改，否则已落库的业务数据会变成悬空值。
type DictItemPatch struct {
	Label       *string         `json:"label"`
	Color       *string         `json:"color"`
	Description *string         `json:"description"`
	SortOrder   *int            `json:"sort_order"`
	Meta        *map[string]any `json:"meta"`
}

// ---- Agent 供应商：接入 OpenAI 兼容 / Anthropic / Gemini / 本地 Ollama ----

// kind 是协议，不是厂商：DeepSeek、Moonshot 这类兼容 OpenAI 的厂商一律 kind=openai，
// 厂商身份放在 extra.preset 上（见 ProviderPresetDeepSeek）。
const (
	ProviderOpenAI    = "openai" // OpenAI 及一切 /v1/chat/completions 兼容端点（DeepSeek、Moonshot、vLLM…）
	ProviderAnthropic = "anthropic"
	ProviderGemini    = "gemini"
	ProviderOllama    = "ollama" // 本地，不需要 api_key
)

// ProviderPresetDeepSeek 是 extra.preset 的取值，和原型 modeldata.ts 的 ProviderKind 同名。
// 只影响默认 base_url，调用走的仍是 openai 协议。
const ProviderPresetDeepSeek = "deepseek"

// AgentProvider 是一个模型接入点。APIKey 只写不读——读取时一律脱敏，
// 避免密钥经由界面、日志、MCP 工具返回值泄漏出去。
type AgentProvider struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Kind      string `json:"kind"`
	BaseURL   string `json:"base_url"`
	Model     string `json:"model"`
	Enabled   bool   `json:"enabled"`
	IsDefault bool   `json:"is_default"`

	// APIKeyMasked 形如 sk-…abcd，仅供界面显示「已配置」；从不返回原文。
	APIKeyMasked string `json:"api_key_masked"`
	HasAPIKey    bool   `json:"has_api_key"`

	Extra     map[string]any `json:"extra"` // temperature / timeout / 组织 ID 之类
	CreatedAt time.Time      `json:"created_at"`
	UpdatedAt time.Time      `json:"updated_at"`

	// LastTest 是最近一次「测试连接」的结论（0046），没测过或改了连接配置后为 nil。
	LastTest *ProviderLastTest `json:"last_test"`
}

// ProviderLastTest 是落库的测试结论：ProviderTestResult 加上测试时间。
type ProviderLastTest struct {
	OK      bool      `json:"ok"`
	Latency int64     `json:"latency_ms"`
	Message string    `json:"message"`
	Models  []string  `json:"models,omitempty"`
	At      time.Time `json:"at"`
}

// AgentProviderInput 的 APIKey 是写入侧字段，指针语义：nil 不改、空串清除。
type AgentProviderInput struct {
	Name    *string         `json:"name"`
	Kind    *string         `json:"kind"`
	BaseURL *string         `json:"base_url"`
	Model   *string         `json:"model"`
	Enabled *bool           `json:"enabled"`
	APIKey  *string         `json:"api_key"`
	Extra   *map[string]any `json:"extra"`
}

// ProviderTestResult 是「测试连接」的结果。不要把上游的原始错误直接抛给界面——
// 里面可能带着 URL 里的密钥。
type ProviderTestResult struct {
	OK      bool     `json:"ok"`
	Latency int64    `json:"latency_ms"`
	Message string   `json:"message"`
	Models  []string `json:"models,omitempty"` // 能列出模型时给前端做下拉
}

// ---- 备份与导出 ----

// MigrationRecord 对应 schema_migrations 一行，设置页的「数据与备份」要展示它。
type MigrationRecord struct {
	Version   string    `json:"version"`
	Checksum  string    `json:"checksum"`
	AppliedAt time.Time `json:"applied_at"`
}

type BackupInfo struct {
	Path      string    `json:"path"`
	Size      int64     `json:"size"`
	CreatedAt time.Time `json:"created_at"`
}

// ---- Agent 会话：主工作区底部的对话框 ----

// AgentSession 一次对话。Workdir 是这次对话的产物落盘目录，
// Agent 写出的文件只能落在它下面——路径越界是必须堵死的攻击面。
type AgentSession struct {
	ID    string `json:"id"`
	Title string `json:"title"`
	// ObjectID 为 nil 表示全局会话（底部那个对话框建的）；非 nil 表示它属于某个
	// 工作对象，只在那个对象的「AI 助手」页签里出现。
	//
	// 两处不拆表：消息、产物、供应商快照完全同构，唯一差别就是这一列，
	// 拆表等于把同一套读写逻辑写两遍。
	ObjectID   *string   `json:"object_id"`
	ProviderID string    `json:"provider_id"`
	Model      string    `json:"model"`
	Workdir    string    `json:"workdir"`
	CreatedAt  time.Time `json:"created_at"`
	UpdatedAt  time.Time `json:"updated_at"`

	// AgentID 为 nil 表示不挂 Agent 的会话（0032 之前的都是）。建的时候定下，之后不改。
	AgentID *string `json:"agent_id"`
	// AgentDeleted：挂了 Agent 但 Agent 已删除，会话照常能看、不能再发消息。
	AgentDeleted bool `json:"agent_deleted"`
	// ModelOverride（0053，TSK-0720）：挂 Agent 的会话单独换过模型。为 true 时 ProviderID / Model 是会话自己选的；
	// 为 false 时跟随 Agent 当前的默认，读出来的 ProviderID / Model 就是 Agent 当前的（Agent 删了是最后的快照）。
	// 不挂 Agent 的会话恒为 false，ProviderID / Model 本来就是自己的。
	ModelOverride bool `json:"model_override"`

	// SourceRef 是会话的来源（0047）：从哪条记录发起的，JSON 对象，建的时候给、之后不改；
	// 不是从别的记录发起的为 nil，响应里不带这个键。会话里 Agent 新建的对象缺省把它记进 props.source_ref，
	// 里面有 project_id 时对象缺省挂到这个项目。
	SourceRef map[string]any `json:"source_ref,omitempty"`

	MessageCount int `json:"message_count"`
}

// ---- Agent 配置（AG-01b1，0032）----

// Agent 是一个工作助手，字段对齐原型 web-next/src/agentdata.ts 的 Agent；
// 工具权限 abilities 归 AG-02a，不在这里。模型带服务商：ProviderID + Model。
type Agent struct {
	ID           string         `json:"id"`
	Name         string         `json:"name"`
	Desc         string         `json:"desc"`
	Color        string         `json:"color"`
	Avatar       AgentAvatar    `json:"avatar"`
	ProviderID   string         `json:"provider_id"`
	Model        string         `json:"model"`
	Instructions string         `json:"instructions"`
	Skills       []string       `json:"skills"`
	MCPs         []string       `json:"mcps"`
	KBs          []string       `json:"kbs"`
	Triggers     []AgentTrigger `json:"triggers"`
	// Thinking 是调模型时的思考档位：default（不传，交给模型默认）/ off / low / medium / high，见 0045
	Thinking  string    `json:"thinking"`
	Enabled   bool      `json:"enabled"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

// AgentAvatar 对应原型 AgentAvatarConf：Kind 为 text / icon / image，image 的 Value 是 data URL。
type AgentAvatar struct {
	Kind  string `json:"kind"`
	Value string `json:"value"`
}

// AgentTrigger 对应原型 AgentTrigger：Kind 为 manual / im / schedule / task，Detail 是条件。
type AgentTrigger struct {
	Kind   string `json:"kind"`
	Detail string `json:"detail"`
	// Match 是结构化的条件（AG-01b4），只有 task、im 有；nil 按默认条件，见 TriggerMatch。
	Match *TriggerMatch `json:"match,omitempty"`
}

// TriggerMatch 是触发条件。task：Assigned 是任务分配给这个 Agent（props.agent_id），Tags 是标签命中任一，
// 两者任一满足即可；nil 时只看分配。im：ConnectorID、Channel、ConversationID 空串不限，OnlyMe 只看与我相关的消息。
type TriggerMatch struct {
	Assigned       bool     `json:"assigned"`
	Tags           []string `json:"tags"`
	ConnectorID    string   `json:"connector_id"`
	Channel        string   `json:"channel"`
	ConversationID string   `json:"conversation_id"`
	OnlyMe         bool     `json:"only_me"`
}

const (
	AvatarText  = "text"
	AvatarIcon  = "icon"
	AvatarImage = "image"

	TriggerManual   = "manual"
	TriggerIM       = "im"
	TriggerSchedule = "schedule"
	TriggerTask     = "task"
)

// AgentInput 是建和改共用的入参，指针语义：nil 不改（建时取默认值）。
type AgentInput struct {
	Name         *string         `json:"name"`
	Desc         *string         `json:"desc"`
	Color        *string         `json:"color"`
	Avatar       *AgentAvatar    `json:"avatar"`
	ProviderID   *string         `json:"provider_id"`
	Model        *string         `json:"model"`
	Instructions *string         `json:"instructions"`
	Skills       *[]string       `json:"skills"`
	MCPs         *[]string       `json:"mcps"`
	KBs          *[]string       `json:"kbs"`
	Triggers     *[]AgentTrigger `json:"triggers"`
	Thinking     *string         `json:"thinking"`
	Enabled      *bool           `json:"enabled"`
}

// 思考档位（Agent.Thinking）。default 是请求里不带任何思考参数，交给模型自己的默认。
const (
	ThinkingDefault = "default"
	ThinkingOff     = "off"
	ThinkingLow     = "low"
	ThinkingMedium  = "medium"
	ThinkingHigh    = "high"
)

// ThinkingLevels 是 Agent.Thinking 的可选值，按界面下拉的顺序。
var ThinkingLevels = []string{ThinkingDefault, ThinkingOff, ThinkingLow, ThinkingMedium, ThinkingHigh}

// AgentSessionFilter 决定列出哪一批会话。
//
// 两个字段互斥，且**不能都不给就返回全部**——抽屉里混进底部对话框的记录，
// 或者底部混进各个对象的对话，都是「看起来有内容，但不是这里该有的内容」。
// 调用方必须明确说自己要哪一批。
type AgentSessionFilter struct {
	// ObjectID 非空：只要挂在这个工作对象上的（详情抽屉用）。
	ObjectID string
	// Unscoped：只要 object_id IS NULL 的全局会话（底部对话框用）。
	// 命名沿用 ObjectFilter.Uncategorized 的先例——同样是「那一列为 NULL」这件事，
	// 同一个仓库里同一种语义用同一种表达。
	Unscoped bool
}

const (
	RoleUser      = "user"
	RoleAssistant = "assistant"
	RoleTool      = "tool"
	// RoleNotice 是会话里给人看的系统提示（如「已切换到 X」，TSK-0720），不进模型的上下文。
	RoleNotice = "notice"
)

type AgentMessage struct {
	ID        string `json:"id"`
	SessionID string `json:"session_id"`
	Role      string `json:"role"`
	Content   string `json:"content"`
	// ToolName / ToolArgs 仅 role=tool 时有值，用于在界面上回放 Agent 做了什么。
	ToolName string `json:"tool_name,omitempty"`
	ToolArgs string `json:"tool_args,omitempty"`
	// ProviderID / Model 是这条助手回复（和换模型的提示）当时用的服务商和模型（0053，TSK-0720）；别的角色和 0053 之前的为空，不出现。
	ProviderID string    `json:"provider_id,omitempty"`
	Model      string    `json:"model,omitempty"`
	CreatedAt  time.Time `json:"created_at"`
}

// Artifact 是一件输出产物：这项工作实际产出的、能被打开的东西。
//
// 它取代了 0007 的 AgentArtifact（只覆盖内置 agent 写的本地文件）。改成一等对象是因为
// 「这件事一共产出了什么」的答案分散在四处：内置 agent 写盘、Claude Code 执行时写盘、
// 用户自己做的文档、别的 agent 发到 Confluence/Jira/云盘的东西。只统计其中一个来源，
// 得到的数字不会报错也不会为空，只是偏小——而偏小的数字看起来和正确的一模一样。
//
// Path 和 URL 可以同时有值：先在本地写出方案、再发到 Confluence，那是同一份交付物的
// 两个位置。拆成两条会让总数翻倍。至少有一个非空，由库里的 CHECK 兜底。
type Artifact struct {
	ID string `json:"id"`
	// ObjectID 可空。底部对话框产生的产物没有归属对象；工作对象被硬删后，
	// 产物也会落到未归属（ON DELETE SET NULL，见 0012 迁移）。
	ObjectID  *string `json:"object_id"`
	SessionID *string `json:"session_id"`
	RunID     *string `json:"run_id"`

	Title string `json:"title"`
	// Path 是绝对路径。BaseDir 是登记时的基准目录（可空），相对路径由两者现算，
	// 不落库——存两个路径字符串的话，文件挪窝时改一个漏一个，两边都不会报错。
	Path     string `json:"path"`
	BaseDir  string `json:"base_dir"`
	URL      string `json:"url"`
	Platform string `json:"platform"` // dict_items(dict_id='artifact_platform').key
	// Size 仅本地文件有意义。云端产物是 0，不代表「空文件」——统计体积时要按
	// Path 非空过滤，否则一堆 0 会把平均值拉垮。
	Size   int64  `json:"size"`
	Source string `json:"source"` // manual | agent | run | mcp
	Note   string `json:"note"`

	// 以下是 0031 加的溯源列，见 docs/file-artifact-model.md 第 4 节。
	// Kind 是字典 artifact_kind 的 key，Status 空表示不跟踪。
	// Actor* 是产出者，可由调用方声明，只用来展示和筛选；可信统计只认 Source。
	// ScopeType + ScopeID 是不是工作对象的归属（知识库、视频等），空串表示没有。
	Kind       string         `json:"kind"`
	Status     string         `json:"status"`
	ActorType  string         `json:"actor_type"`
	ActorID    string         `json:"actor_id"`
	ActorLabel string         `json:"actor_label"`
	ScopeType  string         `json:"scope_type"`
	ScopeID    string         `json:"scope_id"`
	Props      map[string]any `json:"props"`

	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`

	// 以下为查询时填充的展示字段，不落 artifacts 表。
	// RelPath = Rel(BaseDir, Path)，BaseDir 为空时等于 Path。
	RelPath     string `json:"rel_path"`
	ObjectRef   string `json:"object_ref,omitempty"`
	ObjectTitle string `json:"object_title,omitempty"`
	// DisplayKind = Kind，Kind 为空（历史登记）时按备注、链接、扩展名推断（TSK-0497，见 artifactkind.go）。
	DisplayKind string `json:"display_kind"`
}

// ArtifactSource 的取值。放常量而不是各处写字面量：统计页要按来源分组，
// 写错一个字母不会报错，只会凭空多出一个永远是 0 的分组。
const (
	ArtifactSourceManual = "manual" // 用户在界面上登记
	ArtifactSourceAgent  = "agent"  // 内置 agent 的 write_file
	ArtifactSourceRun    = "run"    // Claude Code 执行后扫目录扫出来的
	ArtifactSourceMCP    = "mcp"    // 别的 agent 通过 MCP 回写
)

// ArtifactActor 的取值（actor_type）。和 source 不同，这一列可由调用方声明。
const (
	ActorUser  = "user"
	ActorAgent = "agent"
	ActorSkill = "skill"
	ActorSOP   = "sop"
	ActorRun   = "run"
	ActorMCP   = "mcp"
	ActorIM    = "im"
	ActorSync  = "sync"
)

// ArtifactInput 是登记一条产物需要的全部字段。
// 不复用 Artifact：那里面有 ID、时间戳和派生字段，让调用方填一堆它不该关心的东西。
type ArtifactInput struct {
	ObjectID  *string `json:"object_id"`
	SessionID *string `json:"session_id"`
	RunID     *string `json:"run_id"`
	Title     string  `json:"title"`
	Path      string  `json:"path"`
	BaseDir   string  `json:"base_dir"`
	URL       string  `json:"url"`
	Platform  string  `json:"platform"`
	Size      int64   `json:"size"`
	Source    string  `json:"source"`
	Note      string  `json:"note"`

	Kind       string         `json:"kind"`
	Status     string         `json:"status"`
	ActorType  string         `json:"actor_type"` // 空时按 source 推
	ActorID    string         `json:"actor_id"`
	ActorLabel string         `json:"actor_label"`
	ScopeType  string         `json:"scope_type"`
	ScopeID    string         `json:"scope_id"`
	Props      map[string]any `json:"props"`
}

// ArtifactPatch 里每个指针都是「没给就不改」。
// ObjectID 用 **string：nil = 不改，指向 nil = 清空归属，指向值 = 改挂到那个对象。
// 少这一层的话，「把产物移出某个对象」和「不动它」在 JSON 里长得一模一样。
type ArtifactPatch struct {
	ObjectID **string `json:"object_id"`
	Title    *string  `json:"title"`
	Path     *string  `json:"path"`
	BaseDir  *string  `json:"base_dir"`
	URL      *string  `json:"url"`
	Platform *string  `json:"platform"`
	Note     *string  `json:"note"`

	Kind      *string         `json:"kind"`
	Status    *string         `json:"status"`
	ScopeType *string         `json:"scope_type"`
	ScopeID   *string         `json:"scope_id"`
	Props     *map[string]any `json:"props"` // 整体替换
}

// ArtifactFilter 的字段之间是「与」。空字段 = 不过滤。
//
// 注意 ObjectID 和 Unscoped 的关系跟 AgentSessionFilter 不同：这里两个都不给
// 就是**全部产物**，因为产物页的默认视图就是全量清单。Unscoped 单独表示
// 「只看未归属的那些」。
type ArtifactFilter struct {
	ObjectID  string
	SessionID string
	RunID     string
	Platform  string
	Source    string
	// 0031 的溯源列，空 = 不过滤。ScopeID 只在给了 ScopeType 时生效。
	Kind      string
	Status    string
	ActorType string
	ActorID   string
	ScopeType string
	ScopeID   string
	// HasURL / HasPath 是三态：nil 不过滤，true 要求非空，false 要求为空。
	// 「只看云端产物」= HasURL(true)，「只看还没发出去的本地文件」= HasURL(false)。
	HasURL   *bool
	HasPath  *bool
	Q        string // 匹配 title / path / url / note
	Unscoped bool   // 只看没有归属对象的
	// 以下是 TSK-0497 加的：登记时间区间（含两端），归属对象的类型和所属项目。
	// ProjectID 为 "-" 时是「归属对象不属于任何项目」。
	Since      *time.Time
	Until      *time.Time
	ObjectType string
	ProjectID  string
	Limit      int
	Offset     int
}

// ArtifactStats 是产物页顶部那几个数。
//
// 每个分组都用 map 而不是切片：key 是字典 key / 来源常量，前端要按字典顺序渲染，
// 而字典顺序只有前端知道（它已经拿着 dict_items）。后端排一遍等于把顺序定义
// 复制到第二个地方。
type ArtifactStats struct {
	Total int `json:"total"`
	// Local 是有本地路径的条数，Remote 是有 URL 的条数。两者相加可能大于 Total——
	// 一份既在本地又发了云端的产物两边都算。这是有意的：它回答的是
	// 「有多少产物落在本地」和「有多少已经发出去了」，不是一次划分。
	Local      int            `json:"local"`
	Remote     int            `json:"remote"`
	Unscoped   int            `json:"unscoped"`
	ByPlatform map[string]int `json:"by_platform"`
	BySource   map[string]int `json:"by_source"`
	ByKind     map[string]int `json:"by_kind"` // 未分类的记在 "" 下
	// TotalSize 只累加有本地路径的那些，理由见 Artifact.Size。
	TotalSize int64 `json:"total_size"`
}

// WorkdirCheck 是目录可用性的检查结果，界面在用户选目录时即时反馈。
type WorkdirCheck struct {
	Path     string `json:"path"`
	Exists   bool   `json:"exists"`
	IsDir    bool   `json:"is_dir"`
	Writable bool   `json:"writable"`
	Message  string `json:"message"`
}

// ---- 目录浏览：让界面能选本机文件夹 ----
//
// 浏览器拿不到本地绝对路径（File System Access API 只给 handle 不给 path，
// webkitdirectory 给的是相对名），所以目录选择必须由服务端提供列表。
// 只列目录、不读文件内容——这是个选路径的接口，不是文件管理器。

type FsEntry struct {
	Name  string `json:"name"`
	Path  string `json:"path"`
	IsDir bool   `json:"is_dir"`
	// Writable 只对目录有意义，界面据此决定能不能选。
	Writable bool `json:"writable"`
}

type FsListing struct {
	Path     string     `json:"path"`
	Parent   string     `json:"parent"` // 已在根目录时为空串
	Root     string     `json:"root"`   // 所在的可浏览根（最外层那个），界面据此画面包屑（FS-01）
	Writable bool       `json:"writable"`
	Entries  []*FsEntry `json:"entries"`
}

// FsShortcut 是目录选择器的起跳点，省得用户从 / 一层层点下来。
type FsShortcut struct {
	Label string `json:"label"`
	Path  string `json:"path"`
}

// ---- 用本机 Claude Code 执行任务 ----

const (
	RunPending  = "pending"
	RunRunning  = "running"
	RunDone     = "done"
	RunFailed   = "failed"
	RunCanceled = "canceled"
	// RunWaiting 是交给工作台 Agent 的执行（TSK-0460）停在要人确认的写操作上：没结束（finished_at 为空），
	// 确认、拒绝或等待超时后回到 running。只有 harness=agent 的执行会进这个状态
	RunWaiting = "waiting"
)

// 执行方式（0048）。stream 是工作台起子进程、流式回推；terminal 是在工作台的终端里开交互式会话，
// 进程不归工作台管，结束和结论由终端里的 claude 经 MCP 回写（POST /api/runs/{id}/finish），或用户手动标记。
const (
	RunModeStream   = "stream"
	RunModeTerminal = "terminal"
)

// TaskRun 是一次「把某个工作对象交给一个 agent 执行器去做」的执行记录。
// 留存完整输出而不只是成功失败：这类执行的价值在过程，事后要能复查它到底改了什么。
type TaskRun struct {
	ID         string     `json:"id"`
	ObjectID   string     `json:"object_id"`
	Workdir    string     `json:"workdir"`
	Prompt     string     `json:"prompt"`
	Status     string     `json:"status"`
	ExitCode   int        `json:"exit_code"`
	Output     string     `json:"output"`
	Error      string     `json:"error"`
	StartedAt  time.Time  `json:"started_at"`
	FinishedAt *time.Time `json:"finished_at"`
	// Mode 是执行方式 RunModeStream / RunModeTerminal（0048），老记录都是 stream
	Mode string `json:"mode"`
	// Harness 是这次交给谁跑（0049）：RunHarnessClaude / RunHarnessDeepSeek，
	// 老记录都是 claude。只用于留档与展示，不参与收尾判定。
	Harness string `json:"harness"`
	// HarnessSession 是 dsh 这次用的会话 id（0050）。带上它再跑一次就是续跑；
	// claude 没有这个概念，留空串。harness=agent 时是 Agent 会话 id（TSK-0460），能打开会话接着聊。
	HarnessSession string `json:"harness_session"`
}

// 执行器。值必须和 internal/runner 的 Harness 常量逐字一致——
// 那边决定起哪个进程，这边只负责把它记下来。
const (
	RunHarnessClaude   = "claude"   // 本机 claude CLI
	RunHarnessDeepSeek = "deepseek" // deepseek-harness（dsh）的 headless 模式
	// RunHarnessAgent 是工作台自己的 Agent（TSK-0460）：在工作台进程里跑 internal/agent 的工具循环，
	// 不起外部进程；HarnessSession 记的是这次用的 Agent 会话 id
	RunHarnessAgent = "agent"
)

// ---- 开发任务闭环：进展、领取、会话标识 ----

// ActorSessionSep 分隔 revisions.actor 里的操作者名和会话标识。
//
// 会话标识不单独建列：revisions.actor 本来就是「谁干的」，「哪一次会话干的」是它的细化，
// 塞进同一列就不用为它加迁移。代价是读的时候要拆——拆分只在 SplitActor 一处做，
// 写入端（store 的 addRevision）也只经由 ComposeActor 拼，两头对得上。
// 名字和会话标识在 API 入口都做过清洗，不可能含有这个分隔符。
const ActorSessionSep = "#"

// ComposeActor 把操作者名和会话标识拼成落库的 actor 值。session 为空时就是名字本身，
// 和 0001 以来的老数据形状一致。
func ComposeActor(name, session string) string {
	if session == "" {
		return name
	}
	return name + ActorSessionSep + session
}

// SplitActor 是 ComposeActor 的逆。没有分隔符的老数据整串当名字，会话为空。
func SplitActor(actor string) (name, session string) {
	if i := strings.Index(actor, ActorSessionSep); i >= 0 {
		return actor[:i], actor[i+len(ActorSessionSep):]
	}
	return actor, ""
}

// 开发任务在 objects.props 里的约定字段。
//
// 验收标准、关联仓库不加列：props 本来就是「类型相关的自定义字段」的落点（0001 就有），
// 加列意味着迁移，而这两个字段只有开发类任务才用得上。工作目录已经有 objects.workdir（0008），
// 不再在 props 里重复一份。
//
// key 写成常量是因为它同时被 MCP、前端和演练脚本读写——拼错一个字母不会报错，
// 只会让那个字段在另一端永远是空的。
const (
	// PropAcceptance 是验收标准，Markdown 字符串，一般是一串「- [ ] ...」。
	PropAcceptance = "acceptance"
	// PropRepo 是关联仓库：远端地址（https://github.com/...）或本机绝对路径。
	// 只放一个值。真有多个仓库的任务，应当拆成每个仓库一条子任务。
	PropRepo = "repo"
	// PropSourceRef 是来源详情，对象（map）。来源种类在 objects.source 列，
	// 这里放对应的 id：message_id、hook_id + delivery_id、schedule_id、incident_id。
	PropSourceRef = "source_ref"
)

// 任务来源，落在 objects.source。和原型 TaskSource.kind 一一对应。
// 不用 inbox：那是收件箱口径（Counts.Inbox、ObjectFilter.Inbox）在用的值。
const (
	TaskSourceManual   = "manual"   // 手动新建
	TaskSourceIM       = "im"       // IM 消息转的
	TaskSourceWebhook  = "webhook"  // Webhook 投递建的
	TaskSourceSchedule = "schedule" // 定时任务建的
	TaskSourceIncident = "incident" // 异常转的
)

// FieldProgress 是进展在 revisions 里的 field 值。
//
// 进展复用 revisions 而不是另建表：它和修订一样是「只追加、带操作者、按时间读」的流水，
// 只插入不更新，并发追加天然不会互相覆盖。一条进展 = 一行 field='progress' 的修订，
// new_value 是正文（Markdown），old_value 存元数据 JSON（ProgressMeta）。
// old_value 在这类行上不是「旧值」——这是复用的代价，只在这里和 docs/api-contract.md「进展与领取」一节里说明。
const FieldProgress = "progress"

// 进展的种类。claim / review 由领取和提交验收接口写，note 是普通进展。
const (
	ProgressNote   = "note"
	ProgressClaim  = "claim"
	ProgressReview = "review"
)

// ProgressMeta 是进展行 old_value 里的 JSON。字段都可空，空的不序列化，
// 省得每条普通进展都背一串空数组。
type ProgressMeta struct {
	Kind    string   `json:"kind"`
	Commits []string `json:"commits,omitempty"`
	Files   []string `json:"files,omitempty"`
	// Status 是这条进展顺带把对象切到的状态（领取、提交验收时有值）。
	Status string `json:"status,omitempty"`
}

// Progress 是一条进展。
type Progress struct {
	ID       string   `json:"id"`
	ObjectID string   `json:"object_id"`
	Kind     string   `json:"kind"`
	Text     string   `json:"text"`
	Commits  []string `json:"commits"`
	Files    []string `json:"files"`
	Status   string   `json:"status"`
	// Actor 是原文，ActorName / SessionID 是拆出来的两段，和 Revision 一致。
	Actor     string    `json:"actor"`
	ActorName string    `json:"actor_name"`
	SessionID string    `json:"session_id"`
	Source    string    `json:"source"`
	CreatedAt time.Time `json:"created_at"`
}

// ProgressInput 是追加一条进展的入参。
//
// Status 非空时，这条进展和状态切换在同一个事务里落库：提交验收要的就是
// 「状态变了」和「附了总结」同时成立，分两次请求的话中间失败会留下半截。
type ProgressInput struct {
	Kind    string   `json:"kind"`
	Text    string   `json:"text"`
	Commits []string `json:"commits"`
	Files   []string `json:"files"`
	Status  string   `json:"status"`
}

// ClaimInput 是领取任务的入参。
type ClaimInput struct {
	// OwnerID 是领取者在干系人名册里的 id，必填。
	OwnerID string `json:"owner_id"`
	// Status 是领取后切到的状态 key。空串时取该类型的 doing，类型里没有 doing 就报 400。
	Status string `json:"status"`
	Text   string `json:"text"`
	// Takeover 为 true 时允许接手别人（或别的会话）正在做的任务。
	// 只该在用户明确要求时传，默认拒绝。
	Takeover bool `json:"takeover"`
}

// ClaimResult 是领取的结果。Already 为 true 表示同一会话重复领取，什么都没写。
type ClaimResult struct {
	Object   *Object   `json:"object"`
	Progress *Progress `json:"progress"`
	Already  bool      `json:"already"`
}
