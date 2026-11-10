// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 回测引擎：纯函数，不碰 React。行情一律用 tradedata 的 bars() 取
// 约定：
// 1. 信号在 K 线收盘时评估，按收盘价加减滑点成交；止损止盈在下一根 K 线内按最高最低价触发
// 2. 参数覆盖：规则里某个指标的第一个参数（周期）或某个数值，等于 strategy.params 里某个键的值时，
//    回测用 cfg.params 的同名值替换。比如双均线 params { fast: 12, slow: 48 }，规则里 EMA(12) 跟着 fast 走、EMA(48) 跟着 slow 走；
//    RSI 策略里数值 30、65 跟着 low、high 走。多个键值相同时取先出现的那个
// 3. cfg.params 里的 stop_loss / take_profit / position_pct 三个保留键覆盖策略同名字段，扫参时可以直接扫它们
// 4. 模拟行情没有交易时段，年化按自然时间算：一年 = 365 天 / K 线周期

import {
  INTERVALS, bars as getBars, instOf, round,
  type Bar, type BacktestConfig, type BacktestResult, type BacktestTrade, type Operand, type Rule, type RuleGroup, type Strategy,
} from './tradedata'

export const RESERVED_PARAMS = ['stop_loss', 'take_profit', 'position_pct'] as const
const YEAR_MS = 365 * 86400000

/* ---------- 指标 ---------- */

function sma(xs: number[], n: number): number[] {
  const out = new Array<number>(xs.length).fill(NaN)
  if (n < 1) return out
  let sum = 0, cnt = 0
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i]
    if (Number.isNaN(x)) { sum = 0; cnt = 0; continue }
    sum += x; cnt++
    if (cnt > n) { sum -= xs[i - n]; cnt = n }
    if (cnt === n) out[i] = sum / n
  }
  return out
}

/** EMA：跳过前面的 NaN，用前 n 个值的均值做种子 */
function ema(xs: number[], n: number): number[] {
  const out = new Array<number>(xs.length).fill(NaN)
  if (n < 1) return out
  const k = 2 / (n + 1)
  let start = xs.findIndex((x) => !Number.isNaN(x))
  if (start < 0 || start + n > xs.length) return out
  let v = 0
  for (let i = start; i < start + n; i++) v += xs[i]
  v /= n
  start += n - 1
  out[start] = v
  for (let i = start + 1; i < xs.length; i++) { v = xs[i] * k + v * (1 - k); out[i] = v }
  return out
}

/** Wilder 平滑：RSI、ATR 用 */
function wilder(xs: number[], n: number, from: number): number[] {
  const out = new Array<number>(xs.length).fill(NaN)
  if (n < 1 || from + n > xs.length) return out
  let v = 0
  for (let i = from; i < from + n; i++) v += xs[i]
  v /= n
  out[from + n - 1] = v
  for (let i = from + n; i < xs.length; i++) { v = (v * (n - 1) + xs[i]) / n; out[i] = v }
  return out
}

function stdev(xs: number[], n: number): number[] {
  const m = sma(xs, n)
  return xs.map((_, i) => {
    if (Number.isNaN(m[i])) return NaN
    let s = 0
    for (let j = i - n + 1; j <= i; j++) s += (xs[j] - m[i]) ** 2
    return Math.sqrt(s / n)
  })
}

const p = (ps: number[], i: number, d: number) => Math.max(1, Math.round(Number.isFinite(ps[i]) ? ps[i] : d))

