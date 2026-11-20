// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 内置策略（TRD-09，SPEC-strategy-9）：信号写死在后端、参数可调的策略，策略 mode 为 builtin。
// 第一批从 autotrader 移植：KDJ 1h 定趋势 + 3m 定买卖点、SuperTrend + ADX 1h 定方向 + 3m 翻多入场。
// 正式产品的目录由 GET /api/trade/strategy-builtins 给，信号在 internal/plugins/trade/builtin.go；
// 原型没有后端，目录照抄那份注册表，信号和持仓管理在这里按同样的口径用 TS 再写一份，给原型的回测引擎（backtest.ts）用。
// 只做多；趋势周期（1h）由入场周期（3m）的 K 线聚合。

import type { Bar, BarInterval, Strategy } from './tradedata'

export interface BuiltinParam { key: string; label: string; default: number; min: number; max: number; step: number; unit: string; help: string }
export interface BuiltinStrategy {
  id: string; name: string; desc: string; source: string
  trend_interval: BarInterval; entry_interval: BarInterval
  /** 趋势周期取当前还没收盘的那根（partial），还是只用已收盘的（closed） */
  trend_mode: 'partial' | 'closed'
  direction: Strategy['direction']; symbols: string[]; stop_loss: number; take_profit: number; position_pct: number
  params: BuiltinParam[]
  /** 要多取的入场周期 K 线（指标预热） */
  warm_bars: number
}

const P = (key: string, label: string, def: number, min: number, max: number, step: number, unit = '', help = ''): BuiltinParam =>
  ({ key, label, default: def, min, max, step, unit, help })

/** 出场、仓位一类的参数（各内置策略共用），值为 0 表示不用 */
function exitParams(early: number, minBars: number, be: number, arm: number, give: number, gate: number, first: number, trig: number): BuiltinParam[] {
  return [
    P('early_stop', '应急止损', early, 0, 50, 0.1, '%', '开仓后前「普通止损生效根数」根里，跌到成本以下这么多就走；0 不用'),
    P('min_bars_before_stop', '普通止损生效根数', minBars, 0, 1000, 1, '根', '开仓后多少根入场周期 K 线之后普通止损才生效；之前只认应急止损和移动止盈'),
    P('breakeven_trigger', '保本触发', be, 0, 100, 0.1, '%', '持仓最高浮盈达到这么多后，止损抬到成本价；0 不用'),
    P('trail_arm', '移动止盈启动', arm, 0, 100, 0.1, '%', '持仓最高浮盈达到这么多后，止损跟着最高价走；0 不用'),
    P('trail_giveback', '移动止盈回撤', give, 0, 100, 0.1, '%', '移动止盈启动后，从最高价回撤这么多就走'),
    P('sell_gate', '信号出场浮盈门槛', gate, -100, 100, 0.05, '%', '卖出信号出现时，浮盈不到这么多就不理（止损止盈照常）；-100 表示有卖出信号就走'),
    P('pyramid_first_pct', '首笔仓位', first, 1, 100, 1, '%', '开仓时先买分配资金的这么多（斥候仓），剩下的等浮盈到「加仓触发」或再有买入信号时补满；100 表示一次买满'),
    P('pyramid_add_trigger', '加仓触发', trig, 0, 20, 0.1, '%', '斥候仓浮盈（相对首笔成交价）达到这么多就补满'),
  ]
}

/** 出场和仓位那一组的参数键：编辑页里单独一组 */
export const EXIT_KEYS = new Set(['early_stop', 'min_bars_before_stop', 'breakeven_trigger', 'trail_arm', 'trail_giveback', 'sell_gate', 'pyramid_first_pct', 'pyramid_add_trigger'])

