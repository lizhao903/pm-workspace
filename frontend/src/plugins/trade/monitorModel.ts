// 盯盘页的纯函数：条件表、适用性、当前值格式、规则筛选、触发记录分段、市场时段、抽屉草稿。
// 交互照原型 web-next/src/monitor.tsx，规格 web-next/docs/spec/monitor.md。判定只在后端，这里不判定。
import type { TradeAlert, TradeAlertCond, TradeAlertInput, TradeAlertNotify, TradeInstrument, TradeKind, TradeMarket } from '../../core/data'

/** 条件的显示名、单位、只适用的品种，同原型 ALERT_COND */
export const ALERT_COND: Record<TradeAlertCond, { label: string; unit: string; kinds?: TradeKind[] }> = {
  price_above: { label: '价格上穿', unit: '价格' },
  price_below: { label: '价格下穿', unit: '价格' },
  pct_above: { label: '涨幅超过', unit: '%' },
  pct_below: { label: '跌幅超过', unit: '%' },
  volume_spike: { label: '成交量放大', unit: '倍于均量' },
  funding_above: { label: '资金费率高于', unit: '%', kinds: ['perp'] },
  iv_above: { label: '隐含波动率高于', unit: '%', kinds: ['option'] },
  limit_near: { label: '接近涨跌停', unit: '% 以内' },
}
export const ALERT_CONDS = Object.keys(ALERT_COND) as TradeAlertCond[]

export const NOTIFY_LABEL: Record<TradeAlertNotify, string> = { app: '应用内', im: 'IM', sound: '声音' }
export const NOTIFIES = Object.keys(NOTIFY_LABEL) as TradeAlertNotify[]

export const isPriceCond = (c: TradeAlertCond) => c === 'price_above' || c === 'price_below'

/** 条件是否适用于这个标的，同原型 condFits；后端保存时按同样的规则拒绝 */
export function condFits(cond: TradeAlertCond, i: TradeInstrument | undefined) {
  if (!i) return false
  const k = ALERT_COND[cond].kinds
  if (k && !k.includes(i.kind)) return false
  if (cond === 'limit_near' && !i.limit) return false
  return true
}

const fixed = (v: number, d: number) => v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })

/** 当前值：价格按精度，量比两位小数加「倍」，资金费率四位小数加 %，其余两位小数加 %（同原型 fmtCondValue） */
export function fmtAlertValue(cond: TradeAlertCond, v: number, digits: number) {
  if (isPriceCond(cond)) return fixed(v, digits)
  if (cond === 'volume_spike') return `${v.toFixed(2)} 倍`
  if (cond === 'funding_above') return `${v.toFixed(4)}%`
  return `${v.toFixed(2)}%`
}

/** 规则行里的阈值：价格类按精度，其余原样 */
export const fmtThreshold = (a: Pick<TradeAlert, 'cond' | 'value'>, digits: number) => (isPriceCond(a.cond) ? fixed(a.value, digits) : String(a.value))

/** 「填入当前值」：价格去掉千分位，资金费率四位小数，其余两位小数 */
export function fillValue(cond: TradeAlertCond, v: number, digits: number) {
  if (isPriceCond(cond)) return v.toFixed(digits)
  return cond === 'funding_above' ? v.toFixed(4) : v.toFixed(2)
}

/* ---------- 规则筛选 ---------- */

export type RuleFilter = 'all' | 'on' | 'fired' | 'off'
export const RULE_FILTERS: [RuleFilter, string][] = [['all', '全部'], ['on', '启用'], ['fired', '已触发'], ['off', '停用']]
export const ruleIn = (a: TradeAlert, f: RuleFilter) => f === 'all' || (f === 'on' ? a.enabled : f === 'off' ? !a.enabled : !!a.last_fired_at)

/** 空格分词，每个词都要命中标的名、symbol、备注或条件名 */
export function ruleMatches(a: TradeAlert, name: string, q: string) {
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return true
  const hay = `${name} ${a.symbol} ${a.note} ${ALERT_COND[a.cond].label}`.toLowerCase()
  return words.every((w) => hay.includes(w))
}

/* ---------- 时间 ---------- */

/** 相对时间，同原型 timeAgo */
export function timeAgo(iso: string, now = Date.now()) {
  const m = Math.round((now - new Date(iso).getTime()) / 60000)
  if (m < 1) return '刚刚'
  if (m < 60) return `${m} 分钟前`
  if (m < 1440) return `${Math.floor(m / 60)} 小时前`
  if (m < 2880) return '昨天'
  return `${Math.floor(m / 1440)} 天前`
}

/** 触发记录按天分段的标题：今天、昨天、M 月 D 日，跨年带年份 */
export function dayLabel(iso: string, now = Date.now()) {
  const d = new Date(iso)
  const today = new Date(now)
  today.setHours(0, 0, 0, 0)
  const diff = Math.round((today.getTime() - new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()) / 86400000)
  if (diff === 0) return '今天'
  if (diff === 1) return '昨天'
  return d.getFullYear() === today.getFullYear() ? `${d.getMonth() + 1} 月 ${d.getDate()} 日` : `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日`
}

/* ---------- 市场时段（同原型 sessionOf，不算节假日） ---------- */