/** 指标序列：按 Operand 对 K 线算出与 bars 等长的数组（前面不够周期的填 NaN） */
export function series(op: Operand, bs: Bar[]): number[] {
  if (op.kind === 'num') return bs.map(() => op.value)
  const c = bs.map((b) => b.c)
  const ps = op.params
  switch (op.ind) {
    case 'price': return c
    case 'volume': return bs.map((b) => b.v)
    case 'ma': return sma(c, p(ps, 0, 20))
    case 'ema': return ema(c, p(ps, 0, 20))
    case 'rsi': {
      const n = p(ps, 0, 14)
      const up = c.map((x, i) => (i ? Math.max(x - c[i - 1], 0) : 0))
      const dn = c.map((x, i) => (i ? Math.max(c[i - 1] - x, 0) : 0))
      const au = wilder(up, n, 1), ad = wilder(dn, n, 1)
      return c.map((_, i) => (Number.isNaN(au[i]) ? NaN : ad[i] === 0 ? 100 : 100 - 100 / (1 + au[i] / ad[i])))
    }
    case 'macd': {
      const f = ema(c, p(ps, 0, 12)), s = ema(c, p(ps, 1, 26))
      const line = c.map((_, i) => f[i] - s[i])
      const sig = ema(line, p(ps, 2, 9))
      return line.map((x, i) => x - sig[i])
    }
    case 'boll_up':
    case 'boll_low': {
      const n = p(ps, 0, 20)
      const k = Number.isFinite(ps[1]) ? ps[1] : 2
      const m = sma(c, n), sd = stdev(c, n)
      return m.map((x, i) => (op.ind === 'boll_up' ? x + k * sd[i] : x - k * sd[i]))
    }
    case 'atr': {
      const tr = bs.map((b, i) => (i ? Math.max(b.h - b.l, Math.abs(b.h - bs[i - 1].c), Math.abs(b.l - bs[i - 1].c)) : b.h - b.l))
      return wilder(tr, p(ps, 0, 14), 0)
    }
  }
}

/** 指标需要多少根 K 线预热 */
function warmOf(op: Operand): number {
  if (op.kind === 'num') return 0
  const ps = op.params
  switch (op.ind) {
    case 'ema': return p(ps, 0, 20) * 3
    case 'macd': return (p(ps, 1, 26) + p(ps, 2, 9)) * 3
    case 'rsi': case 'atr': return p(ps, 0, 14) * 3
    case 'ma': case 'boll_up': case 'boll_low': return p(ps, 0, 20)
    default: return 0
  }
}

/* ---------- 参数替换 ---------- */

/** 按约定 2 把规则里的周期、数值换成 cfg.params */
export function applyParams(st: Strategy, over: Record<string, number>): { entry: RuleGroup; exit: RuleGroup } {
  const keys = Object.keys(st.params)
  const swap = (v: number) => {
    const k = keys.find((x) => st.params[x] === v)
    return k !== undefined && Number.isFinite(over[k]) ? over[k] : v
  }
  const opnd = (o: Operand): Operand => (o.kind === 'num' ? { kind: 'num', value: swap(o.value) } : o.params.length ? { ...o, params: [swap(o.params[0]), ...o.params.slice(1)] } : o)
  const grp = (g: RuleGroup): RuleGroup => ({ ...g, rules: g.rules.map((r) => ({ ...r, left: opnd(r.left), right: opnd(r.right) })) })
  return { entry: grp(st.entry), exit: grp(st.exit) }
}

/* ---------- 账本：按均价记持仓，减仓时结算盈亏 ---------- */

class Book {
  cash: number
  qty = 0
  avg = 0
  /** 这一笔持仓累计的开仓手续费，平仓时并进盈亏 */
  openFee = 0
  trades: BacktestTrade[] = []
  constructor(cash: number, readonly symbol: string, readonly mult: number, readonly feeRate: number, readonly slip: number) { this.cash = cash }
  equity(px: number) { return this.cash + this.qty * px * this.mult }
  /** dq 带符号：正买负卖；px 是未加滑点的参考价 */
  trade(dq: number, px: number, t: number, reason: string) {
    if (!dq || !Number.isFinite(dq)) return
    const fill = Math.max(px + (dq > 0 ? this.slip : -this.slip), 0)
    const fee = Math.abs(dq) * fill * this.mult * this.feeRate
    this.cash -= dq * fill * this.mult + fee
    const reducing = this.qty !== 0 && Math.sign(dq) !== Math.sign(this.qty)
    let pnl: number | undefined
    if (reducing) {
      const closed = Math.min(Math.abs(dq), Math.abs(this.qty))
      const share = closed / Math.abs(this.qty)
      const feePart = this.openFee * share
      pnl = (fill - this.avg) * closed * Math.sign(this.qty) * this.mult - fee * (closed / Math.abs(dq)) - feePart
      this.openFee -= feePart
      const rest = Math.abs(dq) - closed
      const nq = this.qty + dq
      if (Math.abs(nq) < 1e-12) { this.qty = 0; this.avg = 0; this.openFee = 0 }
      else if (rest > 0) { this.qty = nq; this.avg = fill; this.openFee = fee * (rest / Math.abs(dq)) }
      else this.qty = nq
    } else {
      this.avg = (this.avg * Math.abs(this.qty) + fill * Math.abs(dq)) / (Math.abs(this.qty) + Math.abs(dq))
      this.qty += dq
      this.openFee += fee
    }
    const d = instOf(this.symbol)?.digits ?? 2
    this.trades.push({ t, symbol: this.symbol, side: dq > 0 ? 'buy' : 'sell', price: round(fill, d + 2), qty: round(Math.abs(dq), 8), pnl: pnl === undefined ? undefined : round(pnl, 2), reason })
  }
}

