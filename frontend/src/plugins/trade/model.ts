// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 行情页的纯函数：标的推断、格式化、指标、把实时价并进最后一根 K 线、数据状态的文案。
// 交互照原型 web-next/src/markets.tsx；价格一律来自后端，这里不造任何价格。
import type { TradeDataStatus, TradeInstrument, TradeInterval, TradeKline, TradeMarket, TradeQuote } from '../../core/data'

export const UP = 'var(--trade-up, #d4372c)'
export const DOWN = 'var(--trade-down, #1f9d55)'

export const MARKETS: Record<TradeMarket, { label: string; color: string; currency: string }> = {
  crypto: { label: '数币', color: '#e8a317', currency: 'USDT' },
  cn: { label: 'A 股', color: '#d4372c', currency: 'CNY' },
  hk: { label: '港股', color: '#7a4fd6', currency: 'HKD' },
  us: { label: '美股', color: '#1c7ed6', currency: 'USD' },
}

export const KIND_SHORT: Record<string, string> = { perp: '永续', future: '期货', option: '期权' }

/** K 线周期，同原型 INTERVALS */
export const INTERVALS: { key: TradeInterval; label: string; ms: number }[] = [
  { key: '1m', label: '1 分', ms: 60_000 },
  { key: '5m', label: '5 分', ms: 300_000 },
  { key: '15m', label: '15 分', ms: 900_000 },
  { key: '1h', label: '1 时', ms: 3_600_000 },
  { key: '4h', label: '4 时', ms: 14_400_000 },
  { key: '1d', label: '日线', ms: 86_400_000 },
]
export const intervalMs = (iv: TradeInterval) => INTERVALS.find((x) => x.key === iv)?.ms ?? (iv === '1w' ? 7 * 86_400_000 : 60_000)

const VENUE_MARKET: Record<string, TradeMarket> = {
  BINANCE: 'crypto', OKX: 'crypto', FAKE: 'crypto', BYBIT: 'crypto', DERIBIT: 'crypto',
  SSE: 'cn', SZSE: 'cn', BSE: 'cn', CFFEX: 'cn', SHFE: 'cn', DCE: 'cn', CZCE: 'cn', INE: 'cn',
  HKEX: 'hk',
  NASDAQ: 'us', NYSE: 'us', AMEX: 'us', ARCA: 'us', CME: 'us', CBOE: 'us', CBOT: 'us', NYMEX: 'us', COMEX: 'us',
}

export const codeOf = (symbol: string) => symbol.slice(symbol.indexOf(':') + 1)
export const venueOf = (symbol: string) => symbol.slice(0, Math.max(0, symbol.indexOf(':')))

/** 标的表里还没有（行情源没同步）时，按 symbol 推一个够显示用的样子 */
export function guessInstrument(symbol: string): TradeInstrument {
  const venue = venueOf(symbol)
  const code = codeOf(symbol)
  const perp = code.endsWith('.P') || code.endsWith('-SWAP')
  const venueName = venue === 'BINANCE' ? 'Binance' : venue === 'OKX' ? 'OKX' : venue
  let name = code
  if (venue === 'BINANCE') name = perp ? code.replace(/USDT\.P$/, '') + ' 永续' : code.replace(/USDT$/, '/USDT')
  if (venue === 'OKX') name = perp ? code.split('-')[0] + ' 永续' : code.replace('-', '/')
  return {
    symbol, name, market: VENUE_MARKET[venue] ?? 'us', kind: perp ? 'perp' : 'spot', venue: venueName,
    digits: -1, lot: 1, multiplier: 1, source: '', updated_at: '',
  }
}

/** 小数位：标的表给了就用；没给按价格大小推 */
export function digitsFor(inst: TradeInstrument | undefined, price: number) {
  if (inst && inst.digits >= 0) return inst.digits
  const a = Math.abs(price)
  return a >= 1000 ? 1 : a >= 1 ? 2 : a >= 0.01 ? 4 : 6
}

export const fmtPrice = (p: number, digits: number) =>
  Number.isFinite(p) ? p.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits }) : '-'