export type SessionState = 'pre' | 'open' | 'break' | 'post' | 'closed'
export const SESSION_LABEL: Record<SessionState, string> = { pre: '盘前', open: '交易中', break: '午休', post: '盘后', closed: '休市' }
export const MARKET_TZ: Record<Exclude<TradeMarket, 'crypto'>, { tz: string; city: string }> = {
  cn: { tz: 'Asia/Shanghai', city: '上海' }, hk: { tz: 'Asia/Hong_Kong', city: '香港' }, us: { tz: 'America/New_York', city: '纽约' },
}

export function sessionOf(market: TradeMarket, at = Date.now()): SessionState {
  if (market === 'crypto') return 'open'
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: MARKET_TZ[market].tz, hour12: false, weekday: 'short', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(at))
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ''
  if (get('weekday') === 'Sat' || get('weekday') === 'Sun') return 'closed'
  const hm = (Number(get('hour')) % 24) * 60 + Number(get('minute'))
  const t = (h: number, m = 0) => h * 60 + m
  if (market === 'cn') {
    if (hm >= t(9, 15) && hm < t(9, 30)) return 'pre'
    if ((hm >= t(9, 30) && hm < t(11, 30)) || (hm >= t(13) && hm < t(15))) return 'open'
    return hm >= t(11, 30) && hm < t(13) ? 'break' : 'closed'
  }
  if (market === 'hk') {
    if (hm >= t(9) && hm < t(9, 30)) return 'pre'
    if ((hm >= t(9, 30) && hm < t(12)) || (hm >= t(13) && hm < t(16))) return 'open'
    if (hm >= t(12) && hm < t(13)) return 'break'
    return hm >= t(16) && hm < t(16, 10) ? 'post' : 'closed'
  }
  if (hm >= t(4) && hm < t(9, 30)) return 'pre'
  if (hm >= t(9, 30) && hm < t(16)) return 'open'
  return hm >= t(16) && hm < t(20) ? 'post' : 'closed'
}

const STEP = 300_000
/** 下一次时段变化、下一次开盘；时段边界都在 5 分钟整点上 */
export function sessionPlan(m: TradeMarket, at: number) {
  const cur = sessionOf(m, at)
  let change: { s: SessionState; at: number } | null = null
  let open: number | null = cur === 'open' ? at : null
  let t = Math.floor(at / STEP) * STEP + STEP
  for (let k = 0; k < 1600 && (!change || open === null); k++, t += STEP) {
    const s = sessionOf(m, t)
    if (!change && s !== cur) change = { s, at: t }
    if (open === null && s === 'open') open = t
  }
  return { change, open }
}

/** 时长：超过一天「N 天 N 小时」，超过一小时「N 小时 MM 分」，否则「N 分钟」 */
export function fmtSessionSpan(ms: number) {
  const m = Math.max(0, Math.ceil(ms / 60000))
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60
  if (d) return `${d} 天 ${h} 小时`
  if (h) return `${h} 小时 ${String(mm).padStart(2, '0')} 分`
  return `${mm} 分钟`
}

/* ---------- 抽屉草稿 ---------- */

export type AlertDraft = {
  symbol: string
  cond: TradeAlertCond
  /** 先按字符串存，保存时转数字 */
  value: string
  repeat: boolean
  cooldown_min: number
  notify: TradeAlertNotify[]
  im_connector: string
  enabled: boolean
  note: string
}

export function draftOf(a: TradeAlert | null, symbol: string, imDefault = ''): AlertDraft {
  if (a) {
    return {
      symbol: a.symbol, cond: a.cond, value: String(a.value), repeat: a.repeat, cooldown_min: a.cooldown_min, notify: [...a.notify],
      im_connector: a.im_connector || imDefault, enabled: a.enabled, note: a.note,
    }
  }
  return { symbol, cond: 'price_above', value: '', repeat: false, cooldown_min: 30, notify: ['app'], im_connector: imDefault, enabled: true, note: '' }
}

/** 换标的：阈值清空，原条件不适用新标的就换回「价格上穿」 */
export function withSymbol(d: AlertDraft, symbol: string, inst: TradeInstrument | undefined): AlertDraft {
  return { ...d, symbol, value: '', cond: condFits(d.cond, inst) ? d.cond : 'price_above' }
}

export const valueOk = (d: AlertDraft) => d.value.trim() !== '' && Number.isFinite(Number(d.value))

/** 保存前的问题，第一条显示在底部；空数组才能保存 */
export function draftErrors(d: AlertDraft, inst: TradeInstrument | undefined): string[] {
  const out: string[] = []
  if (!valueOk(d)) out.push(d.value.trim() ? '阈值要是数字' : '填一个阈值')
  if (!d.notify.length) out.push('至少选一种通知方式')
  if (d.notify.includes('im') && !d.im_connector) out.push('选一个推送用的 IM 连接器')
  if (!condFits(d.cond, inst)) out.push(`「${ALERT_COND[d.cond].label}」不适用于这个标的`)
  return out
}

export function draftBody(d: AlertDraft): TradeAlertInput {
  const im = d.notify.includes('im')
  return {
    symbol: d.symbol, cond: d.cond, value: Number(d.value), repeat: d.repeat, cooldown_min: Math.max(0, Math.floor(d.cooldown_min) || 0),
    notify: d.notify, im_connector: im ? d.im_connector : '', enabled: d.enabled, note: d.note.trim(),
  }
}