export const BUILTIN_STRATEGIES: BuiltinStrategy[] = [
  {
    id: 'kdj-short-1h3m', name: 'KDJ 1h 定趋势 + 3m 定买卖点',
    desc: '1h KDJ 的 J 在超卖区且拐头向上定做多趋势；3m KDJ 超卖后 J 上穿 D（或 K≥D）、J 拐头、3m 收阳时买入。'
      + '3m KDJ 超买后 J 下穿 D（或 K≤D）、或近 7 根超买过且 K≤D、J>42 时出卖出信号，浮盈达到门槛才按信号卖。'
      + '出场另有固定止损止盈、开仓后前 20 根的应急止损、保本、移动止盈；开仓分斥候仓和加仓两笔。只做多，现货。',
    source: 'autotrader script/strategy/strategy_kdj_short_1h3m.py + script/run/run_kdj_short_1h3m.py',
    trend_interval: '1h', entry_interval: '3m', trend_mode: 'partial', direction: 'long',
    symbols: ['BINANCE:SOLUSDT', 'BINANCE:ETHUSDT', 'BINANCE:BTCUSDT'], stop_loss: 4.5, take_profit: 6.5, position_pct: 100,
    params: [
      P('oversold', '超卖线（J）', 20, 1, 99, 1, '', 'J 低于它算超卖，1h 和 3m 共用'),
      P('overbought', '超买线（J）', 78, 1, 99, 1, '', 'J 高于它算超买，1h 和 3m 共用'),
      P('buy_need_j3_turn', '3m 买点要 J 拐头', 1, 0, 1, 1, '', '1：3m 的 J 比上一根高才买（同 autotrader 实盘）；0：不要求（同 autotrader 回测引擎的适配器）'),
      P('sell_need_trend', '卖出信号要 1h 超买', 0, 0, 1, 1, '', '1：3m 卖出信号还要 1h J 超买且拐头向下；0：不要求（autotrader 扫参结论，实盘用 0）'),
      P('kdj_n', 'KDJ 周期 N', 9, 2, 100, 1),
      P('kdj_m1', 'KDJ 平滑 M1', 3, 1, 50, 1),
      P('kdj_m2', 'KDJ 平滑 M2', 3, 1, 50, 1),
      ...exitParams(2.5, 20, 2, 2, 1, 2.25, 40, 0.5),
    ],
    warm_bars: 2000,
  },
  {
    id: 'supertrend-adx-1h3m', name: 'SuperTrend + ADX 1h 定方向 + 3m 翻多入场',
    desc: '1h SuperTrend 向上时，3m SuperTrend 由空翻多且 3m ADX 高于阈值买入；3m SuperTrend 由多翻空卖出。'
      + '不设止盈，只留固定止损（开仓 20 根后生效）；开仓分斥候仓和加仓两笔。只做多。',
    source: 'autotrader script/strategy/strategy_supertrend_adx_1h3m.py + script/run/run_supertrend_hl_1h3m.py',
    trend_interval: '1h', entry_interval: '3m', trend_mode: 'closed', direction: 'long',
    symbols: ['BINANCE:BTCUSDT', 'BINANCE:ETHUSDT', 'BINANCE:SOLUSDT'], stop_loss: 4.5, take_profit: 0, position_pct: 100,
    params: [
      P('st_period', 'SuperTrend 周期', 14, 2, 100, 1, '', '1h 和 3m 共用'),
      P('st_mult', 'SuperTrend 倍数', 3.5, 0.5, 10, 0.1, '', 'ATR 的倍数，1h 和 3m 共用'),
      P('adx_n', 'ADX 周期', 14, 2, 100, 1),
      P('adx_threshold', 'ADX 阈值', 20, 0, 100, 1, '', '3m ADX 高于它才算趋势够强（autotrader 实盘 20，回测稳健档 25）'),
      ...exitParams(0, 20, 0, 0, 0, -100, 40, 0.5),
    ],
    warm_bars: 2000,
  },
]

export const builtinOf = (id?: string) => BUILTIN_STRATEGIES.find((b) => b.id === id)

/** 参数默认值，顺序同参数表 */
export const builtinDefaults = (b: BuiltinStrategy) => Object.fromEntries(b.params.map((p) => [p.key, p.default]))

/* ---------- 指标（口径同 builtin_ta.go） ---------- */

const rd2 = (x: number) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : x)
/** pandas ewm(adjust=False) 的一步：prev 为 NaN 时用 x 起算；x 为 NaN 时沿用 prev */
const ewmStep = (prev: number, x: number, a: number) => (Number.isNaN(x) ? prev : Number.isNaN(prev) ? x : a * x + (1 - a) * prev)

