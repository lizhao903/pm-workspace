// 项目干系人的增删改（PJ-01d）：/api/projects/{id}/stakeholders，契约见 docs/api-contract.md「项目干系人」。
// 读在 projects.ts 的 useProjectStakeholders。改角色、关注点成功后直接把返回的一行写回缓存（关注点边输边存，不每次重新取）；
// 加人、移除报 { kind: 'project-stakeholder' }，只刷这个项目的干系人。
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { request } from '../api'
import { useNotifyChange } from './invalidate'
import { dataKeys } from './keys'
import type { ProjectRole, ProjectStakeholder } from './projects'

export type ProjectStakeholderInput = { stakeholder_id: string; role: ProjectRole; focus?: string }
export type ProjectStakeholderPatch = { role?: ProjectRole; focus?: string; sort_order?: number }

const base = (id: string) => `/api/projects/${encodeURIComponent(id)}/stakeholders`
const one = (id: string, sid: string) => `${base(id)}/${encodeURIComponent(sid)}`

export const projectStakeholdersApi = {
  add: (id: string, body: ProjectStakeholderInput) => request<ProjectStakeholder>('POST', base(id), { body }),
  patch: (id: string, sid: string, body: ProjectStakeholderPatch) => request<ProjectStakeholder>('PATCH', one(id, sid), { body }),
  remove: (id: string, sid: string) => request<null>('DELETE', one(id, sid)),
}

export function useAddProjectStakeholder(projectId: string) {
  const notify = useNotifyChange()
  return useMutation({
    mutationFn: (body: ProjectStakeholderInput) => projectStakeholdersApi.add(projectId, body),
    onSuccess: () => notify({ kind: 'project-stakeholder', projectId }),
  })
}

export function usePatchProjectStakeholder(projectId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ stakeholderId, patch }: { stakeholderId: string; patch: ProjectStakeholderPatch }) =>
      projectStakeholdersApi.patch(projectId, stakeholderId, patch),
    onSuccess: (row) => {
      qc.setQueryData<ProjectStakeholder[]>(dataKeys.projectStakeholders(projectId),
        (list) => list?.map((x) => (x.stakeholder_id === row.stakeholder_id ? row : x)))
    },
  })
}

export function useRemoveProjectStakeholder(projectId: string) {
  const notify = useNotifyChange()
  return useMutation({
    mutationFn: (stakeholderId: string) => projectStakeholdersApi.remove(projectId, stakeholderId),
    onSuccess: () => notify({ kind: 'project-stakeholder', projectId }),
  })
}
