// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 项目（PJ-01c）：项目是 type=project 的工作对象，读写走 /api/objects；项目干系人走项目插件的 /api/projects/{id}/stakeholders。
// 字段约定见 docs/api-contract.md「项目插件 projects」：name=title、desc=body、root=workdir，color、mark、related 在 props 里。
// 写完报 { kind: 'object' }；干系人的键挂在 stakeholders 前缀下，名册和对象一变一起刷。
import { useMutation, useQuery } from '@tanstack/react-query'
import { objects, request, type Dictionary, type ObjectPatch, type WorkObject } from '../api'
import { useNotifyChange } from './invalidate'
import { dataKeys } from './keys'
import { useDictionaries } from './meta'
import { listAllObjects, useAllObjects, useObject, type ObjectFilter } from './objects'
import { queryClient } from './queryClient'

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
  /** props.docs_dir：文档目录（TSK-0718），相对项目目录或绝对路径；空串是没设 */
  docsDir: string
  /** props.sop_ids：关联的 SOP 流程 id，按关联先后 */
  sopIds: string[]
  /** props.sop_ids_hidden：自动关联出来、被用户点了「不自动关联」的 SOP 流程 id */
  sopHidden: string[]
  /** props.agent_ids：项目 Agent，第一个是默认（SPEC-projects-10） */
  agentIds: string[]
  /** props.session_ids：在项目里开的会话；后端会话没有 project_id，先记在项目这边（PR-21） */
  sessionIds: string[]
  created_at: string
  updated_at: string
}

const isRec = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const str = (v: unknown) => (typeof v === 'string' ? v : '')
/** id 列表：只留非空字符串并去重，保持先后 */
const idList = (v: unknown): string[] => (Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string' && !!x))] : [])

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
  const sopIds = idList(p.sop_ids)
  return {
    id: o.id, ref: o.ref, name: o.title, desc: o.body, status: o.status, color: str(p.color), mark,
    root: o.workdir, related, docsDir: str(p.docs_dir).trim(), sopIds, sopHidden: idList(p.sop_ids_hidden), agentIds: idList(p.agent_ids), sessionIds: idList(p.session_ids), created_at: o.created_at, updated_at: o.updated_at,
  }
}

/** 存在 props 里的几个字段 */
export type ProjectProps = {
  color?: string; mark?: ProjectMark; related?: RelatedDir[]; sop_ids?: string[]; agent_ids?: string[]; session_ids?: string[]
  /** 不自动关联的 SOP 流程 id（SOP 标签的自动反向关联里点掉的） */
  sop_ids_hidden?: string[]
  /** 文档目录（TSK-0718）：相对项目目录或绝对路径；空串是清掉 */
  docs_dir?: string
  /** 详情页不显示的标签 key（SPEC-projects-13.19）；没有这个 key 时全部显示，以后新加的标签默认也显示 */
  tabs_hidden?: string[]
  /** 详情页标签的先后（SPEC-projects-13.20）：标签 key 的顺序，不含概览、设置（固定一头一尾）；没有或空时按默认顺序，没列进来的新标签按默认位置插入 */
  tabs_order?: string[]
}

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
  if (edit.docs_dir !== undefined) {
    if (edit.docs_dir.trim()) out.docs_dir = edit.docs_dir.trim()
    else delete out.docs_dir
  }
  if (edit.sop_ids !== undefined) out.sop_ids = [...edit.sop_ids]
  if (edit.sop_ids_hidden !== undefined) out.sop_ids_hidden = [...edit.sop_ids_hidden]
  if (edit.agent_ids !== undefined) out.agent_ids = [...edit.agent_ids]
  if (edit.session_ids !== undefined) out.session_ids = [...edit.session_ids]
  if (edit.tabs_hidden !== undefined) out.tabs_hidden = [...edit.tabs_hidden]
  if (edit.tabs_order !== undefined) out.tabs_order = [...edit.tabs_order]
  return out
}

const PROJECTS_FILTER: ObjectFilter = { type: [PROJECT_TYPE], sort: '-updated_at' }