function rsvAt(hs: number[], ls: number[], c: number, i: number, n: number) {
  if (i + 1 < n) return NaN
  let hh = -Infinity, ll = Infinity
  for (let k = i - n + 1; k <= i; k++) { hh = Math.max(hh, hs[k]); ll = Math.min(ll, ls[k]) }
  return hh === ll ? NaN : ((c - ll) / (hh - ll)) * 100
}

function kdjRaw(bs: Bar[], n: number, m1: number, m2: number) {
  const hs = bs.map((b) => b.h), ls = bs.map((b) => b.l)
  const k: number[] = [], d: number[] = []
  const a1 = 2 / (2 * m1), a2 = 2 / (2 * m2)
  let pk = NaN, pd = NaN
  bs.forEach((b, i) => { pk = ewmStep(pk, rsvAt(hs, ls, b.c, i, n), a1); pd = ewmStep(pd, pk, a2); k.push(pk); d.push(pd) })
  return { k, d }
}

type Kdj = { k: number; d: number; j: number }
const kdjOf = (k: number, d: number): Kdj => ({ k: rd2(k), d: rd2(d), j: rd2(3 * k - 2 * d) })
const NO_KDJ: Kdj = { k: NaN, d: NaN, j: NaN }

function wilderRMA(xs: number[], n: number) {
  const out = new Array<number>(xs.length).fill(NaN)
  if (n < 1 || xs.length < n) return out
  let s = 0
  for (let i = 0; i < n; i++) s += xs[i]
  out[n - 1] = s / n
  for (let i = n; i < xs.length; i++) out[i] = Number.isFinite(xs[i]) ? (out[i - 1] * (n - 1) + xs[i]) / n : out[i - 1]
  return out
}

const trueRange = (bs: Bar[]) => bs.map((b, i) => (i ? Math.max(b.h - b.l, Math.abs(b.h - bs[i - 1].c), Math.abs(b.l - bs[i - 1].c)) : b.h - b.l))

/** SuperTrend 方向：+1 多、-1 空、0 还没出值 */
function supertrendDir(bs: Bar[], period: number, mult: number) {
  const n = bs.length
  const dir = new Array<number>(n).fill(0)
  if (period < 1 || n <= period) return dir
  const atr = wilderRMA(trueRange(bs), period)
  const hl2 = (i: number) => (bs[i].h + bs[i].l) / 2
  const seed = period - 1
  let up = hl2(seed) + mult * atr[seed], lo = hl2(seed) - mult * atr[seed]
  dir[seed] = bs[seed].c < lo ? -1 : 1
  for (let i = seed + 1; i < n; i++) {
    if (!Number.isFinite(atr[i])) { dir[i] = dir[i - 1]; continue }
    const u = hl2(i) + mult * atr[i], l = hl2(i) - mult * atr[i]
    dir[i] = bs[i].c > up ? 1 : bs[i].c < lo ? -1 : dir[i - 1]
    up = u; lo = l
  }
  return dir
}

/** Wilder ADX，前 2n-1 根为 NaN */
function adxWilder(bs: Bar[], n: number) {
  const m = bs.length
  const out = new Array<number>(m).fill(NaN)
  if (n < 1 || m < 2) return out
  const pdm = new Array<number>(m).fill(0), mdm = new Array<number>(m).fill(0)
  for (let i = 1; i < m; i++) {
    const up = bs[i].h - bs[i - 1].h, dn = bs[i - 1].l - bs[i].l
    if (up > dn && up > 0) pdm[i] = up
    if (dn > up && dn > 0) mdm[i] = dn
  }
  const atr = wilderRMA(trueRange(bs), n), pn = wilderRMA(pdm, n), mn = wilderRMA(mdm, n)
  const dx = atr.map((a, i) => {
    if (!(a > 0)) return 0
    const p = (100 * pn[i]) / a, q = (100 * mn[i]) / a
    return p + q > 0 ? (100 * Math.abs(p - q)) / (p + q) : 0
  })
  const adx = wilderRMA(dx, n)
  return adx.map((x, i) => (i >= 2 * n - 1 ? x : NaN))
}

