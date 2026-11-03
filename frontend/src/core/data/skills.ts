// 技能（AG-01b6）：列表、新建（含复制）、修改、删除。契约见 docs/api-contract.md「技能 skills」。
// 内置和插件的技能只读，只有自定义的能改、能删；写完报 { kind: 'skill' }。
import { useMutation, useQuery } from '@tanstack/react-query'
import { request, requestList } from '../api'
import { useNotifyChange } from './invalidate'
import { skillKeys } from './skillKeys'

/** builtin、custom，或提供它的插件 id */
export type SkillSource = 'builtin' | 'custom' | (string & {})

export type Skill = {
  id: string
  name: string
  desc: string
  source: SkillSource
  /** 用到的工具，只是说明 */
  uses: string[]
  /** 怎么做 */
  instructions: string
  /** 什么时候用 */
  when: string
  /** 挂着它的 Agent，新建的在前 */
  agents: { id: string; name: string }[]
  /** 只有自定义技能有 */
  created_at?: string
  updated_at?: string
}

export type SkillInput = {
  name: string
  desc?: string
  instructions: string
  when?: string
  uses?: string[]
  /** 复制：没给的字段从这个技能复制 */
  copy_from?: string
}

export type SkillPatch = Partial<Pick<Skill, 'name' | 'desc' | 'instructions' | 'when' | 'uses'>>

/** 只读：内置和插件的技能 */
export const skillReadonly = (s: Pick<Skill, 'source'>) => s.source !== 'custom'

const normSkill = (s: Skill): Skill => ({ ...s, desc: s.desc ?? '', when: s.when ?? '', uses: s.uses ?? [], agents: s.agents ?? [] })
const path = (id: string) => `/api/skills/${encodeURIComponent(id)}`

export const skillsApi = {
  list: async (signal?: AbortSignal) => (await requestList<Skill>('/api/skills', { signal })).data.map(normSkill),
  create: async (input: SkillInput) => normSkill(await request<Skill>('POST', '/api/skills', { body: input })),
  patch: async (id: string, patch: SkillPatch) => normSkill(await request<Skill>('PATCH', path(id), { body: patch })),
  /** 回删掉的那条，agents 是被摘掉它的 Agent */
  remove: async (id: string) => normSkill(await request<Skill>('DELETE', path(id))),
}

/** 全部技能：内置、在跑的插件、自定义（新建的在前），后端排好序 */
export function useSkills() {
  return useQuery({ queryKey: skillKeys.list, queryFn: ({ signal }) => skillsApi.list(signal) })
}

export function useCreateSkill() {
  const notify = useNotifyChange()
  return useMutation({ mutationFn: (input: SkillInput) => skillsApi.create(input), onSuccess: () => notify({ kind: 'skill' }) })
}

export function usePatchSkill() {
  const notify = useNotifyChange()
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: SkillPatch }) => skillsApi.patch(id, patch),
    onSuccess: () => notify({ kind: 'skill' }),
  })
}

export function useDeleteSkill() {
  const notify = useNotifyChange()
  return useMutation({ mutationFn: (id: string) => skillsApi.remove(id), onSuccess: () => notify({ kind: 'skill' }) })
}
