import { Fragment, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Subnav } from './subnav'
import { PageTitle } from './topbar'
import { cls, timeAgo } from './ui'
import {
  LIVE_CHECKS, MARKETS, ORDER_STATUS, ORDER_TYPE, RUN_STATUS, SESSION_LABEL, UP, DOWN,
  fmtPct, fmtPrice, instOf, positionPnl, prevClose, priceAt, round, seedLiveReview, seedRecons, sessionOf, useNow,
  type Instrument, type LiveCheckKey, type LiveReview, type MarketKey, type Order, type OrderType, type Position, type Reconciliation, type RiskRules,
  type Strategy, type StrategyRun, type TradeAccount,
} from './tradedata'
import './trading.css'
import { KIND_SHORT, SymbolPicker } from './symbolpick'
import { SearchSelect } from './searchselect'

// 交易员工作台 > 交易：总览、持仓、委托、策略运行、交易账户、风控、交易设置（实盘评审、停用插件）
// 数据都在 App 里，这里只通过 onXxx(fn) 改；撮合、策略日志这些模拟只在本页挂载时跑

export type TradingView = 'overview' | 'positions' | 'orders' | 'runs' | 'accounts' | 'risk' | 'settings'

/* ---------- 工具 ---------- */

/** 简单汇率，统一折成 USD 看总数 */
const FX: Record<string, number> = { USD: 1, USDT: 1, CNY: 0.14, HKD: 0.128 }
const toUsd = (v: number, cur: string) => v * (FX[cur] ?? 1)
const fromUsd = (v: number, cur: string) => v / (FX[cur] ?? 1)
const num = (v: number, d = 0) => v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })
const usd = (v: number, d = 0) => `${v < 0 ? '-' : ''}$${num(Math.abs(v), d)}`
const signedUsd = (v: number, d = 0) => `${v > 0 ? '+' : v < 0 ? '-' : ''}$${num(Math.abs(v), d)}`
/** 总览大数字：超过 7 位整数改紧凑写法（$96.1M），完整值放 title；金额不能被省略号截掉尾数 */
const compact = (v: number, sign = false) => {
  const a = Math.abs(v)
  const s = v < 0 ? '-' : sign && v > 0 ? '+' : ''
  if (a < 1e7) return `${s}$${num(a)}`
  return a >= 1e9 ? `${s}$${(a / 1e9).toFixed(2)}B` : `${s}$${(a / 1e6).toFixed(1)}M`
}
const signed = (v: number, d = 2) => `${v > 0 ? '+' : v < 0 ? '-' : ''}${num(Math.abs(v), d)}`
const tone = (v: number) => (v > 0 ? UP : v < 0 ? DOWN : undefined)
const curOf = (i?: Instrument) => (i ? MARKETS[i.market].currency : 'USD')
const isContract = (i?: Instrument) => !!i && i.kind !== 'spot'
const lotDigits = (lot: number) => (lot >= 1 ? 0 : Math.round(-Math.log10(lot)))
const roundLot = (q: number, lot: number) => round(Math.floor(q / lot + 1e-9) * lot, lotDigits(lot))
const fmtQty = (q: number, symbol: string) => q.toLocaleString('en-US', { maximumFractionDigits: lotDigits(instOf(symbol)?.lot ?? 1) })
const nowIso = () => new Date().toISOString()
const fmtTime = (iso: string) => new Date(iso).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
const cnDate = (t: number) => new Date(t).toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' })
const instName = (symbol: string) => instOf(symbol)?.name ?? symbol

const Pill = ({ label, color }: { label: string; color: string }) => <span className="pill" style={{ '--c': color } as React.CSSProperties}><span className="pill-dot" />{label}</span>
const CloseIcon = () => <svg viewBox="0 0 16 16" width="14" height="14"><path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
const PlusIcon = () => <svg viewBox="0 0 16 16" width="12" height="12"><path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>