/* ---------- 多周期：由入场周期的 K 线聚合出趋势周期 ---------- */

interface Mtf { groups: Bar[]; gi: number[]; gStart: number[]; trendMs: number }

function newMTF(bs: Bar[], trendMs: number): Mtf {
  const m: Mtf = { groups: [], gi: [], gStart: [], trendMs }
  bs.forEach((b, i) => {
    const open = Math.floor(b.t / trendMs) * trendMs
    const g = m.groups[m.groups.length - 1]
    if (g && g.t === open) { g.h = Math.max(g.h, b.h); g.l = Math.min(g.l, b.l); g.c = b.c; g.v += b.v }
    else { m.groups.push({ t: open, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }); m.gStart.push(i) }
    m.gi.push(m.groups.length - 1)
  })
  return m
}

/** 入场 K 线 i 收盘时它所在那根趋势 K 线的样子（从这根趋势 K 线开头聚合到 i） */
function partialOf(m: Mtf, bs: Bar[], i: number): Bar {
  const g = m.gi[i], s = m.gStart[g]
  const out: Bar = { t: m.groups[g].t, o: bs[s].o, h: bs[s].h, l: bs[s].l, c: bs[i].c, v: 0 }
  for (let k = s; k <= i; k++) { out.h = Math.max(out.h, bs[k].h); out.l = Math.min(out.l, bs[k].l); out.v += bs[k].v }
  return out
}

/** 入场 K 线 i 收盘时最后一根已经收盘的趋势 K 线下标，没有为 -1 */
function lastClosed(m: Mtf, bs: Bar[], i: number, entryMs: number) {
  const g = m.gi[i]
  return bs[i].t + entryMs >= m.groups[g].t + m.trendMs ? g : g - 1
}

/* ---------- 信号 ---------- */

export interface BuiltinSig { buy: boolean[]; sell: boolean[] }

const MS: Record<string, number> = { '3m': 180000, '1h': 3600000 }
const ipar = (v: number, lo: number) => Math.max(lo, Math.round(v))

/** 每根入场 K 线收盘时的买卖信号；ps 是参数（含覆盖），没有的取默认 */
export function builtinSignals(b: BuiltinStrategy, ps: Record<string, number>, bs: Bar[]): BuiltinSig {
  const get = (k: string) => (Number.isFinite(ps[k]) ? ps[k] : b.params.find((p) => p.key === k)?.default ?? 0)
  return b.id === 'supertrend-adx-1h3m' ? supertrendSignals(b, get, bs) : kdjSignals(b, get, bs)
}

