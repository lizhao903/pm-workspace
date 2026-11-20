// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 技术指标库（TRD-10）：通达信口径的指标，原型在前端按 K 线现算。
// 正式产品由后端指标库 internal/plugins/trade/ta 算（口径对齐通达信 / MyTT，见 docs/api-contract.md「技术指标」），
// 行情 K 线带指标（GET /api/trade/klines?indicators=）、策略规则的通达信口径指标、盯盘提醒的指标条件都走它；
// 原型没有后端，三处共用这一份实现。前面不够算的位置是 NaN。
// 约定同 MyTT：EMA(X, N) 是 alpha = 2/(N+1)、以第一个值为种子的指数平均；SMA(X, N, M) 是通达信的 (M*X + (N-M)*Y')/N；
// KDJ 的 K、D 用 EMA(…, 2*M-1)（等价 alpha = 1/M）

import type { Bar } from './tradedata'

type S = number[]

const nan = (n: number) => new Array<number>(n).fill(NaN)

/** 简单移动平均（滚动 N 根），中间遇到 NaN 重新累计 */
export function MA(xs: S, n: number): S {
  const out = nan(xs.length)
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

/** 指数平均：跳过前面的 NaN，以第一个有效值为种子（同 pandas ewm(span=N, adjust=False)） */
export function EMA(xs: S, n: number): S {
  const out = nan(xs.length)
  const k = 2 / (n + 1)
  let v = NaN
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i]
    if (Number.isNaN(x)) { out[i] = v; continue }
    v = Number.isNaN(v) ? x : x * k + v * (1 - k)
    out[i] = v
  }
  return out
}

/** 通达信 SMA(X, N, M)：Y = (M*X + (N-M)*Y') / N */
export function SMA(xs: S, n: number, m = 1): S {
  const out = nan(xs.length)
  let v = NaN
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i]
    if (Number.isNaN(x)) { out[i] = v; continue }
    v = Number.isNaN(v) ? x : (m * x + (n - m) * v) / n
    out[i] = v
  }
  return out
}

const REF = (xs: S, n: number): S => xs.map((_, i) => (i - n >= 0 ? xs[i - n] : NaN))
const SUM = (xs: S, n: number): S => {
  if (n <= 0) { let s = 0; return xs.map((x) => (s += Number.isNaN(x) ? 0 : x)) }
  return xs.map((_, i) => {
    if (i < n - 1) return NaN
    let s = 0
    for (let j = i - n + 1; j <= i; j++) { if (Number.isNaN(xs[j])) return NaN; s += xs[j] }
    return s
  })
}
const HHV = (xs: S, n: number): S => xs.map((_, i) => (i < n - 1 ? NaN : Math.max(...xs.slice(i - n + 1, i + 1))))
const LLV = (xs: S, n: number): S => xs.map((_, i) => (i < n - 1 ? NaN : Math.min(...xs.slice(i - n + 1, i + 1))))
const AVEDEV = (xs: S, n: number): S => {
  const m = MA(xs, n)
  return xs.map((_, i) => {
    if (Number.isNaN(m[i])) return NaN
    let s = 0
    for (let j = i - n + 1; j <= i; j++) s += Math.abs(xs[j] - m[i])
    return s / n
  })
}
const STD = (xs: S, n: number): S => {
  const m = MA(xs, n)
  return xs.map((_, i) => {
    if (Number.isNaN(m[i])) return NaN
    let s = 0
    for (let j = i - n + 1; j <= i; j++) s += (xs[j] - m[i]) ** 2
    return Math.sqrt(s / n)
  })
}
const div = (a: number, b: number) => (b === 0 || Number.isNaN(a) || Number.isNaN(b) ? NaN : a / b)

/* ---------- 常用指标（多条线的给全） ---------- */

export function macdTdx(c: S, fast = 12, slow = 26, sig = 9) {
  const ef = EMA(c, fast), es = EMA(c, slow)
  const dif = c.map((_, i) => ef[i] - es[i])
  const dea = EMA(dif, sig)
  return { dif, dea, bar: dif.map((x, i) => (x - dea[i]) * 2) }
}

export function kdj(bs: Bar[], n = 9, m1 = 3, m2 = 3) {
  const c = bs.map((b) => b.c)
  const hh = HHV(bs.map((b) => b.h), n), ll = LLV(bs.map((b) => b.l), n)
  const rsv = c.map((x, i) => (Number.isNaN(hh[i]) ? NaN : hh[i] === ll[i] ? 50 : ((x - ll[i]) / (hh[i] - ll[i])) * 100))
  const k = EMA(rsv, m1 * 2 - 1)
  const d = EMA(k, m2 * 2 - 1)
  return { k, d, j: k.map((x, i) => 3 * x - 2 * d[i]) }
}

export function bollTdx(c: S, n = 20, p = 2) {
  const mid = MA(c, n), sd = STD(c, n)
  return { mid, up: mid.map((x, i) => x + p * sd[i]), low: mid.map((x, i) => x - p * sd[i]) }
}

