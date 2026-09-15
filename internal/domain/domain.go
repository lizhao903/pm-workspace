// Package domain 定义工作台的领域模型。这是前后端与各层之间的契约，改动需同步 web/src/lib/types.ts。
package domain

import "time"

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
	ID         string         `json:"id"`
	TypeID     string         `json:"type_id"`
	Ref        string         `json:"ref"`
	Title      string         `json:"title"`
	Body       string         `json:"body"`
	Status     string         `json:"status"`
	Priority   string         `json:"priority"`
	Owner      string         `json:"owner"`
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
}

type ObjectPatch struct {
	Title      *string         `json:"title"`
	Body       *string         `json:"body"`
	Status     *string         `json:"status"`
	Priority   *string         `json:"priority"`
	Owner      *string         `json:"owner"`
	CategoryID **string        `json:"category_id"` // 双指针：区分「不改」与「置空」
	ProjectID  **string        `json:"project_id"`
	Source     *string         `json:"source"`
	Props      *map[string]any `json:"props"`
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
	Owner           string
	ProjectID       string
	Query           string // 标题/正文 LIKE，M3 换 FTS5
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
	ID        string    `json:"id"`
	ObjectID  string    `json:"object_id"`
	Field     string    `json:"field"`
	OldValue  string    `json:"old_value"`
	NewValue  string    `json:"new_value"`
	Actor     string    `json:"actor"`
	Source    string    `json:"source"`
	CreatedAt time.Time `json:"created_at"`
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
	ID         string    `json:"id"`
	Title      string    `json:"title"`
	ProviderID string    `json:"provider_id"`
	Model      string    `json:"model"`
	Workdir    string    `json:"workdir"`
	CreatedAt  time.Time `json:"created_at"`
	UpdatedAt  time.Time `json:"updated_at"`

	MessageCount int `json:"message_count"`
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

// AgentArtifact 是 Agent 写进 Workdir 的一个文件。Path 存相对路径，
// 绝对路径由 Workdir 拼出来——库里存绝对路径的话，换机器或改目录就全失效了。
type AgentArtifact struct {
	ID        string    `json:"id"`
	SessionID string    `json:"session_id"`
	Path      string    `json:"path"`
	Size      int64     `json:"size"`
	CreatedAt time.Time `json:"created_at"`
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