function useEsc(onClose: () => void) {
  const ref = useRef(onClose)
  useEffect(() => { ref.current = onClose })
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') ref.current() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}

/* ---------- 持仓与资金计算 ---------- */

function posCalc(p: Position, at: number) {
  const i = instOf(p.symbol)
  const cur = curOf(i)
  const r = positionPnl(p, at)
  const dir = p.side === 'long' ? 1 : -1
  // 今日盈亏：24 小时内开的仓从成本算，否则从昨收算
  const base = Date.parse(p.opened_at) > at - 86400000 ? p.avg_price : prevClose(p.symbol, at)
  const day = (r.last - base) * p.qty * (i?.multiplier ?? 1) * dir
  const liqDist = p.liq_price ? Math.abs(p.liq_price - r.last) / r.last : undefined
  return { ...r, inst: i, cur, pnlUsd: toUsd(r.pnl, cur), valueUsd: toUsd(r.value, cur), dayUsd: toUsd(day, cur), liqDist }
}

function summarize(accounts: TradeAccount[], positions: Position[], at: number) {
  const equity = accounts.reduce((s, a) => s + toUsd(a.equity, a.currency), 0)
  const available = accounts.reduce((s, a) => s + toUsd(a.available, a.currency), 0)
  const margin = accounts.reduce((s, a) => s + toUsd(a.margin_used, a.currency), 0)
  let float = 0, today = 0
  const byMarket: Record<MarketKey, number> = { crypto: 0, cn: 0, hk: 0, us: 0 }
  for (const p of positions) {
    const c = posCalc(p, at)
    float += c.pnlUsd
    today += c.dayUsd
    if (c.inst) byMarket[c.inst.market] += c.inst.kind === 'spot' ? c.valueUsd : c.valueUsd / (p.leverage ?? 1)
  }
  return { equity, available, margin, float, today, byMarket, marginRate: equity ? margin / equity : 0 }
}

/** 实盘开关没开时，实盘账户上带实盘标记的操作都不可用 */
const LIVE_OFF = '实盘未开启'
const LIVE_OFF_TIP = '实盘未开启：到「交易设置」过评审、打开实盘开关前，实盘账户只读同步'
/** 账户能不能下这个标的：不能的返回原因；live 是实盘开关 */
function acctBlock(a: TradeAccount, i: Instrument | undefined, live: boolean): string | undefined {
  if (i && !a.markets.includes(i.market)) return `不支持${MARKETS[i.market].label}`
  if (!a.permissions.includes('trade')) return '只读权限，不能下单'
  if (!a.paper && !live) return LIVE_OFF
  if (a.status === 'error') return '连接异常'
  if (a.status !== 'connected') return '未连接'
  return undefined
}

/** 这笔是不是开仓（开仓才受熔断、金额、仓位占比限制） */
function isOpening(positions: Position[], accountId: string, i: Instrument, side: 'buy' | 'sell', qty: number, reduce: boolean) {
  if (!isContract(i)) return side === 'buy'
  if (reduce) return false
  const pos = positions.find((p) => p.account_id === accountId && p.symbol === i.symbol)
  return !(pos && (pos.side === 'long') !== (side === 'buy') && qty <= pos.qty + 1e-9)
}

/** 下单前风控检查：返回不通过的原因 */
function riskBlocks(o: { risk: RiskRules; account?: TradeAccount; inst: Instrument; valueUsd: number; leverage: number; opening: boolean; positions: Position[]; at: number }): string[] {
  const { risk, account: a, inst: i, valueUsd, opening } = o
  const out: string[] = []
  if (risk.halted && opening) out.push('熔断中：只能平仓或减仓，禁止新开仓')
  if (opening && valueUsd > risk.max_order_value) out.push(`单笔金额 ${usd(valueUsd)} 超过上限 ${usd(risk.max_order_value)}`)
  if (opening && a) {
    const eq = toUsd(a.equity, a.currency)
    const held = o.positions.filter((p) => p.account_id === a.id && p.symbol === i.symbol).reduce((s, p) => s + posCalc(p, o.at).valueUsd, 0)
    const share = eq ? ((held + valueUsd) / eq) * 100 : 100
    if (share > risk.max_position_pct) out.push(`下单后 ${i.name} 占该账户权益 ${share.toFixed(1)}%，超过单标的上限 ${risk.max_position_pct}%`)
  }
  if (isContract(i) && i.kind !== 'option' && o.leverage > risk.max_leverage) out.push(`杠杆 ${o.leverage}x 超过上限 ${risk.max_leverage}x`)
  return out
}

/** 交易所 / 券商那边会拒的单：提交后 0.6 秒回报被拒 */
function exchangeReject(a: TradeAccount, i: Instrument, side: 'buy' | 'sell', qty: number, type: OrderType, price: number | undefined, reduce: boolean, positions: Position[], at = Date.now()): string | undefined {
  if (!a.permissions.includes('trade')) return '账户只开了只读权限，不能下单'
  if (a.status !== 'connected') return a.status === 'error' ? `账户连接异常：${a.error ?? '未知错误'}` : '账户未连接'
  if (!a.markets.includes(i.market)) return `该账户不支持${MARKETS[i.market].label}`
  const pos = positions.find((p) => p.account_id === a.id && p.symbol === i.symbol)
  if (!isContract(i) && side === 'sell') {
    const have = pos?.side === 'long' ? pos.qty : 0
    if (have < qty - 1e-9) return have ? `可卖数量不足：持有 ${fmtQty(have, i.symbol)}` : '没有可卖的持仓（现货不能卖空）'
    if (i.market === 'cn' && pos && cnDate(Date.parse(pos.opened_at)) === cnDate(at)) return 'T+1：今日买入的股份明日才能卖出'
  }
  if (reduce && (!pos || (pos.side === 'long') === (side === 'buy'))) return '仅减仓：没有可减的反向持仓'
  if (i.market === 'cn' && i.limit && price !== undefined && (type === 'limit' || type === 'stop_limit')) {
    const [lo, hi] = limitBand(i, at)
    if (price < lo || price > hi) return `委托价超出涨跌停范围（${fmtPrice(i.symbol, lo)} - ${fmtPrice(i.symbol, hi)}）`
  }
  return undefined
}

function limitBand(i: Instrument, at: number): [number, number] {
  const pc = prevClose(i.symbol, at)
  return [round(pc * (1 - (i.limit ?? 0.1)), i.digits), round(pc * (1 + (i.limit ?? 0.1)), i.digits)]
}

/* ---------- 撮合用的附加信息（Order 类型里没有的） ---------- */

const orderMeta = new Map<string, { leverage?: number; reject?: string }>()

interface Fill { order: Order; price: number }

/** 把成交应用到持仓：同向加仓算均价，反向先减后反手 */
function applyFills(xs: Position[], fills: Fill[], at: string): Position[] {
  let out = [...xs]
  for (const { order: o, price } of fills) {
    const i = instOf(o.symbol)
    if (!i) continue
    const d = lotDigits(i.lot)
    const idx = out.findIndex((p) => p.account_id === o.account_id && p.symbol === o.symbol)
    const cur = idx >= 0 ? out[idx] : undefined
    const s = cur ? (cur.side === 'long' ? cur.qty : -cur.qty) : 0
    const delta = o.side === 'buy' ? o.qty : -o.qty
    const ns = round(s + delta, d)
    const lev = orderMeta.get(o.id)?.leverage ?? cur?.leverage
    const liq = (side: 'long' | 'short', avg: number) => (isContract(i) && i.kind !== 'option' && lev ? round(side === 'long' ? avg * (1 - 1 / lev + 0.005) : avg * (1 + 1 / lev - 0.005), i.digits) : undefined)
    if (Math.abs(ns) < 10 ** -d / 2) { out = out.filter((_, k) => k !== idx); continue }
    const side: 'long' | 'short' = ns > 0 ? 'long' : 'short'
    let next: Position
    if (!cur || Math.sign(s) === Math.sign(delta)) {
      const avg = round((Math.abs(s) * (cur?.avg_price ?? 0) + o.qty * price) / Math.abs(ns), i.digits + 2)
      next = { id: cur?.id ?? newId('ps'), account_id: o.account_id, symbol: o.symbol, side, qty: Math.abs(ns), avg_price: avg, leverage: isContract(i) ? lev : undefined, liq_price: liq(side, avg), run_id: o.run_id ?? cur?.run_id, opened_at: cur?.opened_at ?? at }
    } else if (Math.sign(ns) === Math.sign(s)) {
      next = { ...cur, qty: Math.abs(ns) }
    } else {
      next = { ...cur, side, qty: Math.abs(ns), avg_price: price, liq_price: liq(side, price), opened_at: at }
    }
    out = idx >= 0 ? out.map((p, k) => (k === idx ? next : p)) : [next, ...out]
  }
  return out
}

/** 成交对账户资金的影响：现货买减可用卖加可用；合约按保证金增减 */
function cashDeltas(positions: Position[], fills: Fill[], accounts: TradeAccount[]) {
  const res = new Map<string, { avail: number; margin: number }>()
  for (const { order: o, price } of fills) {
    const i = instOf(o.symbol)
    const a = accounts.find((x) => x.id === o.account_id)
    if (!i || !a) continue
    const amt = fromUsd(toUsd(price * o.qty * i.multiplier, curOf(i)), a.currency)
    const r = res.get(a.id) ?? { avail: 0, margin: 0 }
    if (!isContract(i)) r.avail += o.side === 'buy' ? -amt : amt
    else {
      const pos = positions.find((p) => p.account_id === o.account_id && p.symbol === o.symbol)
      const s = pos ? (pos.side === 'long' ? pos.qty : -pos.qty) : 0
      const ns = s + (o.side === 'buy' ? o.qty : -o.qty)
      const lev = orderMeta.get(o.id)?.leverage ?? pos?.leverage ?? 1
      const dm = fromUsd(toUsd((Math.abs(ns) - Math.abs(s)) * price * i.multiplier, curOf(i)), a.currency) / lev
      r.margin += dm
      r.avail -= dm
    }
    res.set(a.id, r)
  }
  return res
}

/* ---------- 一键全停 ---------- */

/** 全部运行改 stopped 并写日志、所有未完成委托撤单、进入熔断。纯函数 */
export function killAll(s: { runs: StrategyRun[]; orders: Order[]; risk: RiskRules }, reason: string, at = nowIso()): { runs: StrategyRun[]; orders: Order[]; risk: RiskRules } {
  return {
    runs: s.runs.map((r) => (r.status === 'stopped' ? r : { ...r, status: 'stopped', stopped_at: at, stop_reason: `一键全停：${reason}`, logs: [...r.logs, { at, level: 'warn', text: `一键全停：${reason}` }] })),
    orders: s.orders.map((o) => (o.status === 'open' || o.status === 'partial' || o.status === 'pending' ? { ...o, status: 'canceled', updated_at: at } : o)),
    risk: { ...s.risk, halted: true, halted_reason: reason, halted_at: at },
  }
}

/** 熔断记录：RiskRules 只存当前这一次，历史留在内存里。kind 手动 / 自动；解除要写原因（SPEC-trading-0.15） */
interface HaltRec { at: string; reason: string; kind: 'manual' | 'auto'; runs_stopped?: number; orders_canceled?: number; released_at?: string; release_reason?: string }
const haltLog: HaltRec[] = [
  { at: new Date(Date.now() - 9 * 86400000).toISOString(), reason: '单日亏损 3.1%，超过 3% 上限，自动熔断', kind: 'auto', runs_stopped: 2, orders_canceled: 1,
    released_at: new Date(Date.now() - 9 * 86400000 + 2 * 3600000).toISOString(), release_reason: '行情回稳，复盘后手动解除' },
]
const reportedAcct = new Set<string>()
/** 外部请求处理过的 n：页面重新挂载也不重复打开 */
const handled = { order: 0, deploy: 0 }

/* ---------- 实盘评审、对账、插件开关 ---------- */

/** 原型存模块内存：切走页面保留，刷新回到演示数据；二级菜单和页面都订阅它 */
interface Gate { review: LiveReview; recons: Reconciliation[]; pluginOn: boolean }
let gate: Gate = { review: seedLiveReview, recons: seedRecons, pluginOn: true }
const gateSubs = new Set<() => void>()
function setGate(p: Partial<Gate>) {
  gate = { ...gate, ...p }
  gateSubs.forEach((f) => f())
}
function useGate() {
  return useSyncExternalStore((f) => { gateSubs.add(f); return () => { gateSubs.delete(f) } }, () => gate)
}
/** 实盘开关真正生效：开关开着且 trade:live 还在 */
const liveOn = (r: LiveReview) => r.enabled && !!r.granted_at
/** 插件停用前要先全停：还没停的部署（暂停、异常的也算）和未完成的委托 */
function pluginOffBlock(runs: StrategyRun[], orders: Order[]): string | null {
  const r = runs.filter((x) => x.status !== 'stopped').length
  const o = orders.filter((x) => x.status === 'pending' || x.status === 'open' || x.status === 'partial').length
  if (!r && !o) return null
  return `还有 ${[r && `${r} 个部署在跑`, o && `${o} 笔挂单`].filter(Boolean).join('、')}，先到交易里一键全停`
}

/** 评审清单每一项现在的情况：ok 才能确认通过；不 ok 的给原因和去处理的地方 */
type LiveCheck = { ok: boolean; text: string; go?: TradingView }
function liveChecks(s: { accounts: TradeAccount[]; orders: Order[]; runs: StrategyRun[]; strategies: Strategy[]; recons: Reconciliation[]; at: number }): Record<LiveCheckKey, LiveCheck> {
  const liveAccts = s.accounts.filter((a) => !a.paper)
  const reconBad = liveAccts.flatMap((a) => {
    const rc = s.recons.find((x) => x.account_id === a.id)
    const open = rc?.items.filter((x) => !x.resolved_at).length ?? 0
    if (!rc) return [`${a.name}还没对过账`]
    if (rc.status === 'failed') return [`${a.name}对账失败`]
    return open ? [`${a.name}有 ${open} 处差异没处理`] : []
  })
  const drill = haltLog.find((h) => h.released_at && !h.reason.includes('自动'))
  const paper = s.runs
    .filter((r) => s.accounts.find((a) => a.id === r.account_id)?.paper)
    .map((r) => ({ r, days: ((r.stopped_at ? Date.parse(r.stopped_at) : s.at) - Date.parse(r.started_at)) / 86400000 }))
    .sort((a, b) => b.days - a.days)[0]
  return {
    audit: { ok: true, text: `委托 ${s.orders.length} 笔、熔断 ${haltLog.length} 次，每一步都有记录` },
    recon: reconBad.length
      ? { ok: false, text: reconBad.join('；'), go: 'accounts' }
      : { ok: true, text: `${liveAccts.length} 个实盘账户最近一次对账都一致` },
    incident: { ok: true, text: '交易的异常都记到「设置 / 运行异常」，模块「交易」' },
    drill: drill
      ? { ok: true, text: `${fmtTime(drill.at)} 全停，${fmtTime(drill.released_at!)} 解除` }
      : { ok: false, text: '还没演练过：按一次一键全停，确认都停了再解除熔断', go: 'risk' },
    paper: paper && paper.days >= 14
      ? { ok: true, text: `「${s.strategies.find((x) => x.id === paper.r.strategy_id)?.name ?? '策略'}」在模拟盘连续跑了 ${Math.floor(paper.days)} 天` }
      : { ok: false, text: paper ? `模拟盘最长连续跑了 ${Math.floor(paper.days)} 天，还差 ${Math.ceil(14 - paper.days)} 天` : '还没在模拟盘跑过', go: 'runs' },
  }
}

/* ---------- 二级菜单 ---------- */

export function TradingNav({ view, onSelect, accounts, runs, risk, onKill }: {
  view: TradingView; onSelect: (v: TradingView) => void
  accounts: TradeAccount[]; runs: StrategyRun[]; risk: RiskRules; onKill: () => void
}) {
  const [confirm, setConfirm] = useState(false)
  const badAcct = accounts.filter((a) => a.status !== 'connected').length
  const badRun = runs.filter((r) => r.status === 'error').length
  const live = runs.filter((r) => r.status === 'running').length
  const g = useGate()
  return (
    <Subnav title="交易" active={view} onSelect={onSelect} items={[
      { key: 'overview' as TradingView, label: '总览' },
      { key: 'positions' as TradingView, label: '持仓' },
      { key: 'orders' as TradingView, label: '委托' },
      { key: 'runs' as TradingView, label: '策略运行', desc: badRun ? `${badRun} 个异常` : live ? `${live} 个运行中` : undefined, alert: badRun },
      { key: 'accounts' as TradingView, label: '交易账户', desc: badAcct ? `${badAcct} 个异常` : undefined, alert: badAcct },
      { key: 'risk' as TradingView, label: '风控', desc: risk.halted ? '熔断中' : undefined, alert: risk.halted ? 1 : 0 },
      { key: 'settings' as TradingView, label: '交易设置', desc: !g.pluginOn ? '插件已停用' : liveOn(g.review) ? '实盘已开启' : '只开模拟盘' },
    ]}>
      {confirm ? (
        <>
          <button className="act act-quiet" onClick={() => setConfirm(false)}>取消</button>
          <button className="tr-kill" onClick={() => { onKill(); setConfirm(false) }}>确认全停</button>
        </>
      ) : (
        <button className="tr-kill" title="停掉所有策略、撤掉所有挂单、进入熔断" onClick={() => setConfirm(true)}>一键全停</button>
      )}
    </Subnav>
  )
}

/* ---------- 页面 ---------- */

type DrawerState =
  | { kind: 'order'; symbol: string; side: 'buy' | 'sell'; key: number }
  | { kind: 'run'; strategyId?: string; key: number }
  | { kind: 'account'; key: number }
  | { kind: 'recon'; accountId: string; key: number }
  | null

const TITLES: Record<TradingView, { title: string; desc: string }> = {
  overview: { title: '交易总览', desc: '各账户权益按简单汇率折成 USD；行情是模拟的，每秒刷新' },
  positions: { title: '持仓', desc: '现价随行情跳动；平仓会下一笔反向市价单' },
  orders: { title: '委托', desc: '提交后先到「提交中」，交易所回报后进入挂单；限价单在现价越过时成交' },
  runs: { title: '策略运行', desc: '策略部署到账户上跑；实盘要过评审、打开实盘开关，启动前再确认一次' },
  accounts: { title: '交易账户', desc: '交易所和券商的 API 接入；只申请读取和交易权限，不开提币权限' },
  risk: { title: '风控', desc: '下单前逐笔检查；当日亏损到上限自动熔断' },
  settings: { title: '交易设置', desc: '装好只有模拟盘；实盘要过评审、申请 trade:live、再打开实盘开关' },
}

export function TradingPage(props: {
  view: TradingView
  accounts: TradeAccount[]; positions: Position[]; orders: Order[]; runs: StrategyRun[]; risk: RiskRules; strategies: Strategy[]
  onAccounts: (fn: (xs: TradeAccount[]) => TradeAccount[]) => void
  onPositions: (fn: (xs: Position[]) => Position[]) => void
  onOrders: (fn: (xs: Order[]) => Order[]) => void
  onRuns: (fn: (xs: StrategyRun[]) => StrategyRun[]) => void
  onRisk: (fn: (r: RiskRules) => RiskRules) => void
  orderRequest: { symbol: string; side: 'buy' | 'sell'; n: number } | null
  deployRequest: { strategyId: string; n: number } | null
  onOpenChart: (symbol: string) => void
  onOpenStrategy: (id: string) => void
  onReport: (title: string, message: string) => void
  /** 切换二级视图（总览里「全部账户」跳交易账户）；不传时就地展开 */
  onView?: (v: TradingView) => void
  /** 账户不能删的原因（有持仓、挂单、在跑的部署），能删返回 null */
  accountDeleteBlock: (id: string) => string | null
  onDeleteAccount: (id: string) => void
}) {
  const { view, accounts, positions, orders, runs, risk, strategies, onAccounts, onPositions, onOrders, onRuns, onRisk, orderRequest, deployRequest, onReport } = props
  const [drawer, setDrawer] = useState<DrawerState>(null)
  const tick = useNow(500)
  const g = useGate()
  const liveMode = liveOn(g.review)

  // 最新的 props 放进 ref，给定时器读
  const live = useRef(props)
  useEffect(() => { live.current = props })

  /* 外部请求：n 变化才打开 */
  useEffect(() => {
    if (orderRequest && orderRequest.n !== handled.order) {
      handled.order = orderRequest.n
      setDrawer({ kind: 'order', symbol: orderRequest.symbol, side: orderRequest.side, key: Date.now() })
    }
  }, [orderRequest])
  useEffect(() => {
    if (deployRequest && deployRequest.n !== handled.deploy) {
      handled.deploy = deployRequest.n
      setDrawer({ kind: 'run', strategyId: deployRequest.strategyId, key: Date.now() })
    }
  }, [deployRequest])

  /* 账户异常上报，每个账户只报一次 */
  useEffect(() => {
    for (const a of accounts) {
      if (a.status === 'error' && !reportedAcct.has(a.id)) { reportedAcct.add(a.id); onReport('交易账户异常', `${a.name}：${a.error ?? '连接异常'}`) }
      if (a.status === 'connected') reportedAcct.delete(a.id)
    }
  }, [accounts, onReport])

  /* 模拟撮合：每 0.5 秒扫一遍未完成委托 */
  const processed = useRef(new Set<string>())
  useEffect(() => {
    const at = nowIso()
    const toOpen = new Set<string>()
    const rejects = new Map<string, string>()
    const fills: Fill[] = []
    for (const o of orders) {
      const age = tick - Date.parse(o.created_at)
      if (o.status === 'pending') {
        if (age < 600) continue
        const rej = orderMeta.get(o.id)?.reject
        if (rej) rejects.set(o.id, rej)
        else toOpen.add(o.id)
        continue
      }
      if (o.status !== 'open' && o.status !== 'partial') continue
      if (processed.current.has(o.id)) continue
      const i = instOf(o.symbol)
      const a = accounts.find((x) => x.id === o.account_id)
      if (!i || !a || a.status !== 'connected' || sessionOf(i.market, tick) !== 'open') continue
      const p = priceAt(o.symbol, tick)
      const buy = o.side === 'buy'
      const stopHit = o.stop_price !== undefined && (buy ? p >= o.stop_price : p <= o.stop_price)
      const limitOk = o.price !== undefined && (buy ? p <= o.price : p >= o.price)
      if (o.type === 'market' && age >= 1000) fills.push({ order: o, price: p })
      else if (o.type === 'limit' && limitOk) fills.push({ order: o, price: o.price! })
      else if (o.type === 'stop' && stopHit) fills.push({ order: o, price: p })
      else if (o.type === 'stop_limit' && stopHit && limitOk) fills.push({ order: o, price: o.price! })
    }
    const fresh = fills.filter((f) => !processed.current.has(f.order.id))
    fresh.forEach((f) => processed.current.add(f.order.id))
    const newRej = [...rejects].filter(([id]) => !processed.current.has(id))
    newRej.forEach(([id]) => processed.current.add(id))
    if (!toOpen.size && !newRej.length && !fresh.length) return
    const rejMap = new Map(newRej)
    const fillMap = new Map(fresh.map((f) => [f.order.id, f.price]))
    onOrders((xs) => xs.map((o) => {
      if (o.status === 'pending' && toOpen.has(o.id)) return { ...o, status: 'open', updated_at: at }
      if (o.status === 'pending' && rejMap.has(o.id)) return { ...o, status: 'rejected', reject_reason: rejMap.get(o.id), updated_at: at }
      if ((o.status === 'open' || o.status === 'partial') && fillMap.has(o.id)) return { ...o, status: 'filled', filled: o.qty, avg_fill: fillMap.get(o.id), updated_at: at }
      return o
    }))
    if (fresh.length) {
      const cash = cashDeltas(positions, fresh, accounts)
      onPositions((xs) => applyFills(xs, fresh, at))
      onAccounts((xs) => xs.map((a) => {
        const c = cash.get(a.id)
        return c ? { ...a, available: round(a.available + c.avail, 2), margin_used: round(Math.max(0, a.margin_used + c.margin), 2), updated_at: at } : a
      }))
      const byRun = fresh.filter((f) => f.order.run_id)
      if (byRun.length) onRuns((xs) => xs.map((r) => {
        const mine = byRun.filter((f) => f.order.run_id === r.id)
        return mine.length ? { ...r, logs: [...r.logs, ...mine.map((f) => ({ at, level: 'info' as const, text: `成交：${f.order.side === 'buy' ? '买入' : '卖出'} ${fmtQty(f.order.qty, f.order.symbol)} ${instName(f.order.symbol)} @ ${fmtPrice(f.order.symbol, f.price)}` }))] } : r
      }))
    }
    for (const [id, reason] of newRej) {
      const o = orders.find((x) => x.id === id)
      if (o) onReport('委托被拒', `${instName(o.symbol)} ${o.side === 'buy' ? '买入' : '卖出'} ${fmtQty(o.qty, o.symbol)}：${reason}`)
    }
  }, [tick, orders, accounts, positions, onOrders, onPositions, onAccounts, onRuns, onReport])

  /* 运行中的策略每 15 秒写一条日志、小幅改盈亏 */
  useEffect(() => {
    const t = window.setInterval(() => {
      const { runs: rs, strategies: sts, onRuns: set } = live.current
      const going = rs.filter((r) => r.status === 'running')
      if (!going.length) return
      const at = nowIso()
      const upd = new Map(going.map((r) => [r.id, runTick(r, sts.find((s) => s.id === r.strategy_id), at)]))
      set((xs) => xs.map((r) => {
        const u = upd.get(r.id)
        return u && r.status === 'running' ? { ...r, pnl: round(r.pnl + u.d, 2), logs: [...r.logs, u.log].slice(-60) } : r
      }))
    }, 15000)
    return () => window.clearInterval(t)
  }, [])

  /* 当日亏损到上限自动熔断；回到上限内之前不再重复触发 */
  const sum = summarize(accounts, positions, tick)
  const lossLimit = (sum.equity * risk.daily_loss_pct) / 100
  const lossUsed = Math.max(0, -sum.today)
  const autoTripped = useRef(false)
  useEffect(() => {
    if (lossUsed < lossLimit) { autoTripped.current = false; return }
    if (risk.halted || autoTripped.current) return
    autoTripped.current = true
    const reason = `单日亏损 ${usd(lossUsed)}，达到上限 ${risk.daily_loss_pct}%，自动熔断`
    kill(reason)
    onReport('风控熔断', reason)
  })

  /* 熔断记录：监听 risk.halted 的变化 */
  const [, setHaltVer] = useState(0)
  useEffect(() => {
    if (risk.halted && risk.halted_at && !haltLog.some((h) => h.at === risk.halted_at)) {
      haltLog.unshift({ at: risk.halted_at, reason: risk.halted_reason ?? '手动全停', kind: risk.halted_reason?.includes('自动熔断') ? 'auto' : 'manual' })
      setHaltVer((v) => v + 1)
    } else if (!risk.halted) {
      const open = haltLog.find((h) => !h.released_at)
      if (open) { open.released_at = nowIso(); setHaltVer((v) => v + 1) }
    }
  }, [risk.halted, risk.halted_at, risk.halted_reason])

  /** 一键全停的结果：停了几个部署、撤了几笔挂单，显示在页面顶上（SPEC-trading-1.3） */
  const [killMsg, setKillMsg] = useState('')
  const kill = (reason: string) => {
    const at = nowIso()
    const nRuns = runs.filter((r) => r.status !== 'stopped').length
    const nOrders = orders.filter((o) => ACTIVE.includes(o.status)).length
    if (risk.halted) {
      const open = haltLog.find((h) => !h.released_at)
      if (open) { open.released_at = at; open.release_reason = '再次一键全停，由新的熔断记录接替' }
    }
    haltLog.unshift({ at, reason, kind: reason.includes('自动熔断') ? 'auto' : 'manual', runs_stopped: nRuns, orders_canceled: nOrders })
    if (!reason.includes('自动熔断')) setKillMsg(`一键全停完成：停掉 ${nRuns} 个部署，撤掉 ${nOrders} 笔挂单，持仓保留；已进入熔断`)
    onRuns((xs) => killAll({ runs: xs, orders: [], risk }, reason, at).runs)
    onOrders((xs) => killAll({ runs: [], orders: xs, risk }, reason, at).orders)
    onRisk((r) => killAll({ runs: [], orders: [], risk: r }, reason, at).risk)
  }
  /** 解除熔断要写原因，记到这次熔断记录上；停掉的运行不自动恢复 */
  const release = (reason: string) => {
    const open = haltLog.find((h) => !h.released_at)
    if (open) { open.released_at = nowIso(); open.release_reason = reason }
    onRisk((r) => ({ ...r, halted: false, halted_reason: undefined, halted_at: undefined }))
  }

  /** 下一笔委托（已带上交易所侧会拒的原因） */
  const place = (o: Pick<Order, 'account_id' | 'symbol' | 'side' | 'type' | 'qty' | 'price' | 'stop_price' | 'reduce_only' | 'run_id'>, meta: { leverage?: number; reject?: string }) => {
    const id = newId('od')
    const at = nowIso()
    orderMeta.set(id, meta)
    onOrders((xs) => [{ ...o, id, filled: 0, status: 'pending', created_at: at, updated_at: at }, ...xs])
  }
  /** 平仓：反向市价单，合约带仅减仓 */
  const closePos = (p: Position, type: OrderType = 'market', stop?: number) => {
    const i = instOf(p.symbol)
    const a = accounts.find((x) => x.id === p.account_id)
    if (!i || !a) return
    const side = p.side === 'long' ? 'sell' : 'buy'
    const reduce = isContract(i)
    const reject = exchangeReject(a, i, side, p.qty, type, undefined, reduce, positions)
    place({ account_id: p.account_id, symbol: p.symbol, side, type, qty: p.qty, stop_price: stop, reduce_only: reduce || undefined, run_id: p.run_id }, { reject })
  }

  /* 实盘评审：每项算出现在能不能确认，给交易设置用 */
  const checks = liveChecks({ accounts, orders, runs, strategies, recons: g.recons, at: tick })

  /** 重新对账：账户没连上就记失败；还有没处理的差异照样是「有差异」，两种都记运行异常 */
  const recheck = (a: TradeAccount) => {
    const at = nowIso()
    const old = gate.recons.find((x) => x.account_id === a.id)
    const items = old?.items ?? []
    const open = items.filter((x) => !x.resolved_at)
    const n = 1 + positions.filter((p) => p.account_id === a.id).length + orders.filter((o) => o.account_id === a.id && ACTIVE.includes(o.status)).length
    const next: Reconciliation = a.status !== 'connected'
      ? { account_id: a.id, at, status: 'failed', error: a.status === 'error' ? `${a.error ?? '连接异常'}，拉不到交易所数据` : '账户未连接', checked: 0, items }
      : { account_id: a.id, at, status: open.length ? 'diff' : 'ok', checked: n, items }
    setGate({ recons: [...gate.recons.filter((x) => x.account_id !== a.id), next] })
    if (next.status === 'failed') onReport('交易对账异常', `${a.name}：对账失败，${next.error}`)
    if (next.status === 'diff') onReport('交易对账异常', `${a.name}：${open.length} 处差异没处理，${open.map((x) => `${x.label}本地 ${x.local}，交易所 ${x.remote}`).join('；')}`)
  }
  /** 按交易所修正：持仓差异改本地数量；处理完最后一处，这次对账变成一致 */
  const fixDiff = (accountId: string, itemId: string) => {
    const rc = gate.recons.find((x) => x.account_id === accountId)
    const it = rc?.items.find((x) => x.id === itemId)
    if (!rc || !it || it.resolved_at) return
    const at = nowIso()
    const items = rc.items.map((x) => (x.id === itemId ? { ...x, resolved_at: at, resolution: '按交易所修正了本地记录' } : x))
    const left = items.filter((x) => !x.resolved_at).length
    setGate({ recons: gate.recons.map((x) => (x.account_id === accountId ? { ...x, items, status: rc.status === 'diff' && !left ? 'ok' : x.status } : x)) })
    if (it.position_id && it.remote_qty !== undefined) {
      const pid = it.position_id
      const q = it.remote_qty
      onPositions((xs) => xs.map((p) => (p.id === pid ? { ...p, qty: q } : p)))
    }
  }

  const t = TITLES[view]
  const openOrder = (symbol = 'BINANCE:BTCUSDT', side: 'buy' | 'sell' = 'buy') => setDrawer({ kind: 'order', symbol, side, key: Date.now() })
  const actions = !g.pluginOn ? undefined : (
    <>
      {view === 'runs' && <button className="btn btn-outline" onClick={() => setDrawer({ kind: 'run', key: Date.now() })}>新建运行</button>}
      {view === 'accounts' && <button className="btn btn-outline" onClick={() => setDrawer({ kind: 'account', key: Date.now() })}>新增账户</button>}
      <button className="btn btn-primary" onClick={() => openOrder()}><PlusIcon />下单</button>
    </>
  )
  const acctName = (id: string) => accounts.find((a) => a.id === id)?.name ?? '已删除的账户'
  const reconAcct = drawer?.kind === 'recon' ? accounts.find((a) => a.id === drawer.accountId) : undefined

  // 停用后交易套件的页面都换成这一屏；原型里菜单还在，正式版菜单和扩展点一起消失
  if (!g.pluginOn) {
    return (
      <div className="page page-fill tr-page">
        <PageTitle parent="交易" desc="交易套件已停用，数据保留">{t.title}</PageTitle>
        <div className="empty">
          <div className="empty-title">交易插件已停用</div>
          <div className="list-sub">行情、盯盘、策略和交易都不再运行；账户、持仓记录和策略都还在，重新启用后照常使用</div>
          <button className="btn btn-primary" onClick={() => setGate({ pluginOn: true })}>重新启用</button>
        </div>
      </div>
    )
  }

  return (
    <div className="page page-fill tr-page">
      <PageTitle parent="交易" desc={t.desc} actions={actions}>{t.title}</PageTitle>
      {risk.halted && <HaltBar risk={risk} onRelease={release} />}
      {killMsg && (
        <div className="banner tr-kill-done">
          <span>{killMsg}</span>
          <button className="act act-quiet" onClick={() => setKillMsg('')}>知道了</button>
        </div>
      )}

      {view === 'overview' && <Overview {...props} sum={sum} lossUsed={lossUsed} lossLimit={lossLimit} at={tick} acctName={acctName} />}
      {view === 'positions' && <PositionsView accounts={accounts} positions={positions} runs={runs} strategies={strategies} at={tick} acctName={acctName} live={liveMode}
        onClose={(p) => closePos(p)} onStop={(p, price) => closePos(p, 'stop', price)} onChart={props.onOpenChart} onNew={() => openOrder()} />}
      {view === 'orders' && <OrdersView orders={orders} accounts={accounts} acctName={acctName} at={tick} live={liveMode} onOrders={onOrders} />}
      {view === 'runs' && <RunsView runs={runs} accounts={accounts} strategies={strategies} risk={risk} live={liveMode} onRuns={onRuns} onOpenStrategy={props.onOpenStrategy}
        onNew={() => setDrawer({ kind: 'run', key: Date.now() })} />}
      {view === 'accounts' && <AccountsView accounts={accounts} positions={positions} recons={g.recons} onAccounts={onAccounts} onNew={() => setDrawer({ kind: 'account', key: Date.now() })}
        onRecon={(id) => setDrawer({ kind: 'recon', accountId: id, key: Date.now() })} deleteBlock={props.accountDeleteBlock} onDelete={props.onDeleteAccount} />}
      {view === 'risk' && <RiskView risk={risk} onRisk={onRisk} lossUsed={lossUsed} lossLimit={lossLimit} equity={sum.equity} today={sum.today}
        halts={haltLog} onKill={() => kill('风控页手动一键全停')} />}
      {view === 'settings' && <SettingsView review={g.review} checks={checks} offBlock={pluginOffBlock(runs, orders)}
        onReview={(review) => setGate({ review })} onPluginOff={() => { setDrawer(null); setGate({ pluginOn: false }) }} onView={(v) => props.onView?.(v)} />}

      {drawer?.kind === 'order' && (
        <OrderDrawer key={drawer.key} init={drawer} accounts={accounts} positions={positions} risk={risk} live={liveMode} onReport={onReport}
          onClose={() => setDrawer(null)} onPlace={(o, meta) => { place(o, meta); setDrawer(null) }} onRiskReject={(o, reason) => place(o, { reject: reason })} />
      )}
      {drawer?.kind === 'run' && (
        <RunDrawer key={drawer.key} initStrategy={drawer.strategyId} strategies={strategies} accounts={accounts} risk={risk} live={liveMode} onClose={() => setDrawer(null)}
          onCreate={(r) => { onRuns((xs) => [r, ...xs]); setDrawer(null) }} />
      )}
      {drawer?.kind === 'account' && (
        <AccountDrawer key={drawer.key} onClose={() => setDrawer(null)} onCreate={(a) => { onAccounts((xs) => [...xs, a]); setDrawer(null) }} />
      )}
      {drawer?.kind === 'recon' && reconAcct && (
        <ReconDrawer key={drawer.key} account={reconAcct} recon={g.recons.find((x) => x.account_id === reconAcct.id)} onClose={() => setDrawer(null)}
          onRecheck={() => recheck(reconAcct)} onFix={(id) => fixDiff(reconAcct.id, id)} />
      )}
    </div>
  )
}

/** 策略运行的一次模拟心跳：随机小幅盈亏 + 一条日志 */
function runTick(r: StrategyRun, s: Strategy | undefined, at: string): { d: number; log: StrategyRun['logs'][number] } {
  const sym = r.symbols[Math.floor(Math.random() * r.symbols.length)] ?? r.symbols[0]
  const px = sym ? fmtPrice(sym, priceAt(sym)) : '-'
  const d = round((Math.random() - 0.47) * r.capital * 0.0012, 2)
  const roll = Math.random()
  const text = roll < 0.12
    ? `${instName(sym)} 波动放大，信号确认中`
    : roll < 0.3
      ? `${s?.name ?? '策略'}：${instName(sym)} @ ${px}，条件未满足，继续等待`
      : `${instName(sym)} @ ${px}，持仓中，无新信号；本次浮动 ${signed(d)}`
  return { d, log: { at, level: roll < 0.12 ? 'warn' : 'info', text } }
}

/* ---------- 熔断状态条 ---------- */

function HaltBar({ risk, onRelease }: { risk: RiskRules; onRelease: (reason: string) => void }) {
  const [confirm, setConfirm] = useState(false)
  const [reason, setReason] = useState('')
  return (
    <div className="banner banner-danger tr-halt">
      <span><b>熔断中</b>{risk.halted_reason ?? '手动全停'}{risk.halted_at && ` · ${fmtTime(risk.halted_at)}`}。所有策略已停止、挂单已撤，只能平仓或减仓。</span>
      {confirm ? (
        <span className="tr-halt-act">
          <span className="tr-halt-q">解除后可以重新开仓，策略不会自动恢复</span>
          <input className="tr-input tr-halt-input" placeholder="解除原因（必填）" value={reason} autoFocus onChange={(e) => setReason(e.target.value)} />
          <button className="act act-quiet" onClick={() => setConfirm(false)}>取消</button>
          <button className="act act-danger" disabled={!reason.trim()} title={reason.trim() ? undefined : '先写解除原因'} onClick={() => { onRelease(reason.trim()); setConfirm(false); setReason('') }}>确认解除</button>
        </span>
      ) : (
        <button className="act" onClick={() => setConfirm(true)}>解除熔断</button>
      )}
    </div>
  )
}

/* ---------- 总览 ---------- */

const OV_ACCTS = 6

function Overview({ accounts, positions, orders, runs, risk, strategies, sum, lossUsed, lossLimit, at, acctName, onOpenStrategy, onView }: {
  accounts: TradeAccount[]; positions: Position[]; orders: Order[]; runs: StrategyRun[]; risk: RiskRules; strategies: Strategy[]
  sum: ReturnType<typeof summarize>; lossUsed: number; lossLimit: number; at: number; acctName: (id: string) => string; onOpenStrategy: (id: string) => void
  onView?: (v: TradingView) => void
}) {
  const [allAccts, setAllAccts] = useState(false)
  const cash = sum.available
  const segs = [...(Object.keys(MARKETS) as MarketKey[]).map((m) => ({ key: m, label: MARKETS[m].label, color: MARKETS[m].color, v: sum.byMarket[m] })), { key: 'cash', label: '可用现金', color: 'var(--line-2)', v: cash }].filter((s) => s.v > 0)
  const total = segs.reduce((s, x) => s + x.v, 0)
  const going = runs.filter((r) => r.status === 'running' || r.status === 'error')
  const recent = [...orders].sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 6)
  const lossPct = lossLimit ? Math.min(1, lossUsed / lossLimit) : 0
  const bad = accounts.filter((a) => a.status !== 'connected')
  // 异常的在前，只露前几个；其余到「交易账户」看，没接跳转时就地展开
  const acctRows = [...bad, ...accounts.filter((a) => a.status === 'connected')]
  const acctShown = allAccts ? acctRows : acctRows.slice(0, OV_ACCTS)
  return (
    <>
      <section className="stats tr-stats">
        <div className="stat"><div className="stat-label">总权益（折 USD）</div><div className="stat-value tr-num" title={usd(sum.equity)}>{compact(sum.equity)}</div></div>
        <div className="stat"><div className="stat-label">今日盈亏</div><div className="stat-value tr-num" style={{ color: tone(sum.today) }} title={signedUsd(sum.today)}>{compact(sum.today, true)}</div></div>
        <div className="stat"><div className="stat-label">持仓浮盈</div><div className="stat-value tr-num" style={{ color: tone(sum.float) }} title={signedUsd(sum.float)}>{compact(sum.float, true)}</div></div>
        <div className="stat"><div className="stat-label">可用资金</div><div className="stat-value tr-num" title={usd(sum.available)}>{compact(sum.available)}</div></div>
        <div className="stat"><div className="stat-label">保证金占用率</div><div className={cls('stat-value tr-num', sum.marginRate > 0.5 && 'stat-danger')}>{(sum.marginRate * 100).toFixed(1)}%</div></div>
      </section>

      <div className="tr-ov-box"><div className="tr-ov">
        <div className="tr-ov-main">
          <section className="hook-sec">
            <div className="field-group-title">资产分布<span className="field-hint">持仓按市值（合约按保证金）+ 可用现金，折 USD</span></div>
            <div className="tr-dist">{segs.map((s) => <i key={s.key} style={{ width: `${(s.v / total) * 100}%`, background: s.color }} title={`${s.label} ${usd(s.v)}`} />)}</div>
            <div className="tr-legend">
              {segs.map((s) => (
                <span key={s.key} className="tr-legend-item"><i style={{ background: s.color }} />{s.label}<b className="tr-num">{usd(s.v)}</b><span className="faint">{((s.v / total) * 100).toFixed(1)}%</span></span>
              ))}
            </div>
          </section>

          <section className="hook-sec">
            <div className="field-group-title">运行中的策略<span className="field-hint">{going.length} 个</span></div>
            {!going.length ? <div className="mount-empty">没有运行中的策略</div> : (
              <div className="tr-mini-grid">
                {going.map((r) => {
                  const s = strategies.find((x) => x.id === r.strategy_id)
                  const a = accounts.find((x) => x.id === r.account_id)
                  return (
                    <button key={r.id} className="tr-mini" onClick={() => onOpenStrategy(r.strategy_id)} title="打开策略">
                      <span className="tr-mini-top"><span className="ellipsis">{s?.name ?? '已删除的策略'}</span><Pill {...RUN_STATUS[r.status]} /></span>
                      <span className="run-muted ellipsis">{a?.name ?? '-'}{a?.paper ? ' · 模拟' : ' · 实盘'} · {r.symbols.map(instName).join('、')}</span>
                      <span className="tr-mini-pnl tr-num" style={{ color: tone(r.pnl) }}>{signed(r.pnl)} <span className="faint">{a?.currency}</span></span>
                    </button>
                  )
                })}
              </div>
            )}
          </section>

          <section className="hook-sec">
            <div className="field-group-title">最近委托</div>
            {!recent.length ? <div className="mount-empty">还没有委托</div> : (
              <div className="tr-list">
                {recent.map((o) => (
                  <div key={o.id} className="tr-list-row">
                    <span className={cls('tr-side', o.side === 'buy' ? 'buy' : 'sell')}>{o.side === 'buy' ? '买' : '卖'}</span>
                    <span className="tr-list-main">
                      <span className="ellipsis">{instName(o.symbol)}</span>
                      <span className="run-muted ellipsis">{ORDER_TYPE[o.type]} · {fmtQty(o.qty, o.symbol)}{o.price !== undefined ? ` @ ${fmtPrice(o.symbol, o.price)}` : ''} · {acctName(o.account_id)}</span>
                    </span>
                    <span className="tr-list-side"><Pill {...ORDER_STATUS[o.status]} /><span className="faint">{timeAgo(o.created_at)}</span></span>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>

        <div className="tr-ov-side">
          <section className={cls('hook-sec', risk.halted && 'tr-sec-bad')}>
            <div className="field-group-title">风控状态</div>
            <div className="tr-kv"><span>状态</span><b className={risk.halted ? 'danger-text' : 'tr-ok'}>{risk.halted ? '熔断中' : '正常'}</b></div>
            <div className="tr-loss">
              <div className="tr-kv"><span>当日亏损</span><b className="tr-num">{usd(lossUsed)} / {usd(lossLimit)}</b></div>
              <div className="tr-bar"><i className={cls(lossPct > 0.8 && 'hot')} style={{ width: `${lossPct * 100}%` }} /></div>
            </div>
            <div className="tr-kv"><span>单笔上限</span><b className="tr-num">{usd(risk.max_order_value)}</b></div>
            <div className="tr-kv"><span>单标的仓位</span><b className="tr-num">{risk.max_position_pct}%</b></div>
            <div className="tr-kv"><span>最大杠杆</span><b className="tr-num">{risk.max_leverage}x</b></div>
            <div className="tr-kv"><span>二次确认</span><b className="tr-num">超过 {usd(risk.confirm_above)}</b></div>
          </section>
          <section className="hook-sec">
            <div className="field-group-title">账户<span className="field-hint">{accounts.length} 个{bad.length ? `，${bad.length} 个异常` : ''}</span></div>
            <div className="tr-list">
              {acctShown.map((a) => (
                <div key={a.id} className="tr-list-row">
                  <span className={cls('tr-dot', a.status === 'connected' ? 'ok' : 'bad')} />
                  <span className="tr-list-main"><span className="ellipsis">{a.name}</span><span className="run-muted ellipsis">{a.paper ? '模拟' : '实盘'} · {a.markets.map((m) => MARKETS[m].label).join(' / ')}</span></span>
                  <span className="tr-num tr-list-val">{num(a.equity)} <span className="faint">{a.currency}</span></span>
                </div>
              ))}
            </div>
            {acctRows.length > OV_ACCTS && (
              onView
                ? <button className="act act-quiet tr-more" onClick={() => onView('accounts')}>全部 {acctRows.length} 个账户</button>
                : <button className="act act-quiet tr-more" onClick={() => setAllAccts(!allAccts)}>{allAccts ? '收起' : `其余 ${acctRows.length - OV_ACCTS} 个账户`}</button>
            )}
          </section>
          <div className="faint tr-foot-note">按 {new Date(at).toLocaleTimeString('zh-CN', { hour12: false })} 的模拟行情计算</div>
        </div>
      </div></div>
    </>
  )
}

/* ---------- 持仓 ---------- */

function PositionsView({ accounts, positions, runs, strategies, at, acctName, live, onClose, onStop, onChart, onNew }: {
  accounts: TradeAccount[]; positions: Position[]; runs: StrategyRun[]; strategies: Strategy[]; at: number; acctName: (id: string) => string; live: boolean
  onClose: (p: Position) => void; onStop: (p: Position, price: number) => void; onChart: (symbol: string) => void; onNew: () => void
}) {
  const [acct, setAcct] = useState('')
  const [mkt, setMkt] = useState<MarketKey | ''>('')
  const [confirmClose, setConfirmClose] = useState<string | null>(null)
  const [stopFor, setStopFor] = useState<{ id: string; price: string } | null>(null)
  const rows = positions.filter((p) => (!acct || p.account_id === acct) && (!mkt || instOf(p.symbol)?.market === mkt))
  const calc = rows.map((p) => ({ p, c: posCalc(p, at) }))
  const totalPnl = calc.reduce((s, x) => s + x.c.pnlUsd, 0)
  const totalVal = calc.reduce((s, x) => s + x.c.valueUsd, 0)
  // 按账户分段，段头带权益和浮盈；只看一个账户时不分段
  const [folded, setFolded] = useState<string[]>([])
  const groups = accounts.map((a) => ({ a, items: calc.filter((x) => x.p.account_id === a.id) })).filter((g) => g.items.length)
  const orphan = calc.filter((x) => !accounts.some((a) => a.id === x.p.account_id))
  const sections = acct ? [{ key: acct, a: undefined, items: calc }] : [...groups.map((g) => ({ key: g.a.id, a: g.a as TradeAccount | undefined, items: g.items })), ...(orphan.length ? [{ key: '-', a: undefined, items: orphan }] : [])]
  const fold = (k: string) => setFolded(folded.includes(k) ? folded.filter((x) => x !== k) : [...folded, k])
  // 实盘开关没开时，实盘账户的持仓只读：平仓、加止损不可点
  const locked = (p: Position) => !live && accounts.some((a) => a.id === p.account_id && !a.paper)
  const runName = (id?: string) => {
    if (!id) return '手动'
    const r = runs.find((x) => x.id === id)
    return strategies.find((s) => s.id === r?.strategy_id)?.name ?? '策略'
  }
  return (
    <>
      <div className="toolbar">
        <div className="seg">
          <button className={cls(!mkt && 'on')} onClick={() => setMkt('')}>全部市场<span className="seg-n">{positions.length}</span></button>
          {(Object.keys(MARKETS) as MarketKey[]).map((m) => (
            <button key={m} className={cls(mkt === m && 'on')} onClick={() => setMkt(m)}>{MARKETS[m].label}<span className="seg-n">{positions.filter((p) => instOf(p.symbol)?.market === m).length}</span></button>
          ))}
        </div>
        <label className={cls('chip chip-select', acct && 'chip-on')}>
          <select value={acct} onChange={(e) => setAcct(e.target.value)}>
            <option value="">全部账户</option>
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </label>
        <span className="spacer" />
        <span className="run-muted tr-num">市值 {usd(totalVal)} · 浮盈 <b style={{ color: tone(totalPnl) }}>{signedUsd(totalPnl)}</b></span>
      </div>
      {!rows.length ? (
        <div className="empty"><div className="empty-title">{acct || mkt ? '没有匹配的持仓' : '还没有持仓'}</div><div className="list-sub">下单成交后会出现在这里</div><button className="btn btn-primary" onClick={onNew}>下单</button></div>
      ) : (
        <div className="task-table tr-table">
          <div className="tr-pos-row task-th"><span>标的</span><span className="tr-r tr-c-qty">数量</span><span className="tr-r tr-c-px">成本 / 现价</span><span className="tr-r">浮盈</span><span className="tr-r tr-c-val">市值</span><span className="tr-r tr-c-lev">杠杆 / 强平</span><span className="tr-r">操作</span></div>
          {sections.map((g) => {
            const pnl = g.items.reduce((s, x) => s + x.c.pnlUsd, 0)
            const shut = !acct && folded.includes(g.key)
            return (
            <Fragment key={g.key}>
              {!acct && (
                <button className="tr-grp" onClick={() => fold(g.key)} aria-expanded={!shut}>
                  <svg className={cls('tr-grp-chev', shut && 'shut')} viewBox="0 0 16 16" width="12" height="12"><path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
                  <b className="ellipsis">{g.a?.name ?? '已删除的账户'}</b>
                  <span className="run-muted tr-grp-sub">{g.items.length} 个持仓{g.a ? ` · 权益 ${num(g.a.equity)} ${g.a.currency}` : ''}{g.a && !g.a.paper && !live ? ' · 只读同步' : ''}</span>
                  <span className="spacer" />
                  <span className="run-muted tr-num">浮盈 <b style={{ color: tone(pnl) }}>{signedUsd(pnl)}</b></span>
                </button>
              )}
              {!shut && g.items.map(({ p, c }) => (
            <div key={p.id} className="tr-pos-wrap">
              <div className="tr-pos-row">
                <span className="task-main">
                  <span className="task-title">
                    <span className={cls('tr-side', p.side === 'long' ? 'buy' : 'sell')}>{p.side === 'long' ? '多' : '空'}</span>
                    <span className="ellipsis">{c.inst?.name ?? p.symbol}</span>
                    {c.inst && <span className="tag tr-tag-sm">{KIND_SHORT[c.inst.kind]}</span>}
                  </span>
                  <span className="task-meta"><span className="ellipsis">{acctName(p.account_id)} · {runName(p.run_id)}</span></span>
                </span>
                <span className="tr-r tr-num tr-c-qty">{fmtQty(p.qty, p.symbol)}</span>
                <span className="tr-r tr-num tr-c-px tr-two"><span className="faint">{fmtPrice(p.symbol, p.avg_price)}</span><span>{fmtPrice(p.symbol, c.last)}</span></span>
                <span className="tr-r tr-num tr-two" style={{ color: tone(c.pnl) }}><span>{signed(c.pnl, c.inst && c.inst.digits > 2 ? 2 : c.inst?.digits ?? 2)}</span><span className="tr-pct">{fmtPct(c.pct)}</span></span>
                <span className="tr-r tr-num tr-c-val tr-two"><span>{num(c.value)}</span><span className="faint">{c.cur}</span></span>
                <span className="tr-r tr-num tr-c-lev tr-two">
                  <span>{p.leverage ? `${p.leverage}x` : '-'}</span>
                  {p.liq_price ? <span className={cls(c.liqDist !== undefined && c.liqDist < 0.1 ? 'danger-text' : 'faint')}>{fmtPrice(p.symbol, p.liq_price)} · 距 {((c.liqDist ?? 0) * 100).toFixed(1)}%</span> : <span className="faint">-</span>}
                </span>
                <span className="tr-ops">
                  {confirmClose === p.id ? (
                    <>
                      <button className="act act-quiet" onClick={() => setConfirmClose(null)}>取消</button>
                      <button className="act act-danger" onClick={() => { onClose(p); setConfirmClose(null) }}>市价全平</button>
                    </>
                  ) : (
                    <>
                      <button className="act" disabled={locked(p)} title={locked(p) ? LIVE_OFF_TIP : undefined} onClick={() => setConfirmClose(p.id)}>平仓</button>
                      <button className="act act-quiet" onClick={() => onChart(p.symbol)}>看图</button>
                      <button className="act act-quiet" disabled={locked(p)} title={locked(p) ? LIVE_OFF_TIP : undefined} onClick={() => setStopFor({ id: p.id, price: String(round(c.last * (p.side === 'long' ? 0.95 : 1.05), c.inst?.digits ?? 2)) })}>加止损</button>
                    </>
                  )}
                </span>
              </div>
              {stopFor?.id === p.id && (() => {
                const sp = Number(stopFor.price)
                const bad = !(sp > 0) || (p.side === 'long' ? sp >= c.last : sp <= c.last)
                return (
                  <div className="tr-stop-row">
                    <span className="run-muted">止损价</span>
                    <input className={cls('tr-input', bad && 'bad')} inputMode="decimal" value={stopFor.price} autoFocus onChange={(e) => setStopFor({ ...stopFor, price: e.target.value })} />
                    <span className="run-muted tr-stop-hint">{bad ? (p.side === 'long' ? '多单止损价要低于现价' : '空单止损价要高于现价') : `触发后市价${p.side === 'long' ? '卖出' : '买入'} ${fmtQty(p.qty, p.symbol)}，距现价 ${((Math.abs(sp - c.last) / c.last) * 100).toFixed(1)}%`}</span>
                    <span className="spacer" />
                    <button className="act act-quiet" onClick={() => setStopFor(null)}>取消</button>
                    <button className="act act-primary" disabled={bad} onClick={() => { onStop(p, sp); setStopFor(null) }}>挂止损单</button>
                  </div>
                )
              })()}
            </div>
              ))}
            </Fragment>
            )
          })}
        </div>
      )}
    </>
  )
}

/* ---------- 委托 ---------- */

const ACTIVE: Order['status'][] = ['pending', 'open', 'partial']
/** 历史委托先露这么多条 */
const ORDER_PAGE = 50

function OrdersView({ orders, accounts, acctName, at, live, onOrders }: {
  orders: Order[]; accounts: TradeAccount[]; acctName: (id: string) => string; at: number; live: boolean; onOrders: (fn: (xs: Order[]) => Order[]) => void
}) {
  // 实盘开关没开时，实盘账户的委托只读：改价、撤单不可点，全部撤单跳过它们
  const locked = (o: Order) => !live && accounts.some((a) => a.id === o.account_id && !a.paper)
  const [tab, setTab] = useState<'active' | 'history'>('active')
  const [acct, setAcctRaw] = useState('')
  const setAcct = (v: string) => { setAcctRaw(v); setLimit(ORDER_PAGE) }
  const [edit, setEdit] = useState<{ id: string; price: string } | null>(null)
  const [limit, setLimit] = useState(ORDER_PAGE)
  const isActive = (o: Order) => ACTIVE.includes(o.status)
  const base = orders.filter((o) => !acct || o.account_id === acct)
  const rows = base.filter((o) => (tab === 'active' ? isActive(o) : !isActive(o))).sort((a, b) => b.created_at.localeCompare(a.created_at))
  const cancel = (id: string) => { const t = nowIso(); onOrders((xs) => xs.map((o) => (o.id === id && ACTIVE.includes(o.status) ? { ...o, status: 'canceled', updated_at: t } : o))) }
  const savePrice = (o: Order, v: number) => {
    const t = nowIso()
    onOrders((xs) => xs.map((x) => (x.id === o.id && ACTIVE.includes(x.status) ? { ...x, ...(o.type === 'stop' ? { stop_price: v } : { price: v }), updated_at: t } : x)))
    setEdit(null)
  }
  const cancelable = rows.filter((o) => !locked(o))
  const cancelAll = () => { const t = nowIso(); const ids = new Set(cancelable.map((o) => o.id)); onOrders((xs) => xs.map((o) => (ids.has(o.id) && ACTIVE.includes(o.status) ? { ...o, status: 'canceled', updated_at: t } : o))) }
  return (
    <>
      <div className="toolbar">
        <div className="seg">
          <button className={cls(tab === 'active' && 'on')} onClick={() => { setTab('active'); setLimit(ORDER_PAGE) }}>当前委托<span className="seg-n">{base.filter(isActive).length}</span></button>
          <button className={cls(tab === 'history' && 'on')} onClick={() => { setTab('history'); setLimit(ORDER_PAGE) }}>历史委托<span className="seg-n">{base.filter((o) => !isActive(o)).length}</span></button>
        </div>
        <label className={cls('chip chip-select', acct && 'chip-on')}>
          <select value={acct} onChange={(e) => setAcct(e.target.value)}>
            <option value="">全部账户</option>
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </label>
        <span className="spacer" />
        {tab === 'active' && rows.length > 1 && cancelable.length > 0 && (
          <button className="act act-quiet" title={cancelable.length < rows.length ? `${LIVE_OFF_TIP}；实盘账户的 ${rows.length - cancelable.length} 笔不撤` : undefined} onClick={cancelAll}>
            {cancelable.length < rows.length ? `撤掉模拟盘的 ${cancelable.length} 笔` : '全部撤单'}
          </button>
        )}
      </div>
      {!rows.length ? (
        <div className="empty"><div className="empty-title">{tab === 'active' ? '没有未完成的委托' : '没有历史委托'}</div><div className="list-sub">{tab === 'active' ? '挂单、提交中的委托会在这里' : '成交、撤单、被拒的委托会在这里'}</div></div>
      ) : (
        <div className="task-table tr-table">
          <div className="tr-ord-row task-th"><span>标的</span><span className="tr-c-type">类型</span><span className="tr-r tr-c-oprice">价格</span><span className="tr-r tr-c-oqty">成交 / 数量</span><span>状态</span><span className="tr-r">操作</span></div>
          {(tab === 'history' ? rows.slice(0, limit) : rows).map((o) => {
            const i = instOf(o.symbol)
            const shown = o.type === 'stop' ? o.stop_price : o.price
            const canEdit = isActive(o) && o.status !== 'pending' && o.type !== 'market'
            const last = priceAt(o.symbol, at)
            return (
              <div key={o.id} className="tr-ord-wrap">
                <div className={cls('tr-ord-row', !isActive(o) && o.status !== 'filled' && 'tr-dim')}>
                  <span className="task-main">
                    <span className="task-title">
                      <span className={cls('tr-side', o.side === 'buy' ? 'buy' : 'sell')}>{o.side === 'buy' ? '买' : '卖'}</span>
                      <span className="ellipsis">{i?.name ?? o.symbol}</span>
                      {o.reduce_only && <span className="tag tr-tag-sm">仅减仓</span>}
                    </span>
                    <span className="task-meta"><span className="ellipsis">{acctName(o.account_id)} · {fmtTime(o.created_at)}{o.run_id ? ' · 策略' : ''}</span></span>
                  </span>
                  <span className="tr-c-type"><span className="tag">{ORDER_TYPE[o.type]}</span></span>
                  <span className="tr-r tr-num tr-c-oprice tr-two">
                    <span>{o.type === 'market' ? '市价' : shown !== undefined ? fmtPrice(o.symbol, shown) : '-'}</span>
                    <span className="faint">{o.status === 'filled' && o.avg_fill !== undefined ? `均价 ${fmtPrice(o.symbol, o.avg_fill)}` : o.type === 'stop_limit' && o.stop_price !== undefined ? `触发 ${fmtPrice(o.symbol, o.stop_price)}` : isActive(o) ? `现价 ${fmtPrice(o.symbol, last)}` : ''}</span>
                  </span>
                  <span className="tr-r tr-num tr-c-oqty">{fmtQty(o.filled, o.symbol)} / {fmtQty(o.qty, o.symbol)}</span>
                  <span className="tr-ord-st">
                    <Pill {...ORDER_STATUS[o.status]} />
                    {o.status === 'rejected' && o.reject_reason && <span className="tr-reject" title={o.reject_reason}>{o.reject_reason}</span>}
                    {o.status === 'open' && i && sessionOf(i.market, at) !== 'open' && <span className="faint tr-small">{SESSION_LABEL[sessionOf(i.market, at)]}，开盘后报出</span>}
                  </span>
                  <span className="tr-ops">
                    {canEdit && <button className="act act-quiet" disabled={locked(o)} title={locked(o) ? LIVE_OFF_TIP : undefined} onClick={() => setEdit({ id: o.id, price: String(shown ?? '') })}>改价</button>}
                    {isActive(o) && <button className="act" disabled={locked(o)} title={locked(o) ? LIVE_OFF_TIP : undefined} onClick={() => cancel(o.id)}>撤单</button>}
                    {!isActive(o) && <span className="faint tr-small">{timeAgo(o.updated_at)}</span>}
                  </span>
                </div>
                {edit?.id === o.id && (() => {
                  const v = Number(edit.price)
                  const bad = !(v > 0)
                  return (
                    <div className="tr-stop-row">
                      <span className="run-muted">{o.type === 'stop' ? '新触发价' : '新价格'}</span>
                      <input className={cls('tr-input', bad && 'bad')} inputMode="decimal" autoFocus value={edit.price} onChange={(e) => setEdit({ ...edit, price: e.target.value })}
                        onKeyDown={(e) => { if (e.key === 'Enter' && !bad) savePrice(o, v) }} />
                      <span className="run-muted tr-stop-hint">现价 {fmtPrice(o.symbol, last)}{!bad && ` · 偏离 ${fmtPct((v - last) / last)}`}</span>
                      <span className="spacer" />
                      <button className="act act-quiet" onClick={() => setEdit(null)}>取消</button>
                      <button className="act act-primary" disabled={bad} onClick={() => savePrice(o, v)}>保存</button>
                    </div>
                  )
                })()}
              </div>
            )
          })}
        </div>
      )}
      {tab === 'history' && rows.length > limit && (
        <button className="act act-quiet tr-more" onClick={() => setLimit(limit + ORDER_PAGE)}>再显示 {Math.min(ORDER_PAGE, rows.length - limit)} 条<span className="faint">（还有 {rows.length - limit} 条更早的）</span></button>
      )}
    </>
  )
}

/* ---------- 下单抽屉 ---------- */

function OrderDrawer({ init, accounts, positions, risk, live, onClose, onPlace, onRiskReject, onReport }: {
  init: { symbol: string; side: 'buy' | 'sell' }
  accounts: TradeAccount[]; positions: Position[]; risk: RiskRules; live: boolean
  onClose: () => void
  onPlace: (o: Pick<Order, 'account_id' | 'symbol' | 'side' | 'type' | 'qty' | 'price' | 'stop_price' | 'reduce_only'>, meta: { leverage?: number; reject?: string }) => void
  /** 被风控拦下：委托记成被拒绝，抽屉不关，原因原样显示（正式版是后端统一下单入口回 409） */
  onRiskReject: (o: Pick<Order, 'account_id' | 'symbol' | 'side' | 'type' | 'qty' | 'price' | 'stop_price' | 'reduce_only'>, reason: string) => void
  onReport: (title: string, message: string) => void
}) {
  useEsc(onClose)
  const now = useNow(1000)
  // 默认第一个能用的模拟盘，没有再取第一个能用的
  const firstOk = (i?: Instrument) => (accounts.find((a) => a.paper && !acctBlock(a, i, live)) ?? accounts.find((a) => !acctBlock(a, i, live)))?.id ?? ''
  const [symbol, setSymbol] = useState(init.symbol)
  const inst = instOf(symbol)
  const [showBlocked, setShowBlocked] = useState(false)
  const [side, setSide] = useState(init.side)
  const [type, setType] = useState<OrderType>('limit')
  const [price, setPrice] = useState(() => String(priceAt(init.symbol)))
  const [stop, setStop] = useState('')
  const [qty, setQty] = useState('')
  const [lev, setLev] = useState(3)
  const [reduce, setReduce] = useState(false)
  const [acctId, setAcctId] = useState(() => firstOk(instOf(init.symbol)))
  const [confirming, setConfirming] = useState(false)
  const [tried, setTried] = useState(false)
  /** 提交后被风控拦下的原因；改了任何一项就清掉，回到预检查提示 */
  const [rejectedAt, setRejected] = useState<{ key: string; blocks: string[] } | null>(null)

  const pick = (s: string) => {
    const i = instOf(s)
    setSymbol(s)
    setPrice(String(priceAt(s))); setStop(''); setQty(''); setReduce(false); setConfirming(false)
    if (!accounts.find((a) => a.id === acctId && !acctBlock(a, i, live))) setAcctId(firstOk(i))
  }

  if (!inst) {
    return (
      <aside className="drawer tr-drawer">
        <div className="drawer-head"><span className="drawer-kicker">下单</span><div className="spacer" /><button className="icon-btn" onClick={onClose} title="关闭 (Esc)"><CloseIcon /></button></div>
        <div className="drawer-body form"><div className="mount-empty">找不到标的 {symbol}</div><button className="act" onClick={() => pick('BINANCE:BTCUSDT')}>换成 BTC/USDT</button></div>
      </aside>
    )
  }

  const account = accounts.find((a) => a.id === acctId)
  const usableAccts = accounts.filter((a) => !acctBlock(a, inst, live))
  const blockedAccts = accounts.flatMap((a) => { const why = acctBlock(a, inst, live); return why ? [{ a, why }] : [] })
  const last = priceAt(symbol, now)
  const contract = isContract(inst)
  const needPrice = type === 'limit' || type === 'stop_limit'
  const needStop = type === 'stop' || type === 'stop_limit'
  const priceN = Number(price)
  const stopN = Number(stop)
  const ref = type === 'market' ? last : type === 'stop' ? stopN || last : priceN || last
  const rawQty = Number(qty)
  const qtyN = rawQty > 0 ? roundLot(rawQty, inst.lot) : 0
  const value = ref * qtyN * inst.multiplier
  const cur = curOf(inst)
  const valueUsd = toUsd(value, cur)
  const levN = contract && inst.kind !== 'option' ? lev : 1
  const opening = account ? isOpening(positions, account.id, inst, side, qtyN, contract && reduce) : side === 'buy'
  const pos = positions.find((p) => p.account_id === acctId && p.symbol === symbol)
  const session = sessionOf(inst.market, now)
  const band = inst.market === 'cn' && inst.limit ? limitBand(inst, now) : null

  // 最多能下多少：卖现货看持仓；其他按可用资金（合约乘杠杆）
  const maxQty = (() => {
    if (!account) return 0
    if (!contract && side === 'sell') return pos?.side === 'long' ? pos.qty : 0
    const avail = toUsd(account.available, account.currency)
    const unit = toUsd(ref * inst.multiplier, cur)
    return unit > 0 ? roundLot((avail * levN) / unit, inst.lot) : 0
  })()

  const errors: string[] = []
  if (!account) errors.push('选一个可交易的账户')
  if (needPrice && !(priceN > 0)) errors.push('填委托价格')
  if (needStop && !(stopN > 0)) errors.push('填触发价')
  if (!(qtyN > 0)) errors.push(rawQty > 0 ? `数量不足最小单位 ${inst.lot}` : '填数量')
  const blocks = qtyN > 0 ? riskBlocks({ risk, account, inst, valueUsd, leverage: levN, opening, positions, at: now }) : []
  const needConfirm = valueUsd > risk.confirm_above
  const formKey = [symbol, acctId, side, type, price, stop, qty, lev, reduce].join('|')
  const rejected = rejectedAt?.key === formKey ? rejectedAt.blocks : null

  const hints: string[] = []
  if (inst.market === 'cn' && !contract) hints.push('A 股 T+1：今日买入的股份明日才能卖出')
  if (band) hints.push(`涨跌停 ±${(inst.limit! * 100).toFixed(0)}%，今日可报价 ${fmtPrice(symbol, band[0])} - ${fmtPrice(symbol, band[1])}`)
  if (session !== 'open') hints.push(`${MARKETS[inst.market].label}${SESSION_LABEL[session]}中，委托将在开盘后报出`)
  if (inst.expiry) hints.push(`到期日 ${inst.expiry}`)

  const submit = () => {
    setTried(true)
    if (errors.length || !account) return
    if (blocks.length) {
      onReport('下单被风控拦截', `${inst.name} ${side === 'buy' ? '买入' : '卖出'} ${fmtQty(qtyN, symbol)}：${blocks.join('；')}`)
      onRiskReject({ account_id: account.id, symbol, side, type, qty: qtyN, price: needPrice ? round(priceN, inst.digits) : undefined,
        stop_price: needStop ? round(stopN, inst.digits) : undefined, reduce_only: contract ? reduce : undefined }, blocks.join('；'))
      setRejected({ key: formKey, blocks })
      return
    }
    if (needConfirm && !confirming) { setConfirming(true); return }
    const limitPx = needPrice ? round(priceN, inst.digits) : undefined
    const reject = exchangeReject(account, inst, side, qtyN, type, limitPx, contract && reduce, positions, now)
    onPlace({
      account_id: account.id, symbol, side, type, qty: qtyN,
      price: limitPx, stop_price: needStop ? round(stopN, inst.digits) : undefined, reduce_only: contract ? reduce : undefined,
    }, { leverage: contract && inst.kind !== 'option' ? lev : undefined, reject })
  }

  return (
    <aside className="drawer tr-drawer">
      <div className="drawer-head">
        <span className="drawer-kicker">下单</span>
        <div className="spacer" />
        <button className="icon-btn" onClick={onClose} title="关闭 (Esc)"><CloseIcon /></button>
      </div>
      <div className="drawer-body form">
        <div className="field">
          <span className="field-label">标的</span>
          <SymbolPicker value={symbol} onChange={pick} side={<span className="tr-num">{fmtPrice(symbol, last)}</span>} />
        </div>

        <div className="field">
          <span className="field-label">账户<span className="field-hint">只能选支持{MARKETS[inst.market].label}、有交易权限、已连接的{live ? '' : '；实盘未开启，只能用模拟盘'}</span></span>
          <div className="tr-acct-pick">
            {/* 能下单的在前；不能下单的收成一行，点开再看原因 */}
            {usableAccts.map((a) => (
              <button key={a.id} className={cls('tr-acct-opt', acctId === a.id && 'on')} onClick={() => setAcctId(a.id)}>
                <span className="ellipsis">{a.name}</span>
                <span className="tr-small run-muted">{a.paper ? '模拟' : '实盘'} · 可用 {num(a.available)} {a.currency}</span>
              </button>
            ))}
            {showBlocked && blockedAccts.map(({ a, why }) => (
              <button key={a.id} disabled className="tr-acct-opt" title={why === LIVE_OFF ? LIVE_OFF_TIP : undefined}>
                <span className="ellipsis">{a.name}</span>
                <span className="tr-small faint">{why}</span>
              </button>
            ))}
          </div>
          {!usableAccts.length && <div className="mount-empty">没有能交易{MARKETS[inst.market].label}的账户</div>}
          {blockedAccts.length > 0 && (
            <button className="act act-quiet tr-acct-more" onClick={() => setShowBlocked(!showBlocked)}>
              {showBlocked ? '收起不可用的账户' : `其他 ${blockedAccts.length} 个账户不可用`}
            </button>
          )}
        </div>

        <div className="field-row">
          <div className="field">
            <span className="field-label">方向</span>
            <div className="seg seg-full tr-side-seg">
              <button className={cls(side === 'buy' && 'on buy')} onClick={() => { setSide('buy'); setConfirming(false) }}>{contract ? '买入 / 开多' : '买入'}</button>
              <button className={cls(side === 'sell' && 'on sell')} onClick={() => { setSide('sell'); setConfirming(false) }}>{contract ? '卖出 / 开空' : '卖出'}</button>
            </div>
          </div>
          <div className="field">
            <span className="field-label">类型</span>
            <div className="seg seg-full">
              {(Object.keys(ORDER_TYPE) as OrderType[]).map((k) => <button key={k} className={cls(type === k && 'on')} onClick={() => { setType(k); setConfirming(false) }}>{k === 'stop' ? '止损' : ORDER_TYPE[k]}</button>)}
            </div>
          </div>
        </div>

        <div className="field-row">
          {needStop && (
            <label className="field"><span className="field-label">触发价<span className="field-hint">{side === 'sell' ? '跌到这个价触发' : '涨到这个价触发'}</span></span>
              <input inputMode="decimal" className={cls(tried && !(stopN > 0) && 'bad')} value={stop} placeholder={fmtPrice(symbol, last)} onChange={(e) => { setStop(e.target.value); setConfirming(false) }} />
            </label>
          )}
          {needPrice ? (
            <label className="field"><span className="field-label">委托价<span className="field-hint">现价 {fmtPrice(symbol, last)}</span></span>
              <input inputMode="decimal" className={cls((tried && !(priceN > 0)) || (band && priceN > 0 && (priceN < band[0] || priceN > band[1])) ? 'bad' : undefined)} value={price} onChange={(e) => { setPrice(e.target.value); setConfirming(false) }} />
            </label>
          ) : type === 'market' ? (
            <div className="field"><span className="field-label">价格</span><div className="tr-static tr-num">市价，约 {fmtPrice(symbol, last)}</div></div>
          ) : null}
          <label className="field"><span className="field-label">数量<span className="field-hint">最小单位 {inst.lot}{inst.multiplier !== 1 ? `，每张 ${inst.multiplier}` : ''}</span></span>
            <input inputMode="decimal" className={cls(tried && !(qtyN > 0) && 'bad')} value={qty} placeholder={String(inst.lot)} onChange={(e) => { setQty(e.target.value); setConfirming(false) }}
              onBlur={() => { if (qtyN > 0 && qtyN !== rawQty) setQty(String(qtyN)) }} />
          </label>
        </div>
        <div className="tr-qty-quick">
          {[0.25, 0.5, 1].map((f) => (
            <button key={f} className="act act-quiet" disabled={!maxQty} onClick={() => { setQty(String(roundLot(maxQty * f, inst.lot))); setConfirming(false) }}>{f === 1 ? '最大' : `${f * 100}%`}</button>
          ))}
          <span className="faint tr-small">最多 {fmtQty(maxQty, symbol)}</span>
          <span className="spacer" />
          <span className="tr-num tr-amount">金额 {num(value, 2)} {cur}{cur !== 'USD' && cur !== 'USDT' && <span className="faint"> ≈ {usd(valueUsd)}</span>}</span>
        </div>
        {qtyN > 0 && qtyN !== rawQty && <div className="field-hint-line">按最小单位取整为 {fmtQty(qtyN, symbol)}</div>}

        {contract && (
          <section className="field-group">
            <div className="field-group-title">合约设置</div>
            {inst.kind !== 'option' && (
              <div className="field">
                <span className="field-label">杠杆<span className="field-hint">上限 {risk.max_leverage}x；保证金约 {num(value / lev, 2)} {cur}</span></span>
                <div className="tr-lev">
                  <input type="range" min={1} max={50} value={lev} onChange={(e) => { setLev(Number(e.target.value)); setConfirming(false) }} />
                  <span className={cls('tr-num tr-lev-n', lev > risk.max_leverage && 'danger-text')}>{lev}x</span>
                </div>
              </div>
            )}
            <label className="check"><input type="checkbox" checked={reduce} onChange={(e) => { setReduce(e.target.checked); setConfirming(false) }} />仅减仓：只平掉反向持仓，不会开新仓</label>
          </section>
        )}

        {pos && <div className="run-muted tr-small">该账户已有{pos.side === 'long' ? '多' : '空'}仓 {fmtQty(pos.qty, symbol)}，成本 {fmtPrice(symbol, pos.avg_price)}</div>}
        {hints.length > 0 && <div className="tr-hints">{hints.map((h) => <div key={h}>{h}</div>)}</div>}

        {rejected ? (
          <div className="detail-alert tr-block">
            <span><b>风控未通过</b>这笔已记成被拒绝的委托，拦下的原因：
              <ul>{rejected.map((b) => <li key={b}>{b}</li>)}</ul>
            </span>
          </div>
        ) : blocks.length > 0 && (
          <div className="tr-hints">
            <div><b>预检查</b>：提交后会按同样的规则拦下（正式版在后端拦），以拦截结果为准</div>
            <ul className="tr-hint-list">{blocks.map((b) => <li key={b}>{b}</li>)}</ul>
          </div>
        )}
      </div>
      <div className="drawer-foot">
        {confirming ? (
          <>
            <span className="tr-confirm-q">金额约 <b>{usd(valueUsd)}</b>，超过 {usd(risk.confirm_above)} 二次确认线</span>
            <div className="spacer" />
            <button className="btn btn-ghost" onClick={() => setConfirming(false)}>返回修改</button>
            <button className={cls('btn', side === 'buy' ? 'tr-btn-buy' : 'tr-btn-sell')} onClick={submit}>确认{side === 'buy' ? '买入' : '卖出'}</button>
          </>
        ) : (
          <>
            {tried && errors.length > 0 ? <span className="field-err">{errors[0]}</span> : <span className="run-muted tr-small">{account ? `${account.name}${account.paper ? '（模拟）' : '（实盘）'}` : ''}</span>}
            <div className="spacer" />
            <button className="btn btn-ghost" onClick={onClose}>取消</button>
            <button className={cls('btn', side === 'buy' ? 'tr-btn-buy' : 'tr-btn-sell')} onClick={submit}>
              {side === 'buy' ? '买入' : '卖出'}{qtyN > 0 ? ` ${fmtQty(qtyN, symbol)}` : ''}
            </button>
          </>
        )}
      </div>
    </aside>
  )
}

/* ---------- 策略运行 ---------- */

function RunsView({ runs, accounts, strategies, risk, live, onRuns, onOpenStrategy, onNew }: {
  runs: StrategyRun[]; accounts: TradeAccount[]; strategies: Strategy[]; risk: RiskRules; live: boolean
  onRuns: (fn: (xs: StrategyRun[]) => StrategyRun[]) => void; onOpenStrategy: (id: string) => void; onNew: () => void
}) {
  const [open, setOpen] = useState<string | null>(null)
  const [stopAsk, setStopAsk] = useState<string | null>(null)
  /** 实盘运行的启动、恢复也要再确认一次 */
  const [liveAsk, setLiveAsk] = useState<string | null>(null)
  const [showStopped, setShowStopped] = useState(false)
  const setStatus = (id: string, status: StrategyRun['status'], text: string) => {
    const at = nowIso()
    // 停止时记下时间和原因；从停止状态恢复就清掉
    const stop = status === 'stopped' ? { stopped_at: at, stop_reason: text } : { stopped_at: undefined, stop_reason: undefined }
    onRuns((xs) => xs.map((r) => (r.id === id ? { ...r, status, ...stop, error: status === 'error' ? r.error : undefined, logs: [...r.logs, { at, level: 'info', text }] } : r)))
  }
  const order: Record<StrategyRun['status'], number> = { error: 0, running: 1, paused: 2, stopped: 3 }
  const all = [...runs].sort((a, b) => order[a.status] - order[b.status] || b.started_at.localeCompare(a.started_at))
  // 已停止的折叠成一行，点开再看
  const stopped = all.filter((r) => r.status === 'stopped')
  const rows = showStopped ? all : all.filter((r) => r.status !== 'stopped')
  if (!all.length) return <div className="empty"><div className="empty-title">还没有策略在跑</div><div className="list-sub">在策略页回测满意后部署，或者直接新建一个运行</div><button className="btn btn-primary" onClick={onNew}>新建运行</button></div>
  return (
    <>
    {rows.length > 0 && <div className="tr-cards">
      {rows.map((r) => {
        const s = strategies.find((x) => x.id === r.strategy_id)
        const a = accounts.find((x) => x.id === r.account_id)
        const logs = [...r.logs].reverse()
        const shown = open === r.id ? logs : logs.slice(0, 3)
        return (
          <section key={r.id} className={cls('tr-card', r.status === 'error' && 'tr-card-bad', r.status === 'stopped' && 'tr-dim')}>
            <div className="tr-card-head">
              <button className="tr-card-title ellipsis" onClick={() => s && onOpenStrategy(s.id)} title="打开策略">{s?.name ?? '已删除的策略'}</button>
              <Pill {...RUN_STATUS[r.status]} />
            </div>
            <div className="tr-card-sub">
              <span className={cls('tag tr-tag-sm', a && !a.paper && 'tr-tag-live')}>{a?.paper ? '模拟' : '实盘'}</span>
              <span className="ellipsis">{a?.name ?? '已删除的账户'} · {r.symbols.map(instName).join('、')}</span>
            </div>
            {r.error && <div className="detail-alert tr-card-alert"><span>{r.error}</span></div>}
            <div className="tr-card-nums">
              <div><span className="stat-label">盈亏</span><b className="tr-num" style={{ color: tone(r.pnl) }}>{signed(r.pnl)}</b></div>
              <div><span className="stat-label">分配资金</span><b className="tr-num">{num(r.capital)}</b></div>
              <div><span className="stat-label">收益率</span><b className="tr-num" style={{ color: tone(r.pnl) }}>{fmtPct(r.capital ? r.pnl / r.capital : 0)}</b></div>
            </div>
            <div className="run-muted tr-small">启动于 {fmtTime(r.started_at)} · {Object.entries(r.params).map(([k, v]) => `${k}=${v}`).join('  ')}</div>
            <div className="tr-logs">
              {shown.map((l, k) => (
                <div key={k} className={cls('tr-log', `tr-log-${l.level}`)}><i /><span className="tr-log-at">{fmtTime(l.at)}</span><span className="tr-log-text">{l.text}</span></div>
              ))}
              {logs.length > 3 && <button className="act act-quiet tr-log-more" onClick={() => setOpen(open === r.id ? null : r.id)}>{open === r.id ? '收起' : `全部 ${logs.length} 条日志`}</button>}
            </div>
            <div className="tr-card-foot">
              {liveAsk === r.id && a ? (
                <>
                  <span className="tr-small danger-text">用真实资金运行：{a.name}，分配 {num(r.capital)} {a.currency}</span>
                  <span className="spacer" />
                  <button className="act act-quiet" onClick={() => setLiveAsk(null)}>取消</button>
                  <button className="act act-danger" onClick={() => { setStatus(r.id, 'running', r.status === 'paused' ? '手动恢复（已确认用真实资金）' : '重新启动（已确认用真实资金）'); setLiveAsk(null) }}>{r.status === 'paused' ? '确认恢复' : '确认启动'}</button>
                </>
              ) : stopAsk === r.id ? (
                <>
                  <span className="tr-small danger-text">停止后不会自动平仓，持仓保留</span>
                  <span className="spacer" />
                  <button className="act act-quiet" onClick={() => setStopAsk(null)}>取消</button>
                  <button className="act act-danger" onClick={() => { setStatus(r.id, 'stopped', '手动停止'); setStopAsk(null) }}>确认停止</button>
                </>
              ) : (
                <>
                  {r.status === 'running' && <button className="act" onClick={() => setStatus(r.id, 'paused', '手动暂停')}>暂停</button>}
                  {r.status !== 'running' && (() => {
                    const blk = a ? acctBlock(a, undefined, live) : undefined
                    return (
                      <button className="act act-primary" disabled={risk.halted || !a || !!blk} title={risk.halted ? '熔断中，先到风控解除' : blk === LIVE_OFF ? LIVE_OFF_TIP : blk ? `账户${blk}` : undefined}
                        onClick={() => (a && !a.paper ? setLiveAsk(r.id) : setStatus(r.id, 'running', r.status === 'paused' ? '手动恢复' : '重新启动'))}>{r.status === 'paused' ? '恢复' : '启动'}</button>
                    )
                  })()}
                  {r.status !== 'stopped' && <button className="act act-quiet" onClick={() => setStopAsk(r.id)}>停止</button>}
                  <span className="spacer" />
                  {risk.halted && r.status !== 'running' && <span className="faint tr-small">熔断中不能启动</span>}
                </>
              )}
            </div>
          </section>
        )
      })}
    </div>}
    {stopped.length > 0 && (
      <button className="act act-quiet tr-more" onClick={() => setShowStopped(!showStopped)}>{showStopped ? '收起已停止的' : `已停止 ${stopped.length} 个`}</button>
    )}
    </>
  )
}

function RunDrawer({ initStrategy, strategies, accounts, risk, live, onClose, onCreate }: {
  initStrategy?: string; strategies: Strategy[]; accounts: TradeAccount[]; risk: RiskRules; live: boolean
  onClose: () => void; onCreate: (r: StrategyRun) => void
}) {
  useEsc(onClose)
  const [sid, setSid] = useState(initStrategy && strategies.some((s) => s.id === initStrategy) ? initStrategy : strategies[0]?.id ?? '')
  const s = strategies.find((x) => x.id === sid)
  const marketsOf = (st?: Strategy) => new Set((st?.symbols ?? []).map((x) => instOf(x)?.market).filter(Boolean) as MarketKey[])
  const why = (a: TradeAccount, st?: Strategy) => {
    const b = acctBlock(a, undefined, live)
    if (b) return b
    const ms = marketsOf(st)
    if (ms.size && ![...ms].some((m) => a.markets.includes(m))) return `不支持${[...ms].map((m) => MARKETS[m].label).join(' / ')}`
    return undefined
  }
  const firstAcct = (st?: Strategy) => accounts.find((a) => !why(a, st) && a.paper)?.id ?? accounts.find((a) => !why(a, st))?.id ?? ''
  const [aid, setAid] = useState(() => firstAcct(s))
  const a = accounts.find((x) => x.id === aid)
  const usable = (st: Strategy | undefined, acc: TradeAccount | undefined) => (st?.symbols ?? []).filter((x) => { const i = instOf(x); return i && acc?.markets.includes(i.market) })
  const [syms, setSyms] = useState<string[]>(() => usable(s, accounts.find((x) => x.id === firstAcct(s))))
  const [capital, setCapital] = useState('20000')
  const [params, setParams] = useState<Record<string, string>>(() => Object.fromEntries(Object.entries(s?.params ?? {}).map(([k, v]) => [k, String(v)])))
  const [ack, setAck] = useState(false)
  const [tried, setTried] = useState(false)
  const [showBlocked, setShowBlocked] = useState(false)

  const pickStrategy = (id: string) => {
    const st = strategies.find((x) => x.id === id)
    setSid(id)
    setParams(Object.fromEntries(Object.entries(st?.params ?? {}).map(([k, v]) => [k, String(v)])))
    const keep = a && !why(a, st) ? a : accounts.find((x) => x.id === firstAcct(st))
    setAid(keep?.id ?? '')
    setSyms(usable(st, keep))
  }
  const pickAcct = (acc: TradeAccount) => { setAid(acc.id); setSyms(usable(s, acc)); setAck(false) }

  const cap = Number(capital)
  const availUsd = a ? toUsd(a.available, a.currency) : 0
  const capUsd = a ? toUsd(cap, a.currency) : 0
  const errors: string[] = []
  if (risk.halted) errors.push('熔断中，不能启动新运行；先到风控解除熔断')
  if (!s) errors.push('选一个策略')
  if (!a) errors.push('选一个可交易的账户')
  if (!syms.length) errors.push('至少选一个标的')
  if (!(cap > 0)) errors.push('填分配资金')
  else if (a && capUsd > availUsd) errors.push(`分配资金超过账户可用 ${num(a.available)} ${a.currency}`)
  if (Object.values(params).some((v) => v.trim() === '' || Number.isNaN(Number(v)))) errors.push('参数要填数字')
  if (a && !a.paper && !ack) errors.push('实盘要勾选确认用真实资金运行')

  const create = () => {
    setTried(true)
    if (errors.length || !s || !a) return
    const at = nowIso()
    onCreate({
      id: newId('rn'), strategy_id: s.id, account_id: a.id, symbols: syms, params: Object.fromEntries(Object.entries(params).map(([k, v]) => [k, Number(v)])),
      capital: cap, status: 'running', pnl: 0, started_at: at,
      logs: [{ at, level: 'info', text: `${a.paper ? '模拟盘' : '实盘'}启动：${syms.map(instName).join('、')}，分配 ${num(cap)} ${a.currency}` }],
    })
  }

  return (
    <aside className="drawer tr-drawer">
      <div className="drawer-head">
        <span className="drawer-kicker">新建策略运行</span>
        <div className="spacer" />
        <button className="icon-btn" onClick={onClose} title="关闭 (Esc)"><CloseIcon /></button>
      </div>
      <div className="drawer-body form">
        {risk.halted && <div className="detail-alert"><span><b>熔断中</b>不能启动新运行，先到风控解除熔断</span></div>}
        <div className="field">
          <span className="field-label">策略</span>
          {!strategies.length ? <div className="mount-empty">还没有策略，先去策略页建一个</div> : (
            <SearchSelect variant="field" value={sid} placeholder="选一个策略" searchPlaceholder="搜策略名、标的"
              options={strategies.map((x) => ({ value: x.id, label: x.name || '未命名策略', hint: `${x.interval} · ${x.symbols.map(instName).join('、')}`, keywords: x.tags.join(' ') }))}
              missingLabel={() => '已删除的策略'} onChange={(v) => { if (v) pickStrategy(v) }} />
          )}
        </div>
        <div className="field">
          <span className="field-label">账户<span className="field-hint">{live ? '先在模拟盘跑一段再上实盘' : '实盘未开启，只能部署到模拟盘'}</span></span>
          <div className="tr-acct-pick">
            {/* 同下单抽屉：能用的在前，不能用的收成一行 */}
            {[...accounts.filter((x) => !why(x, s)), ...(showBlocked ? accounts.filter((x) => why(x, s)) : [])].map((x) => {
              const w = why(x, s)
              return (
                <button key={x.id} disabled={!!w} className={cls('tr-acct-opt', aid === x.id && 'on')} title={w === LIVE_OFF ? LIVE_OFF_TIP : undefined} onClick={() => pickAcct(x)}>
                  <span><span className="ellipsis">{x.name}</span><span className={cls('tag tr-tag-sm', !x.paper && 'tr-tag-live')}>{x.paper ? '模拟' : '实盘'}</span></span>
                  <span className={cls('tr-small', w ? 'faint' : 'run-muted')}>{w ?? `可用 ${num(x.available)} ${x.currency}`}</span>
                </button>
              )
            })}
          </div>
          {accounts.some((x) => why(x, s)) && (
            <button className="act act-quiet tr-acct-more" onClick={() => setShowBlocked(!showBlocked)}>
              {showBlocked ? '收起不可用的账户' : `其他 ${accounts.filter((x) => why(x, s)).length} 个账户不可用`}
            </button>
          )}
        </div>
        {s && (
          <div className="field">
            <span className="field-label">标的<span className="field-hint">只列策略适用、账户支持的</span></span>
            <div className="tags">
              {s.symbols.map((x) => {
                const ok = usable(s, a).includes(x)
                const on = syms.includes(x)
                return (
                  <label key={x} className={cls('dep-chip', on && 'on')} style={ok ? undefined : { opacity: 0.45 }} title={ok ? undefined : '这个账户不支持该市场'}>
                    <input type="checkbox" disabled={!ok} checked={on} onChange={() => setSyms(on ? syms.filter((y) => y !== x) : [...syms, x])} />{instName(x)}
                  </label>
                )
              })}
            </div>
          </div>
        )}
        <label className="field"><span className="field-label">分配资金{a && <span className="field-hint">{a.currency}，账户可用 {num(a.available)}</span>}</span>
          <input inputMode="decimal" value={capital} className={cls(tried && !(cap > 0) && 'bad')} onChange={(e) => setCapital(e.target.value)} />
        </label>
        {s && Object.keys(params).length > 0 && (
          <section className="field-group">
            <div className="field-group-title">参数覆盖<span className="field-hint">默认值来自策略，只影响这次运行</span></div>
            <div className="tr-params">
              {Object.entries(params).map(([k, v]) => (
                <label key={k} className="field"><span className="field-label">{k}<span className="field-hint">默认 {s.params[k]}</span></span>
                  <input inputMode="decimal" value={v} onChange={(e) => setParams({ ...params, [k]: e.target.value })} />
                </label>
              ))}
            </div>
          </section>
        )}
        {a && !a.paper && (
          <label className={cls('check check-lg tr-ack', tried && !ack && 'danger-text')}>
            <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />我确认用真实资金运行（{a.name}）
          </label>
        )}
        {s && <div className="tr-hints"><div>止损 {s.stop_loss ? `${s.stop_loss}%` : '未设'} · 止盈 {s.take_profit ? `${s.take_profit}%` : '未设'} · 每次开仓 {s.position_pct}%；下单同样走风控检查</div></div>}
      </div>
      <div className="drawer-foot">
        {tried && errors.length ? <span className="field-err">{errors[0]}</span> : null}
        <div className="spacer" />
        <button className="btn btn-ghost" onClick={onClose}>取消</button>
        <button className="btn btn-primary" disabled={risk.halted} onClick={create}>启动运行</button>
      </div>
    </aside>
  )
}

/* ---------- 交易账户 ---------- */

interface BrokerDef { key: string; label: string; kind: 'exchange' | 'broker'; markets: MarketKey[]; currency: string; fields: { k: string; label: string; secret?: boolean; placeholder?: string }[]; note: string }
const BROKERS: BrokerDef[] = [
  { key: 'Binance', label: 'Binance', kind: 'exchange', markets: ['crypto'], currency: 'USDT', fields: [{ k: 'key', label: 'API Key' }, { k: 'secret', label: 'API Secret', secret: true }], note: '在币安「API 管理」创建，勾选读取和现货 / 合约交易，不要勾提币，建议绑 IP 白名单' },
  { key: 'OKX', label: 'OKX', kind: 'exchange', markets: ['crypto'], currency: 'USDT', fields: [{ k: 'key', label: 'API Key' }, { k: 'secret', label: 'Secret Key', secret: true }, { k: 'pass', label: 'Passphrase', secret: true }], note: '权限选「读取」和「交易」，不选「提币」' },
  { key: 'Bybit', label: 'Bybit', kind: 'exchange', markets: ['crypto'], currency: 'USDT', fields: [{ k: 'key', label: 'API Key' }, { k: 'secret', label: 'API Secret', secret: true }], note: '用系统生成的 API 密钥，权限只开合约 / 现货交易' },
  { key: '富途', label: '富途', kind: 'broker', markets: ['hk', 'us'], currency: 'USD', fields: [{ k: 'gateway', label: 'OpenD 网关地址', placeholder: '127.0.0.1:11111' }, { k: 'pwd', label: '交易密码', secret: true }], note: '本机先启动富途 OpenD，登录牛牛号' },
  { key: '老虎', label: '老虎', kind: 'broker', markets: ['hk', 'us'], currency: 'USD', fields: [{ k: 'tiger_id', label: 'Tiger ID' }, { k: 'key', label: 'RSA 私钥', secret: true }], note: '在老虎开放平台申请开发者，下载私钥' },
  { key: '盈透 IBKR', label: '盈透 IBKR', kind: 'broker', markets: ['us', 'hk'], currency: 'USD', fields: [{ k: 'gateway', label: 'TWS / IB Gateway 地址', placeholder: '127.0.0.1:7497' }, { k: 'client', label: 'Client ID', placeholder: '1' }], note: '在 TWS 设置里打开 API 连接，取消「只读 API」才能下单' },
  { key: '华泰证券', label: '华泰', kind: 'broker', markets: ['cn'], currency: 'CNY', fields: [{ k: 'gateway', label: 'QMT 地址', placeholder: '127.0.0.1:58610' }, { k: 'account', label: '资金账号' }], note: '需要开通 QMT 量化权限，本机运行 miniQMT' },
  { key: '中信证券', label: '中信', kind: 'broker', markets: ['cn'], currency: 'CNY', fields: [{ k: 'gateway', label: 'PTrade / QMT 地址', placeholder: '127.0.0.1:58610' }, { k: 'account', label: '资金账号' }], note: '需要向营业部申请程序化交易权限' },
  { key: '模拟', label: '模拟', kind: 'exchange', markets: ['crypto', 'cn', 'hk', 'us'], currency: 'USD', fields: [{ k: 'capital', label: '初始资金（USD）', placeholder: '100000' }], note: '本地模拟撮合，按实时模拟行情成交，不连真实账户' },
]

function AccountsView({ accounts, positions, recons, onAccounts, onNew, onRecon, deleteBlock, onDelete }: {
  accounts: TradeAccount[]; positions: Position[]; recons: Reconciliation[]; onAccounts: (fn: (xs: TradeAccount[]) => TradeAccount[]) => void; onNew: () => void
  onRecon: (id: string) => void; deleteBlock: (id: string) => string | null; onDelete: (id: string) => void
}) {
  const [busy, setBusy] = useState<Set<string>>(new Set())
  const [askOff, setAskOff] = useState<string | null>(null)
  const [askDel, setAskDel] = useState<string | null>(null)
  const timers = useRef<number[]>([])
  useEffect(() => () => timers.current.forEach((t) => window.clearTimeout(t)), [])
  const reconnect = (id: string) => {
    setBusy((s) => new Set(s).add(id))
    timers.current.push(window.setTimeout(() => {
      const at = nowIso()
      onAccounts((xs) => xs.map((a) => (a.id === id ? { ...a, status: 'connected', error: undefined, updated_at: at } : a)))
      setBusy((s) => { const n = new Set(s); n.delete(id); return n })
    }, 800))
  }
  const disconnect = (id: string) => { const at = nowIso(); onAccounts((xs) => xs.map((a) => (a.id === id ? { ...a, status: 'disconnected', updated_at: at } : a))); setAskOff(null) }
  if (!accounts.length) return <div className="empty"><div className="empty-title">还没有接入交易账户</div><div className="list-sub">接入交易所或券商的 API，或者先开一个模拟盘</div><button className="btn btn-primary" onClick={onNew}>新增账户</button></div>
  return (
    <div className="tr-cards">
      {accounts.map((a) => {
        const st = busy.has(a.id) ? { label: '连接中', tone: 'info' } : a.status === 'connected' ? { label: '已连接', tone: 'ok' } : a.status === 'error' ? { label: '异常', tone: 'danger' } : { label: '已断开', tone: 'muted' }
        const n = positions.filter((p) => p.account_id === a.id).length
        return (
          <section key={a.id} className={cls('tr-card', a.status === 'error' && 'tr-card-bad')}>
            <div className="tr-card-head">
              <span className="tr-card-title ellipsis">{a.name}</span>
              <span className={`conn-status conn-${st.tone}`}><i />{st.label}</span>
            </div>
            <div className="tr-card-sub">
              <span className={cls('tag tr-tag-sm', !a.paper && 'tr-tag-live')}>{a.paper ? '模拟' : '实盘'}</span>
              <span className="ellipsis">{a.broker} · {a.kind === 'exchange' ? '交易所' : '券商'} · {a.markets.map((m) => MARKETS[m].label).join(' / ')}</span>
            </div>
            {a.status === 'error' && (
              <div className="detail-alert tr-card-alert"><span>{a.error ?? '连接异常'}</span>
                <button className="act" disabled={busy.has(a.id)} onClick={() => reconnect(a.id)}>{busy.has(a.id) ? '连接中' : '重新连接'}</button>
              </div>
            )}
            <div className="tr-card-nums">
              <div><span className="stat-label">权益</span><b className="tr-num">{num(a.equity)}</b></div>
              <div><span className="stat-label">可用</span><b className="tr-num">{num(a.available)}</b></div>
              <div><span className="stat-label">保证金</span><b className="tr-num">{num(a.margin_used)}</b></div>
            </div>
            <div className="tr-kv"><span>币种</span><b>{a.currency}{a.currency !== 'USD' && a.currency !== 'USDT' && <span className="faint">（约 {usd(toUsd(a.equity, a.currency))}）</span>}</b></div>
            <div className="tr-kv"><span>API</span><b className="mono">{a.api_hint}</b></div>
            <div className="tr-kv"><span>权限</span><b>{a.permissions.includes('trade') ? '读取 + 交易' : '只读'}<span className="faint">，不开提币</span></b></div>
            <div className="tr-kv"><span>持仓</span><b>{n} 个 · 同步于 {timeAgo(a.updated_at)}</b></div>
            {a.paper ? (
              <div className="tr-kv"><span>对账</span><b className="faint">本地撮合，不用对账</b></div>
            ) : (() => {
              const rc = recons.find((x) => x.account_id === a.id)
              const left = rc?.items.filter((x) => !x.resolved_at).length ?? 0
              const st = !rc ? { text: '还没对过账', bad: true } : rc.status === 'failed' ? { text: '对账失败', bad: true } : left ? { text: `${left} 处差异`, bad: true } : { text: '一致', bad: false }
              return (
                <div className="tr-kv"><span>对账</span>
                  <button className={cls('tr-recon-link', st.bad && 'danger-text')} onClick={() => onRecon(a.id)}>{st.text}{rc ? ` · ${timeAgo(rc.at)}` : ''}<span className="faint">，查看</span></button>
                </div>
              )
            })()}
            <div className="tr-card-foot">
              {askDel === a.id ? (() => {
                const why = deleteBlock(a.id)
                return why ? (
                  <>
                    <span className="tr-small danger-text">不能删除：{why}</span>
                    <span className="spacer" />
                    <button className="act act-quiet" onClick={() => setAskDel(null)}>知道了</button>
                  </>
                ) : (
                  <>
                    <span className="tr-small danger-text">删除后不能恢复，已停止的运行和成交记录保留</span>
                    <span className="spacer" />
                    <button className="act act-quiet" onClick={() => setAskDel(null)}>取消</button>
                    <button className="act act-danger" onClick={() => { onDelete(a.id); setAskDel(null) }}>删除</button>
                  </>
                )
              })() : askOff === a.id ? (
                <>
                  <span className="tr-small danger-text">断开后策略不能下单，持仓不受影响</span>
                  <span className="spacer" />
                  <button className="act act-quiet" onClick={() => setAskOff(null)}>取消</button>
                  <button className="act act-danger" onClick={() => disconnect(a.id)}>断开</button>
                </>
              ) : a.status === 'connected' && !busy.has(a.id) ? (
                <button className="act act-quiet" onClick={() => setAskOff(a.id)}>断开连接</button>
              ) : a.status === 'disconnected' ? (
                <button className="act act-primary" disabled={busy.has(a.id)} onClick={() => reconnect(a.id)}>{busy.has(a.id) ? '连接中' : '连接'}</button>
              ) : null}
              <span className="spacer" />
              {!a.permissions.includes('trade') && askDel !== a.id && <span className="faint tr-small">只读账户只同步持仓，不能下单</span>}
              {askDel !== a.id && askOff !== a.id && <button className="act act-quiet" onClick={() => setAskDel(a.id)}>删除账户</button>}
            </div>
          </section>
        )
      })}
    </div>
  )
}

function AccountDrawer({ onClose, onCreate }: { onClose: () => void; onCreate: (a: TradeAccount) => void }) {
  useEsc(onClose)
  const [bk, setBk] = useState(BROKERS[0].key)
  const b = BROKERS.find((x) => x.key === bk)!
  const [name, setName] = useState(`${b.label} 账户`)
  const [vals, setVals] = useState<Record<string, string>>({})
  // 默认只读，交易权限单独开启（TRD-07）
  const [trade, setTrade] = useState(false)
  const [test, setTest] = useState<{ state: 'idle' | 'testing' | 'ok' | 'fail'; msg?: string }>({ state: 'idle' })
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(timer.current), [])

  const pickBroker = (k: string) => {
    const nb = BROKERS.find((x) => x.key === k)!
    setBk(k); setVals({}); setTest({ state: 'idle' })
    setName(`${nb.label} ${nb.key === '模拟' ? '盘' : '账户'}`)
  }
  const setVal = (k: string, v: string) => { setVals({ ...vals, [k]: v }); setTest({ state: 'idle' }) }
  const runTest = () => {
    setTest({ state: 'testing' })
    window.clearTimeout(timer.current)
    const snapshot = { ...vals }
    timer.current = window.setTimeout(() => {
      const missing = b.fields.find((f) => !(snapshot[f.k] ?? f.placeholder ?? '').trim())
      if (missing) return setTest({ state: 'fail', msg: `没填${missing.label}` })
      const key = snapshot.key ?? ''
      if (b.kind === 'exchange' && b.key !== '模拟' && key.length < 8) return setTest({ state: 'fail', msg: 'API Key 格式不对，交易所返回签名错误' })
      if (b.key === '模拟' && !(Number(snapshot.capital ?? b.fields[0].placeholder) > 0)) return setTest({ state: 'fail', msg: '初始资金要大于 0' })
      setTest({ state: 'ok', msg: b.key === '模拟' ? '模拟撮合就绪' : `连接成功，${trade ? '读取 + 交易' : '只读'}权限已确认，未检测到提币权限` })
    }, 800)
  }
  const hint = () => {
    const v = (k: string) => vals[k] ?? b.fields.find((f) => f.k === k)?.placeholder ?? ''
    if (b.key === '模拟') return '本地模拟撮合'
    if (vals.key) return `****${vals.key.slice(-4)}`
    if (b.key === '富途') return `OpenD ${v('gateway')}`
    if (b.key === '盈透 IBKR') return `TWS ${v('gateway')}`
    if (vals.account) return `QMT ****${vals.account.slice(-4)}`
    return '****'
  }
  const save = () => {
    const paper = b.key === '模拟'
    const cap = paper ? Number(vals.capital ?? b.fields[0].placeholder) : 0
    // 实盘的权益由同步回来，原型里给个模拟值
    const seed = [...(vals.key ?? vals.account ?? vals.gateway ?? name)].reduce((s, c) => (s * 31 + c.charCodeAt(0)) % 100000, 7)
    const equity = paper ? cap : 20000 + seed
    onCreate({
      id: newId('ac'), name: name.trim() || `${b.label} 账户`, broker: b.key, kind: b.kind, markets: b.markets, paper, currency: b.currency,
      equity, available: round(equity * (paper ? 1 : 0.6), 2), margin_used: 0, status: 'connected', api_hint: hint(),
      permissions: paper || trade ? ['read', 'trade'] : ['read'], updated_at: nowIso(),
    })
  }
  return (
    <aside className="drawer tr-drawer">
      <div className="drawer-head">
        <span className="drawer-kicker">新增交易账户</span>
        <div className="spacer" />
        <button className="icon-btn" onClick={onClose} title="关闭 (Esc)"><CloseIcon /></button>
      </div>
      <div className="drawer-body form">
        <div className="field">
          <span className="field-label">交易所 / 券商</span>
          <div className="tr-brokers">
            {BROKERS.map((x) => (
              <button key={x.key} className={cls('tr-broker', bk === x.key && 'on')} onClick={() => pickBroker(x.key)}>
                <span>{x.label}</span><span className="faint tr-small">{x.markets.map((m) => MARKETS[m].label).join(' / ')}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="tr-hints"><div>{b.note}</div></div>
        <label className="field"><span className="field-label">名称</span><input value={name} onChange={(e) => setName(e.target.value)} /></label>
        {b.fields.map((f) => (
          <label key={f.k} className="field"><span className="field-label">{f.label}</span>
            <input type={f.secret ? 'password' : 'text'} autoComplete="off" placeholder={f.placeholder} value={vals[f.k] ?? ''} onChange={(e) => setVal(f.k, e.target.value)} />
          </label>
        ))}
        {b.key !== '模拟' && (
          <div className="field">
            <span className="field-label">权限<span className="field-hint">不开提币权限，资金不会被转走</span></span>
            <div className="seg seg-full">
              <button className={cls(!trade && 'on')} onClick={() => { setTrade(false); setTest({ state: 'idle' }) }}>只读</button>
              <button className={cls(trade && 'on')} onClick={() => { setTrade(true); setTest({ state: 'idle' }) }}>读取 + 交易</button>
            </div>
            {trade && <span className="field-hint-line">开了交易权限也要过实盘评审、打开「交易设置」里的实盘开关才能下单；在那之前只读同步</span>}
          </div>
        )}
        <div className="act-row">
          <button className="act" disabled={test.state === 'testing'} onClick={runTest}>{test.state === 'testing' ? '测试中' : '测试连接'}</button>
          {test.state === 'ok' && <span className="conn-status conn-ok"><i />{test.msg}</span>}
          {test.state === 'fail' && <span className="conn-status conn-danger"><i />{test.msg}</span>}
          {test.state === 'testing' && <span className="conn-status conn-info"><i />正在连接 {b.label}</span>}
        </div>
        <div className="faint tr-small">密钥只保存在本机；列表里只显示后四位</div>
      </div>
      <div className="drawer-foot">
        {test.state !== 'ok' && <span className="run-muted tr-small">测试通过后才能保存</span>}
        <div className="spacer" />
        <button className="btn btn-ghost" onClick={onClose}>取消</button>
        <button className="btn btn-primary" disabled={test.state !== 'ok'} onClick={save}>保存</button>
      </div>
    </aside>
  )
}

/* ---------- 风控 ---------- */

const RULES: { k: 'max_position_pct' | 'daily_loss_pct' | 'max_order_value' | 'max_leverage' | 'confirm_above'; label: string; unit: string; desc: string }[] = [
  { k: 'daily_loss_pct', label: '单日最大亏损', unit: '% 权益', desc: '今日盈亏亏到总权益的这个比例，自动熔断：停所有策略、撤所有挂单、禁止新开仓' },
  { k: 'max_order_value', label: '单笔最大金额', unit: 'USD', desc: '开仓单折成 USD 超过这个数直接拦截；平仓不受限' },
  { k: 'max_position_pct', label: '单标的最大仓位', unit: '% 账户权益', desc: '下单后同一账户里这个标的的市值占比不能超过它' },
  { k: 'max_leverage', label: '合约最大杠杆', unit: '倍', desc: '永续、交割期货下单时的杠杆上限' },
  { k: 'confirm_above', label: '二次确认阈值', unit: 'USD', desc: '单笔金额超过它，提交前要再点一次确认' },
]

function RiskView({ risk, onRisk, lossUsed, lossLimit, equity, today, halts, onKill }: {
  risk: RiskRules; onRisk: (fn: (r: RiskRules) => RiskRules) => void; lossUsed: number; lossLimit: number; equity: number; today: number; halts: HaltRec[]; onKill: () => void
}) {
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [confirmKill, setConfirmKill] = useState(false)
  const val = (k: string) => draft[k] ?? String(risk[k as keyof RiskRules] ?? '')
  const commit = (k: (typeof RULES)[number]['k']) => {
    const v = Number(draft[k])
    if (draft[k] !== undefined && v > 0) onRisk((r) => ({ ...r, [k]: v }))
    setDraft((d) => { const n = { ...d }; delete n[k]; return n })
  }
  const pct = lossLimit ? Math.min(1, lossUsed / lossLimit) : 0
  return (
    <div className="tr-risk">
      <section className="hook-sec">
        <div className="field-group-title">当日亏损<span className="field-hint">今日盈亏 / 上限（总权益 {usd(equity)} 的 {risk.daily_loss_pct}%）</span></div>
        <div className="tr-loss-big">
          <span className="tr-num" style={{ color: tone(today) }}>{signedUsd(today)}</span>
          <span className="faint tr-num">已用 {usd(lossUsed)} / {usd(lossLimit)}</span>
          <span className="spacer" />
          <span className={cls('tr-num', pct > 0.8 ? 'danger-text' : 'run-muted')}>{(pct * 100).toFixed(0)}%</span>
        </div>
        <div className="tr-bar tr-bar-lg"><i className={cls(pct > 0.8 && 'hot')} style={{ width: `${pct * 100}%` }} /></div>
        <div className="faint tr-small">{today >= 0 ? '今天还在盈利，不占亏损额度' : pct >= 1 ? '已到上限，触发熔断' : `再亏 ${usd(lossLimit - lossUsed)} 触发熔断`}</div>
      </section>

      <section className="hook-sec">
        <div className="field-group-title">规则<span className="field-hint">改完离开输入框生效；每笔下单前按这里检查</span></div>
        <div className="tr-rules">
          {RULES.map((r) => {
            const bad = draft[r.k] !== undefined && !(Number(draft[r.k]) > 0)
            return (
              <div key={r.k} className="tr-rule">
                <div className="tr-rule-text"><b>{r.label}</b><span className="faint tr-small">{r.desc}</span></div>
                <div className="tr-rule-input">
                  <input className={cls('tr-input', bad && 'bad')} inputMode="decimal" value={val(r.k)} onChange={(e) => setDraft({ ...draft, [r.k]: e.target.value })}
                    onBlur={() => commit(r.k)} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }} />
                  <span className="faint tr-small">{r.unit}</span>
                </div>
              </div>
            )
          })}
        </div>
      </section>

      <section className={cls('hook-sec', 'tr-sec-bad')}>
        <div className="field-group-title">一键全停<span className="field-hint">停掉所有策略运行、撤掉所有未成交委托、进入熔断；持仓保留</span></div>
        {confirmKill ? (
          <div className="act-row">
            <span className="danger-text">确定全部停掉？熔断后要手动解除才能开新仓</span>
            <span className="spacer" />
            <button className="act act-quiet" onClick={() => setConfirmKill(false)}>取消</button>
            <button className="btn btn-danger" onClick={() => { onKill(); setConfirmKill(false) }}>确认全停</button>
          </div>
        ) : (
          <div className="act-row">
            <span className="run-muted">{risk.halted ? '当前已在熔断中，再按一次会撤掉熔断后新挂的单' : '行情异常、策略失控时用'}</span>
            <span className="spacer" />
            <button className="btn btn-danger" onClick={() => setConfirmKill(true)}>一键全停</button>
          </div>
        )}
      </section>

      <section className="hook-sec">
        <div className="field-group-title">熔断记录</div>
        {!halts.length ? <div className="mount-empty">还没有熔断过</div> : (
          <div className="tr-list">
            {halts.map((h) => (
              <div key={h.at} className="tr-list-row tr-halt-row">
                <span className={cls('tr-dot', h.released_at ? 'off' : 'bad')} />
                <span className="tr-list-main">
                  <span><span className="tag tr-tag-sm tr-tag-first">{h.kind === 'auto' ? '自动' : '手动'}</span>{h.reason}</span>
                  <span className="run-muted">{fmtTime(h.at)} 触发{h.runs_stopped !== undefined ? ` · 停掉 ${h.runs_stopped} 个部署、撤掉 ${h.orders_canceled ?? 0} 笔挂单` : ''}{h.released_at ? ` · ${fmtTime(h.released_at)} 解除` : ' · 未解除'}</span>
                  {h.release_reason && <span className="run-muted">解除原因：{h.release_reason}</span>}
                </span>
                {!h.released_at && <span className="danger-text tr-small">进行中</span>}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}

import { newId } from './ids'
/* ---------- 对账抽屉 ---------- */

const RECON_KIND: Record<'balance' | 'position' | 'order', string> = { balance: '余额', position: '持仓', order: '挂单' }

function ReconDrawer({ account, recon, onClose, onRecheck, onFix }: {
  account: TradeAccount; recon?: Reconciliation; onClose: () => void; onRecheck: () => void; onFix: (itemId: string) => void
}) {
  useEsc(onClose)
  const [checking, setChecking] = useState(false)
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  const run = () => {
    setChecking(true)
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => { setChecking(false); onRecheck() }, 800)
  }
  const items = recon?.items ?? []
  const left = items.filter((x) => !x.resolved_at)
  const st = !recon ? { label: '还没对过账', tone: 'muted' } : recon.status === 'failed' ? { label: '对账失败', tone: 'danger' } : left.length ? { label: `${left.length} 处差异`, tone: 'danger' } : { label: '一致', tone: 'ok' }
  return (
    <aside className="drawer tr-drawer">
      <div className="drawer-head">
        <span className="drawer-kicker">对账 · {account.name}</span>
        <div className="spacer" />
        <button className="icon-btn" onClick={onClose} title="关闭 (Esc)"><CloseIcon /></button>
      </div>
      <div className="drawer-body form">
        <div className="tr-kv"><span>结果</span><b><span className={`conn-status conn-${checking ? 'info' : st.tone}`}><i />{checking ? '对账中' : st.label}</span></b></div>
        <div className="tr-kv"><span>最近一次</span><b>{recon ? `${fmtTime(recon.at)}（${timeAgo(recon.at)}）` : '-'}</b></div>
        <div className="tr-kv"><span>对账项</span><b>{recon ? `${recon.checked} 项：余额、每个持仓、每笔挂单` : '-'}</b></div>
        {recon?.status === 'failed' && <div className="detail-alert tr-card-alert"><span>{recon.error}</span></div>}
        <section className="field-group">
          <div className="field-group-title">差异<span className="field-hint">本地记的和交易所返回的对不上的项</span></div>
          {!items.length ? <div className="mount-empty">{recon?.status === 'failed' ? '这次没拿到交易所数据，修好账户连接后重新对账' : '没有差异'}</div> : (
            <div className="tr-list">
              {items.map((x) => (
                <div key={x.id} className={cls('tr-list-row tr-recon-row', x.resolved_at && 'tr-dim')}>
                  <span className={cls('tr-dot', x.resolved_at ? 'ok' : 'bad')} />
                  <span className="tr-list-main">
                    <span><span className="tag tr-tag-sm">{RECON_KIND[x.kind]}</span> {x.label}</span>
                    <span className="tr-num">本地 <b>{x.local}</b> · 交易所 <b>{x.remote}</b></span>
                    {x.note && <span className="run-muted tr-small">{x.note}</span>}
                    {x.resolved_at && <span className="faint tr-small">{fmtTime(x.resolved_at)} {x.resolution}</span>}
                  </span>
                  {!x.resolved_at && <button className="act" onClick={() => onFix(x.id)}>按交易所修正</button>}
                </div>
              ))}
            </div>
          )}
        </section>
        <div className="faint tr-small">正式版定时对账；有差异记运行异常「交易对账异常」并通知，差异超过阈值自动熔断</div>
      </div>
      <div className="drawer-foot">
        {account.status !== 'connected' && <span className="run-muted tr-small">账户{account.status === 'error' ? '连接异常' : '未连接'}，对账会失败</span>}
        <div className="spacer" />
        <button className="btn btn-ghost" onClick={onClose}>关闭</button>
        <button className="btn btn-primary" disabled={checking} onClick={run}>{checking ? '对账中' : '重新对账'}</button>
      </div>
    </aside>
  )
}

/* ---------- 交易设置 ---------- */

/** 二次确认要输入的插件名，和插件清单的 name 一致 */
const PLUGIN_NAME = '交易套件'

function SettingsView({ review, checks, offBlock, onReview, onPluginOff, onView }: {
  review: LiveReview; checks: Record<LiveCheckKey, LiveCheck>; offBlock: string | null
  onReview: (r: LiveReview) => void; onPluginOff: () => void; onView: (v: TradingView) => void
}) {
  const [applying, setApplying] = useState(false)
  const [typed, setTyped] = useState('')
  const [offAsk, setOffAsk] = useState(false)
  const missing = LIVE_CHECKS.filter((c) => !review.confirmed[c.key])
  const on = liveOn(review)
  // 开关不可用的原因，按要做的先后排
  const why = missing.length ? `评审还差 ${missing.length} 项没确认：${missing.map((c) => c.label).join('、')}` : !review.granted_at ? '还没申请 trade:live 权限' : null
  const confirm = (k: LiveCheckKey) => onReview({ ...review, confirmed: { ...review.confirmed, [k]: nowIso() } })
  // 撤回任何一项评审，trade:live 一并收回、实盘关掉
  const revoke = (k: LiveCheckKey) => {
    const confirmed = { ...review.confirmed }
    delete confirmed[k]
    onReview({ confirmed, enabled: false })
  }
  const grant = () => { onReview({ ...review, granted_at: nowIso() }); setApplying(false); setTyped('') }
  const toggle = (v: boolean) => {
    if (v && why) return
    onReview(v ? { ...review, enabled: true, enabled_at: nowIso() } : { ...review, enabled: false, enabled_at: undefined })
  }
  return (
    <div className="tr-risk">
      <section className={cls('hook-sec', on && 'tr-sec-live')}>
        <div className="field-group-title">实盘<span className="field-hint">开了以后实盘账户才能下单、改单撤单、平仓、部署和启动；没开时实盘账户只读同步</span></div>
        <div className="tr-live-head">
          <span className="tr-rule-text">
            <b>{on ? '实盘已开启' : '只开模拟盘'}</b>
            <span className={cls('tr-small', why ? 'danger-text' : 'faint')}>
              {why ? `不能打开：${why}` : on ? `${review.enabled_at ? fmtTime(review.enabled_at) : ''} 打开；关掉后实盘账户回到只读，已挂的单不会自动撤` : '评审和 trade:live 都齐了，可以打开'}
            </span>
          </span>
          <label className={cls('switch-line', !!why && 'disabled')} title={why ?? (on ? '关掉实盘' : '打开实盘')}>
            <input type="checkbox" checked={on} disabled={!!why} onChange={(e) => toggle(e.target.checked)} /><span className="switch" />
          </label>
        </div>
      </section>

      <section className="hook-sec">
        <div className="field-group-title">评审清单<span className="field-hint">每项都由你本人确认；条件没满足的不能确认</span></div>
        <div className="tr-rules">
          {LIVE_CHECKS.map((c) => {
            const ck = checks[c.key]
            const done = review.confirmed[c.key]
            return (
              <div key={c.key} className="tr-rule tr-check">
                <span className={cls('tr-dot', done ? 'ok' : !ck.ok && 'bad')} />
                <div className="tr-rule-text">
                  <b>{c.label}</b>
                  <span className="faint tr-small">{c.desc}</span>
                  <span className={cls('tr-small', ck.ok ? 'run-muted' : 'danger-text')}>{ck.text}</span>
                </div>
                <div className="tr-rule-input">
                  {done ? (
                    <>
                      <span className="tr-ok tr-small">已确认 · {fmtTime(done)}</span>
                      <button className="act act-quiet" onClick={() => revoke(c.key)} title="撤回后 trade:live 一并收回、实盘关掉">撤回</button>
                    </>
                  ) : (
                    <>
                      {!ck.ok && ck.go && <button className="act act-quiet" onClick={() => onView(ck.go!)}>去处理</button>}
                      <button className="act act-primary" disabled={!ck.ok} title={ck.ok ? undefined : ck.text} onClick={() => confirm(c.key)}>确认通过</button>
                    </>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </section>

      <section className="hook-sec">
        <div className="field-group-title">trade:live 权限<span className="field-hint">实盘下单，风险最高；安装时不授予，要在这里单独申请</span></div>
        {review.granted_at ? (
          <div className="act-row">
            <span className="tr-ok">已授予 · {fmtTime(review.granted_at)}</span>
            <span className="spacer" />
            <button className="act act-quiet" onClick={() => onReview({ ...review, granted_at: undefined, enabled: false, enabled_at: undefined })}>收回</button>
          </div>
        ) : applying ? (
          <div className="tr-apply">
            <span className="danger-text">授予后，打开实盘开关就能用真实资金下单。输入插件名「{PLUGIN_NAME}」确认：</span>
            <div className="act-row">
              <input className="tr-input tr-apply-input" value={typed} autoFocus placeholder={PLUGIN_NAME} onChange={(e) => setTyped(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && typed.trim() === PLUGIN_NAME) grant() }} />
              <span className="spacer" />
              <button className="act act-quiet" onClick={() => { setApplying(false); setTyped('') }}>取消</button>
              <button className="btn btn-danger" disabled={typed.trim() !== PLUGIN_NAME} onClick={grant}>确认申请</button>
            </div>
          </div>
        ) : (
          <div className="act-row">
            <span className={cls(missing.length ? 'danger-text' : 'run-muted')}>{missing.length ? `评审五项都确认后才能申请，还差 ${missing.length} 项` : '未申请'}</span>
            <span className="spacer" />
            <button className="btn btn-outline" disabled={!!missing.length} onClick={() => setApplying(true)}>申请 trade:live</button>
          </div>
        )}
      </section>

      <section className="hook-sec">
        <div className="field-group-title">停用插件<span className="field-hint">停用前必须先一键全停：没有在跑的部署、没有挂单才能停</span></div>
        {!offAsk ? (
          <div className="act-row">
            <span className="run-muted">停用后行情、盯盘、策略、交易都不再运行；数据保留，重新启用后照常</span>
            <span className="spacer" />
            <button className="act" onClick={() => setOffAsk(true)}>停用交易插件</button>
          </div>
        ) : offBlock ? (
          <div className="detail-alert tr-card-alert tr-off-block">
            <span><b>不能停用</b>{offBlock}</span>
            <button className="act act-quiet" onClick={() => setOffAsk(false)}>知道了</button>
            <button className="act act-danger" onClick={() => onView('risk')}>去一键全停</button>
          </div>
        ) : (
          <div className="act-row">
            <span className="danger-text">确定停用交易插件？</span>
            <span className="spacer" />
            <button className="act act-quiet" onClick={() => setOffAsk(false)}>取消</button>
            <button className="btn btn-danger" onClick={onPluginOff}>停用</button>
          </div>
        )}
      </section>
    </div>
  )
}
