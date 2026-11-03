// 内容日历的纯函数（VID-06d，照原型 web-next/src/videocalendar.tsx 和 videodata.ts 的 calendarItems）：
// 网格画哪些日子、同一天怎么排、拖动后的新时刻、能不能挪。发布和首发日由后端日历接口给，商单交付截止后端还没合进日历，在这里按商单补上
import type { VideoCalendarItem, VideoCalendarKind, VideoCalendarTone, VideoDeal } from '../../core/data'

export type CalMode = 'month' | 'week'

/** 日历上的一条：后端给的发布、首发日，加上前端补的商单交付 */
export type CalItem = Omit<VideoCalendarItem, 'kind' | 'tone'> & {
  kind: VideoCalendarKind | 'deal_deadline'
  tone: VideoCalendarTone | 'warn'
  /** 商单所在项目，跳到项目的「商单」标签用 */
  project_id?: string
}

export const WEEK_HEAD = ['一', '二', '三', '四', '五', '六', '日']
/** 月视图一格最多露几条，多的折成「+N 条」 */
export const CELL_PEEK = 3
export const KIND_LABEL: Record<CalItem['kind'], string> = { publish: '发布', target: '计划首发', deal_deadline: '商单交付' }
/** 商单离交付截止不到几天标橙，同原型 */
const DEAL_WARN_DAYS = 3
const DEAL_CLOSED = ['delivered', 'paid', 'lost']

const pad = (n: number) => String(n).padStart(2, '0')
export const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
export const fromYmd = (s: string) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d) }
export const isYmd = (s: string | null | undefined): s is string => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s) && ymd(fromYmd(s)) === s
export const addDays = (d: Date, n: number) => { const x = new Date(d); x.setDate(x.getDate() + n); return x }
/** 这一周的周一 */
export const mondayOf = (d: Date) => { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); return addDays(x, -((x.getDay() + 6) % 7)) }
/** 两个 YYYY-MM-DD 差几天（b - a） */
export const daysBetween = (a: string, b: string) => Math.round((fromYmd(b).getTime() - fromYmd(a).getTime()) / 86400000)
export const hm = (iso: string) => { const d = new Date(iso); return `${pad(d.getHours())}:${pad(d.getMinutes())}` }
export const keyOf = (x: Pick<CalItem, 'kind' | 'ref_id'>) => `${x.kind}:${x.ref_id}`
export const weekdayOf = (s: string) => WEEK_HEAD[(fromYmd(s).getDay() + 6) % 7]

/** 要画的日子：月视图从 1 号所在周的周一画到月底所在周的周日；周视图就是这一周 */
export function gridDays(mode: CalMode, anchor: Date): Date[] {
  if (mode === 'week') return Array.from({ length: 7 }, (_, i) => addDays(mondayOf(anchor), i))
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1)
  const last = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0)
  const start = mondayOf(first)
  const n = Math.ceil((daysBetween(ymd(start), ymd(last)) + 1) / 7) * 7
  return Array.from({ length: n }, (_, i) => addDays(start, i))
}

/** 标题：「2026 年 10 月」「10 月 26 日 - 11 月 1 日」 */
export function rangeTitle(mode: CalMode, anchor: Date, days: Date[]): string {
  if (mode === 'month') return `${anchor.getFullYear()} 年 ${anchor.getMonth() + 1} 月`
  const a = days[0]
  const b = days[days.length - 1]
  return `${a.getMonth() + 1} 月 ${a.getDate()} 日 - ${b.getMonth() + 1} 月 ${b.getDate()} 日`
}

/** 上一个、下一个月或周 */
export const stepAnchor = (mode: CalMode, d: Date, n: number) => (mode === 'month' ? new Date(d.getFullYear(), d.getMonth() + n, 1) : addDays(d, n * 7))

/** 同一天里：失败的、落后的排前面，然后商单、首发日，发布按时刻 */
const rank = (x: CalItem) => (x.tone === 'danger' ? 0 : x.kind === 'deal_deadline' ? 1 : x.kind === 'target' ? 2 : 3)
export const sortDay = (xs: CalItem[]) => [...xs].sort((a, b) => rank(a) - rank(b) || (a.at ?? '').localeCompare(b.at ?? ''))

/** 没交付、没丢单、交付截止在范围里的商单 */
export function dealItems(deals: readonly VideoDeal[], from: string, to: string, today: string): CalItem[] {
  return deals
    .filter((d) => d.deadline && d.deadline >= from && d.deadline <= to && !DEAL_CLOSED.includes(d.status))
    .map((d) => ({
      date: d.deadline!, kind: 'deal_deadline', ref_id: d.id, label: `${d.brand}：${d.title}`, project_id: d.project_id, movable: false,
      tone: daysBetween(today, d.deadline!) <= DEAL_WARN_DAYS ? 'warn' : 'muted',
    }))
}

/** 挪到另一天，时刻不变 */
export function movedAt(at: string, date: string): string {
  const d = new Date(at)
  const [y, m, dd] = date.split('-').map(Number)
  d.setFullYear(y, m - 1, dd)
  return d.toISOString()
}

/** 能不能挪到这一天：不能时给一句原因。已定时的挪到过去的时刻会被后端当场投出去，先挡住 */
export function moveError(x: CalItem, date: string, now: Date = new Date()): string {
  if (!x.movable) return x.kind === 'publish' ? (x.status === 'published' ? '已经发出去了，日期不能改' : '发布失败的要先在发布记录里重试，再排日子') : '这一条的日期不能改'
  if (x.kind === 'publish' && x.status === 'scheduled' && x.at && new Date(movedAt(x.at, date)) <= now) {
    return `已定时的发布不能挪到已经过去的时间（${date} ${hm(x.at)}）`
  }
  return ''
}

/** 一条的提示文字 */
export function chipTip(x: CalItem, platformLabel: string | undefined, statusLabel: string | undefined): string {
  return `${KIND_LABEL[x.kind]}${platformLabel ? ` · ${platformLabel}` : ''}${x.at ? ` ${hm(x.at)}` : ''}：${x.label}`
    + `${statusLabel ? `（${statusLabel}）` : ''}${x.kind === 'target' && x.behind ? '，进度落后' : ''}${x.movable ? '；可以拖到别的日子' : ''}`
}