export function rsiTdx(c: S, n = 14): S {
  const lc = REF(c, 1)
  const up = SMA(c.map((x, i) => (Number.isNaN(lc[i]) ? NaN : Math.max(x - lc[i], 0))), n, 1)
  const ab = SMA(c.map((x, i) => (Number.isNaN(lc[i]) ? NaN : Math.abs(x - lc[i]))), n, 1)
  return up.map((x, i) => (i < n ? NaN : div(x, ab[i]) * 100))
}

export function dmi(bs: Bar[], m1 = 14, m2 = 6) {
  const h = bs.map((b) => b.h), l = bs.map((b) => b.l), c = bs.map((b) => b.c)
  const lc = REF(c, 1), lh = REF(h, 1), ll = REF(l, 1)
  const tr = SUM(h.map((x, i) => Math.max(x - l[i], Math.abs(x - lc[i]), Math.abs(l[i] - lc[i]))), m1)
  const hd = h.map((x, i) => x - lh[i]), ld = l.map((x, i) => ll[i] - x)
  const dmp = SUM(hd.map((x, i) => (x > 0 && x > ld[i] ? x : Number.isNaN(x) ? NaN : 0)), m1)
  const dmm = SUM(ld.map((x, i) => (x > 0 && x > hd[i] ? x : Number.isNaN(x) ? NaN : 0)), m1)
  const pdi = dmp.map((x, i) => div(x * 100, tr[i]))
  const mdi = dmm.map((x, i) => div(x * 100, tr[i]))
  const adx = MA(pdi.map((p, i) => div(Math.abs(mdi[i] - p), p + mdi[i]) * 100), m2)
  return { pdi, mdi, adx }
}

/* ---------- 单条线的通达信口径指标（策略规则、盯盘提醒用） ---------- */

/** 通达信口径的那一批指标（策略规则的 Indicator key） */
export type TdxIndicator = 'macd_dif' | 'macd_dea' | 'macd_bar' | 'kdj_k' | 'kdj_d' | 'kdj_j' | 'wr' | 'cci' | 'bias' | 'boll_mid' | 'bbi'
  | 'psy' | 'roc' | 'mtm' | 'trix' | 'obv' | 'mfi' | 'vr' | 'cr' | 'pdi' | 'mdi' | 'adx'

const pi = (ps: number[], i: number, d: number) => Math.max(1, Math.min(500, Math.round(Number.isFinite(ps[i]) ? ps[i] : d)))

/** 通达信口径指标的主线（和 K 线等长）；参数缺的按默认值，按 1 到 500 夹住 */
export function tdxSeries(ind: TdxIndicator, ps: number[], bs: Bar[]): S {
  const c = bs.map((b) => b.c), h = bs.map((b) => b.h), l = bs.map((b) => b.l), v = bs.map((b) => b.v)
  switch (ind) {
    case 'macd_dif': case 'macd_dea': case 'macd_bar': {
      const m = macdTdx(c, pi(ps, 0, 12), pi(ps, 1, 26), pi(ps, 2, 9))
      return ind === 'macd_dif' ? m.dif : ind === 'macd_dea' ? m.dea : m.bar
    }
    case 'kdj_k': case 'kdj_d': case 'kdj_j': {
      const k = kdj(bs, pi(ps, 0, 9), pi(ps, 1, 3), pi(ps, 2, 3))
      return ind === 'kdj_k' ? k.k : ind === 'kdj_d' ? k.d : k.j
    }
    case 'wr': {
      const n = pi(ps, 0, 10), hh = HHV(h, n), ll = LLV(l, n)
      return c.map((x, i) => div(hh[i] - x, hh[i] - ll[i]) * 100)
    }
    case 'cci': {
      const n = pi(ps, 0, 14), tp = bs.map((b) => (b.h + b.l + b.c) / 3), m = MA(tp, n), ad = AVEDEV(tp, n)
      return tp.map((x, i) => div(x - m[i], 0.015 * ad[i]))
    }
    case 'bias': {
      const m = MA(c, pi(ps, 0, 6))
      return c.map((x, i) => div(x - m[i], m[i]) * 100)
    }
    case 'boll_mid': return MA(c, pi(ps, 0, 20))
    case 'bbi': {
      const a = MA(c, 3), b = MA(c, 6), d = MA(c, 12), e = MA(c, 24)
      return c.map((_, i) => (a[i] + b[i] + d[i] + e[i]) / 4)
    }
    case 'psy': {
      const n = pi(ps, 0, 12), lc = REF(c, 1)
      const up = SUM(c.map((x, i) => (Number.isNaN(lc[i]) ? NaN : x > lc[i] ? 1 : 0)), n)
      return up.map((x) => (x / n) * 100)
    }
    case 'roc': {
      const r = REF(c, pi(ps, 0, 12))
      return c.map((x, i) => div(x - r[i], r[i]) * 100)
    }
    case 'mtm': {
      const r = REF(c, pi(ps, 0, 12))
      return c.map((x, i) => x - r[i])
    }
    case 'trix': {
      const n = pi(ps, 0, 12), tr = EMA(EMA(EMA(c, n), n), n), r = REF(tr, 1)
      return tr.map((x, i) => div(x - r[i], r[i]) * 100)
    }
    case 'obv': {
      const lc = REF(c, 1)
      return SUM(c.map((x, i) => (Number.isNaN(lc[i]) ? 0 : x > lc[i] ? v[i] : x < lc[i] ? -v[i] : 0)), 0).map((x) => x / 10000)
    }
    case 'mfi': {
      const n = pi(ps, 0, 14), tp = bs.map((b) => (b.h + b.l + b.c) / 3), lt = REF(tp, 1)
      const pos = SUM(tp.map((x, i) => (Number.isNaN(lt[i]) ? NaN : x > lt[i] ? x * v[i] : 0)), n)
      const neg = SUM(tp.map((x, i) => (Number.isNaN(lt[i]) ? NaN : x < lt[i] ? x * v[i] : 0)), n)
      return pos.map((x, i) => (Number.isNaN(x) ? NaN : neg[i] === 0 ? 100 : 100 - 100 / (1 + x / neg[i])))
    }
    case 'vr': {
      const n = pi(ps, 0, 26), lc = REF(c, 1)
      const a = SUM(c.map((x, i) => (Number.isNaN(lc[i]) ? NaN : x > lc[i] ? v[i] : 0)), n)
      const b = SUM(c.map((x, i) => (Number.isNaN(lc[i]) ? NaN : x <= lc[i] ? v[i] : 0)), n)
      return a.map((x, i) => div(x, b[i]) * 100)
    }
    case 'cr': {
      const n = pi(ps, 0, 26), mid = REF(bs.map((b) => (b.h + b.l) / 2), 1)
      const a = SUM(h.map((x, i) => (Number.isNaN(mid[i]) ? NaN : Math.max(0, x - mid[i]))), n)
      const b = SUM(l.map((x, i) => (Number.isNaN(mid[i]) ? NaN : Math.max(0, mid[i] - x))), n)
      return a.map((x, i) => div(x, b[i]) * 100)
    }
    case 'pdi': case 'mdi': case 'adx': {
      const d = dmi(bs, pi(ps, 0, 14), pi(ps, 1, 6))
      return ind === 'pdi' ? d.pdi : ind === 'mdi' ? d.mdi : d.adx
    }
  }
}

