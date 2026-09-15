// 与 internal/domain/domain.go 一一对应。改动需同步后端与 docs/api-contract.md。

export interface Status {
  key: string
  label: string
  color: string
  terminal: boolean
}

export interface ObjectType {
  id: string
  name: string
  plural: string
  ref_prefix: string
  icon: string
  color: string
  builtin: boolean
  sort_order: number
  statuses: Status[]
  created_at: string
  updated_at: string
}

export interface Category {
  id: string
  type_id: string
  parent_id: string | null
  name: string
  slug: string
  path: string
  depth: number
  color: string
  description: string
  sort_order: number
  created_at: string
  updated_at: string
  count: number
  total_count: number
  children?: Category[]
}

export interface WorkObject {
  id: string
  type_id: string
  ref: string
  title: string
  body: string
  status: string
  priority: string
  owner: string
  category_id: string | null
  project_id: string | null
  source: string
  props: Record<string, unknown>
  /** 该对象的专属工作区目录；任务没设时向上取所属项目的 */
  workdir: string
  due_at: string | null
  started_at: string | null
  completed_at: string | null
  archived_at: string | null
  deleted_at: string | null
  created_at: string
  updated_at: string
  tags: string[]
  category_name?: string
  category_path?: string
  /** 分类色，后端 denormalize 自 categories.color；跨类型列表里也能拿到，不必回分类树查 */
  category_color?: string
  project_title?: string
  link_count: number
}

export interface Tag {
  id: string
  name: string
  color: string
  count: number
  created_at: string
}

export interface Link {
  id: string
  from_id: string
  to_id: string
  relation: string
  note: string
  created_at: string
}

export interface LinkView extends Link {
  direction: 'out' | 'in'
  peer: WorkObject | null
}

export interface Revision {
  id: string
  object_id: string
  field: string
  old_value: string
  new_value: string
  actor: string
  source: string
  created_at: string
}

export interface Counts {
  /** key 是 object_types.id */
  by_type: Record<string, number>
  /** key 是复合形式 `<type_id>:<status>`，如 `requirement:doing`；不同类型的状态集有重名，不能用裸 status */
  by_status: Record<string, number>
  /** key 是 object_types.id，值为该类型下未分类的对象数，供侧栏「未分类」行显示徽标 */
  uncategorized_by_type: Record<string, number>
  inbox: number
  today: number
  week: number
  overdue: number
  stalled: number
  total: number
}

export interface Stats {
  db_path: string
  db_size: number
  objects: number
  last_write: string | null
  version: string
}

export interface ObjectQuery {
  type?: string[]
  category?: string
  subtree?: boolean
  /** 只看未分类的对象，与 category 互斥 */
  uncategorized?: boolean
  status?: string[]
  priority?: string[]
  tag?: string[]
  owner?: string
  project?: string
  q?: string
  due_after?: string
  due_before?: string
  overdue?: boolean
  /** N 天未更新且未进终态 */
  stalled?: boolean
  /** 排除终态对象 */
  not_terminal?: boolean
  inbox?: boolean
  archived?: boolean
  deleted?: boolean
  sort?: string
  limit?: number
  offset?: number
}

export interface ObjectPatch {
  workdir?: string
  title?: string
  body?: string
  status?: string
  priority?: string
  owner?: string
  category_id?: string | null
  project_id?: string | null
  source?: string
  props?: Record<string, unknown>
  due_at?: string | null
  tags?: string[]
  archived?: boolean
}

export interface CreateObjectInput extends ObjectPatch {
  type_id: string
  title: string
}

export interface CategoryInput {
  type_id: string
  parent_id?: string | null
  name: string
  slug?: string
  color?: string
  description?: string
  sort_order?: number
}

export type ViewMode = 'list' | 'board' | 'table' | 'calendar' | 'timeline'

// ---- 快捷访问 ----

export type ShortcutTargetKind = 'url' | 'internal' | 'command'

export interface Shortcut {
  id: string
  group_id: string | null
  label: string
  target_kind: ShortcutTargetKind
  url: string
  nav: string // NavSelection 的 JSON 字符串
  command: string
  icon: string
  color: string
  description: string
  open_in: 'new_tab' | 'same_tab'
  pinned: boolean
  sort_order: number
  last_used_at: string | null
  use_count: number
  created_at: string
  updated_at: string
}

export interface ShortcutGroup {
  id: string
  name: string
  color: string
  collapsed: boolean
  sort_order: number
  created_at: string
  updated_at: string
  items?: Shortcut[]
}

export interface ShortcutInput {
  group_id?: string | null
  label: string
  target_kind: ShortcutTargetKind
  url?: string
  nav?: string
  command?: string
  icon?: string
  color?: string
  description?: string
  open_in?: 'new_tab' | 'same_tab'
  pinned?: boolean
  sort_order?: number
}

export interface ShortcutGroupInput {
  name: string
  color?: string
  collapsed?: boolean
  sort_order?: number
}

// ---- 字典：可配置枚举 ----

export interface DictItem {
  id: string
  dict_id: string
  type_id: string | null
  /** 落在业务表里的值（如 objects.priority），一经创建不可改 */
  key: string
  label: string
  color: string
  description: string
  sort_order: number
  meta: Record<string, unknown>
  archived_at: string | null
  created_at: string
  updated_at: string
  /** 被多少条业务数据引用，按需填充 */
  usage: number
}

