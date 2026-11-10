// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

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

/** 名册里的 AI 成员（TSK-0500）：agent 是工作台 Agent（ref 是 Agent id），cli 是命令行执行器（ref 是 claude / deepseek） */
export type AIKind = 'agent' | 'cli'

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
  /** '' 是人；AI 成员由工作台自动维护，名字和在岗状态不能手工改（TSK-0500） */
  ai_kind?: AIKind | ''
  ai_ref?: string
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
  /** 负责人是 AI 成员时的类型与引用（TSK-0500）；负责人是人或没有时不出现 */
  owner_ai_kind?: AIKind
  owner_ai_ref?: string
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
  // 按 props.stage 筛（AUTO-05），多个之间是或，"none" 是没设阶段
  stage?: string[]
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
  /** 字典 artifact_kind 的 key，空 = 登记时没分类（TSK-0497 之前执行扫目录登记的） */
  kind: string
  created_at: string
  updated_at: string
  // 派生字段，不接受写入
  rel_path: string
  object_ref?: string
  object_title?: string
  /** kind 非空就是 kind，为空时后端按备注、链接、扩展名推断（TSK-0497） */
  display_kind: string
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
  // TSK-0497：种类（按对象汇总时按 display_kind 比）、登记时间区间、归属对象的类型和项目（- 是不属于项目）
  kind?: string
  since?: string
  until?: string
  object_type?: string
  project_id?: string
  limit?: number
  offset?: number
}

/** GET /api/artifacts/by-object 的一行：一个对象的产出汇总（TSK-0497） */
export type ArtifactObjectSummary = {
  object_id: string
  object_ref: string
  object_title: string
  object_type: string
  status: string
  project_id: string | null
  project_title: string
  completed_at: string | null
  total: number
  /** 按 display_kind */
  by_kind: Record<string, number>
  by_source: Record<string, number>
  last_at: string
}

/** by_kind 不受 kind 条件影响、by_source 不受 source 条件影响；total、objects 是全部条件生效后的 */
export type ArtifactsByObject = {
  objects: ArtifactObjectSummary[]
  total: number
  by_kind: Record<string, number>
  by_source: Record<string, number>
}

export type ArtifactStats = {
  total: number
  local: number
  remote: number
  unscoped: number
  by_platform: Record<string, number>
  by_source: Record<string, number>
  /** 按库里的 kind，未分类的在 "" 下 */
  by_kind: Record<string, number>
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

/** waiting：交给工作台 Agent 的执行（harness=agent）停在要人确认的写操作上，没结束 */
export type RunStatus = 'pending' | 'running' | 'waiting' | 'done' | 'failed' | 'canceled'

/** 执行器（0049、TSK-0460）：claude 本机 Claude Code，deepseek 是 deepseek-harness，agent 是工作台自己的 Agent */
export type RunHarness = 'claude' | 'deepseek' | 'agent'

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
  /** 执行方式（0048）：stream 工作台起进程流式回推；terminal 在终端里交互执行，靠 MCP 回写或手动标记结束 */
  mode: RunMode
  /** 执行器（0049），老记录是 claude */
  harness?: RunHarness | (string & {})
  /** 执行器的会话（0050）：deepseek 是 dsh 会话，agent 是 Agent 会话 id（能打开会话接着聊）；没有为空串 */
  harness_session?: string
}

export type RunMode = 'stream' | 'terminal'

/** POST /api/objects/{id}/run/terminal 的请求和响应（0048） */
/** preset_id 是选的角色（SPEC-tasks-6.18，原预置提示词），不用时不传 */
export type TerminalRunRequest = { workdir?: string; extra_prompt?: string; preset_id?: string }
export type TerminalHandoff = {
  run: TaskRun
  workdir: string
  /** 数据目录 tmp/handoff/<执行 id>/ 下的提示词和 MCP 配置，交给终端插件 */
  prompt_file: string
  mcp_config: string
}
/** 终端执行收尾：终端里的 claude 经 MCP 或界面上的「标记结束」 */
export type FinishRunInput = { status: 'done' | 'failed' | 'canceled'; summary?: string }
/** GET /api/objects/{id}/run/prompt 的参数和响应 */
/** harness=agent 时预览交给工作台 Agent 的那一份（TSK-0460），resume 是续跑的说法 */
export type RunPromptParams = { mode?: RunMode; workdir?: string; extra_prompt?: string; preset_id?: string; harness?: RunHarness; resume?: boolean }
export type RunPrompt = { prompt: string; workdir: string }
/** 角色的权限：只读不放开文件编辑；accept_edits 流式执行时加 --permission-mode acceptEdits（AUTO-03） */
export type RolePermission = 'read_only' | 'accept_edits'
/** 角色默认在项目档案的哪个目录跑（AUTO-04 落地前只存不用） */
export type RoleDirKind = 'code' | 'prototype' | 'prd' | 'any'
/**
 * 交给 Claude Code 的角色（由预置提示词升级而来，SPEC-tasks-6.18、SPEC-settings-24），GET / PUT /api/run-prompts。
 * permission / output / dir_kind 可选：后端读出来总会补齐（accept_edits / 空 / any），旧数据和保存时不带也行
 */
