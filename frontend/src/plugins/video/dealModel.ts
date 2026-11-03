// 商单（VID-08d）的纯函数：状态、账期提示、金额、草稿和改动，照原型 web-next/src/videodata.ts、videodeals.tsx。
// 状态流转的校验以后端为准（丢单要原因、已收款不能丢单），这里只做提交前的提示
import { localDay, type VideoDeal, type VideoDealCurrency, type VideoDealInput, type VideoDealStatus, type VideoPlatform } from '../../core/data'

export const DEAL_STATUS: Record<VideoDealStatus, { label: string; color: string }> = {
  inquiry: { label: '询价', color: '#a19d92' },
  quoted: { label: '已报价', color: '#7a4fd6' },
  signed: { label: '已签约', color: '#3d4fd6' },
  producing: { label: '制作中', color: '#0f8a8a' },
  client_review: { label: '客户审核', color: '#b0570b' },
  delivered: { label: '已交付', color: '#2f7d43' },
  paid: { label: '已收款', color: '#2f7d43' },
  lost: { label: '丢单', color: '#c0352b' },
}
/** 正常流转的顺序；丢单可以从收款前的任一步进 */
export const DEAL_FLOW: VideoDealStatus[] = ['inquiry', 'quoted', 'signed', 'producing', 'client_review', 'delivered', 'paid']
export const CURRENCIES: { value: VideoDealCurrency; label: string }[] = [{ value: 'CNY', label: '人民币' }, { value: 'USD', label: '美元' }]
/** 发布满几天出结案报告，同后端 ReportDays */
export const REPORT_DAYS = 7

const DAY_MS = 86400000
/** 两个本地日期 YYYY-MM-DD 差几天（b - a） */
export const daysBetween = (a: string, b: string) => Math.round((new Date(`${b}T00:00`).getTime() - new Date(`${a}T00:00`).getTime()) / DAY_MS)

export const money = (d: Pick<VideoDeal, 'quote' | 'currency'>) => `${d.currency === 'CNY' ? '¥' : '$'}${d.quote.toLocaleString('zh-CN')}`
/** 还在跑的商单：没收款、没丢单 */
export const isOpenDeal = (d: Pick<VideoDeal, 'status'>) => d.status !== 'paid' && d.status !== 'lost'

/** 账期提示：已交付没收款，离最晚收款日不到 7 天提醒，过了标红；口径同今日卡片 video_deal_due */
export function payState(d: Pick<VideoDeal, 'status' | 'pay_due'>, today = localDay(new Date())): { days: number; tone: 'warn' | 'danger' } | null {
  if (d.status !== 'delivered' || !d.pay_due) return null
  const days = daysBetween(today, d.pay_due)
  if (days > 7) return null
  return { days, tone: days < 0 ? 'danger' : 'warn' }
}

/** 账期一句话（SPEC-videos-16.3） */
export function payText(d: Pick<VideoDeal, 'status' | 'pay_due' | 'deadline'>, today = localDay(new Date())): { text: string; tone: '' | 'warn' | 'danger' } {
  const ps = payState(d, today)
  if (ps) return { text: ps.days < 0 ? `账期已过 ${-ps.days} 天` : ps.days === 0 ? '今天到账期' : `${ps.days} 天后到账期`, tone: ps.tone }
  if (d.status === 'paid') return { text: '已收款', tone: '' }
  if (d.deadline && isOpenDeal(d) && d.status !== 'delivered') return { text: `${d.deadline} 交付`, tone: '' }
  if (d.pay_due && d.status === 'delivered') return { text: `${d.pay_due} 前收款`, tone: '' }
  return { text: '-', tone: '' }
}

/** 项目汇总：进行中几单、进行中金额和已收款（只算人民币）、账期快到的几单 */
export function dealStats(xs: VideoDeal[], today = localDay(new Date())) {
  const open = xs.filter(isOpenDeal)
  const cny = (ys: VideoDeal[]) => ys.filter((d) => d.currency === 'CNY').reduce((s, d) => s + d.quote, 0)
  return { open: open.length, openSum: cny(open), paidSum: cny(xs.filter((d) => d.status === 'paid')), due: xs.filter((d) => payState(d, today)).length }
}

/** 列表顺序：进行中的在前（新建的在前），已收款、丢单的折在后面 */
export function splitDeals(xs: VideoDeal[]) {
  const desc = [...xs].sort((a, b) => b.created_at.localeCompare(a.created_at))
  return { open: desc.filter(isOpenDeal), closed: desc.filter((d) => !isOpenDeal(d)) }
}

