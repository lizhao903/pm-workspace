// 项目列表和设置的纯函数：搜索、状态筛选和分组、排序、最近打开、底色、关联目录的保存口径。
import { PROJECT_ROLES, localDay, projectView, type DictItem, type ObjectStatus, type ProjectMark, type ProjectProps, type ProjectSave, type ProjectStakeholder, type ProjectView, type RelatedDir, type WorkObject } from '../../core/data'
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

// ---- 列表的分组和筛选（SPEC-projects-1.5、1.6、1.8）：有原型在跑 / 有待回复 / 其他，一个项目只归一组 ----

export type ActivityKey = 'running' | 'pending' | 'other'
export type Activity = '' | ActivityKey

export const ACTIVITY_GROUPS: { key: ActivityKey; label: string }[] = [
  { key: 'running', label: '有原型在跑' },
  { key: 'pending', label: '有待回复' },
  { key: 'other', label: '其他' },
]

/** 有运行中的原型归「有原型在跑」，否则有待回复（不含稍后）归「有待回复」，否则「其他」 */
export const activityOf = (s: { protoRunning: number; pending: number } | undefined): ActivityKey =>
  s?.protoRunning ? 'running' : s?.pending ? 'pending' : 'other'

export type ActivityGroup = { key: ActivityKey; label: string; items: ProjectView[] }

/** 按 ACTIVITY_GROUPS 的顺序分段，段内保持传进来的顺序；空的段不要 */
export function groupByActivity(rows: ProjectView[], of: (p: ProjectView) => ActivityKey): ActivityGroup[] {
  return ACTIVITY_GROUPS.map((g) => ({ ...g, items: rows.filter((p) => of(p) === g.key) })).filter((g) => g.items.length)
}

/** 卡片上要不要标项目状态：常态「进行中」不标，筹备中、已暂停、已结项这类才标 */
export const showStatusTag = (status: string) => !!status && status !== 'active'

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
  { key: 'comms', label: '沟通' },
  { key: 'stakeholders', label: '干系人' },
  { key: 'tasks', label: '任务' },
  { key: 'docs', label: '文档' },
  { key: 'sop', label: 'SOP', todo: '关联的标准流程和最近执行，等 SOP 插件' },
  { key: 'agents', label: 'Agent', todo: '项目 Agent 和项目里的会话，等 Agent 相关任务' },
  { key: 'materials', label: '支持材料' },
  { key: 'prototypes', label: '原型' },
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

// ---- 任务标签（SPEC-projects-7）：终态看 /api/object-types 的 terminal 标记，优先级顺序看字典 ----

/** 未完成：状态不是终态（已完成、已取消）；不认识的状态算未完成，和后端 not_terminal 一致 */
export const isOpenStatus = (statuses: readonly ObjectStatus[], k: string) => !statuses.some((s) => s.key === k && s.terminal)

/** 完成圆圈标完成用的状态：优先 done，没有就取第一个终态（但不取已取消） */
export const doneStatus = (statuses: readonly ObjectStatus[]) =>
  (statuses.find((s) => s.key === 'done') ?? statuses.find((s) => s.terminal && s.key !== 'cancelled'))?.key

/** 已完成的改回去用的状态：第一个非终态 */
export const reopenStatus = (statuses: readonly ObjectStatus[]) => statuses.find((s) => !s.terminal)?.key

/** 按优先级排（字典顺序，没有优先级的排最后），同优先级的新改的在前 */
export function sortByPriority(tasks: readonly WorkObject[], prios: readonly DictItem[]): WorkObject[] {
  const rank = new Map(prios.map((x, i) => [x.key, i]))
  const r = (k: string) => rank.get(k) ?? (k ? 999 : 1000)
  return [...tasks].sort((a, b) => r(a.priority) - r(b.priority) || a.priority.localeCompare(b.priority) || b.updated_at.localeCompare(a.updated_at))
}

// ---- 干系人标签（SPEC-projects-6）：按角色顺序（STAKE_ORDER），同角色按加入顺序 ----

const roleRank = (role: string) => {
  const i = PROJECT_ROLES.findIndex((x) => x.key === role)
  return i < 0 ? PROJECT_ROLES.length : i
}

export function sortStakeholders(rows: readonly ProjectStakeholder[]): ProjectStakeholder[] {
  return [...rows].sort((a, b) => roleRank(a.role) - roleRank(b.role) || a.sort_order - b.sort_order || a.created_at.localeCompare(b.created_at))
}

/** 相对时间：刚刚、N 分钟前、N 小时前、N 天前，超过 30 天给日期 */
export function ago(iso: string, now = Date.now()): string {
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return '-'
  const m = Math.floor((now - t) / 60000)
  if (m < 1) return '刚刚'
  if (m < 60) return `${m} 分钟前`
  if (m < 60 * 24) return `${Math.floor(m / 60)} 小时前`
  if (m < 60 * 24 * 30) return `${Math.floor(m / 1440)} 天前`
  return localDay(new Date(t))
}