export type RunPreset = {
  id: string; scene: string; content: string; default: boolean
  permission?: RolePermission; output?: string; dir_kind?: RoleDirKind
}
/** 后台执行的权限档位（TSK-0499）：只读 / 允许改文件 / 允许改文件 + 跑测试构建 / 自定义白名单 */
export type RunPermission = 'read_only' | 'accept_edits' | 'edits_and_tests' | 'custom'
/** 写入档位：勾「允许写入」时可选的三档 */
export type RunWriteProfile = Exclude<RunPermission, 'read_only'>
/** 一个档位：是否放开文件编辑、实际传给 --allowedTools 的规则（不含 MCP） */
export type RunPermProfile = { key: RunPermission; label: string; writes: boolean; allowed: string[] }
/** GET / PUT /api/run-permissions（TSK-0499） */
export type RunPermissions = {
  write_profile: RunWriteProfile
  /** 自定义白名单，只在 custom 档生效 */
  custom: string[]
  profiles: RunPermProfile[]
  /** 工作台注入的 MCP server 名（pmw-run），每一档都放行它的全部工具 */
  mcp_server: string
}
export type RunPermissionsInput = { write_profile: RunWriteProfile; custom: string[] }

// ---- 执行器（TSK-0722）----

/** 执行器缺的一样东西；blocking 的让分派入口置灰 */
export type RunnerProblemCode = 'not_installed' | 'broken' | 'no_provider' | 'provider_disabled' | 'no_model' | 'no_agent' | 'no_mcp'
export type RunnerProblem = {
  code: RunnerProblemCode | (string & {})
  message: string
  /** 一句话的修法 */
  fix: string
  /** 要照做的几步（命令原文），没有为空数组；没装 dsh 时是安装步骤 */
  steps: string[]
  blocking: boolean
}
/** GET /api/runners 的一项，顺序固定 claude、deepseek、agent */
export type RunnerStatus = {
  harness: RunHarness
  label: string
  available: boolean
  /** 能用的执行方式；claude 的 terminal 还要终端插件在跑 */
  modes: RunMode[]
  bin: string
  /** flag：启动参数或 DSH_BIN 指定；path：走 PATH；builtin：工作台自己 */
  bin_source: 'flag' | 'path' | 'builtin'
  version: string
  /** 发起时能不能接上工作台 MCP 回写 */
  mcp: boolean
  /** 只 deepseek 有：不指定服务商时默认用哪个、哪个模型 */
  provider_id: string
  provider_name: string
  model: string
  problems: RunnerProblem[]
  checked_at: string
}
export type SmokeCheckKey = 'spawn' | 'model' | 'mcp' | 'readonly' | 'persist' | 'cancel' | 'timeout' | 'cleanup'
export type SmokeCheck = {
  key: SmokeCheckKey | (string & {})
  label: string
  status: 'pending' | 'running' | 'pass' | 'fail' | 'skip'
  detail: string
  ms: number
}
/** DeepSeek 的集成检查（GET / POST /api/runners/deepseek/smoke） */
export type RunnerSmoke = {
  id: string
  harness: RunHarness
  status: 'running' | 'passed' | 'failed'
  started_at: string
  finished_at: string | null
  bin: string
  version: string
  provider_id: string
  provider_name: string
  model: string
  session_id: string
  /** 模型经 MCP 回报的结论 */
  conclusion: string
  /** 它最后的答复（截到 2000 字） */
  answer: string
  checks: SmokeCheck[]
}
export type RunnerSmokeInput = { provider_id?: string; model?: string }

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