export const fmtPct = (x: number) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(2)}%`
export const fmtVol = (v: number) => (v >= 1e8 ? `${(v / 1e8).toFixed(2)} 亿` : v >= 1e4 ? `${(v / 1e4).toFixed(2)} 万` : v >= 100 ? v.toFixed(0) : v.toFixed(v >= 1 ? 2 : 4))
export const fmtNum = (x: number) => {
  const a = Math.abs(x)
  return a >= 100 ? x.toFixed(1) : a >= 1 ? x.toFixed(2) : a >= 0.001 ? x.toFixed(4) : x === 0 ? '0' : x.toExponential(2)
}
export const signColor = (x: number) => (x > 0 ? UP : x < 0 ? DOWN : 'var(--muted)')
const p2 = (n: number) => String(n).padStart(2, '0')

/** 本地时间 HH:MM:SS；跨天带上日期 */
export function fmtClock(iso: string, now = Date.now()) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const hms = `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`
  const n = new Date(now)
  return d.toDateString() === n.toDateString() ? hms : `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${hms}`
}

/** 距现在多久：几秒、几分、几小时 */
export function fmtSpan(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s} 秒`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} 分 ${p2(s % 60)} 秒`
  return `${Math.floor(m / 60)} 时 ${p2(m % 60)} 分`
}

export function fmtBarTime(t: number, iv: TradeInterval, long = false) {
  const d = new Date(t)
  const md = `${p2(d.getMonth() + 1)}-${p2(d.getDate())}`
  const hm = `${p2(d.getHours())}:${p2(d.getMinutes())}`
  if (iv === '1d' || iv === '1w') return long ? `${d.getFullYear()}-${md}` : md
  if (iv === '1h' || iv === '4h' || long) return `${md} ${hm}`
  return hm
}

/** 数据状态的短标签和说明（界面上标明数据从哪来、是不是实时） */
export const STATUS_LABEL: Record<TradeDataStatus, string> = {
  live: '实时', stale: '缓存', loading: '加载中', error: '取不到', no_source: '数据源未接',
}

export type Bar = { t: number; o: number; h: number; l: number; c: number; v: number }

export const toBars = (ks: TradeKline[]): Bar[] =>
  ks.map((k) => ({ t: new Date(k.time).getTime(), o: k.open, h: k.high, l: k.low, c: k.close, v: k.volume }))

/**
 * 把实时价并进最后一根：只在报价是实时的、且报价时间落在最后一根的区间里时更新收、高、低。
 * 报价停了（stale）就不动，价格停在最后一次取到的值，不往前跳。
 */
export function withLive(bars: Bar[], q: TradeQuote | undefined, iv: TradeInterval): Bar[] {
  const last = bars[bars.length - 1]
  if (!last || !q || q.status !== 'live' || !(q.last > 0)) return bars
  const at = new Date(q.at || q.fetched_at).getTime()
  if (!(at >= last.t && at < last.t + intervalMs(iv))) return bars
  return [...bars.slice(0, -1), { ...last, c: q.last, h: Math.max(last.h, q.last), l: Math.min(last.l, q.last) }]
}

/* ---------- 指标，同原型 ---------- */

export function sma(xs: number[], n: number) {
  const out: number[] = []
  let s = 0
  xs.forEach((x, i) => {
    s += x
    if (i >= n) s -= xs[i - n]
    out.push(i >= n - 1 ? s / n : NaN)
  })
  return out
}
export function ema(xs: number[], n: number) {
  const k = 2 / (n + 1)
  const out: number[] = []
  xs.forEach((x, i) => out.push(i === 0 ? x : x * k + out[i - 1] * (1 - k)))
  return out
}
export function boll(xs: number[], n = 20, m = 2) {
  const mid = sma(xs, n)
  const up: number[] = []
  const low: number[] = []
  xs.forEach((_, i) => {
    if (i < n - 1) {
      up.push(NaN)
      low.push(NaN)
      return
    }
    let v = 0
    for (let j = i - n + 1; j <= i; j++) v += (xs[j] - mid[i]) ** 2
    const sd = Math.sqrt(v / n)
    up.push(mid[i] + m * sd)
    low.push(mid[i] - m * sd)
  })
  return { mid, up, low }
}
export function macd(xs: number[]) {
  const a = ema(xs, 12)
  const b = ema(xs, 26)
  const dif = xs.map((_, i) => a[i] - b[i])
  const dea = ema(dif, 9)
  return { dif, dea, hist: dif.map((d, i) => 2 * (d - dea[i])) }
}
export function rsi(xs: number[], n = 14) {
  const out: number[] = [NaN]
  let g = 0
  let l = 0
  for (let i = 1; i < xs.length; i++) {
    const d = xs[i] - xs[i - 1]
    const up = Math.max(d, 0)
    const dn = Math.max(-d, 0)
    if (i <= n) {
      g += up / n
      l += dn / n
      out.push(i === n ? (l ? 100 - 100 / (1 + g / l) : 100) : NaN)
      continue
    }
    g = (g * (n - 1) + up) / n
    l = (l * (n - 1) + dn) / n
    out.push(l ? 100 - 100 / (1 + g / l) : 100)
  }
  return out
}
