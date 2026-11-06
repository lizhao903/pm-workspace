// 项目知识库（TSK-0721）：/api/projects/{id}/kb，契约见 docs/api-contract.md「项目插件」的「项目知识库」。
// 每个项目绑一个内核知识库，项目资料同步进去。键放在 ['knowledge-bases'] 前缀下：知识库页增删改、同步都会改篇数和绑定显示，
// 换绑、新建、同步一律报 { kind: 'knowledge-base' }（同时刷 Agent 配置：挂到项目默认 Agent 会改它的 kbs）。
import { useMutation, useQuery } from '@tanstack/react-query'
import { request } from '../api'
import { useNotifyChange } from './invalidate'
import { dataKeys } from './keys'

/** 一条没收进来的资料和原因 */
export type ProjectKbProblem = { title: string; ref?: string; reason: string }

/** 一个项目一次同步的结果（节点 kb_sync.projects 的一项、立即同步的响应、项目设置里的「上次同步」） */
export type ProjectKbSync = {
  project_id: string
  name: string
  ref: string
  kb_id: string
  kb_name: string
  /** 这次新建并绑定了知识库 */
  created: boolean
  added: number
  updated: number
  removed: number
  unchanged: number
  skipped: number
  failed: number
  /** 各最多 50 条 */
  failures: ProjectKbProblem[]
  skips: ProjectKbProblem[]
  /** 这次交给知识库的资料条数：files、folders、notes、links、docs、docs_dir */
  sources: Record<string, number>
  /** 整个项目没同步成的原因，成了为空串 */
  error: string
  at: string
}

export type ProjectKbInfo = { id: string; name: string; desc: string; docs: number; agents: string[] }

export type ProjectKb = {
  project_id: string
  /** 没绑为空串 */
  kb_id: string
  /** 没绑或已删为 null */
  kb: ProjectKbInfo | null
  /** 绑了但知识库已经删了：下次同步新建并换绑 */
  missing: boolean
  auto_created: boolean
  /** 项目默认 Agent（agent_ids 第一个），没有为空串 */
  default_agent_id: string
  agent_attached: boolean
  last_sync_at: string | null
  last_result: ProjectKbSync | null
}

/** 换绑（kb_id 空串解绑）、新建（create）、挂到项目默认 Agent（attach_agent），至少给一项 */
export type ProjectKbBind = { kb_id?: string; create?: boolean; name?: string; attach_agent?: boolean }
/** 各来源开关，不给的按收 */
export type ProjectKbSources = { files?: boolean; notes?: boolean; links?: boolean; docs?: boolean; docs_dir?: boolean }

const base = (id: string) => `/api/projects/${encodeURIComponent(id)}/kb`

export const projectKbApi = {
  get: (id: string, signal?: AbortSignal) => request<ProjectKb>('GET', base(id), { signal }),
  bind: (id: string, body: ProjectKbBind) => request<ProjectKb>('PUT', base(id), { body }),
  sync: (id: string, body: ProjectKbSources = {}) => request<ProjectKbSync>('POST', `${base(id)}/sync`, { body }),
}

export function useProjectKb(projectId: string) {
  return useQuery({ queryKey: dataKeys.knowledgeBases.project(projectId), queryFn: ({ signal }) => projectKbApi.get(projectId, signal) })
}

export function useBindProjectKb(projectId: string) {
  const notify = useNotifyChange()
  return useMutation({
    mutationFn: (body: ProjectKbBind) => projectKbApi.bind(projectId, body),
    onSettled: () => notify({ kind: 'knowledge-base' }),
  })
}

/** 立即同步；目录大时要一阵子，后端和连接脱钩 */
export function useSyncProjectKb(projectId: string) {
  const notify = useNotifyChange()
  return useMutation({
    mutationFn: (body?: ProjectKbSources) => projectKbApi.sync(projectId, body),
    onSettled: () => notify({ kind: 'knowledge-base' }),
  })
}

/** 一次同步的一句话：「新增 2、更新 1、移除 0、失败 0、跳过 3」 */
export const kbSyncLine = (r: Pick<ProjectKbSync, 'added' | 'updated' | 'removed' | 'failed' | 'skipped'>) =>
  `新增 ${r.added}、更新 ${r.updated}、移除 ${r.removed}、失败 ${r.failed}、跳过 ${r.skipped}`

/** 知识库页里打开这个知识库的地址 */
export const kbPagePath = (kbId: string) => `/settings/kbs?kb=${encodeURIComponent(kbId)}`
