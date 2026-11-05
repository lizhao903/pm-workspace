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
  /** 0010 之前的自由文本负责人，**只读**。新写入一律走 owner_id */
  owner: string
  owner_id: string | null
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
  /** owner_id 指向的干系人名字；owner_id 为空时回退到 owner 文本 */
  owner_name?: string
  /** 参与人。只带渲染需要的三个字段，不是完整 Stakeholder */
  participants: StakeholderRef[]
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
  /** 按干系人 id 筛负责人。0010 起取代了原来的 owner 文本匹配——
   *  一个语义只留一个定义，否则「示例甲、示例乙、示例丙」按文本搜得到、按 id 搜不到 */
  owner_id?: string
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
  /** 空串 = 清空负责人 */
  owner_id?: string
  /** 全量替换：省略 = 不改，空数组 = 清空 */
  participant_ids?: string[]
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
  /** null = 全局会话（底部对话框）；有值 = 只属于那个工作对象的「AI 助手」页签 */
  object_id: string | null
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

/**
 * Artifact 是一件输出产物：这项工作实际产出的、能被打开的东西。
 *
 * 取代了原来的 AgentArtifact（只记内置 Agent 写的本地文件）。改成一等对象是因为
 * 「这件事一共产出了什么」的答案分散在四处：内置 Agent 写盘、Claude Code 执行时写盘、
 * 用户手工登记、别的 Agent 通过 MCP 回写。只统计其中一个来源，得到的数字不会报错、
 * 不会为空，只是偏小——而偏小的数字看起来和正确的一模一样。
 */
export interface Artifact {
  id: string
  /** 可空：底部对话框产生的产物没有归属；工作对象被硬删后产物也会落到未归属 */
  object_id: string | null
  session_id: string | null
  run_id: string | null
  title: string
  /** 绝对路径。和 url **可以同时有值**：先在本地写出方案、再发到 Confluence，
   *  那是同一份交付物的两个位置，拆成两条会让产物总数翻倍。两者至少有一个非空。 */
  path: string
  /** path 的基准目录，可空 */
  base_dir: string
  url: string
  /** 字典 artifact_platform 的 key */
  platform: string
  /** 字节数。仅本地文件有意义，云端产物恒为 0——不代表「空文件」 */
  size: number
  source: ArtifactSource
  note: string
  created_at: string
  updated_at: string

  /** 后端现算的派生字段，**不接受写入**。base_dir 为空或文件已不在其下时等于 path */
  rel_path: string
  object_ref?: string
  object_title?: string
}

export type ArtifactSource = 'manual' | 'agent' | 'run' | 'mcp'

/** 各来源的显示名。用 Record 而不是普通对象：漏掉一个 source 时 tsc 会红，
 *  而漏掉的后果是统计页上出现一个没有名字的分组。 */
export const ARTIFACT_SOURCE_LABELS: Record<ArtifactSource, string> = {
  manual: '手工登记',
  agent: 'AI 助手',
  run: '任务执行',
  mcp: '外部工具',
}

/** POST /api/artifacts 的请求体。source 由后端强制为 manual，这里不给。 */
export interface ArtifactInput {
  object_id?: string | null
  title?: string
  path?: string
  base_dir?: string
  url?: string
  platform?: string
  note?: string
}

/**
 * PATCH 的 object_id 是三态：字段不出现 = 不改，null = 解除归属，有值 = 改挂过去。
 * 用 '' 表达清空是不行的——它会被当成一个不存在的对象 id。
 * 所以这里是 `string | null | undefined`，而 undefined 必须真的不出现在 JSON 里
 * （见 api.ts 的 updateArtifact）。
 */
export interface ArtifactPatch {
  object_id?: string | null
  title?: string
  path?: string
  base_dir?: string
  url?: string
  platform?: string
  note?: string
}

export interface ArtifactFilter {
  object_id?: string
  session_id?: string
  run_id?: string
  platform?: string
  source?: ArtifactSource
  /** 三态：不传 = 不过滤，false = 「还没发出去的本地文件」。
   *  用 `has_url?: boolean` 而不是 `has_url: boolean` 才能表达「不过滤」。 */
  has_url?: boolean
  has_path?: boolean
  q?: string
  /** 只看没有归属对象的。与 object_id 同时给后端报 400 */
  unscoped?: boolean
  limit?: number
  offset?: number
}

