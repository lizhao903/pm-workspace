// 缓存键（CORE-03a）。所有查询键都在这里生成，按资源分前缀，失效规则（invalidate.ts）按前缀刷新。
// 对象列表一律挂在 ['objects', 'list'] 下：任务列表、今日、项目的任务标签页都是它，改了对象一起刷新。
import type { ArtifactListParams, ObjectListParams } from '../api'

type Filter = Record<string, unknown>

/**
 * 过滤条件归一：去掉空值（undefined、null、空串、false、空数组），键按字母排。
 * 同一个过滤条件不管字段顺序、写没写默认值，生成的缓存键都一样。
 */
export function normFilter<T extends object>(f: T | undefined): Filter {
  const out: Filter = {}
  if (!f) return out
  for (const k of Object.keys(f).sort()) {
    const v = (f as Filter)[k]
    if (v === undefined || v === null || v === '' || v === false) continue
    if (Array.isArray(v) && !v.length) continue
    out[k] = v
  }
  return out
}

export const dataKeys = {
  health: ['health'] as const,
  objectTypes: ['object-types'] as const,
  dictionaries: {
    all: ['dictionaries'] as const,
    list: (withItems = false) => ['dictionaries', 'list', { withItems }] as const,
    items: (dictId: string) => ['dictionaries', dictId, 'items'] as const,
    /** 含已停用的条目，设置 / 枚举值用（ALIGN-14） */
    itemsAll: (dictId: string) => ['dictionaries', dictId, 'items', 'all'] as const,
  },
  stakeholders: {
    all: ['stakeholders'] as const,
    list: (archived = false) => ['stakeholders', 'list', { archived }] as const,
  },
  /** 联系人（CT-03a）：同一张名册带联系人字段，挂在 stakeholders 前缀下，干系人一变一起刷 */
  contacts: {
    list: ['stakeholders', 'contacts'] as const,
  },
  /** 项目干系人（PJ-01c）：也挂在 stakeholders 前缀下，名册和对象一变一起刷 */
  projectStakeholders: (projectId: string) => ['stakeholders', 'projects', projectId] as const,
  /** 项目资料（PJ-03b）：只随资料的增删改刷新 */
  projectMaterials: (projectId: string) => ['project-materials', projectId] as const,
  /** IM 身份（CT-03b）：一次拉全，按联系人合进 Contact.im */
  identities: {
    all: ['im-identities'] as const,
    list: ['im-identities', 'list'] as const,
  },
  objects: {
    all: ['objects'] as const,
    lists: ['objects', 'list'] as const,
    /** 一页；分页参数也进键 */
    list: (f?: ObjectListParams) => ['objects', 'list', normFilter(f)] as const,
    /** 按页拉完的整份，和单页分开缓存 */
    listAll: (f?: Omit<ObjectListParams, 'limit' | 'offset'>) => ['objects', 'list', { ...normFilter(f), all: true }] as const,
    detail: (id: string) => ['objects', 'get', id] as const,
    progress: (id: string) => ['objects', 'progress', id] as const,
    revisions: (id: string) => ['objects', 'revisions', id] as const,
    /** 阶段变化历史（AUTO-12，取审计 kind=stage） */
    stageHistory: (id: string) => ['objects', 'stage-history', id] as const,
  },
  /** type 只收窄聚焦类计数器；不传是全局 */
  counts: {
    all: ['counts'] as const,
    of: (type?: string) => ['counts', type ?? ''] as const,
  },
  artifacts: {
    all: ['artifacts'] as const,
    list: (f?: ArtifactListParams) => ['artifacts', 'list', normFilter(f)] as const,
    stats: (f?: ArtifactListParams) => ['artifacts', 'stats', normFilter(f)] as const,
  },
  runs: {
    all: ['runs'] as const,
    list: (objectId: string) => ['runs', 'list', objectId] as const,
    detail: (id: string) => ['runs', 'get', id] as const,
    /** 提示词预览（0048），参数是 { mode, workdir, extra_prompt } */
    prompt: (objectId: string, params: object) => ['runs', 'prompt', objectId, params] as const,
    /** 预置提示词（SPEC-settings-24）；不在 runs 前缀下：执行收尾刷 runs 时不该跟着刷它 */
    presets: ['run-presets'] as const,
  },
  workdir: (path: string) => ['agent', 'workdir', path] as const,
  fs: {
    all: ['fs'] as const,
    browse: (path: string) => ['fs', 'browse', path] as const,
    shortcuts: ['fs', 'shortcuts'] as const,
    roots: ['fs', 'roots'] as const,
  },
  plugins: {
    all: ['plugins'] as const,
    list: ['plugins', 'list'] as const,
  },
  /** 工作台（CORE-10b）：列表和只读的模板 */
  workspaces: {
    all: ['workspaces'] as const,
    list: ['workspaces', 'list'] as const,
    templates: ['workspaces', 'templates'] as const,
  },
  /** 文档页（DOC-01b）：分类树带数量，对象一变就跟着刷 */
  categories: {
    all: ['categories'] as const,
    tree: (type: string) => ['categories', 'tree', type] as const,
  },
  tags: {
    all: ['tags'] as const,
    list: ['tags', 'list'] as const,
  },
  /** 挂载的本地目录、目录里的文件清单、读过的文件，挂载变了一起刷 */
  localDirs: {
    all: ['local-dirs'] as const,
    list: ['local-dirs', 'list'] as const,
    files: (id: string) => ['local-dirs', 'files', id] as const,
    read: (path: string) => ['local-dirs', 'read', path] as const,
  },
  /** 定时任务的列表在 todayKeys.schedules（今日页共用）；这里是执行记录和规则预览 */
  schedules: {
    all: ['schedules'] as const,
    /** 一个定时任务的全部执行记录（各种条数）都在这个前缀下 */
    runsOf: (id: string) => ['schedules', 'runs', id] as const,
    runs: (id: string, limit: number) => ['schedules', 'runs', id, { limit }] as const,
    preview: (rule: unknown, count: number) => ['schedules', 'preview', { rule, count }] as const,
  },
  /** Webhook（TASK-04b）：列表、投递记录（各种条数都在 deliveriesOf 前缀下）、删除影响 */
  webhooks: {
    all: ['webhooks'] as const,
    list: ['webhooks', 'list'] as const,
    deliveriesOf: (id: string) => ['webhooks', 'deliveries', id] as const,
    deliveries: (id: string, limit: number) => ['webhooks', 'deliveries', id, { limit }] as const,
    usage: (id: string) => ['webhooks', 'usage', id] as const,
  },
  /** 连接器（CONN-01d）：定义列表和实例列表 */
  connectors: {
    all: ['connectors'] as const,
    defs: ['connectors', 'defs'] as const,
    list: ['connectors', 'list'] as const,
  },
  /** IM 消息（IM-02b）：消息列表一次拉全，单条另存 */
  im: {
    all: ['im'] as const,
    list: ['im', 'messages'] as const,
    detail: (id: string) => ['im', 'message', id] as const,
    /** 一个会话里的消息（PJ-02b 项目沟通），也在 im 前缀下，消息一变跟着刷 */
    conversation: (conversationId: string) => ['im', 'conversation', conversationId] as const,
    /** 归到一个项目的消息（消息分流），项目沟通里和绑定会话的消息合在一起 */
    project: (projectId: string) => ['im', 'project', projectId] as const,
    /** 项目里来自消息的资料的出处（0009），在 im 前缀下，消息一变跟着刷 */
    materials: (projectId: string) => ['im', 'materials', projectId] as const,
    /** 附件目录和大小上限（IM-04b） */
    attachmentStorage: ['im', 'attachment-storage'] as const,
    /** 插件设置：过期天数（IM-07） */
    settings: ['im', 'settings'] as const,
    /** 群组默认归属的项目（会话 id -> 项目），消息一变跟着刷 */
    conversationProjects: ['im', 'conversation-projects'] as const,
    /** 群组管理的会话统计（0.15.0），消息一变跟着刷 */
    conversationSummary: (channel: string) => ['im', 'conversation-summary', channel] as const,
    /** 一个会话主动发出的消息（0.17.0），在 im 前缀下 */
    sent: (conversationId: string) => ['im', 'sent', conversationId] as const,
    /** 一个会话的 @ 候选（0.18.0），在 im 前缀下 */
    members: (conversationId: string) => ['im', 'members', conversationId] as const,
  },
  /** IM 会话（PJ-02b）：项目绑定时从这里挑 */
  conversations: {
    all: ['conversations'] as const,
    list: ['conversations', 'list'] as const,
  },
  /** 项目绑定的会话（PJ-02b）：只随绑定、解绑刷新 */
  projectConversations: (projectId: string) => ['project-conversations', projectId] as const,
  /** 项目原型（PJ-04b）：列表和每个原型的日志都在项目前缀下，启停、增删改一起刷 */
  projectPrototypes: {
    of: (projectId: string) => ['project-prototypes', projectId] as const,
    list: (projectId: string) => ['project-prototypes', projectId, 'list'] as const,
    logs: (projectId: string, protoId: string) => ['project-prototypes', projectId, 'logs', protoId] as const,
  },
  /** 项目汇总（ALIGN-05）：列表卡片的原型数和绑定的会话，原型启停、会话绑定时刷 */
  projectSummary: ['project-summary'] as const,
  /** SOP（SOP-04b）：流程、节点类型、执行列表和单次执行，执行都在 runs 前缀下，事件一来一起刷 */
  sop: {
    all: ['sop'] as const,
    flows: ['sop', 'flows'] as const,
    /** 单条流程在 flows 前缀下，删改流程时一起刷 */
    flow: (id: string) => ['sop', 'flows', 'get', id] as const,
    nodeTypes: ['sop', 'node-types'] as const,
    runs: ['sop', 'runs'] as const,
    runList: ['sop', 'runs', 'list'] as const,
    run: (id: string) => ['sop', 'runs', 'get', id] as const,
    /** 关联到某个工作对象的执行（SOP-06，任务详情用） */
    objectRuns: (objectId: string) => ['sop', 'runs', 'object', objectId] as const,
    /** 插件设置（SOP-07）：放在 runs 前缀下，执行一变跟着刷在调模型、排队的个数 */
    settings: ['sop', 'runs', 'settings'] as const,
    /** 一条需求的流水线（AUTO-12）：在 runs 前缀下，执行一变跟着刷 */
    pipeline: (taskId: string) => ['sop', 'runs', 'pipeline', taskId] as const,
    /** 所有等人的步骤（AUTO-12，今日「待我处理」） */
    waiting: ['sop', 'runs', 'waiting'] as const,
  },
  /** 知识库（AG-01b7）：列表、每个库的文档、还没收进来的篇目、检索结果、Agent 列表，增删改一起刷 */
  knowledgeBases: {
    all: ['knowledge-bases'] as const,
    list: ['knowledge-bases', 'list'] as const,
    docs: (id: string) => ['knowledge-bases', 'docs', id] as const,
    missing: (id: string) => ['knowledge-bases', 'missing', id] as const,
    search: (id: string, q: string) => ['knowledge-bases', 'search', id, q] as const,
    /** 正在跑的同步的进度，同步请求没回来时轮询 */
    syncProgress: (id: string) => ['knowledge-bases', 'sync-progress', id] as const,
    agents: ['knowledge-bases', 'agents'] as const,
  },
  /** 运行异常（INC-01b）：一次拉全，设置页、二级菜单红点、今日待办共用 */
  incidents: {
    all: ['incidents'] as const,
    list: ['incidents', 'list'] as const,
  },
  /** 终端（TERM-01b）：会话列表；终端页认原型目录用的全部项目的原型，任一项目原型启停都刷 */
  terminal: {
    all: ['terminal'] as const,
    sessions: ['terminal', 'sessions'] as const,
    prototypes: ['terminal', 'prototypes'] as const,
    /** 插件设置（Claude Code 启动命令，终端插件 0.2.0） */
    settings: ['terminal', 'settings'] as const,
  },
}