export interface Dictionary {
  id: string
  name: string
  description: string
  scope: 'global' | 'type'
  builtin: boolean
  sort_order: number
  created_at: string
  updated_at: string
  items?: DictItem[]
}

export interface DictItemInput {
  key: string
  label: string
  color?: string
  description?: string
  sort_order?: number
  meta?: Record<string, unknown>
  type_id?: string | null
}

/** 不含 key：枚举值一经创建不可改 */
export interface DictItemPatch {
  label?: string
  color?: string
  description?: string
  sort_order?: number
  meta?: Record<string, unknown>
}

// ---- Agent 供应商 ----

export type ProviderKind = 'openai' | 'gemini' | 'ollama'

export interface AgentProvider {
  id: string
  name: string
  kind: ProviderKind
  base_url: string
  model: string
  enabled: boolean
  is_default: boolean
  /** 形如 sk-…abcd，仅用于显示「已配置」；后端从不返回原文 */
  api_key_masked: string
  has_api_key: boolean
  extra: Record<string, unknown>
  created_at: string
  updated_at: string
}

export interface AgentProviderInput {
  name?: string
  kind?: ProviderKind
  base_url?: string
  model?: string
  enabled?: boolean
  /** 只写字段：不传=不改，传空串=清除 */
  api_key?: string
  extra?: Record<string, unknown>
}

export interface ProviderTestResult {
  ok: boolean
  latency_ms: number
  message: string
  models?: string[]
}

// ---- 数据与备份 ----

export interface MigrationRecord {
  version: string
  checksum: string
  applied_at: string
}

export interface BackupInfo {
  path: string
  size: number
  created_at: string
}

// ---- Agent 对话 ----

export interface AgentSession {
  id: string
  title: string
  provider_id: string
  model: string
  /** 本次对话的产物落盘目录，Agent 写文件只能落在它下面 */
  workdir: string
  created_at: string
  updated_at: string
  message_count: number
}

export interface AgentMessage {
  id: string
  session_id: string
  role: 'user' | 'assistant' | 'tool'
  content: string
  tool_name?: string
  tool_args?: string
  created_at: string
}

export interface AgentArtifact {
  id: string
  session_id: string
  /** 相对 workdir 的路径 */
  path: string
  size: number
  created_at: string
}

export interface WorkdirCheck {
  path: string
  exists: boolean
  is_dir: boolean
  writable: boolean
  message: string
}

/** SSE 事件：对话框按 type 分别渲染 */
export type AgentStreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'tool_call'; name: string; args: string }
  // object_id 是内部 id（用于 select 跳转），不是 REQ-0012 这种人读编号——
  // 人读编号已经在 summary 里了。字段名早先叫 object_ref 造成过歧义，故改名。
  | { type: 'tool_result'; name: string; summary: string; object_id?: string }
  | { type: 'artifact'; path: string; size: number }
  | { type: 'done'; session_id: string; message_id: string }
  | { type: 'error'; message: string }

// ---- 目录浏览 ----

export interface FsEntry {
  name: string
  path: string
  is_dir: boolean
  writable: boolean
}

export interface FsListing {
  path: string
  /** 已在根目录时为空串 */
  parent: string
  writable: boolean
  entries: FsEntry[]
}

export interface FsShortcut {
  label: string
  path: string
}

// ---- 用本机 Claude Code 执行任务 ----

export type TaskRunStatus = 'pending' | 'running' | 'done' | 'failed' | 'canceled'

export interface TaskRun {
  id: string
  object_id: string
  workdir: string
  prompt: string
  status: TaskRunStatus
  exit_code: number
  output: string
  error: string
  started_at: string
  finished_at: string | null
}

/**
 * 执行流事件。形状取自 internal/runner 的 Event.MarshalJSON——那是唯一的真相，
 * 改这里之前先去看那个 switch。
 *
 * tool 与 tool_result 是两条事件，靠 id 配对，不是一条带结果的事件：
 * 一次 Bash 可能跑 60 秒，合成一条就得等结果回来才发，那段时间界面是空的。
 * 分开还有一个好处——执行被取消时，已发出的 tool 收不到配对的 tool_result，
 * 界面上它停在「进行中」，这是诚实的；合成一条的话它会整个消失，
 * 用户看不出 claude 当时卡在哪一步。
 *
 * tool_result 上的 name 是后端用 id 对照表补的（原始 JSON 那行只有 tool_use_id），
 * 所以漏了配对也能独立渲染成一行，不会出现「某个工具 成功」。
 */
export type TaskRunEvent =
  | { type: 'start'; run_id: string; workdir: string }
  | { type: 'delta'; text: string }
  | { type: 'tool'; id: string; name: string; detail: string }
  | { type: 'tool_result'; id: string; name: string; ok: boolean; error: string }
  | { type: 'done'; run_id: string; exit_code: number }
  | { type: 'error'; message: string }

/** POST /api/objects/{id}/run 的请求体 */
export interface TaskRunRequest {
  /** 留空则用对象自己的 workdir；两边都空时后端拒绝执行 */
  workdir?: string
  extra_prompt?: string
  /**
   * 允许 claude 修改文件（后端译成 --permission-mode acceptEdits）。
   * 默认 false：只读跑一遍看它打算做什么，是比「先改了再说」安全的默认值。
   */
  allow_writes?: boolean
}