/* ---------- 单标的模拟 ---------- */

interface Ctx {
  cfg: BacktestConfig
  st: Strategy
  end: number
  load: (symbol: string, count: number) => Bar[]
}
interface Leg { equity: number[]; bench: number[]; t: number[]; trades: BacktestTrade[] }

const num = (o: Record<string, number>, k: string, d: number) => (Number.isFinite(o[k]) ? o[k] : d)

/** 下单数量：按最小下单量向下取整；不够一手时按可分割数量模拟，并记一条说明 */
function sizeOf(value: number, px: number, symbol: string, notes: Set<string>) {
  const i = instOf(symbol)
  const mult = i?.multiplier ?? 1
  const lot = i?.lot ?? 1
  const raw = value / (px * mult)
  const q = Math.floor(raw / lot + 1e-9) * lot
  if (q > 0) return round(q, 10)
  if (raw > 0) notes.add(`${i?.name ?? symbol} 资金不足一手，按可分割数量模拟`)
  return raw
}

function evalGroup(g: RuleGroup, sv: Map<Rule, [number[], number[]]>, i: number): boolean {
  if (!g.rules.length) return false
  const one = (r: Rule) => {
    const [a, b] = sv.get(r)!
    const x = a[i], y = b[i], x0 = a[i - 1], y0 = b[i - 1]
    if ([x, y].some(Number.isNaN)) return false
    if (r.op === 'gt') return x > y
    if (r.op === 'lt') return x < y
    if ([x0, y0].some((v) => v === undefined || Number.isNaN(v))) return false
    return r.op === 'cross_up' ? x0 <= y0 && x > y : x0 >= y0 && x < y
  }
  return g.logic === 'all' ? g.rules.every(one) : g.rules.some(one)
}