export interface ArtifactStats {
  total: number
  /**
   * local + remote 可能大于 total：一份既在本地又发了云端的产物两边都算。
   * 它回答的是「有多少落在本地」和「有多少已经发出去了」，不是一次互斥划分。
   */
  local: number
  remote: number
  unscoped: number
  by_platform: Record<string, number>
  by_source: Record<string, number>
  /** 只累加有本地路径的那些，云端产物的 size 恒为 0 */
  total_size: number
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
  // Agent 遇到拿不准的地方时反问，而不是自己猜一个答案继续做。
  //
  // 发出 question 后**本轮就结束**（后面紧跟 done），流不会挂在那里等回答。
  // 用户的回答走下一条普通的 chat 消息，没有单独的应答接口——这样即使前端
  // 没把它渲染成按钮，问题也仍然是一段看得懂的文字，回答仍然是一句普通的话。
  | { type: 'question'; id: string; question: string; options: QuestionOption[]; multi: boolean }
  | { type: 'done'; session_id: string; message_id: string }
  | { type: 'error'; message: string }

export interface QuestionOption {
  label: string
  /** 选这个意味着什么、有什么代价。只有 label 的选项等于在逼用户猜 */
  detail: string
}

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
  /** 这次交给谁跑：'claude'（本机 Claude Code）或 'deepseek'（deepseek-harness 的 headless 模式） */
  harness: string
  /** dsh 这次用的会话 id；勾「接着上次会话」时下一次会带上它。claude 的执行是空串 */
  harness_session: string
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
  /** 收尾时扫工作目录扫出来的产出，每登记一件一条，**在 done 之前发**。
   *  path 是相对 workdir 的路径。 */
  | { type: 'artifact'; artifact_id: string; path: string; size: number; is_new: boolean }

/** POST /api/objects/{id}/run 的请求体 */
export interface TaskRunRequest {
  /** 留空则用对象自己的 workdir；两边都空时后端拒绝执行 */
  workdir?: string
  extra_prompt?: string
  /**
   * 允许执行器修改文件。claude 译成 --permission-mode acceptEdits，
   * deepseek 译成 dsh 沙箱的 workspace-write。
   * 默认 false：只读跑一遍看它打算做什么，是比「先改了再说」安全的默认值。
   */
  allow_writes?: boolean
  /** 执行器：空或 'claude' 走本机 Claude Code，'deepseek' 走 deepseek-harness（dsh） */
  harness?: 'claude' | 'deepseek'
  /** 只在 harness='deepseek' 时用：把哪个模型服务商交给 dsh，空用默认服务商 */
  provider_id?: string
  /** 只在 harness='deepseek' 时用：接着这个对象上一次 dsh 会话继续跑（没有可续的会话时后端回 400） */
  resume_session?: boolean
}

// ---- 干系人名册 ----

/** 干系人的展示投影：够画一个头像加一个名字，仅此而已 */
export interface StakeholderRef {
  id: string
  name: string
  /**
   * 头像底色。**空串是常态不是异常**——0010 迁移建出来的人 color 全空，
   * 而那就是名册的初始全部内容。
   *
   * 空时由前端按名字哈希取色（`stakeholderColor()`），不要就地兜底成一个定值：
   * 头像在一列名字里的作用就是先靠颜色认人，全同色比没有头像更糟，
   * 因为它看起来像在传达信息。哈希只吃名字，排序/刷新/跨会话都得到同一个颜色。
   */
  color: string
}

export interface Stakeholder {
  id: string
  name: string
  role: string
  email: string
  note: string
  /** 见 StakeholderRef.color：空串走按名字哈希，不是兜底成定值 */
  color: string
  sort_order: number
  /** null = 在岗 */
  archived_at: string | null
  created_at: string
  updated_at: string
  /** 删除前的确认依据，也是名册页上的「他手上有多少事」 */
  owned_count: number
  participating_count: number
}

export interface StakeholderPatch {
  name?: string
  role?: string
  email?: string
  note?: string
  color?: string
  sort_order?: number
  archived?: boolean
}