/** 同 builtin.go kdjSignals：3m 用截至这一根的 K 线，1h 用聚合出来的（当前这根取截至这一根的部分），两边都要至少 20 根 */
function kdjSignals(b: BuiltinStrategy, get: (k: string) => number, bs: Bar[]): BuiltinSig {
  const n = ipar(get('kdj_n'), 2), m1 = ipar(get('kdj_m1'), 1), m2 = ipar(get('kdj_m2'), 1)
  const os = get('oversold'), ob = get('overbought')
  const needTurn = get('buy_need_j3_turn') >= 0.5, needTrend = get('sell_need_trend') >= 0.5
  const sig: BuiltinSig = { buy: bs.map(() => false), sell: bs.map(() => false) }
  if (!bs.length) return sig
  const r3 = kdjRaw(bs, n, m1, m2)
  const k3 = bs.map((_, i) => kdjOf(r3.k[i], r3.d[i]))
  const m = newMTF(bs, MS[b.trend_interval] ?? 3600000)
  const gh = m.groups.map((g) => g.h), gl = m.groups.map((g) => g.l)
  const gr = kdjRaw(m.groups, n, m1, m2)
  const a1 = 2 / (2 * m1), a2 = 2 / (2 * m2)
  const closedMode = b.trend_mode === 'closed'
  for (let i = 0; i < bs.length; i++) {
    const g = m.gi[i]
    let cur = NO_KDJ, prev = NO_KDJ, cnt: number
    if (closedMode) {
      const c = lastClosed(m, bs, i, MS[b.entry_interval] ?? 180000)
      cnt = c + 1
      if (c >= 0) cur = kdjOf(gr.k[c], gr.d[c])
      if (c > 0) prev = kdjOf(gr.k[c - 1], gr.d[c - 1])
    } else {
      cnt = g + 1
      const p = partialOf(m, bs, i)
      let hh = p.h, ll = p.l, rsv = NaN
      if (g + 1 >= n) {
        for (let k = g - n + 1; k < g; k++) { hh = Math.max(hh, gh[k]); ll = Math.min(ll, gl[k]) }
        if (hh !== ll) rsv = ((p.c - ll) / (hh - ll)) * 100
      }
      let pk = NaN, pd = NaN
      if (g > 0) { pk = gr.k[g - 1]; pd = gr.d[g - 1]; prev = kdjOf(pk, pd) }
      const kk = ewmStep(pk, rsv, a1)
      cur = kdjOf(kk, ewmStep(pd, kk, a2))
    }
    if (i + 1 < 20 || cnt < 20 || i < 1) continue
    const x = k3[i]
    if (Number.isNaN(x.j) || Number.isNaN(cur.j)) continue
    const hasPrev = cnt >= 2
    const turnedUp = !hasPrev || (!Number.isNaN(prev.j) && (cur.j >= prev.j || cur.j < 15))
    const turnedDown = !hasPrev || (!Number.isNaN(prev.j) && (cur.j <= prev.j || cur.j > 85))
    const trendBuy = cur.j < os && turnedUp
    const trendSell = cur.j > ob && turnedDown
    const y = k3[i - 1]
    const ok = (...v: number[]) => v.every((z) => !Number.isNaN(z))
    const crossUp = ok(y.j, y.d, x.d) && y.j <= y.d && x.j > x.d
    const crossDown = ok(y.j, y.d, x.d) && y.j >= y.d && x.j < x.d
    const recent = (f: (v: number) => boolean) => {
      for (let k = Math.max(0, i - 6); k <= i; k++) if (!Number.isNaN(k3[k].j) && f(k3[k].j)) return true
      return false
    }
    const kOK = !Number.isNaN(x.k) && x.k >= x.d
    const jTurn = !Number.isNaN(y.j) && x.j > y.j
    let buy3 = (x.j < os && (crossUp || kOK)) || (recent((v) => v < os) && kOK && x.j < 58 && crossUp)
    if (needTurn) buy3 = buy3 && jTurn
    const kSell = !Number.isNaN(x.k) && x.k <= x.d
    const sell3 = (x.j > ob && (crossDown || kSell)) || (recent((v) => v > ob) && kSell && x.j > 42)
    sig.buy[i] = trendBuy && buy3 && bs[i].c > bs[i - 1].c
    sig.sell[i] = sell3 && (!needTrend || trendSell)
  }
  return sig
}

/** 同 builtin.go supertrendSignals：1h 用已收盘的那根 */
function supertrendSignals(b: BuiltinStrategy, get: (k: string) => number, bs: Bar[]): BuiltinSig {
  const period = ipar(get('st_period'), 2), mult = get('st_mult'), adxN = ipar(get('adx_n'), 2), thr = get('adx_threshold')
  const sig: BuiltinSig = { buy: bs.map(() => false), sell: bs.map(() => false) }
  if (!bs.length) return sig
  const d3 = supertrendDir(bs, period, mult)
  const adx = adxWilder(bs, adxN)
  const m = newMTF(bs, MS[b.trend_interval] ?? 3600000)
  const d1 = supertrendDir(m.groups, period, mult)
  const entryMs = MS[b.entry_interval] ?? 180000
  for (let i = Math.max(36, 2 * adxN + 2, period + 2); i < bs.length; i++) {
    const c = lastClosed(m, bs, i, entryMs)
    const up = c >= 0 && d1[c] === 1
    sig.buy[i] = up && d3[i] === 1 && d3[i - 1] === -1 && Number.isFinite(adx[i]) && adx[i] > thr
    sig.sell[i] = d3[i] === -1 && d3[i - 1] === 1
  }
  return sig
}