function runRulesLeg(ctx: Ctx, symbol: string, cash: number, notes: Set<string>): Leg {
  const { cfg, st } = ctx
  const { entry, exit } = applyParams(st, cfg.params)
  const all = [...entry.rules, ...exit.rules]
  const warm = Math.min(600, Math.max(0, ...all.flatMap((r) => [warmOf(r.left), warmOf(r.right)])))
  const bs = ctx.load(symbol, cfg.bars + warm)
  const sv = new Map<Rule, [number[], number[]]>(all.map((r) => [r, [series(r.left, bs), series(r.right, bs)]]))
  const inst = instOf(symbol)
  const book = new Book(cash, symbol, inst?.multiplier ?? 1, cfg.fee_bp / 10000, cfg.slippage_ticks * 10 ** -(inst?.digits ?? 2))
  const sl = num(cfg.params, 'stop_loss', st.stop_loss) / 100
  const tp = num(cfg.params, 'take_profit', st.take_profit) / 100
  const pct = num(cfg.params, 'position_pct', st.position_pct) / 100
  const first = bs.length - cfg.bars
  const leg: Leg = { equity: [], bench: [], t: [], trades: book.trades }
  const p0 = bs[Math.max(first, 0)]?.c ?? 1
  const open = (side: 1 | -1, b: Bar, reason: string) => book.trade(side * sizeOf(book.equity(b.c) * pct, b.c, symbol, notes), b.c, b.t, reason)
  for (let i = Math.max(first, 0); i < bs.length; i++) {
    const b = bs[i]
    const last = i === bs.length - 1
    if (i > first) {
      // 止损止盈：按本根 K 线最高最低价判断
      if (book.qty !== 0 && (sl > 0 || tp > 0)) {
        const dir = Math.sign(book.qty)
        const stopPx = book.avg * (1 - dir * sl)
        const takePx = book.avg * (1 + dir * tp)
        if (sl > 0 && (dir > 0 ? b.l <= stopPx : b.h >= stopPx)) book.trade(-book.qty, dir > 0 ? Math.min(stopPx, b.o) : Math.max(stopPx, b.o), b.t, `止损 ${(sl * 100).toFixed(1)}%`)
        else if (tp > 0 && (dir > 0 ? b.h >= takePx : b.l <= takePx)) book.trade(-book.qty, dir > 0 ? Math.max(takePx, b.o) : Math.min(takePx, b.o), b.t, `止盈 ${(tp * 100).toFixed(1)}%`)
      }
      if (!last) {
        const en = evalGroup(entry, sv, i)
        const ex = evalGroup(exit, sv, i)
        if (st.direction === 'long') {
          if (book.qty > 0 && ex) book.trade(-book.qty, b.c, b.t, '出场信号')
          else if (book.qty === 0 && en) open(1, b, '入场信号')
        } else if (st.direction === 'short') {
          if (book.qty < 0 && ex) book.trade(-book.qty, b.c, b.t, '出场信号')
          else if (book.qty === 0 && en) open(-1, b, '入场信号')
        } else {
          // 多空双向：入场信号做多（有空单先平），出场信号做空（有多单先平）
          if (en && book.qty <= 0) { if (book.qty < 0) book.trade(-book.qty, b.c, b.t, '反手平空'); open(1, b, '入场信号做多') }
          else if (ex && book.qty >= 0) { if (book.qty > 0) book.trade(-book.qty, b.c, b.t, '反手平多'); open(-1, b, '出场信号做空') }
        }
      }
    }
    if (last && book.qty !== 0) book.trade(-book.qty, b.c, b.t, '回测结束平仓')
    leg.t.push(b.t)
    leg.equity.push(book.equity(b.c))
    leg.bench.push((cash * b.c) / p0)
  }
  return leg
}

/** 网格近似：区间等分，目标仓位 = (格数/2 - 当前格) × 每格数量 */
function runGridLeg(ctx: Ctx, symbol: string, cash: number, notes: Set<string>): Leg {
  const { cfg, st } = ctx
  const prm = { ...st.params, ...cfg.params }
  const bs = ctx.load(symbol, cfg.bars)
  const inst = instOf(symbol)
  const book = new Book(cash, symbol, inst?.multiplier ?? 1, cfg.fee_bp / 10000, cfg.slippage_ticks * 10 ** -(inst?.digits ?? 2))
  const p0 = bs[0]?.c ?? 1
  let lower = num(prm, 'lower', p0 * 0.92), upper = num(prm, 'upper', p0 * 1.08)
  if (!(upper > lower) || p0 < lower || p0 > upper) {
    notes.add('首根价格不在网格区间内，近似按首根价格上下 8% 重设区间')
    lower = p0 * 0.92; upper = p0 * 1.08
  }
  const grids = Math.max(2, Math.round(num(prm, 'grids', 20)))
  const step = (upper - lower) / grids
  const pct = num(cfg.params, 'position_pct', st.position_pct) / 100
  // 每格数量：有 qty 用 qty，但不让满仓超过分配资金 × 仓位比例
  const cap = (cash * pct) / (grids / 2) / (p0 * (inst?.multiplier ?? 1))
  const unit = Math.min(num(prm, 'qty', cap), cap)
  const sl = num(cfg.params, 'stop_loss', st.stop_loss) / 100
  const leg: Leg = { equity: [], bench: [], t: [], trades: book.trades }
  let halted = false
  bs.forEach((b, i) => {
    const last = i === bs.length - 1
    if (!halted && !last) {
      const level = Math.max(0, Math.min(grids, Math.floor((b.c - lower) / step)))
      let target = (grids / 2 - level) * unit
      if (st.direction === 'long') target = Math.max(target, 0)
      if (st.direction === 'short') target = Math.min(target, 0)
      const dq = target - book.qty
      if (Math.abs(dq) > unit * 0.5) book.trade(dq, b.c, b.t, `网格第 ${level} 格`)
      if (sl > 0 && book.equity(b.c) < cash * (1 - sl)) { book.trade(-book.qty, b.c, b.t, `亏损超过 ${(sl * 100).toFixed(0)}% 停止网格`); halted = true }
    }
    if (last && book.qty !== 0) book.trade(-book.qty, b.c, b.t, '回测结束平仓')
    leg.t.push(b.t)
    leg.equity.push(book.equity(b.c))
    leg.bench.push((cash * b.c) / p0)
  })
  return leg
}

