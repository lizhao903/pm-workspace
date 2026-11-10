// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 项目资料（PJ-03b）：/api/projects/{id}/materials，契约见 docs/api-contract.md「项目资料」（PJ-03a）。
// 只存路径和元信息，不读本机文件内容；文件、文件夹的 value 是绝对路径。增删报 { kind: 'project-material' }，只刷这个项目的资料。
import { useMutation, useQuery } from '@tanstack/react-query'
import { request } from '../api'
import { useNotifyChange } from './invalidate'
import { dataKeys } from './keys'

export type MaterialKind = 'file' | 'folder' | 'link' | 'note'
/** 种类和显示名，顺序同原型 MATERIAL_KIND；种类是契约里的固定四种 */
export const MATERIAL_KINDS: { key: MaterialKind; label: string }[] = [
  { key: 'file', label: '文件' }, { key: 'folder', label: '文件夹' }, { key: 'link', label: '链接' }, { key: 'note', label: '笔记' },
]
export type MaterialStatus = '' | 'draft' | 'review' | 'final'
/** 笔记正文最多这么多字（契约 note 上限），新建、编辑、IM 消息转笔记同一个数 */
export const MATERIAL_NOTE_MAX = 5000
/** 编辑时能互换的种类（项目插件 0.9.1）：笔记和链接、文件和文件夹 */
export const MATERIAL_KIND_GROUPS: MaterialKind[][] = [['note', 'link'], ['file', 'folder']]

export type ProjectMaterial = {
  id: string
  project_id: string
  kind: MaterialKind
  name: string
  value: string
  /** 资料类别（PRD、技术方案……），空串是普通材料 */
  category: string
  status: MaterialStatus
  tags: string[]
  source: string
  created_at: string
  updated_at: string
}

export type ProjectMaterialInput = { kind: MaterialKind; value: string; name?: string; category?: string; status?: MaterialStatus; tags?: string[] }
/** kind 只能在 MATERIAL_KIND_GROUPS 的同一组里换，换了值按新种类校验 */
export type ProjectMaterialPatch = { kind?: MaterialKind; name?: string; value?: string; category?: string; status?: MaterialStatus; tags?: string[] }

const base = (id: string) => `/api/projects/${encodeURIComponent(id)}/materials`
const one = (id: string, mid: string) => `${base(id)}/${encodeURIComponent(mid)}`

export const projectMaterialsApi = {
  list: async (id: string, signal?: AbortSignal) => (await request<ProjectMaterial[] | null>('GET', base(id), { signal })) ?? [],
  add: (id: string, body: ProjectMaterialInput) => request<ProjectMaterial>('POST', base(id), { body }),
  patch: (id: string, mid: string, body: ProjectMaterialPatch) => request<ProjectMaterial>('PATCH', one(id, mid), { body }),
  remove: (id: string, mid: string) => request<null>('DELETE', one(id, mid)),
}

/** 一个项目的全部资料，按添加先后（旧的在前） */
export function useProjectMaterials(projectId: string) {
  return useQuery({
    queryKey: dataKeys.projectMaterials(projectId),
    queryFn: ({ signal }) => projectMaterialsApi.list(projectId, signal),
  })
}

/** 一次加一条或几条（选多个文件各加一条）；全部发完再刷新，有失败的照样刷，已加上的不丢 */
export function useAddProjectMaterials(projectId: string) {
  const notify = useNotifyChange()
  return useMutation({
    mutationFn: async (rows: ProjectMaterialInput[]) => {
      const res = await Promise.allSettled(rows.map((r) => projectMaterialsApi.add(projectId, r)))
      const failed = res.flatMap((r, i) => (r.status === 'rejected' ? [{ input: rows[i], error: r.reason as unknown }] : []))
      return { added: res.filter((r) => r.status === 'fulfilled').length, failed }
    },
    onSettled: () => notify({ kind: 'project-material', projectId }),
  })
}

export function usePatchProjectMaterial(projectId: string) {
  const notify = useNotifyChange()
  return useMutation({
    mutationFn: ({ materialId, patch }: { materialId: string; patch: ProjectMaterialPatch }) =>
      projectMaterialsApi.patch(projectId, materialId, patch),
    onSuccess: () => notify({ kind: 'project-material', projectId }),
  })
}

export function useRemoveProjectMaterial(projectId: string) {
  const notify = useNotifyChange()
  return useMutation({
    mutationFn: (materialId: string) => projectMaterialsApi.remove(projectId, materialId),
    onSuccess: () => notify({ kind: 'project-material', projectId }),
  })
}