/** 抽屉里的草稿：可选字段用空串表示没有 */
export type DealDraft = {
  project_id: string
  contact_id: string
  brand: string
  title: string
  platforms: VideoPlatform[]
  deliverables: string
  quote: number
  currency: VideoDealCurrency
  status: VideoDealStatus
  deadline: string
  pay_due: string
  video_ids: string[]
  source_message_id: string
  lost_reason: string
}

export function draftOf(d: VideoDeal | null, init: Partial<DealDraft> = {}): DealDraft {
  if (!d) {
    return {
      project_id: '', contact_id: '', brand: '', title: '', platforms: [], deliverables: '', quote: 0, currency: 'CNY', status: 'inquiry',
      deadline: '', pay_due: '', video_ids: [], source_message_id: '', lost_reason: '', ...init,
    }
  }
  return {
    project_id: d.project_id, contact_id: d.contact_id ?? '', brand: d.brand, title: d.title, platforms: d.platforms, deliverables: d.deliverables,
    quote: d.quote, currency: d.currency, status: d.status, deadline: d.deadline ?? '', pay_due: d.pay_due ?? '', video_ids: d.video_ids,
    source_message_id: d.source_message_id ?? '', lost_reason: d.lost_reason ?? '',
  }
}

/** 提交前的校验，只显示第一条（SPEC-videos-16.12） */
export function dealErrors(d: DealDraft, saved?: Pick<VideoDeal, 'status'> | null): string[] {
  return [
    !d.brand.trim() && '品牌必填',
    !d.title.trim() && '商单名称必填',
    !d.project_id && '选一个项目',
    d.status === 'lost' && !d.lost_reason.trim() && '写一下丢单原因',
    d.status === 'lost' && saved?.status === 'paid' && '已收款的商单不能丢单',
  ].filter((x): x is string => !!x)
}

const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i])
const opt = (s: string) => (s.trim() ? s.trim() : null)

/** 新建时的 body：没填的可选字段不传 */
export function createBody(d: DealDraft): VideoDealInput {
  const body: VideoDealInput = {
    project_id: d.project_id, brand: d.brand.trim(), title: d.title.trim(), platforms: d.platforms, deliverables: d.deliverables.trim(),
    quote: d.quote, currency: d.currency, status: d.status, video_ids: d.video_ids,
  }
  if (d.contact_id) body.contact_id = d.contact_id
  if (d.deadline) body.deadline = d.deadline
  if (d.pay_due) body.pay_due = d.pay_due
  if (d.source_message_id) body.source_message_id = d.source_message_id
  if (d.status === 'lost') body.lost_reason = d.lost_reason.trim()
  return body
}

/** 改动的字段；可选字段清空时传 null；丢单原因只在丢单时带 */
export function dealPatch(d: VideoDeal, x: DealDraft): VideoDealInput {
  const o = draftOf(d)
  const p: VideoDealInput = {}
  if (x.project_id !== o.project_id) p.project_id = x.project_id
  if (x.brand.trim() !== o.brand) p.brand = x.brand.trim()
  if (x.title.trim() !== o.title) p.title = x.title.trim()
  if (x.deliverables.trim() !== o.deliverables) p.deliverables = x.deliverables.trim()
  if (x.quote !== o.quote) p.quote = x.quote
  if (x.currency !== o.currency) p.currency = x.currency
  if (x.status !== o.status) p.status = x.status
  if (!same(x.platforms, o.platforms)) p.platforms = x.platforms
  if (!same(x.video_ids, o.video_ids)) p.video_ids = x.video_ids
  if (x.contact_id !== o.contact_id) p.contact_id = opt(x.contact_id)
  if (x.deadline !== o.deadline) p.deadline = opt(x.deadline)
  if (x.pay_due !== o.pay_due) p.pay_due = opt(x.pay_due)
  if (x.status === 'lost' && x.lost_reason.trim() !== o.lost_reason) p.lost_reason = x.lost_reason.trim()
  return p
}

/** 报价参考的「填入」：后端给的投放价值 */
export const quoteFill = (value: number) => Math.max(0, Math.round(value / 100) * 100)

/** 最近几次状态变化一行（SPEC-videos-16.6）：「<状态> <多久前>」 */
export function historyLine(h: VideoDeal['history'], ago: (iso: string) => string, n = 4) {
  return h.slice(0, n).map((x) => `${DEAL_STATUS[x.status]?.label ?? x.status} ${ago(x.at)}`).join(' · ')
}