/** 期现基差近似：模拟行情里期货和现货同源，真基差几乎不动，
 *  所以用「期货折算价相对现货 60 根均值的偏离」代替基差；低于 -open_bp 买期货卖现货，回到 -close_bp 以上平仓 */
function runBasis(ctx: Ctx, fut: string, spot: string, cash: number, notes: Set<string>): Leg {
  const { cfg, st } = ctx
  const prm = { ...st.params, ...cfg.params }
  const fb = ctx.load(fut, cfg.bars), sb = ctx.load(spot, cfg.bars)
  const n = Math.min(fb.length, sb.length)
  const fi = instOf(fut), si = instOf(spot)
  const fBook = new Book(cash / 2, fut, fi?.multiplier ?? 1, cfg.fee_bp / 10000, cfg.slippage_ticks * 10 ** -(fi?.digits ?? 2))
  const sBook = new Book(cash / 2, spot, si?.multiplier ?? 1, cfg.fee_bp / 10000, cfg.slippage_ticks * 10 ** -(si?.digits ?? 2))
  // 期货价 / 现货价的初始比例，IF 对 300ETF 约 1000
  const ratio = fb[0].c / sb[0].c
  const fair = sma(sb.map((b) => b.c), 60)
  const openBp = num(prm, 'open_bp', 40), closeBp = num(prm, 'close_bp', 10)
  const pct = num(cfg.params, 'position_pct', st.position_pct) / 100
  notes.add('模拟行情里期货与现货同源，基差近似为期货折算价相对现货 60 根均值的偏离')
  const leg: Leg = { equity: [], bench: [], t: [], trades: [] }
  for (let i = 0; i < n; i++) {
    const f = fb[i], s = sb[i]
    const last = i === n - 1
    const basis = Number.isNaN(fair[i]) ? NaN : ((f.c / ratio - fair[i]) / fair[i]) * 10000
    const holding = fBook.qty !== 0
    if (!last && !Number.isNaN(basis)) {
      if (!holding && basis < -openBp) {
        const value = cash * pct / 2
        fBook.trade(sizeOf(value, f.c, fut, notes), f.c, f.t, `基差 ${basis.toFixed(0)}bp 开仓买期货`)
        sBook.trade(-sizeOf(value, s.c, spot, notes), s.c, s.t, `基差 ${basis.toFixed(0)}bp 卖现货对冲`)
      } else if (holding && basis > -closeBp) {
        fBook.trade(-fBook.qty, f.c, f.t, `基差回到 ${basis.toFixed(0)}bp 平仓`)
        sBook.trade(-sBook.qty, s.c, s.t, `基差回到 ${basis.toFixed(0)}bp 平仓`)
      }
    }
    if (last && holding) { fBook.trade(-fBook.qty, f.c, f.t, '回测结束平仓'); sBook.trade(-sBook.qty, s.c, s.t, '回测结束平仓') }
    leg.t.push(f.t)
    leg.equity.push(fBook.equity(f.c) + sBook.equity(s.c))
    leg.bench.push((cash / 2) * (f.c / fb[0].c) + (cash / 2) * (s.c / sb[0].c))
  }
  leg.trades = [...fBook.trades, ...sBook.trades].sort((a, b) => a.t - b.t)
  return leg
}

