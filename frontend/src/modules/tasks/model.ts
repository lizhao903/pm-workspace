// 任务列表的纯函数：截止分段、状态筛选、排序。规格见 web-next/docs/spec/tasks.md SPEC-tasks-2。
// 「是否结束」一律看 /api/object-types 里状态的 terminal 标记，和后端 overdue / not_terminal 的判定同一来源。
import { localDay, type DictItem, type ObjectStatus, type WorkObject } from '../../core/data'

/** 每段先露几条 */
export const PAGE = 30
/** 段尾「这一段还有 N 条」点一次多露几条 */
export const MORE_STEP = 100
/** 状态分段按钮最多放几个，其余收进「更多状态」 */
export const STATUS_HEAD = 5

/** 截止分段：逾期 / 今天 / 本周 / 以后 / 无截止 / 已结束 */
export type DueSeg = 'overdue' | 'today' | 'week' | 'later' | 'none' | 'closed'
export const DUE_SEGS: { key: DueSeg; label: string }[] = [
  { key: 'overdue', label: '逾期' },
  { key: 'today', label: '今天' },
  { key: 'week', label: '本周' },
  { key: 'later', label: '以后' },
  { key: 'none', label: '无截止' },
  { key: 'closed', label: '已结束' },
]

/** 状态筛选：open 未结束（默认）、all 全部，其余是状态 key */
export type StatusFilter = string
export const OPEN = 'open'
export const ALL = 'all'

export type Terminal = (status: string) => boolean

/** 待验收：开发闭环约定的状态（迁移 0013），完成圆圈和抽屉对它另有处理 */
export const REVIEW = 'review'

/** 完成圆圈标完成时用的状态：优先 done，没有就取第一个终态（但不取已取消） */
export function doneKey(statuses: readonly ObjectStatus[]): string | undefined {
  return (statuses.find((s) => s.key === 'done') ?? statuses.find((s) => s.terminal && s.key !== 'cancelled'))?.key
}

/** 已完成的改回去用的状态：第一个非终态（种子里是 todo） */
export function reopenKey(statuses: readonly ObjectStatus[]): string | undefined {
  return statuses.find((s) => !s.terminal)?.key
}

/** 按类型的状态表判断是否终态；不认识的状态算未结束，和后端 terminalClause 一致 */
export function terminalOf(statuses: readonly ObjectStatus[]): Terminal {
  const set = new Set(statuses.filter((s) => s.terminal).map((s) => s.key))
  return (k) => set.has(k)
}

/** 截止日在本地时区是哪一天；没有截止为 null */
export function dueDay(t: Pick<WorkObject, 'due_at'>): string | null {
  if (!t.due_at) return null
  const d = new Date(t.due_at)
  return Number.isNaN(d.getTime()) ? null : localDay(d)
}

/** 本周最后一天（周日），本地日期 */
export function weekEnd(now: Date): string {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + ((7 - now.getDay()) % 7))
  return localDay(d)
}

/** 逾期：有截止、截止日早于今天、未结束。和后端「早于今天零点」是同一个分界，待验收也算 */
export function isOverdue(t: WorkObject, terminal: Terminal, today: string): boolean {
  const d = dueDay(t)
  return !!d && d < today && !terminal(t.status)
}

export function dueSeg(t: WorkObject, terminal: Terminal, today: string, end: string): DueSeg {
  if (terminal(t.status)) return 'closed'
  const d = dueDay(t)
  if (!d) return 'none'
  if (d < today) return 'overdue'
  if (d === today) return 'today'
  return d <= end ? 'week' : 'later'
}

export function matchStatus(t: WorkObject, f: StatusFilter, terminal: Terminal): boolean {
  if (f === ALL) return true
  if (f === OPEN) return !terminal(t.status)
  return t.status === f
}

/** 分段按钮上的状态：去掉已取消（只在「全部」里看），前 5 个放按钮，其余进「更多状态」 */
export function statusButtons(statuses: readonly ObjectStatus[]) {
  const items = statuses.filter((s) => s.key !== 'cancelled')
  return { head: items.slice(0, STATUS_HEAD), rest: items.slice(STATUS_HEAD) }
}

/** 优先级的先后：按字典顺序，不在字典里的排最后，再按 key */
export function priorityRank(items: readonly DictItem[]) {
  const order = [...items].sort((a, b) => a.sort_order - b.sort_order)
  const rank = new Map(order.map((it, i) => [it.key, i]))
  return (k: string) => rank.get(k) ?? (k ? order.length : order.length + 1)
}

/** 段内排序：先优先级，再截止日，没有截止的在后 */
export function sortTasks(rows: WorkObject[], rank: (k: string) => number): WorkObject[] {
  const due = (t: WorkObject) => (t.due_at ? Date.parse(t.due_at) : Number.POSITIVE_INFINITY)
  return [...rows].sort((a, b) =>
    rank(a.priority) - rank(b.priority) || a.priority.localeCompare(b.priority) || due(a) - due(b) || a.ref.localeCompare(b.ref))
}

export function segment(rows: WorkObject[], terminal: Terminal, now: Date) {
  const today = localDay(now)
  const end = weekEnd(now)
  return DUE_SEGS
    .map((s) => ({ ...s, rows: rows.filter((t) => dueSeg(t, terminal, today, end) === s.key) }))
    .filter((s) => s.rows.length > 0)
}

/** 截止列的文字：今天显示「今天」，其余 mm-dd，没有显示「-」 */
export function dueText(t: WorkObject, today: string): string {
  const d = dueDay(t)
  if (!d) return '-'
  return d === today ? '今天' : d.slice(5)
}

export function timeAgo(iso: string, now: Date = new Date()): string {
  const m = Math.round((now.getTime() - new Date(iso).getTime()) / 60000)
  if (m < 1) return '刚刚'
  if (m < 60) return `${m} 分钟前`
  if (m < 1440) return `${Math.floor(m / 60)} 小时前`
  if (m < 2880) return '昨天'
  return `${Math.floor(m / 1440)} 天前`
}
