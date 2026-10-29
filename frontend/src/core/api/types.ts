// 后端返回的类型，按 docs/api-contract.md 和 internal/domain/domain.go 手写。
// 时间一律是 RFC3339 字符串，可空时间是 null。状态、类型、优先级的取值从后端读，这里只写 string。

export type Health = { ok: boolean; version: string }

// ---- 工作对象类型 ----

export type ObjectStatus = { key: string; label: string; color: string; terminal: boolean; /** 给人看的说明，设置的枚举值页里填；老数据没有 */ description?: string }

export type ObjectType = {
  id: string
  name: string
  plural: string
  ref_prefix: string
  icon: string
  color: string
  builtin: boolean
  sort_order: number
  statuses: ObjectStatus[]
  created_at: string
  updated_at: string
}

export type ObjectTypeInput = {
  id: string
  name: string
  plural: string
  ref_prefix: string
  icon?: string
  color?: string
  sort_order?: number
  statuses: ObjectStatus[]
}

// builtin 类型只允许改 icon / color / sort_order / statuses
export type ObjectTypePatch = Partial<Omit<ObjectTypeInput, 'id'>>

// ---- 干系人 ----

export type StakeholderRef = { id: string; name: string; color: string }

export type Stakeholder = {
  id: string
  name: string
  role: string
  email: string
  note: string
  color: string
  sort_order: number
  archived_at: string | null
  created_at: string
  updated_at: string
  owned_count: number
  participating_count: number
}

export type StakeholderInput = {
  name: string
  role?: string
  email?: string
  note?: string
  color?: string
  sort_order?: number
}

export type StakeholderPatch = Partial<StakeholderInput> & { archived?: boolean }

// ---- 工作对象 ----

// 契约里叫 Object，前端改名 WorkObject，免得遮住全局的 Object。
export type WorkObject = {
  id: string
  type_id: string
  ref: string
  title: string
  body: string
  status: string
  priority: string
  // 0010 之前的自由文本负责人，只读；owner_id 为空时界面回退显示它
  owner: string
  owner_id: string | null
  category_id: string | null
  project_id: string | null
  source: string
  props: Record<string, unknown> | null
  workdir: string
  due_at: string | null
  started_at: string | null
  completed_at: string | null
  archived_at: string | null
  deleted_at: string | null
  created_at: string
  updated_at: string

  // 查询时计算的派生字段
  tags: string[]
  category_name?: string
  category_path?: string
  category_color?: string
  project_title?: string
  link_count: number
  owner_name?: string
  participants: StakeholderRef[]
}

export type ObjectCreateInput = {
  type_id: string
  title: string
  body?: string
  status?: string
  priority?: string
  // 空串 = 没有负责人
  owner_id?: string
  participant_ids?: string[]
  source?: string
  category_id?: string | null
  project_id?: string | null
  props?: Record<string, unknown>
  workdir?: string
  // RFC3339 或 YYYY-MM-DD
  due_at?: string | null
  tags?: string[]
}

// 只传要改的字段，未出现的不改。
export type ObjectPatch = {
  title?: string
  body?: string
  status?: string
  priority?: string
  // 空串 = 清空负责人
  owner_id?: string
  // 全量替换：省略 = 不改，[] = 清空
  participant_ids?: string[]
  // null = 置空
  category_id?: string | null
  project_id?: string | null
  source?: string
  // 整体替换，只改一个 key 也要先读回再拼
  props?: Record<string, unknown>
  workdir?: string
  // null = 清空到期日
  due_at?: string | null
  tags?: string[]
  archived?: boolean
}

export type SortField = 'updated_at' | 'created_at' | 'due_at' | 'priority' | 'title'
export type ObjectSort = SortField | `-${SortField}`

// GET /api/objects 的筛选条件，字段名就是 query 参数名。
export type ObjectListParams = {
  type?: string[]
  category?: string
  subtree?: boolean
  uncategorized?: boolean
  status?: string[]
  priority?: string[]
  // 可重复传多个，AND 语义
  tag?: string[]
  owner_id?: string
  project?: string
  // 按 objects.source 精确匹配，多个之间是或（任务来源见契约「任务来源」）
  source?: string[]
  q?: string
  // 纯日期 YYYY-MM-DD 由后端补时：due_after 补 00:00:00，due_before 补 23:59:59；也可传 RFC3339
  due_after?: string
  due_before?: string
  stalled?: boolean
  not_terminal?: boolean
  overdue?: boolean
  inbox?: boolean
  archived?: boolean
  deleted?: boolean
  sort?: ObjectSort
  limit?: number
  offset?: number
}

// ---- 关联 / 历史 ----

export type Link = {
  id: string
  from_id: string
  to_id: string
  relation: string
  note: string
  created_at: string
}

export type LinkView = Link & { direction: 'out' | 'in'; peer: WorkObject | null }

export type LinkInput = { to_id: string; relation: string; note?: string }

