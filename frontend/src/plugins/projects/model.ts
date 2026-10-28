// 项目列表和设置的纯函数：搜索、状态筛选和分组、排序、最近打开、底色、关联目录的保存口径。
import { projectView, type ObjectStatus, type ProjectMark, type ProjectProps, type ProjectSave, type ProjectView, type RelatedDir, type WorkObject } from '../../core/data'
import { PROJECT_COLORS } from './markIcons'

/** 每组先露几个，多的点「显示全部」（SPEC-projects-1.8） */
export const GROUP_PEEK = 12
/** 最近打开最多记几个（SPEC-projects-1.13） */
export const RECENT_MAX = 20
/** 概览里露几个任务、几个干系人（SPEC-projects-3） */
export const TASK_PEEK = 5
export const STAKE_PEEK = 6

export type Sort = 'recent' | 'name'

/** props.color 没填时按 id 给一个固定的底色，同一个项目到处同色 */
export function colorOf(p: Pick<ProjectView, 'id' | 'color'>): string {
  if (p.color) return p.color
  const h = [...p.id].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) % 9973, 7)
  return PROJECT_COLORS[h % PROJECT_COLORS.length]
}

/** 新建时轮流取底色：现有几个项目就取第几个 */
export const nextColor = (count: number) => PROJECT_COLORS[count % PROJECT_COLORS.length]

/** 标志上的文字：填了用填的，否则名称第一个字，名称也空时「项」 */
export const markText = (p: Pick<ProjectView, 'mark' | 'name'>) => p.mark.text || Array.from(p.name.trim())[0] || '项'

/** 目录最后一段；没设时为空串 */
export const dirName = (root: string) => root.replace(/\/+$/, '').split('/').pop() ?? ''

/** 搜索：名称、说明、项目目录，不区分大小写 */
export function matchQuery(p: ProjectView, q: string): boolean {
  const kw = q.trim().toLowerCase()
  if (!kw) return true
  return `${p.name} ${p.desc} ${p.root}`.toLowerCase().includes(kw)
}

/** 按最近打开排：打开过的在前（新的在前），没打开过的保持原顺序排后面；名称按中文排序规则 */
export function sortProjects(list: ProjectView[], sort: Sort, recent: string[]): ProjectView[] {
  if (sort === 'name') return [...list].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
  const rank = new Map(recent.map((id, i) => [id, i]))
  // Array.prototype.sort 是稳定的，没打开过的同为 Infinity，保持原顺序
  return [...list].sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity))
}

export type StatusGroup = { key: string; label: string; color: string; items: ProjectView[] }

/** 按项目类型的状态分组（状态集从后端读）；不在状态集里的归到最后的「其他」；空的组不要 */
export function groupByStatus(rows: ProjectView[], statuses: ObjectStatus[]): StatusGroup[] {
  const known = new Set(statuses.map((s) => s.key))
  const groups: StatusGroup[] = statuses.map((s) => ({ key: s.key, label: s.label, color: s.color, items: rows.filter((p) => p.status === s.key) }))
  const rest = rows.filter((p) => !known.has(p.status))
  if (rest.length) groups.push({ key: '', label: '其他', color: '', items: rest })
  return groups.filter((g) => g.items.length)
}

/** 每个项目的未完成任务数；传进来的已经是未进终态的任务 */
export function openTaskCounts(tasks: WorkObject[]): Map<string, number> {
  const out = new Map<string, number>()
  for (const t of tasks) if (t.project_id) out.set(t.project_id, (out.get(t.project_id) ?? 0) + 1)
  return out
}

/** 关联目录存哪些：路径为空的行不保存（SPEC-projects-13.16），首尾空白去掉 */
export const relatedToSave = (rows: RelatedDir[]): RelatedDir[] =>
  rows.map((r) => ({ path: r.path.trim(), label: r.label.trim() })).filter((r) => r.path)

export const sameRelated = (a: RelatedDir[], b: RelatedDir[]) =>
  a.length === b.length && a.every((r, i) => r.path === b[i].path && r.label === b[i].label)

// ---- 设置：边改边保存，和上次存下的比 ----

