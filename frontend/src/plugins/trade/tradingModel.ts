// 交易页的纯函数：状态文案、金额格式、下单前的预检查提示。
// 交互照原型 web-next/src/trading.tsx；撮合、估值、风控只在后端做，这里的预检查只做提示，不拦提交（SPEC-trading-0.12）。
import type {
  TradeAccount, TradeInstrument, TradeOrderSide, TradeOrderSource, TradeOrderStatus, TradeOrderType, TradePosition, TradeRiskRules, TradeRunStatus,
} from '../../core/data'
import { DOWN, MARKETS, UP } from './model'

export const ORDER_TYPE: Record<TradeOrderType, string> = { market: '市价', limit: '限价', stop: '止损市价', stop_limit: '止损限价' }
export const ORDER_STATUS: Record<TradeOrderStatus, { label: string; color: string }> = {
  open: { label: '挂单中', color: '#3d4fd6' }, partial: { label: '部分成交', color: '#b0570b' }, filled: { label: '已成交', color: '#2f7d43' },
  canceled: { label: '已撤单', color: '#a19d92' }, rejected: { label: '被拒绝', color: '#c0352b' },
}
export const ORDER_SOURCE: Record<TradeOrderSource, string> = { manual: '手动', close: '平仓', run: '策略', liquidation: '强平' }
export const RUN_STATUS: Record<TradeRunStatus, { label: string; color: string }> = {
  running: { label: '运行中', color: '#2f7d43' }, paused: { label: '已暂停', color: '#b0570b' }, stopped: { label: '已停止', color: '#a19d92' }, error: { label: '异常', color: '#c0352b' },
}
export const isActive = (s: TradeOrderStatus) => s === 'open' || s === 'partial'

/** 现在只有数币有行情源；别的市场下单、部署后端回 400「行情源还没接」（SPEC-trading-0.16） */
export const LIVE_MARKETS: readonly string[] = ['crypto']
export const NO_SOURCE = '行情源还没接'

export const num = (v: number, d = 0) => v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })
export const usd = (v: number, d = 0) => `${v < 0 ? '-' : ''}$${num(Math.abs(v), d)}`
export const signedUsd = (v: number, d = 0) => `${v > 0 ? '+' : v < 0 ? '-' : ''}$${num(Math.abs(v), d)}`
export const signed = (v: number, d = 2) => `${v > 0 ? '+' : v < 0 ? '-' : ''}${num(Math.abs(v), d)}`
export const tone = (v: number) => (v > 0 ? UP : v < 0 ? DOWN : undefined)
/** 总览大数字：超过 7 位整数改紧凑写法，完整值放 title */
export function compact(v: number, sign = false) {
  const a = Math.abs(v)
  const s = v < 0 ? '-' : sign && v > 0 ? '+' : ''
  if (a < 1e7) return `${s}$${num(a)}`
  return a >= 1e9 ? `${s}$${(a / 1e9).toFixed(2)}B` : `${s}$${(a / 1e6).toFixed(1)}M`
}
export const lotDigits = (lot: number) => (lot >= 1 ? 0 : Math.min(8, Math.round(-Math.log10(lot))))
export const roundLot = (q: number, lot: number) => {
  if (!(lot > 0)) return q
  const d = lotDigits(lot)
  return Number((Math.floor(q / lot + 1e-9) * lot).toFixed(d))
}
export const fmtQty = (q: number, lot = 0.00000001) => q.toLocaleString('en-US', { maximumFractionDigits: lotDigits(lot) })
export function fmtTime(iso?: string) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
}
export const isContract = (i?: Pick<TradeInstrument, 'kind'>) => !!i && i.kind !== 'spot'

/** 账户能不能下这个标的：不能的返回原因 */
export function acctBlock(a: TradeAccount, i: Pick<TradeInstrument, 'market'> | undefined): string | undefined {
  if (!a.paper) return '不是模拟盘账户'
  if (i && !a.markets.includes(i.market)) return `不支持${MARKETS[i.market].label}`
  if (i && !LIVE_MARKETS.includes(i.market)) return `${MARKETS[i.market].label}${NO_SOURCE}`
  if (!a.permissions.includes('trade')) return '只读权限，不能下单'
  return undefined
}

/** 这笔是不是开仓（开仓才受熔断、金额、仓位占比限制），同后端 isOpening */
export function isOpening(positions: TradePosition[], accountId: string, i: Pick<TradeInstrument, 'symbol' | 'kind'>, side: TradeOrderSide, qty: number, reduce: boolean) {
  const pos = positions.find((p) => p.account_id === accountId && p.symbol === i.symbol)
  if (!isContract(i)) return side === 'buy'
  if (reduce) return false
  return !(pos && (pos.side === 'long') !== (side === 'buy') && qty <= pos.qty + 1e-9)
}

/**
 * 下单前的预检查，原因文字同后端（SPEC-trading-10）。只做提示：真正的检查在后端统一下单入口，
 * 提交后被拦就以后端返回的原因为准。value 是这一笔的金额（折 USD，数币 1:1）。
 */
export function riskHints(o: {
  risk: TradeRiskRules & { halted: boolean }; account?: TradeAccount; inst: Pick<TradeInstrument, 'name' | 'kind' | 'symbol'>; value: number; leverage: number
  opening: boolean; positions: TradePosition[]
}): string[] {
  const { risk, account: a, inst: i, value, opening } = o
  const out: string[] = []
  if (risk.halted && opening) out.push('熔断中：只能平仓或减仓，禁止新开仓')
  if (opening && value > risk.max_order_value) out.push(`单笔金额 ${usd(value)} 超过上限 ${usd(risk.max_order_value)}`)
  if (opening && a) {
    const held = o.positions.filter((p) => p.account_id === a.id && p.symbol === i.symbol).reduce((s, p) => s + Math.abs(p.value), 0)
    const share = a.equity > 0 ? ((held + value) / a.equity) * 100 : 100
    if (share > risk.max_position_pct) out.push(`下单后 ${i.name} 占该账户权益 ${share.toFixed(1)}%，超过单标的上限 ${risk.max_position_pct}%`)
  }
  if (isContract(i) && i.kind !== 'option' && o.leverage > risk.max_leverage) out.push(`杠杆 ${o.leverage}x 超过上限 ${risk.max_leverage}x`)
  return out
}

/** 部署持续时长：一天以上「N 天」，否则「N 小时」（至少 1） */
export function runDuration(from: string, to?: string, now = Date.now()) {
  const d = ((to ? Date.parse(to) : now) - Date.parse(from)) / 86400000
  return d >= 1 ? `${Math.floor(d)} 天` : `${Math.max(1, Math.round(d * 24))} 小时`
}
