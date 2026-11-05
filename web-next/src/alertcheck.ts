import { ALERT_COND, bars, greeks, instOf, prevClose, priceAt, type AlertCond, type Instrument, type PriceAlert } from './tradedata'

// 盯盘提醒的判定（纯函数，从 monitor.tsx 抽出来）。正式版的后端（internal/plugins/trade/alerts.go）逐行移植这里，
// 用 internal/plugins/trade/testdata/gen-alert-golden.mjs 跑出的同一组夹具对拍；改了判定或文案要重跑生成脚本。
//
// 判定只看「行情」AlertMarket：原型里由模拟行情现算（simMarket），正式版由后端的行情缓存给。

const TAU = Math.PI * 2
function hashStr(s: string) { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0 }

/** 模拟资金费率（单位 %，每 8 小时结算一次的费率）；只有永续有，其它返回 0。看盘页显示的也是它 */
export function fundingRate(symbol: string, at = Date.now()): number {
  const i = instOf(symbol)
  if (!i || i.kind !== 'perp') return 0
  const h = hashStr(symbol)
  const t = at / 3600000
  const v = 0.012
    + 0.03 * Math.sin(TAU * (t / 9 + (h % 100) / 100))
    + 0.018 * Math.sin(TAU * (t / 1.7 + (h % 37) / 37))
    + 0.006 * Math.sin(TAU * (t / 0.25 + (h % 13) / 13))
  return Math.round(v * 10000) / 10000
}

/** 条件是否适用于这个标的 */
export function condFits(cond: AlertCond, i: Instrument | undefined) {
  if (!i) return false
  const k = ALERT_COND[cond].kinds
  if (k && !k.includes(i.kind)) return false
  if (cond === 'limit_near' && !i.limit) return false
  return true
}

/**
 * 判定一条提醒要用的行情。用到才取（模拟行情算 K 线、希腊值不便宜）：
 * last 最新价；prev 昨收（数币用 24 小时前）；volumes 最近 21 根 1 分钟成交量，最后一根是没走完的；
 * funding 资金费率 %（只有永续）；iv 隐含波动率 %（只有期权）。
 */
export interface AlertMarket {
  inst: Instrument | undefined
  last: () => number
  prev: () => number
  volumes: () => number[]
  funding: () => number
  iv: () => number
}

/** 原型的模拟行情 */
export function simMarket(symbol: string, at: number): AlertMarket {
  const i = instOf(symbol)
  return {
    inst: i,
    last: () => priceAt(symbol, at),
    prev: () => prevClose(symbol, at),
    volumes: () => bars(symbol, '1m', 21, at).map((b) => b.v),
    funding: () => fundingRate(symbol, at),
    iv: () => greeks(i!, at).iv * 100,
  }
}

/** 按条件的单位算当前值：价格、涨跌幅 %、量比、资金费率 %、IV %、距涨跌停 % */
export function condValueOn(cond: AlertCond, m: AlertMarket): number | null {
  const i = m.inst
  if (!condFits(cond, i)) return null
  const last = m.last()
  switch (cond) {
    case 'price_above': case 'price_below': return last
    case 'pct_above': case 'pct_below': {
      const prev = m.prev()
      const pct = prev ? ((last - prev) / prev) * 100 : 0
      return cond === 'pct_above' ? pct : -pct
    }
    case 'volume_spike': {
      const xs = m.volumes()
      if (!xs.length) return null
      const avg = xs.slice(0, -1).reduce((s, v) => s + Math.abs(v), 0) / Math.max(1, xs.length - 1)
      return avg ? Math.abs(xs[xs.length - 1]) / avg : 0
    }
    case 'funding_above': return m.funding()
    case 'iv_above': return m.iv()
    case 'limit_near': {
      const prev = m.prev()
      const up = prev * (1 + i!.limit!), down = prev * (1 - i!.limit!)
      return (Math.min(up - last, last - down) / prev) * 100
    }
  }
}

export function condValue(cond: AlertCond, symbol: string, at: number): number | null {
  return condValueOn(cond, simMarket(symbol, at))
}

export function hit(cond: AlertCond, v: number, th: number) {
  if (cond === 'price_below' || cond === 'limit_near') return v <= th
  return v >= th
}

const fmtPx = (i: Instrument | undefined, p: number) =>
  p.toLocaleString('en-US', { minimumFractionDigits: i?.digits ?? 2, maximumFractionDigits: i?.digits ?? 2 })

export function fmtCondValueOf(cond: AlertCond, i: Instrument | undefined, v: number) {
  if (cond === 'price_above' || cond === 'price_below') return fmtPx(i, v)
  if (cond === 'volume_spike') return `${v.toFixed(2)} 倍`
  if (cond === 'funding_above') return `${v.toFixed(4)}%`
  return `${v.toFixed(2)}%`
}

export const fmtCondValue = (cond: AlertCond, symbol: string, v: number) => fmtCondValueOf(cond, instOf(symbol), v)

export function alertText(a: PriceAlert, i: Instrument | undefined, v: number) {
  const name = i?.name ?? a.symbol
  const th = a.cond === 'price_above' || a.cond === 'price_below' ? fmtPx(i, a.value) : String(a.value)
  switch (a.cond) {
    case 'price_above': return `${name} 价格 ${fmtPx(i, v)}，上穿 ${th}`
    case 'price_below': return `${name} 价格 ${fmtPx(i, v)}，下穿 ${th}`
    case 'pct_above': return `${name} 涨幅 ${v.toFixed(2)}%，超过 ${th}%`
    case 'pct_below': return `${name} 跌幅 ${v.toFixed(2)}%，超过 ${th}%`
    case 'volume_spike': return `${name} 1 分钟成交量是 20 根均量的 ${v.toFixed(2)} 倍，超过 ${th} 倍`
    case 'funding_above': return `${name} 资金费率 ${v.toFixed(4)}%，高于 ${th}%`
    case 'iv_above': return `${name} 隐含波动率 ${v.toFixed(1)}%，高于 ${th}%`
    case 'limit_near': return `${name} 距涨跌停 ${v.toFixed(2)}%，在 ${th}% 以内`
  }
}

export type AlertHit = { alert: PriceAlert; text: string; price: number }

/** 纯函数：给定时刻、给定行情，哪些提醒该触发 */
export function checkAlertsOn(alerts: PriceAlert[], at: number, marketOf: (symbol: string) => AlertMarket): AlertHit[] {
  const out: AlertHit[] = []
  for (const a of alerts) {
    if (!a.enabled) continue
    const m = marketOf(a.symbol)
    if (!condFits(a.cond, m.inst)) continue
    if (a.last_fired_at) {
      // 单次提醒触发过就不再响；重复提醒要过了冷却
      if (!a.repeat) continue
      if (at - new Date(a.last_fired_at).getTime() < Math.max(0, a.cooldown_min) * 60000) continue
    }
    const v = condValueOn(a.cond, m)
    if (v === null || !Number.isFinite(v) || !hit(a.cond, v, a.value)) continue
    out.push({ alert: a, text: alertText(a, m.inst, v), price: m.last() })
  }
  return out
}

/** 原型用：按模拟行情判定 */
export function checkAlerts(alerts: PriceAlert[], at: number): AlertHit[] {
  return checkAlertsOn(alerts, at, (s) => simMarket(s, at))
}