/** 未知的代码策略：退回双均线，参数取 fast / slow，没有就 12 / 48 */
function fallbackMa(st: Strategy, cfg: BacktestConfig): Strategy {
  const prm = { ...st.params, ...cfg.params }
  const f = Math.round(num(prm, 'fast', 12)), s = Math.round(num(prm, 'slow', 48))
  return {
    ...st, mode: 'rules', params: {},
    entry: { logic: 'all', rules: [{ id: 'fa', left: { kind: 'ind', ind: 'ema', params: [f] }, op: 'cross_up', right: { kind: 'ind', ind: 'ema', params: [s] } }] },
    exit: { logic: 'any', rules: [{ id: 'fb', left: { kind: 'ind', ind: 'ema', params: [f] }, op: 'cross_down', right: { kind: 'ind', ind: 'ema', params: [s] } }] },
  }
}

export type CodeKind = 'grid' | 'basis' | 'ma'
/** 代码策略按名字、参数认是哪种内置近似 */
export function codeKindOf(st: Strategy): CodeKind {
  const txt = `${st.name} ${st.code}`
  if ('grids' in st.params || /网格|grid/i.test(txt)) return 'grid'
  if ('open_bp' in st.params || /基差|期现|basis/i.test(txt)) return 'basis'
  return 'ma'
}
export const CODE_KIND_LABEL: Record<CodeKind, string> = { grid: '网格', basis: '期现基差', ma: '未识别，按双均线' }

/* ---------- 统计 ---------- */

function statsOf(equity: number[], bench: number[], trades: BacktestTrade[], capital: number, ms: number): BacktestResult['stats'] {
  const n = equity.length
  const last = equity[n - 1] ?? capital
  const total = capital ? last / capital - 1 : 0
  const years = Math.max((n - 1) * ms, ms) / YEAR_MS
  const annual = total <= -1 ? -1 : Math.min(Math.pow(1 + total, 1 / years) - 1, 100)
  let peak = -Infinity, dd = 0
  for (const v of equity) { peak = Math.max(peak, v); if (peak > 0) dd = Math.max(dd, 1 - v / peak) }
  const rets: number[] = []
  for (let i = 1; i < n; i++) if (equity[i - 1] > 0) rets.push(equity[i] / equity[i - 1] - 1)
  const mean = rets.reduce((s, x) => s + x, 0) / (rets.length || 1)
  const sd = Math.sqrt(rets.reduce((s, x) => s + (x - mean) ** 2, 0) / (rets.length || 1))
  const sharpe = sd > 1e-12 ? (mean / sd) * Math.sqrt(YEAR_MS / ms) : 0
  const closed = trades.filter((t) => t.pnl !== undefined)
  const wins = closed.filter((t) => t.pnl! > 0)
  const gain = wins.reduce((s, t) => s + t.pnl!, 0)
  const loss = -closed.filter((t) => t.pnl! < 0).reduce((s, t) => s + t.pnl!, 0)
  return {
    total_return: total, annual, max_dd: dd, sharpe,
    win_rate: closed.length ? wins.length / closed.length : 0,
    trades: closed.length,
    profit_factor: loss > 0 ? gain / loss : gain > 0 ? 99 : 0,
    bench_return: capital && bench.length ? bench[bench.length - 1] / capital - 1 : 0,
  }
}

/* ---------- 入口 ---------- */

