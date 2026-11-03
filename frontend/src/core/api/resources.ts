// 各资源的请求函数，一个接口一个函数，路径和参数照 docs/api-contract.md。
// 不做缓存（在 core/data），也不做 SSE（在 sse.ts）。

import { request, requestList, seg, type ListResult } from './client'
import { artifactListQuery, objectListQuery } from './query'
import type {
  Artifact,
  ArtifactInput,
  ArtifactListParams,
  ArtifactPatch,
  ArtifactStats,
  ClaimInput,
  ClaimResult,
  Counts,
  DictItem,
  DictItemInput,
  DictItemPatch,
  Dictionary,
  FsListing,
  FsShortcut,
  FsRoot,
  FsRoots,
  Health,
  LinkInput,
  LinkView,
  ObjectCreateInput,
  ObjectListParams,
  ObjectPatch,
  ObjectType,
  ObjectTypeInput,
  ObjectTypePatch,
  Progress,
  ProgressInput,
  Revision,
  Stakeholder,
  StakeholderInput,
  StakeholderPatch,
  TaskRun,
  TerminalHandoff,
  TerminalRunRequest,
  FinishRunInput,
  RunPrompt,
  RunPromptParams,
  WorkdirCheck,
  WorkObject,
} from './types'

function limitQuery(limit?: number) {
  const qs = new URLSearchParams()
  if (limit !== undefined) qs.set('limit', String(limit))
  return qs
}

export const health = () => request<Health>('GET', '/api/health')

// type 只收窄聚焦类计数器，by_type / total 恒为全局
export function counts(opts: { type?: string } = {}) {
  const qs = new URLSearchParams()
  if (opts.type) qs.set('type', opts.type)
  return request<Counts>('GET', '/api/counts', { query: qs })
}

export const objects = {
  list: (params?: ObjectListParams, signal?: AbortSignal): Promise<ListResult<WorkObject>> =>
    requestList<WorkObject>('/api/objects', { query: objectListQuery(params), signal }),
  get: (id: string) => request<WorkObject>('GET', `/api/objects/${seg(id)}`),
  create: (input: ObjectCreateInput) => request<WorkObject>('POST', '/api/objects', { body: input }),
  // 只传改动字段，配合 changedFields 用
  patch: (id: string, patch: ObjectPatch) => request<WorkObject>('PATCH', `/api/objects/${seg(id)}`, { body: patch }),
  // 默认软删除进回收站
  delete: (id: string, opts: { hard?: boolean } = {}) =>
    request<null>('DELETE', `/api/objects/${seg(id)}`, {
      query: opts.hard ? new URLSearchParams({ hard: 'true' }) : undefined,
    }),
  restore: (id: string) => request<WorkObject>('POST', `/api/objects/${seg(id)}/restore`),
  links: (id: string) => request<LinkView[]>('GET', `/api/objects/${seg(id)}/links`),
  addLink: (id: string, input: LinkInput) =>
    request<LinkView>('POST', `/api/objects/${seg(id)}/links`, { body: input }),
  revisions: (id: string, opts: { limit?: number } = {}) =>
    request<Revision[]>('GET', `/api/objects/${seg(id)}/revisions`, { query: limitQuery(opts.limit) }),
  // 最近的在前；limit 省略取 100，上限 500
  progress: (id: string, opts: { limit?: number } = {}) =>
    request<Progress[]>('GET', `/api/objects/${seg(id)}/progress`, { query: limitQuery(opts.limit) }),
  appendProgress: (id: string, input: ProgressInput) =>
    request<Progress>('POST', `/api/objects/${seg(id)}/progress`, { body: input }),
  // 被占用时抛 conflict；同一会话重复领返回 already=true
  claim: (id: string, input: ClaimInput) =>
    request<ClaimResult>('POST', `/api/objects/${seg(id)}/claim`, { body: input }),
}

export const links = {
  delete: (id: string) => request<null>('DELETE', `/api/links/${seg(id)}`),
}

export const revisions = {
  recent: (opts: { limit?: number } = {}) =>
    request<Revision[]>('GET', '/api/revisions', { query: limitQuery(opts.limit) }),
}

export const objectTypes = {
  list: () => request<ObjectType[]>('GET', '/api/object-types'),
  create: (input: ObjectTypeInput) => request<ObjectType>('POST', '/api/object-types', { body: input }),
  patch: (id: string, patch: ObjectTypePatch) =>
    request<ObjectType>('PATCH', `/api/object-types/${seg(id)}`, { body: patch }),
  delete: (id: string) => request<null>('DELETE', `/api/object-types/${seg(id)}`),
}

