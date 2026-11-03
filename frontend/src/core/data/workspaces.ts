// 工作台（CORE-10a 后端、CORE-10b 前端）：一套菜单配置，开哪些模块、怎么分组、默认打开哪个、需要哪些插件。
// 契约见 docs/api-contract.md「工作台 workspaces」。工作台之间数据不隔离，写完只报 { kind: 'workspace' }，不刷别的缓存。
// 当前用哪个工作台由前端记（core/shell/workspace.ts），不存后端。
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { request, requestList } from '../api'
import { useNotifyChange } from './invalidate'
import { dataKeys } from './keys'

export type WorkspaceGroup = {
  id: string
  /** 留空只分隔不显示标题 */
  name: string
  modules: string[]
  /** 一级菜单里默认折起来 */
  collapsed: boolean
}

export type WorkspaceMark = { text: string; color: string; image?: string; icon?: string }

export type Workspace = {
  id: string
  name: string
  role: string
  description: string
  groups: WorkspaceGroup[]
  /** 按分组顺序摊平的启用模块，后端读的时候算 */
  modules: string[]
  home: string
  mark: WorkspaceMark | null
  /** 需要的插件 id，去重保序 */
  plugins: string[]
  /** 从哪个模板建的，空白新建为空串 */
  template: string
  position: number
  created_at: string
  updated_at: string
}

export type WorkspaceTemplate = {
  id: string
  role: string
  name: string
  description: string
  groups: { name: string; modules: string[] }[]
  modules: string[]
  home: string
  mark: WorkspaceMark | null
  plugins: string[]
}

export type WorkspaceGroupInput = { id?: string; name: string; modules: string[]; collapsed?: boolean }

export type WorkspaceInput = {
  template?: string
  name?: string
  role?: string
  description?: string
  groups?: WorkspaceGroupInput[]
  home?: string
  mark?: WorkspaceMark | null
  plugins?: string[]
}

/** 只传要改的；groups、plugins 整体替换 */
export type WorkspacePatch = Omit<WorkspaceInput, 'template'>

const one = (id: string) => `/api/workspaces/${encodeURIComponent(id)}`

export const workspacesApi = {
  list: (signal?: AbortSignal) => requestList<Workspace>('/api/workspaces', { signal }).then((r) => r.data),
  templates: (signal?: AbortSignal) => requestList<WorkspaceTemplate>('/api/workspaces/templates', { signal }).then((r) => r.data),
  create: (body: WorkspaceInput) => request<Workspace>('POST', '/api/workspaces', { body }),
  patch: (id: string, body: WorkspacePatch) => request<Workspace>('PATCH', one(id), { body }),
  remove: (id: string) => request<null>('DELETE', one(id)),
}

/** 全部工作台，按 position */
export function useWorkspaces() {
  return useQuery({ queryKey: dataKeys.workspaces.list, queryFn: ({ signal }) => workspacesApi.list(signal) })
}

/** 预设模板，只读，按原型的顺序 */
export function useWorkspaceTemplates() {
  return useQuery({ queryKey: dataKeys.workspaces.templates, queryFn: ({ signal }) => workspacesApi.templates(signal), staleTime: Infinity })
}

export function useCreateWorkspace() {
  const notify = useNotifyChange()
  return useMutation({ mutationFn: (body: WorkspaceInput) => workspacesApi.create(body), onSettled: () => notify({ kind: 'workspace' }) })
}

/**
 * 修改：先把改动放进缓存（菜单、管理页马上跟着变，连点上移下移不会基于旧数据），
 * 回来后用后端的结果替换；失败时由失效重新读回
 */
export function usePatchWorkspace() {
  const qc = useQueryClient()
  const notify = useNotifyChange()
  const put = (w: Workspace) => qc.setQueryData<Workspace[]>(dataKeys.workspaces.list, (xs) => xs?.map((x) => (x.id === w.id ? w : x)))
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: WorkspacePatch }) => workspacesApi.patch(id, patch),
    onMutate: async ({ id, patch }) => {
      await qc.cancelQueries({ queryKey: dataKeys.workspaces.list })
      const cur = qc.getQueryData<Workspace[]>(dataKeys.workspaces.list)?.find((x) => x.id === id)
      if (cur) put(applyPatch(cur, patch))
    },
    onSuccess: (w) => put(w),
    onError: () => notify({ kind: 'workspace' }),
  })
}

export function useDeleteWorkspace() {
  const notify = useNotifyChange()
  return useMutation({ mutationFn: (id: string) => workspacesApi.remove(id), onSettled: () => notify({ kind: 'workspace' }) })
}

/** 本地先套用改动，规则和后端一致：modules 跟着分组算，默认模块被去掉了换成第一个 */
export function applyPatch(w: Workspace, p: WorkspacePatch): Workspace {
  const groups = p.groups
    ? p.groups.map((g, i) => ({ id: g.id || `g${i + 1}`, name: g.name, modules: [...g.modules], collapsed: !!g.collapsed }))
    : w.groups
  const modules = groups.flatMap((g) => g.modules)
  const want = p.home ?? w.home
  return {
    ...w,
    ...(p.name !== undefined && { name: p.name }),
    ...(p.role !== undefined && { role: p.role }),
    ...(p.description !== undefined && { description: p.description }),
    ...(p.mark !== undefined && { mark: p.mark }),
    ...(p.plugins !== undefined && { plugins: [...new Set(p.plugins)] }),
    groups,
    modules,
    home: modules.includes(want) ? want : modules[0] ?? want,
  }
}
