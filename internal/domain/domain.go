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

	// 以下为查询时填充的展示字段，不落 stakeholders 表。
	// OwnedCount / ParticipatingCount 是删除前的确认依据，也是名册页上的「他手上有多少事」。
	OwnedCount         int `json:"owned_count"`
	ParticipatingCount int `json:"participating_count"`
}

type StakeholderPatch struct {
	Name      *string `json:"name"`
	Role      *string `json:"role"`
	Email     *string `json:"email"`
	Note      *string `json:"note"`
	Color     *string `json:"color"`
	SortOrder *int    `json:"sort_order"`
	Archived  *bool   `json:"archived"`
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
	// 两种筛法并存的话，「宋一杰、李钊、振华」这条按文本能搜到、按 id 搜不到，
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
	NotTerminal     bool
	Inbox           bool // source='inbox' 或未分类
	IncludeArchived bool
	IncludeDeleted  bool
	Sort            string // updated_at|created_at|due_at|priority|title，前缀 - 表示倒序
	Limit           int
	Offset          int
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

// ---- Agent 供应商：接入 OpenAI 兼容 / Gemini / 本地 Ollama ----

const (
	ProviderOpenAI = "openai" // OpenAI 及一切 /v1/chat/completions 兼容端点（DeepSeek、Moonshot、vLLM…）
	ProviderGemini = "gemini"
	ProviderOllama = "ollama" // 本地，不需要 api_key
)

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

	MessageCount int `json:"message_count"`
}

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
)

type AgentMessage struct {
	ID        string `json:"id"`
	SessionID string `json:"session_id"`
	Role      string `json:"role"`
	Content   string `json:"content"`
	// ToolName / ToolArgs 仅 role=tool 时有值，用于在界面上回放 Agent 做了什么。
	ToolName  string    `json:"tool_name,omitempty"`
	ToolArgs  string    `json:"tool_args,omitempty"`
	CreatedAt time.Time `json:"created_at"`
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
	Size      int64     `json:"size"`
	Source    string    `json:"source"` // manual | agent | run | mcp
	Note      string    `json:"note"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`

	// 以下为查询时填充的展示字段，不落 artifacts 表。
	// RelPath = Rel(BaseDir, Path)，BaseDir 为空时等于 Path。
	RelPath     string `json:"rel_path"`
	ObjectRef   string `json:"object_ref,omitempty"`
	ObjectTitle string `json:"object_title,omitempty"`
}

// ArtifactSource 的取值。放常量而不是各处写字面量：统计页要按来源分组，
// 写错一个字母不会报错，只会凭空多出一个永远是 0 的分组。
const (
	ArtifactSourceManual = "manual" // 用户在界面上登记
	ArtifactSourceAgent  = "agent"  // 内置 agent 的 write_file
	ArtifactSourceRun    = "run"    // Claude Code 执行后扫目录扫出来的
	ArtifactSourceMCP    = "mcp"    // 别的 agent 通过 MCP 回写
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
	// HasURL / HasPath 是三态：nil 不过滤，true 要求非空，false 要求为空。
	// 「只看云端产物」= HasURL(true)，「只看还没发出去的本地文件」= HasURL(false)。
	HasURL   *bool
	HasPath  *bool
	Q        string // 匹配 title / path / url / note
	Unscoped bool   // 只看没有归属对象的
	Limit    int
	Offset   int
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
)

// TaskRun 是一次「把某个工作对象交给本机 claude 去做」的执行记录。
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
}

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