// field 为 progress 的行是进展：old_value 是元数据 JSON，只显示 new_value；读进展走 /progress。
export type Revision = {
  id: string
  object_id: string
  field: string
  old_value: string
  new_value: string
  actor: string
  source: string
  created_at: string
  // 由 actor 拆出来的派生字段，按 session_id 分组看 Agent 改动，不要自己拆 actor
  actor_name: string
  session_id: string
}

// ---- 进展与领取 ----

export type ProgressKind = 'note' | 'claim' | 'review'

export type Progress = {
  id: string
  object_id: string
  kind: ProgressKind
  text: string
  commits: string[]
  files: string[]
  status: string
  actor: string
  actor_name: string
  session_id: string
  source: string
  created_at: string
}

// kind 不能是 claim，领取只能走 /claim
export type ProgressInput = {
  kind?: 'note' | 'review'
  text: string
  commits?: string[]
  files?: string[]
  status?: string
}

export type ClaimInput = {
  owner_id: string
  // 空串取该类型的 doing
  status?: string
  text?: string
  takeover?: boolean
}

export type ClaimResult = { object: WorkObject; progress: Progress | null; already: boolean }

// ---- 枚举字典 ----

export type DictItem = {
  id: string
  dict_id: string
  type_id: string | null
  key: string
  label: string
  color: string
  description: string
  sort_order: number
  meta: Record<string, unknown> | null
  archived_at: string | null
  created_at: string
  updated_at: string
  usage: number
}

export type Dictionary = {
  id: string
  name: string
  description: string
  scope: 'global' | 'type'
  builtin: boolean
  sort_order: number
  created_at: string
  updated_at: string
  // with_items=true 时才有
  items?: DictItem[]
}

export type DictItemInput = {
  type_id?: string
  key: string
  label: string
  color?: string
  description?: string
  sort_order?: number
  meta?: Record<string, unknown>
}

// key 一经创建不可改
export type DictItemPatch = Partial<Omit<DictItemInput, 'key' | 'type_id'>>

// ---- 输出产物 ----

export type ArtifactSource = 'manual' | 'agent' | 'run' | 'mcp'

export type Artifact = {
  id: string
  object_id: string | null
  session_id: string | null
  run_id: string | null
  title: string
  path: string
  base_dir: string
  url: string
  platform: string
  size: number
  source: ArtifactSource
  note: string
  created_at: string
  updated_at: string
  // 派生字段，不接受写入
  rel_path: string
  object_ref?: string
  object_title?: string
}

// source 由请求头 X-Actor-Source 判定，不在这里传。path 和 url 至少一个非空。
export type ArtifactInput = {
  object_id?: string | null
  session_id?: string | null
  run_id?: string | null
  title?: string
  path?: string
  base_dir?: string
  url?: string
  platform?: string
  size?: number
  note?: string
}

// object_id 三态：不出现 = 不改，null = 解除归属，有值 = 改挂
export type ArtifactPatch = {
  object_id?: string | null
  title?: string
  path?: string
  base_dir?: string
  url?: string
  platform?: string
  note?: string
}

export type ArtifactListParams = {
  object_id?: string
  // 与 object_id 同时给后端报 400
  unscoped?: boolean
  session_id?: string
  run_id?: string
  platform?: string
  source?: ArtifactSource
  // 三态：不传 = 不过滤，true = 非空，false = 为空
  has_url?: boolean
  has_path?: boolean
  q?: string
  limit?: number
  offset?: number
}

export type ArtifactStats = {
  total: number
  local: number
  remote: number
  unscoped: number
  by_platform: Record<string, number>
  by_source: Record<string, number>
  total_size: number
}

// ---- 本机文件系统 ----

export type FsEntry = { name: string; path: string; is_dir: boolean; writable: boolean }

export type FsListing = {
  path: string
  // 已在根目录时为空串
  parent: string
  /** 所在的最外层可浏览根，面包屑从它画起（FS-01） */
  root: string
  writable: boolean
  entries: FsEntry[]
}

export type FsShortcut = { label: string; path: string }

/** 用户加的额外可浏览目录（FS-01），path 是解开软链后的 */
export type FsRoot = { path: string; added_at: string }

export type FsRoots = { defaults: string[]; extra: FsRoot[] }

// ---- 任务执行 ----

export type RunStatus = 'pending' | 'running' | 'done' | 'failed' | 'canceled'

export type TaskRun = {
  id: string
  object_id: string
  workdir: string
  prompt: string
  status: RunStatus
  exit_code: number
  output: string
  error: string
  started_at: string
  finished_at: string | null
}

// ---- 侧栏计数 ----

export type Counts = {
  by_type: Record<string, number>
  by_status: Record<string, number>
  uncategorized_by_type: Record<string, number>
  inbox: number
  today: number
  week: number
  overdue: number
  stalled: number
  total: number
}

// POST /api/agent/workdir/check 的结果
export type WorkdirCheck = { path: string; exists: boolean; is_dir: boolean; writable: boolean; message: string }