export const dictionaries = {
  list: (opts: { withItems?: boolean } = {}) =>
    request<Dictionary[]>('GET', '/api/dictionaries', {
      query: opts.withItems ? new URLSearchParams({ with_items: 'true' }) : undefined,
    }),
  items: (dictId: string) => request<DictItem[]>('GET', `/api/dictionaries/${seg(dictId)}/items`),
  createItem: (dictId: string, input: DictItemInput) =>
    request<DictItem>('POST', `/api/dictionaries/${seg(dictId)}/items`, { body: input }),
  patchItem: (id: string, patch: DictItemPatch) =>
    request<DictItem>('PATCH', `/api/dict-items/${seg(id)}`, { body: patch }),
  archiveItem: (id: string, archived: boolean) =>
    request<DictItem>('POST', `/api/dict-items/${seg(id)}/archive`, { body: { archived } }),
  // 有引用时抛 conflict，改走归档
  deleteItem: (id: string) => request<null>('DELETE', `/api/dict-items/${seg(id)}`),
  usage: (id: string) => request<{ usage: number }>('GET', `/api/dict-items/${seg(id)}/usage`),
  reorder: (dictId: string, ids: string[], typeId?: string) =>
    request<null>('POST', `/api/dictionaries/${seg(dictId)}/items/reorder`, {
      body: typeId ? { type_id: typeId, ids } : { ids },
    }),
}

export const stakeholders = {
  // 默认只回在岗的，archived=true 带上已归档的
  list: (opts: { archived?: boolean } = {}) =>
    request<Stakeholder[]>('GET', '/api/stakeholders', {
      query: opts.archived ? new URLSearchParams({ archived: 'true' }) : undefined,
    }),
  create: (input: StakeholderInput) => request<Stakeholder>('POST', '/api/stakeholders', { body: input }),
  patch: (id: string, patch: StakeholderPatch) =>
    request<Stakeholder>('PATCH', `/api/stakeholders/${seg(id)}`, { body: patch }),
  // 有引用（含回收站）时抛 conflict，改走归档
  delete: (id: string) => request<null>('DELETE', `/api/stakeholders/${seg(id)}`),
}

export const artifacts = {
  list: (params?: ArtifactListParams, signal?: AbortSignal): Promise<ListResult<Artifact>> =>
    requestList<Artifact>('/api/artifacts', { query: artifactListQuery(params), signal }),
  // 同一套过滤参数，忽略 limit / offset
  stats: (params?: ArtifactListParams) =>
    request<ArtifactStats>('GET', '/api/artifacts/stats', { query: artifactListQuery(params) }),
  get: (id: string) => request<Artifact>('GET', `/api/artifacts/${seg(id)}`),
  create: (input: ArtifactInput) => request<Artifact>('POST', '/api/artifacts', { body: input }),
  patch: (id: string, patch: ArtifactPatch) =>
    request<Artifact>('PATCH', `/api/artifacts/${seg(id)}`, { body: patch }),
  // 只删登记记录，不删磁盘文件和云端页面
  delete: (id: string) => request<null>('DELETE', `/api/artifacts/${seg(id)}`),
}

function runPromptQuery(p: RunPromptParams): URLSearchParams {
  const q = new URLSearchParams()
  if (p.mode) q.set('mode', p.mode)
  if (p.workdir?.trim()) q.set('workdir', p.workdir.trim())
  if (p.extra_prompt?.trim()) q.set('extra_prompt', p.extra_prompt.trim())
  return q
}

export const runs = {
  // 最近的在前；limit 省略取 20，上限 100
  list: (objectId: string, opts: { limit?: number } = {}) =>
    request<TaskRun[]>('GET', `/api/objects/${seg(objectId)}/runs`, { query: limitQuery(opts.limit) }),
  get: (id: string) => request<TaskRun>('GET', `/api/runs/${seg(id)}`),
  cancel: (id: string) => request<TaskRun>('POST', `/api/runs/${seg(id)}/cancel`),
  // 交给 Claude Code「切换到终端」（0048）：建执行记录、写好提示词和 MCP 配置，不起进程
  terminal: (objectId: string, body: TerminalRunRequest) =>
    request<TerminalHandoff>('POST', `/api/objects/${seg(objectId)}/run/terminal`, { body }),
  // 终端执行收尾；流式执行回 409
  finish: (id: string, body: FinishRunInput) => request<TaskRun>('POST', `/api/runs/${seg(id)}/finish`, { body }),
  // 提示词预览，和发起时同一套拼法；目录不校验
  prompt: (objectId: string, params: RunPromptParams, signal?: AbortSignal) =>
    request<RunPrompt>('GET', `/api/objects/${seg(objectId)}/run/prompt`, {
      query: runPromptQuery(params), signal,
    }),
}

// 不可用也是 200，看返回的字段，message 说明原因
export const agentWorkdir = {
  check: (path: string, signal?: AbortSignal) =>
    request<WorkdirCheck>('POST', '/api/agent/workdir/check', { body: { path }, signal }),
}

export const fs = {
  // 越界返回 readonly（403）
  browse: (path?: string) =>
    request<FsListing>('GET', '/api/fs/browse', { query: path ? new URLSearchParams({ path }) : undefined }),
  shortcuts: () => request<FsShortcut[]>('GET', '/api/fs/shortcuts'),
  mkdir: (parent: string, name: string) => request<FsListing>('POST', '/api/fs/mkdir', { body: { parent, name } }),
  // 额外可浏览目录（FS-01）：被拒回 400 并写明原因，加过或在默认范围里回 409
  roots: () => request<FsRoots>('GET', '/api/fs/roots'),
  addRoot: (path: string) => request<FsRoot>('POST', '/api/fs/roots', { body: { path } }),
  removeRoot: (path: string) => request<null>('DELETE', '/api/fs/roots', { query: new URLSearchParams({ path }) }),
}