export type Form = { name: string; desc: string; status: string; root: string; color: string; mark: ProjectMark; related: RelatedDir[] }

export const formOf = (o: WorkObject): Form => {
  const p = projectView(o)
  return { name: p.name, desc: p.desc, status: p.status, root: p.root, color: p.color, mark: p.mark, related: p.related }
}
export const sameMark = (a: ProjectMark, b: ProjectMark) => a.text === b.text && (a.icon ?? '') === (b.icon ?? '') && (a.image ?? '') === (b.image ?? '')

/** 和上次存下的比，挑出要存的；名称为空不存（必填），关联目录只存路径不为空的行 */
export function diffForm(f: Form, saved: Form): { patch: NonNullable<ProjectSave['patch']>; props: ProjectProps } {
  const patch: NonNullable<ProjectSave['patch']> = {}
  const props: ProjectProps = {}
  if (f.name.trim() && f.name !== saved.name) patch.title = f.name
  if (f.desc !== saved.desc) patch.body = f.desc
  if (f.status !== saved.status) patch.status = f.status
  if (f.root.trim() !== saved.root.trim()) patch.workdir = f.root.trim()
  if (f.color !== saved.color) props.color = f.color
  if (!sameMark(f.mark, saved.mark)) props.mark = f.mark
  const rel = relatedToSave(f.related)
  if (!sameRelated(rel, relatedToSave(saved.related))) props.related = rel
  return { patch, props }
}

// ---- 详情的标签（顺序和显示名见 SPEC-projects-0 ProjectTab）；todo 是还没做的标签由谁补 ----

export type ProjectTab = 'overview' | 'comms' | 'stakeholders' | 'tasks' | 'docs' | 'sop' | 'agents' | 'materials' | 'prototypes' | 'settings'

export const TABS: { key: ProjectTab; label: string; todo?: string }[] = [
  { key: 'overview', label: '概览' },
  { key: 'comms', label: '沟通', todo: '绑定群聊和私聊、看项目里的消息，由 PJ-02b 实现' },
  { key: 'stakeholders', label: '干系人', todo: '从联系人里挑人、标角色和关注点，由 PJ-01d 实现' },
  { key: 'tasks', label: '任务', todo: '这个项目的任务，由 PJ-01d 实现' },
  { key: 'docs', label: '文档', todo: '关联文档库或项目目录里的文件，由 PJ-01d 实现' },
  { key: 'sop', label: 'SOP', todo: '关联的标准流程和最近执行，等 SOP 插件' },
  { key: 'agents', label: 'Agent', todo: '项目 Agent 和项目里的会话，等 Agent 相关任务' },
  { key: 'materials', label: '支持材料', todo: '文件、文件夹、链接、笔记，由 PJ-03b 实现' },
  { key: 'prototypes', label: '原型', todo: '原型卡片的启停与日志，由 PJ-04b 实现' },
  { key: 'settings', label: '设置' },
]

export const tabOf = (s: string | undefined): ProjectTab | null =>
  !s ? 'overview' : TABS.some((t) => t.key === s) ? (s as ProjectTab) : null

// ---- 最近打开：存本机 localStorage ----
// 只用来排序，每台机器、每个浏览器各记各的；规格说正式产品存本机偏好，后端没有偏好接口，
// 和主题、侧栏折叠一样放 localStorage。拿不到存储时只在本次会话生效

const RECENT_KEY = 'pmw-projects-recent'
let memo: string[] | null = null

export function loadRecent(): string[] {
  if (memo) return memo
  try {
    const v: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]')
    memo = Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, RECENT_MAX) : []
  } catch {
    memo = []
  }
  return memo
}

/** 打开过的挪到最前，最多记 RECENT_MAX 个；返回新的列表 */
export function touchRecent(id: string): string[] {
  const next = [id, ...loadRecent().filter((x) => x !== id)].slice(0, RECENT_MAX)
  memo = next
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(next)) } catch { /* 只在本次会话生效 */ }
  return next
}

/** 测试用：清掉模块里缓存的一份 */
export function resetRecentMemo() {
  memo = null
}
