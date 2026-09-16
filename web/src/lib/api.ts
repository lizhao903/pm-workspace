// 唯一的后端访问层。组件不得自行 fetch，一律走这里。
import type {
  Category, CategoryInput, Counts, CreateObjectInput, LinkView,
  AgentArtifact, AgentMessage, AgentProvider, AgentProviderInput,
  FsListing, FsShortcut, TaskRun,
  AgentSession, BackupInfo, WorkdirCheck, DictItem, DictItemInput,
  DictItemPatch, Dictionary, MigrationRecord, ProviderTestResult,
  ObjectPatch, ObjectQuery, ObjectType, Revision, Shortcut, ShortcutGroup,
  ShortcutGroupInput, ShortcutInput, Stakeholder, StakeholderPatch, Stats, Tag, WorkObject,
} from './types'

const BASE = '/api'

export class ApiError extends Error {
  // 显式字段而非构造参数属性：tsconfig 开了 erasableSyntaxOnly，参数属性需要运行时代码生成，不被允许。
  code: string
  status: number

  constructor(code: string, message: string, status: number) {
    super(message)
    this.code = code
    this.status = status
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<{ data: T; meta?: Record<string, number> }> {
  const res = await fetch(BASE + path, {
    ...init,
    headers: { 'Content-Type': 'application/json', 'X-Actor-Source': 'ui', ...(init?.headers ?? {}) },
  })
  const text = await res.text()
  const body = text ? JSON.parse(text) : {}
  if (!res.ok) {
    throw new ApiError(body?.error?.code ?? 'internal', body?.error?.message ?? res.statusText, res.status)
  }
  return body
}

const get = <T>(p: string) => request<T>(p).then((r) => r)
const send = <T>(m: string, p: string, b?: unknown) =>
  request<T>(p, { method: m, body: b === undefined ? undefined : JSON.stringify(b) }).then((r) => r.data)

function qs(q: ObjectQuery): string {
  const p = new URLSearchParams()
  if (q.type?.length) p.set('type', q.type.join(','))
  if (q.category) p.set('category', q.category)
  if (q.subtree) p.set('subtree', 'true')
  if (q.uncategorized) p.set('uncategorized', 'true')
  if (q.status?.length) p.set('status', q.status.join(','))
  if (q.priority?.length) p.set('priority', q.priority.join(','))
  q.tag?.forEach((t) => p.append('tag', t))
  if (q.owner_id) p.set('owner_id', q.owner_id)
  if (q.project) p.set('project', q.project)
  if (q.q) p.set('q', q.q)
  if (q.due_after) p.set('due_after', q.due_after)
  if (q.due_before) p.set('due_before', q.due_before)
  if (q.overdue) p.set('overdue', 'true')
  if (q.stalled) p.set('stalled', 'true')
  if (q.not_terminal) p.set('not_terminal', 'true')
  if (q.inbox) p.set('inbox', 'true')
  if (q.archived) p.set('archived', 'true')
  if (q.deleted) p.set('deleted', 'true')
  if (q.sort) p.set('sort', q.sort)
  p.set('limit', String(q.limit ?? 50))
  p.set('offset', String(q.offset ?? 0))
  return p.toString()
}

export const api = {
  stats: () => send<Stats>('GET', '/stats'),
  /** typeID 非空时聚焦计数器按该类型统计；by_type / total 恒为全局 */
  counts: (typeID?: string) => send<Counts>('GET', `/counts${typeID ? `?type=${encodeURIComponent(typeID)}` : ''}`),

  objectTypes: () => send<ObjectType[]>('GET', '/object-types'),
  createObjectType: (t: Partial<ObjectType>) => send<ObjectType>('POST', '/object-types', t),
  updateObjectType: (id: string, p: Partial<ObjectType>) => send<ObjectType>('PATCH', `/object-types/${id}`, p),
  deleteObjectType: (id: string) => send<null>('DELETE', `/object-types/${id}`),

  categories: (typeID: string, opts: { tree?: boolean; counts?: boolean } = {}) => {
    const p = new URLSearchParams({ type: typeID })
    if (opts.tree) p.set('tree', 'true')
    if (opts.counts) p.set('counts', 'true')
    return send<Category[]>('GET', `/categories?${p}`)
  },
  createCategory: (c: CategoryInput) => send<Category>('POST', '/categories', c),
  updateCategory: (id: string, p: Partial<CategoryInput>) => send<Category>('PATCH', `/categories/${id}`, p),
  moveCategory: (id: string, parent_id: string | null, sort_order: number) =>
    send<Category>('POST', `/categories/${id}/move`, { parent_id, sort_order }),
  deleteCategory: (id: string, reassignTo?: string) =>
    send<null>('DELETE', `/categories/${id}${reassignTo ? `?reassign_to=${reassignTo}` : ''}`),

  objects: async (q: ObjectQuery = {}) => {
    const r = await get<WorkObject[]>(`/objects?${qs(q)}`)
    return { items: r.data ?? [], total: r.meta?.total ?? 0 }
  },
  object: (id: string) => send<WorkObject>('GET', `/objects/${id}`),
  createObject: (o: CreateObjectInput) => send<WorkObject>('POST', '/objects', o),
  updateObject: (id: string, p: ObjectPatch) => send<WorkObject>('PATCH', `/objects/${id}`, p),
  deleteObject: (id: string, hard = false) => send<null>('DELETE', `/objects/${id}${hard ? '?hard=true' : ''}`),
  restoreObject: (id: string) => send<WorkObject>('POST', `/objects/${id}/restore`),

  links: (id: string) => send<LinkView[]>('GET', `/objects/${id}/links`),
  createLink: (id: string, to_id: string, relation: string, note = '') =>
    send<LinkView>('POST', `/objects/${id}/links`, { to_id, relation, note }),
  deleteLink: (linkID: string) => send<null>('DELETE', `/links/${linkID}`),

  revisions: (id: string, limit = 50) => send<Revision[]>('GET', `/objects/${id}/revisions?limit=${limit}`),
  recentRevisions: (limit = 100) => send<Revision[]>('GET', `/revisions?limit=${limit}`),

  // 目录浏览（选文件夹用）
  fsBrowse: (path?: string) =>
    send<FsListing>('GET', `/fs/browse${path ? `?path=${encodeURIComponent(path)}` : ''}`),
  fsShortcuts: () => send<FsShortcut[]>('GET', '/fs/shortcuts'),
  fsMkdir: (parent: string, name: string) => send<FsListing>('POST', '/fs/mkdir', { parent, name }),

  // 用本机 Claude Code 执行任务
  /** 干系人名册。includeArchived=true 才带上已归档的（名册管理页用），
   *  选人时一律不带——给已经离职的人再派活是个 bug 不是功能 */
  stakeholders: (includeArchived = false) =>
    send<Stakeholder[]>('GET', `/stakeholders${includeArchived ? '?archived=true' : ''}`),
  createStakeholder: (body: Partial<Stakeholder>) => send<Stakeholder>('POST', '/stakeholders', body),
  updateStakeholder: (id: string, patch: StakeholderPatch) =>
    send<Stakeholder>('PATCH', `/stakeholders/${id}`, patch),
  deleteStakeholder: (id: string) => send<void>('DELETE', `/stakeholders/${id}`),

  taskRuns: (objectId: string) => send<TaskRun[]>('GET', `/objects/${objectId}/runs`),
  taskRun: (runId: string) => send<TaskRun>('GET', `/runs/${runId}`),
  cancelTaskRun: (runId: string) => send<TaskRun>('POST', `/runs/${runId}/cancel`),
  /** 执行走 SSE，不走 send()；POST /api/objects/{id}/run */
  taskRunUrl: (objectId: string) => `/api/objects/${objectId}/run`,

  // Agent 对话
  /**
   * 会话列表。**必须明确说要哪一批**：objectId 给了就是那个对象的，
   * 没给就是全局的（object_id IS NULL）。没有「全部」这个选项——
   * 抽屉里混进底部对话框的记录、或者底部混进各对象的对话，
   * 都属于「看起来有内容，但不是这里该有的内容」。
   */
  agentSessions: (objectId?: string) =>
    send<AgentSession[]>('GET', objectId
      ? `/agent/sessions?object_id=${encodeURIComponent(objectId)}`
      : '/agent/sessions?unscoped=true'),
  createAgentSession: (s: { title?: string; provider_id?: string; model?: string; workdir?: string; object_id?: string }) =>
    send<AgentSession>('POST', '/agent/sessions', s),
  updateAgentSession: (id: string, s: { title?: string; provider_id?: string; model?: string; workdir?: string }) =>
    send<AgentSession>('PATCH', `/agent/sessions/${id}`, s),
  deleteAgentSession: (id: string) => send<null>('DELETE', `/agent/sessions/${id}`),
  agentMessages: (id: string) => send<AgentMessage[]>('GET', `/agent/sessions/${id}/messages`),
  agentArtifacts: (id: string) => send<AgentArtifact[]>('GET', `/agent/sessions/${id}/artifacts`),
  checkWorkdir: (path: string) => send<WorkdirCheck>('POST', '/agent/workdir/check', { path }),
  /** 对话走 SSE，不走 send()。URL 给调用方自己 new EventSource / fetch-stream */
  agentChatUrl: () => '/api/agent/chat',

  // Agent 供应商
  providers: () => send<AgentProvider[]>('GET', '/agent-providers'),
  createProvider: (p: AgentProviderInput & { api_key?: string }) =>
    send<AgentProvider>('POST', '/agent-providers', p),
  updateProvider: (id: string, p: AgentProviderInput) =>
    send<AgentProvider>('PATCH', `/agent-providers/${id}`, p),
  deleteProvider: (id: string) => send<null>('DELETE', `/agent-providers/${id}`),
  setDefaultProvider: (id: string) => send<AgentProvider>('POST', `/agent-providers/${id}/default`),
  testProvider: (id: string) => send<ProviderTestResult>('POST', `/agent-providers/${id}/test`),

  // 数据与备份
  migrations: () => send<MigrationRecord[]>('GET', '/admin/migrations'),
  snapshot: () => send<BackupInfo>('POST', '/admin/snapshot'),
  exportUrl: (format: 'json' | 'markdown') => `/api/admin/export?format=${format}`,

  // 标签维护
  updateTag: (id: string, p: { name?: string; color?: string }) => send<Tag>('PATCH', `/tags/${id}`, p),
  mergeTags: (srcId: string, dstId: string) => send<Tag>('POST', `/tags/${srcId}/merge`, { target_id: dstId }),

  // 字典（可配置枚举）
  dictionaries: (withItems = true) =>
    send<Dictionary[]>('GET', `/dictionaries${withItems ? '?with_items=true' : ''}`),
  dictItems: (dictID: string, opts: { typeId?: string; includeArchived?: boolean } = {}) => {
    const p = new URLSearchParams()
    if (opts.typeId) p.set('type', opts.typeId)
    if (opts.includeArchived) p.set('include_archived', 'true')
    const qs = p.toString()
    return send<DictItem[]>('GET', `/dictionaries/${dictID}/items${qs ? `?${qs}` : ''}`)
  },
  createDictItem: (dictID: string, it: DictItemInput) =>
    send<DictItem>('POST', `/dictionaries/${dictID}/items`, it),
  updateDictItem: (id: string, p: DictItemPatch) => send<DictItem>('PATCH', `/dict-items/${id}`, p),
  archiveDictItem: (id: string, archived: boolean) =>
    send<DictItem>('POST', `/dict-items/${id}/archive`, { archived }),
  deleteDictItem: (id: string) => send<null>('DELETE', `/dict-items/${id}`),
  dictItemUsage: (id: string) => send<{ usage: number }>('GET', `/dict-items/${id}/usage`),
  reorderDictItems: (dictID: string, type_id: string | null, ids: string[]) =>
    send<null>('POST', `/dictionaries/${dictID}/items/reorder`, { type_id, ids }),

  // 快捷访问
  shortcuts: (grouped = false) =>
    send<Shortcut[] | ShortcutGroup[]>('GET', `/shortcuts${grouped ? '?grouped=true' : ''}`),
  createShortcut: (s: ShortcutInput) => send<Shortcut>('POST', '/shortcuts', s),
  updateShortcut: (id: string, p: Partial<ShortcutInput>) => send<Shortcut>('PATCH', `/shortcuts/${id}`, p),
  deleteShortcut: (id: string) => send<null>('DELETE', `/shortcuts/${id}`),
  visitShortcut: (id: string) => send<Shortcut>('POST', `/shortcuts/${id}/visit`),
  reorderShortcuts: (group_id: string | null, ids: string[]) =>
    send<null>('POST', '/shortcuts/reorder', { group_id, ids }),

  shortcutGroups: () => send<ShortcutGroup[]>('GET', '/shortcut-groups'),
  createShortcutGroup: (g: ShortcutGroupInput) => send<ShortcutGroup>('POST', '/shortcut-groups', g),
  updateShortcutGroup: (id: string, p: Partial<ShortcutGroupInput>) =>
    send<ShortcutGroup>('PATCH', `/shortcut-groups/${id}`, p),
  deleteShortcutGroup: (id: string) => send<null>('DELETE', `/shortcut-groups/${id}`),

  tags: () => send<Tag[]>('GET', '/tags'),
  createTag: (name: string, color = '') => send<Tag>('POST', '/tags', { name, color }),
  deleteTag: (id: string) => send<null>('DELETE', `/tags/${id}`),
}
