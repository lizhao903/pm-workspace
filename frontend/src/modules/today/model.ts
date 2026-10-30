// 今日页的纯函数：问候语、今天的任务、插件卡片合并。规格见 web-next/docs/spec/today.md SPEC-today-1。
import type { ComponentType } from 'react'
import type { PluginTodayCard, TodayItem, TodayTone } from '../../core/plugin'
import { connectorsPagePath, incidentsPagePath, openErrors, type Connector, type DictItem, type Incident, type Progress, type TodayCard, type WorkObject } from '../../core/data'

/** 每组需要处理的事露几条，今天的任务露几条，自动执行、正在运行各露几条 */
export const NEED_SHOW = 3
export const TASK_SHOW = 8
export const LINE_SHOW = 5
/** 进行中：高优先级的第二档只算这个状态的 */
export const DOING = 'doing'

export function greet(h: number): string {
  return h < 6 ? '夜深了' : h < 11 ? '早上好' : h < 13 ? '中午好' : h < 18 ? '下午好' : '晚上好'
}

export function dateText(d: Date): string {
  return d.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' })
}

/** 高优先级的两档：优先级字典按顺序的前两项（种子里是 P0、P1） */
export function hotLevels(items: readonly DictItem[]): [string | undefined, string | undefined] {
  const order = [...items].filter((it) => !it.archived_at).sort((a, b) => a.sort_order - b.sort_order)
  return [order[0]?.key, order[1]?.key]
}

/**
 * 其余的高优先级：第一档任意状态，第二档且进行中；截止在今天或更早的已经算在逾期、今天里，去掉。
 * rows 是未结束的任务（not_terminal），dueDay 按本地日期算截止日
 */
export function pickHot(rows: readonly WorkObject[], levels: [string | undefined, string | undefined], today: string,
  dueDay: (t: WorkObject) => string | null): WorkObject[] {
  const [top, second] = levels
  return rows.filter((t) => {
    const d = dueDay(t)
    if (d && d <= today) return false
    return (!!top && t.priority === top) || (!!second && t.priority === second && t.status === DOING)
  })
}

export type DayRow = { task: WorkObject; tag?: string; bad?: boolean }

/** 逾期（截止早的在前，接口已排好）、今天截止、其余高优先级合起来；hidden 是刚点了完成、等刷新的 */
export function dayRows(overdue: readonly WorkObject[], dueToday: readonly WorkObject[], hot: readonly WorkObject[],
  doingLabel: string, hidden: ReadonlySet<string>): DayRow[] {
  const seen = new Set<string>()
  const out: DayRow[] = []
  const push = (r: DayRow) => {
    if (seen.has(r.task.id) || hidden.has(r.task.id)) return
    seen.add(r.task.id)
    out.push(r)
  }
  for (const t of overdue) push({ task: t, tag: '逾期', bad: true })
  for (const t of dueToday) push({ task: t, tag: '今天' })
  for (const t of hot) push({ task: t, tag: t.status === DOING ? doingLabel : undefined })
  return out
}

/** 今日页上的一张插件卡片：前端注册了渲染的用它渲染，否则按通用样式显示接口给的条数和条目 */
export type PluginCardView = {
  key: string
  title: string
  order: number
  /** 接口里这张卡的数据；只有前端的插件没有 */
  data?: TodayCard
  render?: ComponentType<{ data: unknown }>
}

/**
 * 合并插件卡片，按 order 排（同 order 按前端注册在前、再按接口顺序）。
 * - 接口给了的卡片都显示：插件在跑、今天有内容；停用的插件后端不再返回
 * - 前端注册了、接口没给的：插件有后端记录（backendPlugins 里有）说明今天没内容或停用了，不显示；
 *   只有前端的插件（示例 hello）照常显示，data 为 undefined
 * - 停用插件时前端注册的卡片由 deactivatePlugin 撤掉，后端那份由失效规则刷新后消失
 */