/* ---------- 持仓管理（同 posman.go，只做多） ---------- */

export interface PmCfg { sl: number; tp: number; early: number; minBars: number; be: number; arm: number; give: number; gate: number; first: number; addTrig: number; pct: number }
export interface PmPos { avg: number; first: number; peak: number; armed: boolean }

export function pmCfgOf(b: BuiltinStrategy, st: Strategy, ps: Record<string, number>): PmCfg {
  const get = (k: string) => (Number.isFinite(ps[k]) ? ps[k] : b.params.find((p) => p.key === k)?.default ?? 0)
  const num = (k: string, d: number) => (Number.isFinite(ps[k]) ? ps[k] : d)
  return {
    sl: num('stop_loss', st.stop_loss) / 100, tp: num('take_profit', st.take_profit) / 100,
    early: get('early_stop') / 100, minBars: Math.round(get('min_bars_before_stop')),
    be: get('breakeven_trigger') / 100, arm: get('trail_arm') / 100, give: get('trail_giveback') / 100, gate: get('sell_gate') / 100,
    first: Math.min(1, Math.max(0.01, get('pyramid_first_pct') / 100)), addTrig: get('pyramid_add_trigger') / 100,
    pct: num('position_pct', st.position_pct) / 100,
  }
}

/** 这根 K 线里有没有止损、止盈（exit）或加仓（addPx > 0）；held 是开仓后第几根 */
export function intrabar(c: PmCfg, p: PmPos, b: Bar, held: number): { exit?: { px: number; reason: string }; addPx: number } {
  const avg = p.avg
  if (avg <= 0) return { addPx: 0 }
  const peakGain = p.peak / avg - 1
  const slBase = c.sl > 0 ? avg * (1 - c.sl) : 0
  let sl = slBase
  const trail = c.arm > 0 && peakGain >= c.arm
  if (c.be > 0 && peakGain >= c.be) sl = Math.max(sl, avg)
  if (trail) sl = Math.max(sl, p.peak * (1 - c.give))
  const down = (level: number, reason: string) => ({ exit: { px: Math.min(level, b.o), reason }, addPx: 0 })
  if (held < c.minBars) {
    if (c.early > 0 && b.l <= avg * (1 - c.early)) return down(avg * (1 - c.early), `应急止损 ${(c.early * 100).toFixed(1)}%`)
    if (trail && sl > 0 && b.l <= sl) return down(sl, '移动止盈')
  } else if (sl > 0 && b.l <= sl) {
    if (trail && sl > slBase && sl > avg) return down(sl, '移动止盈')
    if (sl > slBase) return down(sl, '保本')
    return down(sl, `止损 ${(c.sl * 100).toFixed(1)}%`)
  }
  if (c.tp > 0 && b.h >= avg * (1 + c.tp)) return { exit: { px: Math.max(avg * (1 + c.tp), b.o), reason: `止盈 ${(c.tp * 100).toFixed(1)}%` }, addPx: 0 }
  if (p.armed && p.first > 0 && b.h >= p.first * (1 + c.addTrig)) return { addPx: Math.max(p.first * (1 + c.addTrig), b.o) }
  return { addPx: 0 }
}

/** 收盘：有卖出信号且收盘价相对成本的浮盈到门槛 */
export const sellAtClose = (c: PmCfg, p: PmPos, close: number, sell: boolean) => sell && p.avg > 0 && close / p.avg - 1 >= c.gate - 1e-12
/** 收盘：斥候仓有买入信号、收盘价不低于首笔价 */
export const addAtClose = (p: PmPos, close: number, buy: boolean) => p.armed && buy && close >= p.first

/** 按权重分资金（TRD-09）：没写或不大于 0 的按 1 算 */
export function weightsOf(st: Pick<Strategy, 'symbol_weights'>, symbols: string[]): number[] {
  const w = symbols.map((s) => { const v = st.symbol_weights?.[s]; return v !== undefined && v > 0 ? v : 1 })
  const sum = w.reduce((a, b) => a + b, 0) || 1
  return w.map((x) => x / sum)
}
