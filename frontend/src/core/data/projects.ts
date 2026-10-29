// 项目（PJ-01c）：项目是 type=project 的工作对象，读写走 /api/objects；项目干系人走项目插件的 /api/projects/{id}/stakeholders。
// 字段约定见 docs/api-contract.md「项目插件 projects」：name=title、desc=body、root=workdir，color、mark、related 在 props 里。
// 写完报 { kind: 'object' }；干系人的键挂在 stakeholders 前缀下，名册和对象一变一起刷。
import { useMutation, useQuery } from '@tanstack/react-query'
import { objects, request, type ObjectPatch, type WorkObject } from '../api'
import { useNotifyChange } from './invalidate'
import { dataKeys } from './keys'
import { useAllObjects, useObject } from './objects'

export const PROJECT_TYPE = 'project'

/** 标志：text 空串表示取名称第一个字；icon 是内置图标 key；image 是 data URL */
export type ProjectMark = { text: string; icon?: string; image?: string }
export type RelatedDir = { path: string; label: string }

/** 项目在界面上用的字段，从对象上整理出来 */
export type ProjectView = {
  id: string
  ref: string
  name: string
  desc: string
  status: string
  /** props.color；空串时界面按 id 给一个 */
  color: string
  mark: ProjectMark
  root: string
  related: RelatedDir[]
  /** props.sop_ids：关联的 SOP 流程 id，按关联先后 */
  sopIds: string[]
  created_at: string
  updated_at: string
}

const isRec = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const str = (v: unknown) => (typeof v === 'string' ? v : '')

/** props 里的值不可信（后端不校验），取不到的按空值处理 */
export function projectView(o: WorkObject): ProjectView {
  const p = o.props ?? {}
  const m = isRec(p.mark) ? p.mark : {}
  const mark: ProjectMark = { text: str(m.text) }
  if (str(m.icon)) mark.icon = str(m.icon)
  if (str(m.image).startsWith('data:image/')) mark.image = str(m.image)
  const related = Array.isArray(p.related)
    ? p.related.filter(isRec).map((r) => ({ path: str(r.path), label: str(r.label) }))
    : []
  const sopIds = Array.isArray(p.sop_ids) ? [...new Set(p.sop_ids.filter((x): x is string => typeof x === 'string' && !!x))] : []
  return {
    id: o.id, ref: o.ref, name: o.title, desc: o.body, status: o.status, color: str(p.color), mark,
    root: o.workdir, related, sopIds, created_at: o.created_at, updated_at: o.updated_at,
  }
}

/** 存在 props 里的几个字段 */
export type ProjectProps = { color?: string; mark?: ProjectMark; related?: RelatedDir[]; sop_ids?: string[] }

/** 把改动合并进读回来的最新 props，别的 key（agent_ids、sop_ids 等）原样留着 */
export function mergeProjectProps(current: Record<string, unknown> | null, edit: ProjectProps): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(current ?? {}) }
  if (edit.color !== undefined) out.color = edit.color
  if (edit.mark !== undefined) {
    const m: Record<string, string> = { text: edit.mark.text }
    if (edit.mark.icon) m.icon = edit.mark.icon
    if (edit.mark.image) m.image = edit.mark.image
    out.mark = m
  }
  if (edit.related !== undefined) out.related = edit.related.map((r) => ({ path: r.path, label: r.label }))
  if (edit.sop_ids !== undefined) out.sop_ids = [...edit.sop_ids]
  return out
}

/** 全部项目（不含回收站里的） */
export function useProjects() {
  return useAllObjects({ type: [PROJECT_TYPE], sort: '-updated_at' })
}

/** 单个项目；不是项目或已进回收站的，界面按「不存在」处理 */
export function useProject(id: string | null) {
  return useObject(id)
}

export const isLiveProject = (o: WorkObject | undefined) => !!o && o.type_id === PROJECT_TYPE && !o.deleted_at

export type ProjectCreate = { title: string; color: string; mark: ProjectMark; status?: string }

export function useCreateProject() {
  const notify = useNotifyChange()
  return useMutation({
    mutationFn: (p: ProjectCreate) => objects.create({
      type_id: PROJECT_TYPE, title: p.title, status: p.status, source: 'manual',
      props: mergeProjectProps(null, { color: p.color, mark: p.mark, related: [] }),
    }),
    onSuccess: (o) => notify({ kind: 'object', id: o.id }),
  })
}

export type ProjectSave = {
  id: string
  /** 列上的字段：title、body、workdir、status */
  patch?: Pick<ObjectPatch, 'title' | 'body' | 'workdir' | 'status'>
  props?: ProjectProps
}

/** 保存：props 有改动时先读回最新的再合并；什么都没改返回 null */
export async function saveProject({ id, patch, props }: ProjectSave): Promise<WorkObject | null> {
  const body: ObjectPatch = { ...(patch ?? {}) }
  if (props && Object.keys(props).length) {
    const fresh = await objects.get(id)
    body.props = mergeProjectProps(fresh.props, props)
  }
  if (!Object.keys(body).length) return null
  return objects.patch(id, body)
}

export function useSaveProject() {
  const notify = useNotifyChange()
  return useMutation({ mutationFn: saveProject, onSuccess: (_, v) => notify({ kind: 'object', id: v.id }) })
}

// ---- 项目干系人 ----

export type ProjectRole = 'decider' | 'contact' | 'owner' | 'member' | 'informed'

/** 显示顺序固定，和原型 STAKE_ORDER 一致 */
export const PROJECT_ROLES: { key: ProjectRole; label: string; desc: string }[] = [
  { key: 'decider', label: '决策人', desc: '拍板、验收' },
  { key: 'contact', label: '对接人', desc: '日常沟通、需求来源' },
  { key: 'owner', label: '负责人', desc: '我方交付负责' },
  { key: 'member', label: '参与', desc: '一起做事' },
  { key: 'informed', label: '知会', desc: '有进展告诉他就行' },
]

export type ProjectStakeholder = {
  project_id: string
  stakeholder_id: string
  role: ProjectRole
  focus: string
  sort_order: number
  created_at: string
  updated_at: string
}

const stakePath = (id: string) => `/api/projects/${encodeURIComponent(id)}/stakeholders`

export const projectsApi = {
  stakeholders: (id: string, signal?: AbortSignal) => request<ProjectStakeholder[]>('GET', stakePath(id), { signal }),
}

/** 项目干系人，不带人名；人名从联系人（useContacts）取 */
export function useProjectStakeholders(id: string | null) {
  return useQuery({
    queryKey: dataKeys.projectStakeholders(id ?? ''),
    queryFn: ({ signal }) => projectsApi.stakeholders(id ?? '', signal),
    enabled: !!id,
  })
}