export function mergePluginCards(registered: readonly PluginTodayCard[], backend: readonly TodayCard[],
  backendPlugins: ReadonlySet<string>): PluginCardView[] {
  const byKey = new Map(backend.map((c) => [c.key, c]))
  const out: PluginCardView[] = []
  const used = new Set<string>()
  for (const c of registered) {
    const data = byKey.get(c.key)
    if (!data && backendPlugins.has(c.plugin)) continue
    used.add(c.key)
    out.push({ key: c.key, title: c.title, order: c.order ?? data?.order ?? 100, data, render: c.render as ComponentType<{ data: unknown }> })
  }
  for (const c of backend) if (!used.has(c.key)) out.push({ key: c.key, title: c.title, order: c.order || 100, data: c })
  return out.map((c, i) => [c, i] as const).sort((a, b) => a[0].order - b[0].order || a[1] - b[1]).map(([c]) => c)
}

/** 通用卡片里一条的文字：字符串原样，对象取 title / name / text，取不到不显示 */
export function itemText(it: unknown): string {
  if (typeof it === 'string') return it
  if (it && typeof it === 'object') {
    const o = it as Record<string, unknown>
    for (const k of ['title', 'name', 'text']) if (typeof o[k] === 'string' && o[k]) return o[k] as string
  }
  return ''
}

/** 定时任务的执行时刻 HH:mm（本地时间） */
export function clock(iso: string): string {
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 组内排序（SPEC-today-1.4、1.20）：异常在前，同级先按来源给的 rank，再按时间新的在前，没时间的放最后 */
const TONE_RANK: Record<TodayTone, number> = { danger: 0, warn: 1, info: 2, ok: 3 }
export function byUrgency(a: TodayItem, b: TodayItem): number {
  return TONE_RANK[a.tone] - TONE_RANK[b.tone] || (a.rank ?? 0) - (b.rank ?? 0) || (b.at ?? '').localeCompare(a.at ?? '')
}

/** 「需要你处理」的一组。review 是内核的任务待验收，条目另行渲染 */
export type NeedGroup = {
  key: string
  label: string
  order: number
  total: number
  items: TodayItem[]
  /** 「查看全部」去哪；没有不显示 */
  more?: string
  /** 不到 NEED_SHOW 条也显示「查看全部」（任务待验收） */
  moreAlways?: boolean
  /** 这一组没取到 */
  error?: boolean
  retry?: () => void
}

/** 没条目的组不出现，没取到的组留着显示重试；按来源顺序排，同序按传进来的顺序 */
export function needGroups(groups: readonly NeedGroup[]): NeedGroup[] {
  return groups.map((g, i) => [g, i] as const).filter(([g]) => g.total > 0 || g.error)
    .sort((a, b) => a[0].order - b[0].order || a[1] - b[1]).map(([g]) => ({ ...g, items: [...g.items].sort(byUrgency) }))
}

/** 连接异常（SPEC-today-1.4）：连接器 status=error；没有时间，点了去设置的连接器并打开这个实例的抽屉 */
export function connectorNeeds(rows: readonly Connector[]): TodayItem[] {
  return rows.filter((c) => c.status === 'error').map((c) => ({
    id: c.id, tone: 'danger', title: `连接器「${c.name}」异常`, sub: c.error, action: '去修复', to: connectorsPagePath({ connector: c.id }),
  }))
}

/** 运行异常（SPEC-today-1.4 表）：未处理的错误级异常；说明「模块 · 共 N 次」，时间是最近一次，点了打开异常抽屉 */
export function incidentNeeds(rows: readonly Incident[]): TodayItem[] {
  return openErrors(rows).map((x) => ({
    id: `inc-${x.id}`, tone: 'danger', title: x.title, sub: `${x.module} · 共 ${x.count} 次`, at: x.last_at, action: '去看看', to: incidentsPagePath(x.id),
  }))
}

/** 操作者显示名：Claude Code 的 actor_name 是 claude-code */
export function actorText(name: string): string {
  return name === 'claude-code' ? 'Claude Code' : name
}

/** 最近一条提交验收的进展；接口给的是新的在前 */
export function lastReview(rows: readonly Progress[] | undefined): Progress | undefined {
  return rows?.find((p) => p.kind === 'review')
}

/** 任务待验收的说明（SPEC-today-1.25）：「操作者 提交验收 · 项目名」，没有提交验收的进展时「等你验收」 */
export function reviewSub(last: Progress | undefined, project?: string): string {
  const who = last ? `${actorText(last.actor_name) || '有人'} 提交验收` : '等你验收'
  return project ? `${who} · ${project}` : who
}