function run(cfg: BacktestConfig, st: Strategy, end: number, load: Ctx['load']): BacktestResult & { note?: string } {
  const notes = new Set<string>()
  const syms = cfg.symbols.filter((s) => instOf(s))
  const ms = INTERVALS[cfg.interval].ms
  if (!syms.length || cfg.bars < 2 || !(cfg.capital > 0)) {
    return { equity: [], trades: [], stats: statsOf([], [], [], cfg.capital, ms), note: '没有可回测的标的或区间' }
  }
  const ctx: Ctx = { cfg, st, end, load }
  let legs: Leg[]
  if (st.mode === 'code') {
    const kind = codeKindOf(st)
    notes.add(`代码策略用内置近似模拟（${CODE_KIND_LABEL[kind]}），不执行源码`)
    if (kind === 'grid') legs = syms.map((s) => runGridLeg(ctx, s, cfg.capital / syms.length, notes))
    else if (kind === 'basis') {
      const fut = syms.find((s) => ['future', 'perp'].includes(instOf(s)!.kind))
      const spot = fut && (syms.find((s) => s !== fut && instOf(s)!.kind === 'spot') ?? instOf(fut)!.underlying)
      if (fut && spot && instOf(spot)) legs = [runBasis(ctx, fut, spot, cfg.capital, notes)]
      else {
        notes.add('没找到期货和对应现货，退回双均线')
        const fb = fallbackMa(st, cfg)
        legs = syms.map((s) => runRulesLeg({ ...ctx, st: fb, cfg: { ...cfg, params: pick(cfg.params, RESERVED_PARAMS) } }, s, cfg.capital / syms.length, notes))
      }
    } else {
      const fb = fallbackMa(st, cfg)
      legs = syms.map((s) => runRulesLeg({ ...ctx, st: fb, cfg: { ...cfg, params: pick(cfg.params, RESERVED_PARAMS) } }, s, cfg.capital / syms.length, notes))
    }
  } else {
    if (!st.entry.rules.length) notes.add('入场规则为空，不会开仓')
    legs = syms.map((s) => runRulesLeg(ctx, s, cfg.capital / syms.length, notes))
  }
  // 合并：各标的 K 线按同一周期对齐到整点，按下标相加；长度不一时按最短的对齐到末尾
  const len = Math.min(...legs.map((l) => l.t.length))
  const tail = <T,>(xs: T[]) => xs.slice(xs.length - len)
  const eqs = legs.map((l) => tail(l.equity)), bns = legs.map((l) => tail(l.bench))
  const ts = tail(legs[0].t)
  const equity = ts.map((t, i) => ({ t, v: eqs.reduce((s, e) => s + e[i], 0), bench: bns.reduce((s, e) => s + e[i], 0) }))
  const trades = legs.flatMap((l) => l.trades).sort((a, b) => a.t - b.t)
  const stats = statsOf(equity.map((e) => e.v), equity.map((e) => e.bench), trades, cfg.capital, ms)
  if (!trades.length) notes.add('区间内没有触发入场条件，可以放宽阈值、换周期或拉长区间')
  return { equity, trades, stats, note: notes.size ? [...notes].join('；') : undefined }
}

function pick(o: Record<string, number>, ks: readonly string[]) {
  const r: Record<string, number> = {}
  for (const k of ks) if (k in o) r[k] = o[k]
  return r
}

function loader(cfg: BacktestConfig, end: number) {
  const cache = new Map<string, Bar[]>()
  return (symbol: string, count: number) => {
    const k = `${symbol}|${count}`
    if (!cache.has(k)) cache.set(k, getBars(symbol, cfg.interval, count, end))
    return cache.get(k)!
  }
}

/** 同步跑完一次回测 */
export function runBacktest(cfg: BacktestConfig, st: Strategy, end = Date.now()): BacktestResult & { note?: string } {
  return run(cfg, st, end, loader(cfg, end))
}

/** 参数扫描：对一个参数取一组值各跑一次；K 线只取一次 */
export function sweep(cfg: BacktestConfig, st: Strategy, param: string, values: number[], end = Date.now()): { value: number; total_return: number; max_dd: number; sharpe: number }[] {
  const load = loader(cfg, end)
  return values.map((value) => {
    const r = run({ ...cfg, params: { ...cfg.params, [param]: value } }, st, end, load)
    return { value, total_return: r.stats.total_return, max_dd: r.stats.max_dd, sharpe: r.stats.sharpe }
  })
}

/** 能扫的参数：策略参数 + 三个保留键 */
export function sweepableParams(st: Strategy): { key: string; label: string; value: number }[] {
  return [
    ...Object.entries(st.params).map(([key, value]) => ({ key, label: key, value })),
    { key: 'stop_loss', label: '止损 %', value: st.stop_loss },
    { key: 'take_profit', label: '止盈 %', value: st.take_profit },
    { key: 'position_pct', label: '仓位 %', value: st.position_pct },
  ]
}