/** 预热根数：长周期的指数平均要多取一些才稳定 */
export function tdxWarm(ind: TdxIndicator, ps: number[]): number {
  const a = pi(ps, 0, 20), b = Number.isFinite(ps[1]) ? pi(ps, 1, 26) : 0, c = Number.isFinite(ps[2]) ? pi(ps, 2, 9) : 0
  if (ind === 'obv') return 0
  if (ind === 'bbi') return 24
  if (ind.startsWith('macd') || ind === 'trix' || ind.startsWith('kdj')) return (Math.max(a, b) + c) * 4
  return (a + b) * 3
}

/* ---------- 盯盘指标条件（TRD-10） ---------- */

/** 策略能用的指标里除收盘价、成交量以外的全部；盯盘的指标条件用 */
export type AlertIndicator = 'ma' | 'ema' | 'rsi' | 'macd' | 'boll_up' | 'boll_low' | 'atr' | TdxIndicator

/** 盯盘指标条件的指标值（和 K 线等长）：正式产品全部由后端指标库按通达信口径算，原型这里同样按通达信口径 */
export function alertSeries(ind: AlertIndicator, ps: number[], bs: Bar[]): S {
  const c = bs.map((b) => b.c)
  switch (ind) {
    case 'ma': return MA(c, pi(ps, 0, 20))
    case 'ema': return EMA(c, pi(ps, 0, 20))
    case 'rsi': return rsiTdx(c, pi(ps, 0, 14))
    case 'macd': { const m = macdTdx(c, pi(ps, 0, 12), pi(ps, 1, 26), pi(ps, 2, 9)); return m.dif.map((x, i) => x - m.dea[i]) }
    case 'boll_up': case 'boll_low': {
      const b = bollTdx(c, pi(ps, 0, 20), Number.isFinite(ps[1]) ? ps[1] : 2)
      return ind === 'boll_up' ? b.up : b.low
    }
    case 'atr': {
      const lc = REF(c, 1)
      return MA(bs.map((b, i) => (Number.isNaN(lc[i]) ? b.h - b.l : Math.max(b.h - b.l, Math.abs(b.h - lc[i]), Math.abs(b.l - lc[i])))), pi(ps, 0, 14))
    }
    default: return tdxSeries(ind, ps, bs)
  }
}

/** 算一条指标要取多少根 K 线（含预热） */
export const alertBars = (ind: AlertIndicator, ps: number[]) =>
  Math.min(600, 60 + (ind === 'ma' || ind === 'boll_up' || ind === 'boll_low' || ind === 'atr' ? pi(ps, 0, 20) : tdxWarm(ind as TdxIndicator, ps)))