/** 全部项目（不含回收站里的） */
export function useProjects() {
  return useAllObjects(PROJECTS_FILTER)
}

/**
 * 项目下拉的选项（值是项目 id），给不在组件里的地方用（插件登记的 SOP 节点配置项）：读项目列表的缓存，
 * 还没取过就取一次（失败了不反复取）；和 useProjects 同一份缓存，调用方订阅缓存变化后重新调
 */
export function projectOptions(): { value: string; label: string }[] {
  const key = dataKeys.objects.listAll(PROJECTS_FILTER)
  const st = queryClient.getQueryState(key)
  if (!st || (st.status === 'pending' && st.fetchStatus === 'idle')) {
    void queryClient.prefetchQuery({ queryKey: key, queryFn: ({ signal }) => listAllObjects(PROJECTS_FILTER, signal) })
  }
  const list = queryClient.getQueryData<{ data: WorkObject[] }>(key)?.data ?? []
  return list.filter((o) => !o.deleted_at).map((o) => ({ value: o.id, label: o.title }))
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

/** 角色是枚举字典 project_role 里的 key（TSK-0718，设置 / 枚举值里维护）；内置五个见 PROJECT_ROLES */
export type ProjectRole = string

/** 角色在界面上用的字段；enabled 为 false 是已停用（已有干系人照常显示，下拉里不再能选） */
export type ProjectRoleItem = { key: string; label: string; desc: string; color: string; enabled: boolean }

/** 项目干系人角色的字典 id（内核迁移 0052） */
export const PROJECT_ROLE_DICT = 'project_role'
/** 新加干系人的默认角色：字典里标了默认的，没有时用它 */
export const DEFAULT_PROJECT_ROLE = 'member'

/** 内置五个角色，顺序和原型 STAKE_ORDER 一致；字典还没有条目（后端没迁移）时兜底 */
export const PROJECT_ROLES: ProjectRoleItem[] = [
  { key: 'decider', label: '决策人', desc: '拍板、验收', color: '#c0352b', enabled: true },
  { key: 'contact', label: '对接人', desc: '日常沟通、需求来源', color: '#3d4fd6', enabled: true },
  { key: 'owner', label: '负责人', desc: '我方交付负责', color: '#e8590c', enabled: true },
  { key: 'member', label: '参与', desc: '一起做事', color: '#0c8599', enabled: true },
  { key: 'informed', label: '知会', desc: '有进展告诉他就行', color: '#a19d92', enabled: true },
]

/** 字典里的角色（含停用的，按 sort_order）；没有字典或没有条目时用内置五个 */
export function projectRoleItems(dicts: Dictionary[] | undefined): ProjectRoleItem[] {
  const items = dicts?.find((d) => d.id === PROJECT_ROLE_DICT)?.items
  if (!items?.length) return PROJECT_ROLES
  return [...items].sort((a, b) => a.sort_order - b.sort_order || a.key.localeCompare(b.key))
    .map((i) => ({ key: i.key, label: i.label, desc: i.description, color: i.color, enabled: !i.archived_at }))
}

/** 新加干系人的默认角色：字典里标了默认且没停用的，其次「参与」，再其次第一个没停用的 */
export function defaultProjectRole(dicts: Dictionary[] | undefined): string {
  const items = dicts?.find((d) => d.id === PROJECT_ROLE_DICT)?.items ?? []
  const marked = items.find((i) => i.meta?.default === true && !i.archived_at)?.key
  if (marked) return marked
  const roles = projectRoleItems(dicts)
  return roles.find((r) => r.key === DEFAULT_PROJECT_ROLE && r.enabled)?.key ?? roles.find((r) => r.enabled)?.key ?? DEFAULT_PROJECT_ROLE
}

/** 项目干系人角色（字典 project_role，含停用的）和默认角色；字典没取到时按内置五个 */
export function useProjectRoles() {
  const q = useDictionaries({ withItems: true })
  return { roles: projectRoleItems(q.data), defaultRole: defaultProjectRole(q.data), isPending: q.isPending }
}

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
