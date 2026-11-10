// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 交易员模块的数据约定：行情（看盘）、盯盘、策略与回测、交易执行共用
// 市场：数币交易所、A 股、港股、美股；品种：现货、期货（含永续）、期权
// 没有后端，行情是「时间决定价格」的确定性模拟：同一个标的同一时刻在哪个页面算都是同一个价，不用共享状态
// markets.tsx / strategy.tsx / trading.tsx 只读这里的类型和函数，不改它

import { useEffect, useState } from 'react'

/* ---------- 市场与标的 ---------- */

export type MarketKey = 'crypto' | 'cn' | 'hk' | 'us'
export const MARKETS: Record<MarketKey, { label: string; currency: string; tz: string; color: string; t1: boolean; desc: string }> = {
  crypto: { label: '数币', currency: 'USDT', tz: 'UTC', color: '#f0b90b', t1: false, desc: '7x24 小时，现货、永续、交割、期权' },
  cn: { label: 'A 股', currency: 'CNY', tz: 'Asia/Shanghai', color: '#c0352b', t1: true, desc: 'T+1，涨跌停 10% / 20%，股指期货、ETF 期权' },
  hk: { label: '港股', currency: 'HKD', tz: 'Asia/Hong_Kong', color: '#7a4fd6', t1: false, desc: 'T+0，无涨跌停，恒指期货、个股期权' },
  us: { label: '美股', currency: 'USD', tz: 'America/New_York', color: '#3d4fd6', t1: false, desc: 'T+0，盘前盘后，股指期货、个股期权' },
}

export type InstKind = 'spot' | 'perp' | 'future' | 'option'
export const INST_KIND: Record<InstKind, { label: string; short: string }> = {
  spot: { label: '现货 / 股票', short: '现货' },
  perp: { label: '永续合约', short: '永续' },
  future: { label: '交割期货', short: '期货' },
  option: { label: '期权', short: '期权' },
}

export interface Instrument {
  /** 全局唯一，形如 BINANCE:BTCUSDT、SSE:600519、HKEX:00700、NASDAQ:AAPL、CFFEX:IF2612 */
  symbol: string
  name: string
  market: MarketKey
  kind: InstKind
  /** 交易场所：Binance、OKX、上交所、深交所、中金所、港交所、纳斯达克、纽交所、CME、Deribit */
  venue: string
  /** 模拟用的基准价、年化波动率 */
  base: number
  vol: number
  /** 价格精度（小数位）、最小下单量、合约乘数 */
  digits: number
  lot: number
  multiplier: number
  /** 期货 / 期权：到期日（ISO 日期）；期权：标的、行权价、看涨看跌 */
  expiry?: string
  underlying?: string
  strike?: number
  right?: 'call' | 'put'
  /** A 股涨跌停幅度 */
  limit?: number
}

const inst = (symbol: string, name: string, market: MarketKey, kind: InstKind, venue: string, base: number, vol: number, extra: Partial<Instrument> = {}): Instrument => ({
  symbol, name, market, kind, venue, base, vol, digits: base > 1000 ? 1 : base > 10 ? 2 : 3, lot: market === 'cn' ? 100 : market === 'hk' ? 100 : 1, multiplier: 1, ...extra,
})

export const INSTRUMENTS: Instrument[] = [
  // 数币
  inst('BINANCE:BTCUSDT', 'BTC/USDT', 'crypto', 'spot', 'Binance', 67000, 0.55, { lot: 0.0001, digits: 1 }),
  inst('BINANCE:ETHUSDT', 'ETH/USDT', 'crypto', 'spot', 'Binance', 3400, 0.7, { lot: 0.001, digits: 2 }),
  inst('BINANCE:SOLUSDT', 'SOL/USDT', 'crypto', 'spot', 'Binance', 165, 0.9, { lot: 0.01 }),
  inst('BINANCE:BTCUSDT.P', 'BTC 永续', 'crypto', 'perp', 'Binance', 67020, 0.55, { lot: 0.001, digits: 1, underlying: 'BINANCE:BTCUSDT' }),
  inst('OKX:ETH-USDT-SWAP', 'ETH 永续', 'crypto', 'perp', 'OKX', 3402, 0.7, { lot: 0.01, digits: 2, underlying: 'BINANCE:ETHUSDT' }),
  inst('OKX:BTC-USD-261225', 'BTC 季度交割 1225', 'crypto', 'future', 'OKX', 68100, 0.55, { lot: 1, multiplier: 100, digits: 1, expiry: '2026-12-25', underlying: 'BINANCE:BTCUSDT' }),
  // A 股
  inst('SSE:600519', '贵州茅台', 'cn', 'spot', '上交所', 1520, 0.25, { limit: 0.1 }),
  inst('SZSE:300750', '宁德时代', 'cn', 'spot', '深交所', 245, 0.4, { limit: 0.2 }),
  inst('SSE:510300', '沪深300ETF', 'cn', 'spot', '上交所', 4.12, 0.18, { limit: 0.1 }),
  inst('CFFEX:IF2612', '沪深300股指 2612', 'cn', 'future', '中金所', 4105, 0.2, { lot: 1, multiplier: 300, expiry: '2026-12-18', underlying: 'SSE:510300' }),
  // 港股
  inst('HKEX:00700', '腾讯控股', 'hk', 'spot', '港交所', 485, 0.32),
  inst('HKEX:09988', '阿里巴巴-W', 'hk', 'spot', '港交所', 118, 0.42),
  inst('HKEX:HSI2611', '恒指期货 2611', 'hk', 'future', '港交所', 25600, 0.24, { lot: 1, multiplier: 50, digits: 0, expiry: '2026-11-27' }),
  // 美股
  inst('NASDAQ:AAPL', 'Apple', 'us', 'spot', '纳斯达克', 232, 0.28),
  inst('NASDAQ:NVDA', 'NVIDIA', 'us', 'spot', '纳斯达克', 182, 0.55),
  inst('NYSE:TSLA', 'Tesla', 'us', 'spot', '纽交所', 265, 0.65),
  inst('CME:ESZ6', 'E-mini 标普 500 2612', 'us', 'future', 'CME', 6120, 0.17, { lot: 1, multiplier: 50, expiry: '2026-12-18' }),
]

/** 期权链：按标的、到期日、行权价现算，T 型报价用 */
export function optionChain(underlying: string, expiry: string, strikes = 11): { strike: number; call: Instrument; put: Instrument }[] {
  const u = instOf(underlying)
  if (!u) return []
  const step = niceStep(u.base * 0.025)
  const atm = Math.round(u.base / step) * step
  const venue = u.market === 'crypto' ? 'Deribit' : u.market === 'cn' ? '上交所' : u.market === 'hk' ? '港交所' : 'CBOE'
  const mult = u.market === 'crypto' ? 1 : u.market === 'cn' ? 10000 : 100
  return Array.from({ length: strikes }, (_, i) => {
    const strike = atm + (i - (strikes >> 1)) * step
    const mk = (right: 'call' | 'put'): Instrument => ({
      symbol: `${u.symbol}-${expiry}-${strike}-${right === 'call' ? 'C' : 'P'}`, name: `${u.name} ${expiry.slice(5)} ${strike} ${right === 'call' ? '购' : '沽'}`,
      market: u.market, kind: 'option', venue, base: u.base, vol: u.vol, digits: u.base > 1000 ? 1 : 3, lot: 1, multiplier: mult,
      expiry, underlying: u.symbol, strike, right,
    })
    return { strike, call: mk('call'), put: mk('put') }
  })
}
export const OPTION_UNDERLYINGS = ['BINANCE:BTCUSDT', 'BINANCE:ETHUSDT', 'SSE:510300', 'HKEX:00700', 'NASDAQ:AAPL', 'NASDAQ:NVDA']
export const OPTION_EXPIRIES = ['2026-11-07', '2026-11-28', '2026-12-26', '2027-03-26']

function niceStep(x: number) {
  const p = 10 ** Math.floor(Math.log10(x))
  return [1, 2, 2.5, 5, 10].map((k) => k * p).find((s) => s >= x) ?? 10 * p
}

const optionCache = new Map<string, Instrument>()
/** 按 symbol 找标的；期权 symbol 现场解析 */
export function instOf(symbol: string): Instrument | undefined {
  const x = INSTRUMENTS.find((i) => i.symbol === symbol)
  if (x) return x
  const m = /^(.+)-(\d{4}-\d{2}-\d{2})-([\d.]+)-([CP])$/.exec(symbol)
  if (!m) return undefined
  if (!optionCache.has(symbol)) {
    const row = optionChain(m[1], m[2], 41).find((r) => r.strike === Number(m[3]))
    if (row) optionCache.set(symbol, m[4] === 'C' ? row.call : row.put)
  }
  return optionCache.get(symbol)
}

/* ---------- 交易时段 ---------- */

export type SessionState = 'pre' | 'open' | 'break' | 'post' | 'closed'
export const SESSION_LABEL: Record<SessionState, string> = { pre: '盘前', open: '交易中', break: '午休', post: '盘后', closed: '休市' }

/** 按市场所在时区算当前时段；节假日不算，原型够用 */
export function sessionOf(market: MarketKey, at = Date.now()): SessionState {
  if (market === 'crypto') return 'open'
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: MARKETS[market].tz, hour12: false, weekday: 'short', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(at))
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ''
  if (get('weekday') === 'Sat' || get('weekday') === 'Sun') return 'closed'
  const hm = (Number(get('hour')) % 24) * 60 + Number(get('minute'))
  const t = (h: number, m = 0) => h * 60 + m
  if (market === 'cn') return hm >= t(9, 15) && hm < t(9, 30) ? 'pre' : (hm >= t(9, 30) && hm < t(11, 30)) || (hm >= t(13) && hm < t(15)) ? 'open' : hm >= t(11, 30) && hm < t(13) ? 'break' : 'closed'
  if (market === 'hk') return hm >= t(9) && hm < t(9, 30) ? 'pre' : (hm >= t(9, 30) && hm < t(12)) || (hm >= t(13) && hm < t(16)) ? 'open' : hm >= t(12) && hm < t(13) ? 'break' : hm >= t(16) && hm < t(16, 10) ? 'post' : 'closed'
  return hm >= t(4) && hm < t(9, 30) ? 'pre' : hm >= t(9, 30) && hm < t(16) ? 'open' : hm >= t(16) && hm < t(20) ? 'post' : 'closed'
}

/* ---------- 确定性行情 ---------- */

// 价格 = 基准价 × exp(几组不同周期正弦叠加的「随机游走」)；同一 symbol 的相位由名字哈希决定
function hash(s: string) { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0 }
const TAU = Math.PI * 2
function wave(seed: number, t: number) {
  // t 是秒；周期从 40 秒到 60 天，振幅按 sqrt(周期) 缩放，近似布朗运动
  let v = 0
  for (let k = 0; k < 9; k++) {
    const period = 40 * 3.6 ** k
    const ph = ((seed >>> (k * 3)) % 1000) / 1000
    v += Math.sqrt(period) * Math.sin(TAU * (t / period + ph)) * (k % 2 ? 0.8 : 1)
  }
  return v
}

/** 某一时刻的价格；期权按简化的 Black-Scholes 用标的价现算 */
export function priceAt(symbol: string, at = Date.now()): number {
  const i = instOf(symbol)
  if (!i) return 0
  if (i.kind === 'option') return greeks(i, at).price
  const sec = at / 1000
  const sigmaPerSqrtSec = i.vol / Math.sqrt(365 * 86400)
  const p = i.base * Math.exp(wave(hash(i.underlying ?? symbol), sec) * sigmaPerSqrtSec * 0.4 + (i.underlying ? (hash(symbol) % 7) * 0.0002 : 0))
  return round(p, i.digits)
}

/** 昨收（数币用 24 小时前） */
export const prevClose = (symbol: string, at = Date.now()) => priceAt(symbol, at - 86400000)

export interface Quote { symbol: string; last: number; prev: number; change: number; pct: number; high: number; low: number; volume: number; bid: number; ask: number; at: number }
export function quoteOf(symbol: string, at = Date.now()): Quote {
  const i = instOf(symbol)!
  const last = priceAt(symbol, at)
  const prev = prevClose(symbol, at)
  const day = bars(symbol, '15m', 96, at)
  const tick = 10 ** -i.digits
  return {
    symbol, last, prev, change: round(last - prev, i.digits), pct: prev ? (last - prev) / prev : 0,
    high: Math.max(last, ...day.map((b) => b.h)), low: Math.min(last, ...day.map((b) => b.l)),
    volume: day.reduce((s, b) => s + b.v, 0), bid: round(last - tick, i.digits), ask: round(last + tick, i.digits), at,
  }
}

export type BarInterval = '1m' | '5m' | '15m' | '1h' | '4h' | '1d'
export const INTERVALS: Record<BarInterval, { label: string; ms: number }> = {
  '1m': { label: '1 分', ms: 60000 }, '5m': { label: '5 分', ms: 300000 }, '15m': { label: '15 分', ms: 900000 },
  '1h': { label: '1 时', ms: 3600000 }, '4h': { label: '4 时', ms: 14400000 }, '1d': { label: '日线', ms: 86400000 },
}
export interface Bar { t: number; o: number; h: number; l: number; c: number; v: number }

/** 截至 end 的最近 count 根 K 线（最后一根是未走完的当前 K 线） */
export function bars(symbol: string, interval: BarInterval, count: number, end = Date.now()): Bar[] {
  const i = instOf(symbol)
  if (!i) return []
  const ms = INTERVALS[interval].ms
  const start = Math.floor(end / ms) * ms - (count - 1) * ms
  const seed = hash(symbol)
  return Array.from({ length: count }, (_, k) => {
    const t = start + k * ms
    const close = Math.min(t + ms, end)
    const o = priceAt(symbol, t)
    const c = priceAt(symbol, close)
    const n = 6
    let h = Math.max(o, c), l = Math.min(o, c)
    for (let j = 1; j < n; j++) { const p = priceAt(symbol, t + ((close - t) * j) / n); h = Math.max(h, p); l = Math.min(l, p) }
    // 每根 K 线单独哈希一次：保证非负，也不会随时间线性变化出锯齿
    const v = Math.round((1 + (hash(`${seed}:${Math.floor(t / ms)}`) % 97) / 40) * (i.market === 'crypto' ? 120 : 8000) * (ms / 60000) ** 0.7)
    return { t, o, h, l, c, v }
  })
}

/** 盘口：买卖各 n 档 */
export function orderBook(symbol: string, at = Date.now(), n = 10): { bids: [number, number][]; asks: [number, number][] } {
  const i = instOf(symbol)!
  const q = priceAt(symbol, at)
  const tick = Math.max(10 ** -i.digits, q * 0.0001)
  const seed = hash(symbol) ^ Math.floor(at / 1500)
  const size = (k: number, side: number) => round(((((seed >>> (k + side)) % 50) + 5) * (i.market === 'crypto' ? 0.05 : 100)) * (1 + k * 0.15), i.market === 'crypto' ? 3 : 0)
  return {
    bids: Array.from({ length: n }, (_, k) => [round(q - tick * (k + 1), i.digits), size(k, 0)]),
    asks: Array.from({ length: n }, (_, k) => [round(q + tick * (k + 1), i.digits), size(k, 7)]),
  }
}

export interface Greeks { price: number; iv: number; delta: number; gamma: number; theta: number; vega: number }
/** 简化 Black-Scholes：无利率；IV 带一点微笑 */
export function greeks(opt: Instrument, at = Date.now()): Greeks {
  const S = priceAt(opt.underlying!, at)
  const K = opt.strike!
  const T = Math.max((new Date(opt.expiry!).getTime() - at) / (365 * 86400000), 1 / 365)
  const m = Math.log(K / S)
  const iv = opt.vol * (1 + 1.2 * m * m + (m < 0 ? -0.15 * m : 0))
  const d1 = (Math.log(S / K) + 0.5 * iv * iv * T) / (iv * Math.sqrt(T))
  const d2 = d1 - iv * Math.sqrt(T)
  const call = S * cdf(d1) - K * cdf(d2)
  const price = opt.right === 'call' ? call : call - S + K
  const pdf = Math.exp(-d1 * d1 / 2) / Math.sqrt(TAU)
  return {
    price: round(Math.max(price, 10 ** -opt.digits), opt.digits), iv,
    delta: opt.right === 'call' ? cdf(d1) : cdf(d1) - 1, gamma: pdf / (S * iv * Math.sqrt(T)),
    theta: -(S * pdf * iv) / (2 * Math.sqrt(T)) / 365, vega: (S * pdf * Math.sqrt(T)) / 100,
  }
}
function cdf(x: number) { const t = 1 / (1 + 0.2316419 * Math.abs(x)); const d = 0.3989423 * Math.exp(-x * x / 2); const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return x > 0 ? 1 - p : p }
export const round = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d

/** 每 ms 毫秒刷新一次的「现在」；行情页用它驱动重绘 */
export function useNow(ms = 1000) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => { const t = window.setInterval(() => setNow(Date.now()), ms); return () => window.clearInterval(t) }, [ms])
  return now
}

/** 价格格式：按标的精度 + 千分位 */
export const fmtPrice = (symbol: string, p: number) => p.toLocaleString('en-US', { minimumFractionDigits: instOf(symbol)?.digits ?? 2, maximumFractionDigits: instOf(symbol)?.digits ?? 2 })
export const fmtPct = (x: number) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(2)}%`
/** 涨跌色：按习惯可切「红涨绿跌」或「绿涨红跌」，默认红涨绿跌 */
export const UP = 'var(--trade-up, #d4372c)'
export const DOWN = 'var(--trade-down, #1f9d55)'

/* ---------- 自选 ---------- */

export interface Watchlist { id: string; name: string; symbols: string[] }
export const seedWatchlists: Watchlist[] = [
  { id: 'wl_core', name: '核心关注', symbols: ['BINANCE:BTCUSDT', 'BINANCE:ETHUSDT', 'NASDAQ:NVDA', 'HKEX:00700', 'SSE:600519', 'CME:ESZ6'] },
  { id: 'wl_crypto', name: '数币合约', symbols: ['BINANCE:BTCUSDT.P', 'OKX:ETH-USDT-SWAP', 'OKX:BTC-USD-261225', 'BINANCE:SOLUSDT'] },
  { id: 'wl_cn', name: 'A 股与股指', symbols: ['SSE:600519', 'SZSE:300750', 'SSE:510300', 'CFFEX:IF2612'] },
]

/* ---------- 盯盘提醒 ---------- */

export type AlertCond = 'price_above' | 'price_below' | 'pct_above' | 'pct_below' | 'volume_spike' | 'funding_above' | 'iv_above' | 'limit_near'
export const ALERT_COND: Record<AlertCond, { label: string; unit: string; kinds?: InstKind[] }> = {
  price_above: { label: '价格上穿', unit: '价格' },
  price_below: { label: '价格下穿', unit: '价格' },
  pct_above: { label: '涨幅超过', unit: '%' },
  pct_below: { label: '跌幅超过', unit: '%' },
  volume_spike: { label: '成交量放大', unit: '倍于均量' },
  funding_above: { label: '资金费率高于', unit: '%', kinds: ['perp'] },
  iv_above: { label: '隐含波动率高于', unit: '%', kinds: ['option'] },
  limit_near: { label: '接近涨跌停', unit: '% 以内' },
}
export type AlertNotify = 'app' | 'im' | 'sound'
export interface PriceAlert {
  id: string
  symbol: string
  cond: AlertCond
  value: number
  /** 触发一次就停，还是每次满足都提醒（有冷却） */
  repeat: boolean
  cooldown_min: number
  notify: AlertNotify[]
  /** 推 IM 时用哪个连接器（connector id） */
  im_connector?: string
  enabled: boolean
  note: string
  last_fired_at?: string
  created_at: string
}
export interface AlertEvent { id: string; alert_id: string; symbol: string; text: string; price: number; at: string; read: boolean }

const minsAgo = (m: number) => new Date(Date.now() - m * 60000).toISOString()
const daysAgo = (d: number) => minsAgo(d * 1440)
// 提醒最近一次触发和事件记录共用同一个时刻
const FIRED_AL3 = minsAgo(180)
const FIRED_AL2 = daysAgo(2)

export const seedAlerts: PriceAlert[] = [
  { id: 'al1', symbol: 'BINANCE:BTCUSDT', cond: 'price_above', value: 70000, repeat: false, cooldown_min: 30, notify: ['app', 'im'], im_connector: 'cn_tg', enabled: true, note: '突破前高考虑加仓', created_at: daysAgo(3) },
  { id: 'al2', symbol: 'NASDAQ:NVDA', cond: 'pct_below', value: 4, repeat: true, cooldown_min: 60, notify: ['app'], enabled: true, note: '', last_fired_at: FIRED_AL2, created_at: daysAgo(6) },
  { id: 'al3', symbol: 'BINANCE:BTCUSDT.P', cond: 'funding_above', value: 0.05, repeat: true, cooldown_min: 480, notify: ['app', 'im'], im_connector: 'cn_tg', enabled: true, note: '费率过高减多单', last_fired_at: FIRED_AL3, created_at: daysAgo(10) },
  { id: 'al4', symbol: 'SZSE:300750', cond: 'limit_near', value: 2, repeat: false, cooldown_min: 0, notify: ['app', 'sound'], enabled: false, note: '', created_at: daysAgo(12) },
]
export const seedAlertEvents: AlertEvent[] = [
  { id: 'ae1', alert_id: 'al3', symbol: 'BINANCE:BTCUSDT.P', text: 'BTC 永续资金费率 0.061%，高于 0.05%', price: 67120, at: FIRED_AL3, read: false },
  { id: 'ae2', alert_id: 'al2', symbol: 'NASDAQ:NVDA', text: 'NVIDIA 跌幅 4.3%，超过 4%', price: 174.2, at: FIRED_AL2, read: true },
]

/* ---------- 策略 ---------- */

export type StrategyMode = 'rules' | 'code'
export type Indicator = 'price' | 'ma' | 'ema' | 'rsi' | 'macd' | 'boll_up' | 'boll_low' | 'volume' | 'atr'
export const INDICATORS: Record<Indicator, { label: string; params: string[] }> = {
  price: { label: '收盘价', params: [] },
  ma: { label: '均线 MA', params: ['周期'] },
  ema: { label: '指数均线 EMA', params: ['周期'] },
  rsi: { label: 'RSI', params: ['周期'] },
  macd: { label: 'MACD 柱', params: ['快', '慢', '信号'] },
  boll_up: { label: '布林上轨', params: ['周期', '倍数'] },
  boll_low: { label: '布林下轨', params: ['周期', '倍数'] },
  volume: { label: '成交量', params: [] },
  atr: { label: 'ATR', params: ['周期'] },
}
export type Operand = { kind: 'ind'; ind: Indicator; params: number[] } | { kind: 'num'; value: number }
export type Compare = 'cross_up' | 'cross_down' | 'gt' | 'lt'
export const COMPARE: Record<Compare, string> = { cross_up: '上穿', cross_down: '下穿', gt: '大于', lt: '小于' }
export interface Rule { id: string; left: Operand; op: Compare; right: Operand }
export interface RuleGroup { logic: 'all' | 'any'; rules: Rule[] }

export interface Strategy {
  id: string
  name: string
  desc: string
  mode: StrategyMode
  /** 适用标的（symbol） */
  symbols: string[]
  interval: BarInterval
  direction: 'long' | 'short' | 'both'
  entry: RuleGroup
  exit: RuleGroup
  /** 止损、止盈（%，0 表示不设） */
  stop_loss: number
  take_profit: number
  /** 每次开仓用多少资金（占账户 %） */
  position_pct: number
  /** 代码模式的源码（Python 风格，原型不执行，只做展示和参数提取） */
  code: string
  /** 可调参数：名字 → 值，回测时可以扫参 */
  params: Record<string, number>
  tags: string[]
  updated_at: string
  created_at: string
}

const ind = (i: Indicator, ...params: number[]): Operand => ({ kind: 'ind', ind: i, params })
const num = (value: number): Operand => ({ kind: 'num', value })

export const seedStrategies: Strategy[] = [
  {
    id: 'st_macross', name: '双均线趋势', desc: '快线上穿慢线开多，下穿平仓；适合趋势明显的标的', mode: 'rules', symbols: ['BINANCE:BTCUSDT', 'BINANCE:ETHUSDT'], interval: '4h', direction: 'long',
    entry: { logic: 'all', rules: [{ id: 'r1', left: ind('ema', 12), op: 'cross_up', right: ind('ema', 48) }] },
    exit: { logic: 'any', rules: [{ id: 'r2', left: ind('ema', 12), op: 'cross_down', right: ind('ema', 48) }] },
    stop_loss: 6, take_profit: 0, position_pct: 30, code: '', params: { fast: 12, slow: 48 }, tags: ['趋势', '数币'], updated_at: daysAgo(2), created_at: daysAgo(30),
  },
  {
    id: 'st_rsi', name: 'RSI 超卖反弹', desc: 'RSI 低于 30 且站上布林下轨买入，RSI 高于 65 卖出', mode: 'rules', symbols: ['NASDAQ:NVDA', 'NASDAQ:AAPL', 'HKEX:00700'], interval: '4h', direction: 'long',
    entry: { logic: 'all', rules: [{ id: 'r3', left: ind('rsi', 14), op: 'lt', right: num(30) }, { id: 'r4', left: ind('price'), op: 'cross_up', right: ind('boll_low', 20, 2) }] },
    exit: { logic: 'any', rules: [{ id: 'r5', left: ind('rsi', 14), op: 'gt', right: num(65) }] },
    stop_loss: 8, take_profit: 15, position_pct: 20, code: '', params: { rsi: 14, low: 30, high: 65 }, tags: ['均值回归', '美股'], updated_at: daysAgo(5), created_at: daysAgo(40),
  },
  {
    id: 'st_grid', name: '永续网格', desc: '在区间内等距挂单，低买高卖；代码模式', mode: 'code', symbols: ['BINANCE:BTCUSDT.P', 'OKX:ETH-USDT-SWAP'], interval: '15m', direction: 'both',
    entry: { logic: 'all', rules: [] }, exit: { logic: 'any', rules: [] }, stop_loss: 10, take_profit: 0, position_pct: 50,
    code: `# 网格策略：区间 [lower, upper] 等分 grids 格，每格挂一笔
def init(ctx):
    ctx.lower = params.lower
    ctx.upper = params.upper
    ctx.grids = params.grids
    ctx.step = (ctx.upper - ctx.lower) / ctx.grids

def on_bar(ctx, bar):
    level = int((bar.close - ctx.lower) / ctx.step)
    target = (ctx.grids / 2 - level) * params.qty
    ctx.order_target(bar.symbol, target)
`, params: { lower: 62000, upper: 72000, grids: 20, qty: 0.01 }, tags: ['网格', '合约'], updated_at: daysAgo(1), created_at: daysAgo(9),
  },
  {
    id: 'st_ifbasis', name: '股指期现基差', desc: 'IF 主力相对沪深300ETF 贴水过深时买期货、卖 ETF 对冲', mode: 'code', symbols: ['CFFEX:IF2612', 'SSE:510300'], interval: '5m', direction: 'both',
    entry: { logic: 'all', rules: [] }, exit: { logic: 'any', rules: [] }, stop_loss: 0, take_profit: 0, position_pct: 40,
    code: `# 期现套利：基差 = 期货 - 现货 * 1000；低于阈值开仓，回归平仓
def on_bar(ctx, bars):
    basis = bars['CFFEX:IF2612'].close - bars['SSE:510300'].close * 1000
    if basis < -params.open_bp and not ctx.position:
        ctx.buy('CFFEX:IF2612', 1)
        ctx.sell('SSE:510300', 300000)
    elif basis > -params.close_bp and ctx.position:
        ctx.close_all()
`, params: { open_bp: 40, close_bp: 10 }, tags: ['套利', 'A 股'], updated_at: daysAgo(8), created_at: daysAgo(20),
  },
]

/* ---------- 回测 ---------- */

export interface BacktestConfig {
  strategy_id: string
  symbols: string[]
  interval: BarInterval
  /** 回测区间：最近多少根 K 线 */
  bars: number
  capital: number
  /** 手续费（万分之几）、滑点（跳） */
  fee_bp: number
  slippage_ticks: number
  /** 参数覆盖 */
  params: Record<string, number>
}
export interface BacktestTrade { t: number; symbol: string; side: 'buy' | 'sell'; price: number; qty: number; pnl?: number; reason: string }
export interface BacktestResult {
  /** 资金曲线（与 K 线对齐）和基准（买入持有） */
  equity: { t: number; v: number; bench: number }[]
  trades: BacktestTrade[]
  stats: { total_return: number; annual: number; max_dd: number; sharpe: number; win_rate: number; trades: number; profit_factor: number; bench_return: number }
}
export type BacktestStatus = 'queued' | 'running' | 'done' | 'failed'
export interface Backtest {
  id: string
  name: string
  config: BacktestConfig
  status: BacktestStatus
  progress: number
  /** 回测时的策略快照（策略之后再改不影响这次结果） */
  strategy_snapshot: Strategy
  result?: BacktestResult
  error?: string
  created_at: string
  finished_at?: string
}

/* ---------- 交易：账户、持仓、委托、策略运行、风控 ---------- */

export type AccountKind = 'exchange' | 'broker'
export interface TradeAccount {
  id: string
  name: string
  /** Binance、OKX、Bybit、富途、老虎、盈透 IBKR、华泰、中信 */
  broker: string
  kind: AccountKind
  markets: MarketKey[]
  /** 实盘 / 模拟盘 */
  paper: boolean
  currency: string
  /** 权益、可用、已用保证金 */
  equity: number
  available: number
  margin_used: number
  status: 'connected' | 'disconnected' | 'error'
  error?: string
  /** API key 只存后四位给人认 */
  api_hint: string
  /** 权限：只读、交易；不开提币 */
  permissions: ('read' | 'trade')[]
  updated_at: string
}

export interface Position {
  id: string
  account_id: string
  symbol: string
  side: 'long' | 'short'
  qty: number
  avg_price: number
  /** 合约：杠杆、强平价 */
  leverage?: number
  liq_price?: number
  /** 来自哪个策略运行（手动开的没有） */
  run_id?: string
  opened_at: string
}

export type OrderType = 'market' | 'limit' | 'stop' | 'stop_limit'
export const ORDER_TYPE: Record<OrderType, string> = { market: '市价', limit: '限价', stop: '止损市价', stop_limit: '止损限价' }
export type OrderStatus = 'pending' | 'open' | 'partial' | 'filled' | 'canceled' | 'rejected'
export const ORDER_STATUS: Record<OrderStatus, { label: string; color: string }> = {
  pending: { label: '提交中', color: '#a19d92' }, open: { label: '挂单中', color: '#3d4fd6' }, partial: { label: '部分成交', color: '#b0570b' },
  filled: { label: '已成交', color: '#2f7d43' }, canceled: { label: '已撤单', color: '#a19d92' }, rejected: { label: '被拒绝', color: '#c0352b' },
}
export interface Order {
  id: string
  account_id: string
  symbol: string
  side: 'buy' | 'sell'
  type: OrderType
  qty: number
  price?: number
  stop_price?: number
  filled: number
  avg_fill?: number
  status: OrderStatus
  reject_reason?: string
  /** 仅减仓（合约） */
  reduce_only?: boolean
  run_id?: string
  created_at: string
  updated_at: string
}

export type RunStatus = 'running' | 'paused' | 'stopped' | 'error'
export const RUN_STATUS: Record<RunStatus, { label: string; color: string }> = {
  running: { label: '运行中', color: '#2f7d43' }, paused: { label: '已暂停', color: '#b0570b' }, stopped: { label: '已停止', color: '#a19d92' }, error: { label: '异常', color: '#c0352b' },
}
export interface StrategyRun {
  id: string
  strategy_id: string
  account_id: string
  symbols: string[]
  params: Record<string, number>
  /** 分配给这个运行的资金上限 */
  capital: number
  status: RunStatus
  error?: string
  pnl: number
  started_at: string
  /** 停了的运行：什么时候停的、为什么停 */
  stopped_at?: string
  stop_reason?: string
  /** 运行日志：信号、下单、风控拦截 */
  logs: { at: string; level: 'info' | 'warn' | 'error'; text: string }[]
}

export interface RiskRules {
  /** 单标的最大仓位（占权益 %） */
  max_position_pct: number
  /** 单日最大亏损（占权益 %），触发后停所有策略、禁止新开仓 */
  daily_loss_pct: number
  /** 单笔最大下单金额 */
  max_order_value: number
  /** 合约最大杠杆 */
  max_leverage: number
  /** 下单前二次确认金额阈值 */
  confirm_above: number
  /** 熔断状态：触发了日亏损或手动一键全停 */
  halted: boolean
  halted_reason?: string
  halted_at?: string
}

export const seedAccounts: TradeAccount[] = [
  { id: 'ac_bn', name: 'Binance 主账户', broker: 'Binance', kind: 'exchange', markets: ['crypto'], paper: false, currency: 'USDT', equity: 128450, available: 61230, margin_used: 0, status: 'connected', api_hint: '****7Q2c', permissions: ['read', 'trade'], updated_at: minsAgo(1) },
  { id: 'ac_okx', name: 'OKX 合约', broker: 'OKX', kind: 'exchange', markets: ['crypto'], paper: false, currency: 'USDT', equity: 40210, available: 18800, margin_used: 9600, status: 'error', error: 'API Key 已过期，请到 OKX 重新创建并更新', api_hint: '****m9Lk', permissions: ['read', 'trade'], updated_at: minsAgo(240) },
  { id: 'ac_futu', name: '富途 港美股', broker: '富途', kind: 'broker', markets: ['hk', 'us'], paper: false, currency: 'USD', equity: 86300, available: 30120, margin_used: 0, status: 'connected', api_hint: 'OpenD 127.0.0.1:11111', permissions: ['read', 'trade'], updated_at: minsAgo(2) },
  { id: 'ac_ht', name: '华泰 A 股', broker: '华泰证券', kind: 'broker', markets: ['cn'], paper: false, currency: 'CNY', equity: 512000, available: 188400, margin_used: 0, status: 'connected', api_hint: 'QMT ****1203', permissions: ['read'], updated_at: minsAgo(5) },
  { id: 'ac_paper', name: '模拟盘（全市场）', broker: '模拟', kind: 'exchange', markets: ['crypto', 'cn', 'hk', 'us'], paper: true, currency: 'USD', equity: 100000, available: 70252, margin_used: 4068, status: 'connected', api_hint: '本地模拟撮合', permissions: ['read', 'trade'], updated_at: minsAgo(0) },
]

// 运行启动时刻，持仓和日志都按它往后排
const RN1_START = daysAgo(16)
const RN1_OPEN = minsAgo(1440 * 16 - 240)
const RN2_START = daysAgo(1)
const RN2_OPEN = minsAgo(1440 - 90)
const ETH_BUY = daysAgo(14)

export const seedPositions: Position[] = [
  { id: 'ps1', account_id: 'ac_paper', symbol: 'BINANCE:BTCUSDT', side: 'long', qty: 0.4, avg_price: 64200, run_id: 'rn1', opened_at: RN1_OPEN },
  { id: 'ps2', account_id: 'ac_paper', symbol: 'BINANCE:BTCUSDT.P', side: 'short', qty: 0.3, avg_price: 67800, leverage: 5, liq_price: 80100, run_id: 'rn2', opened_at: RN2_OPEN },
  { id: 'ps3', account_id: 'ac_bn', symbol: 'BINANCE:ETHUSDT', side: 'long', qty: 6.2, avg_price: 3280, opened_at: ETH_BUY },
  { id: 'ps4', account_id: 'ac_futu', symbol: 'NASDAQ:NVDA', side: 'long', qty: 120, avg_price: 168.5, opened_at: daysAgo(20) },
  { id: 'ps5', account_id: 'ac_futu', symbol: 'HKEX:00700', side: 'long', qty: 300, avg_price: 452, opened_at: daysAgo(35) },
  { id: 'ps6', account_id: 'ac_ht', symbol: 'SSE:600519', side: 'long', qty: 100, avg_price: 1488, opened_at: daysAgo(50) },
]

export const seedOrders: Order[] = [
  { id: 'od1', account_id: 'ac_bn', symbol: 'BINANCE:BTCUSDT', side: 'buy', type: 'limit', qty: 0.1, price: 63500, filled: 0, status: 'open', created_at: minsAgo(40), updated_at: minsAgo(40) },
  { id: 'od2', account_id: 'ac_paper', symbol: 'BINANCE:BTCUSDT.P', side: 'sell', type: 'limit', qty: 0.05, price: 68200, filled: 0, status: 'open', run_id: 'rn2', reduce_only: false, created_at: minsAgo(15), updated_at: minsAgo(15) },
  { id: 'od3', account_id: 'ac_futu', symbol: 'NASDAQ:NVDA', side: 'sell', type: 'stop', qty: 120, stop_price: 160, filled: 0, status: 'open', created_at: daysAgo(3), updated_at: daysAgo(3) },
  { id: 'od4', account_id: 'ac_bn', symbol: 'BINANCE:ETHUSDT', side: 'buy', type: 'market', qty: 6.2, filled: 6.2, avg_fill: 3280, status: 'filled', created_at: ETH_BUY, updated_at: ETH_BUY },
  { id: 'od5', account_id: 'ac_ht', symbol: 'SZSE:300750', side: 'buy', type: 'limit', qty: 200, price: 240, filled: 0, status: 'rejected', reject_reason: '账户只开了只读权限，不能下单', created_at: daysAgo(1), updated_at: daysAgo(1) },
  { id: 'od6', account_id: 'ac_paper', symbol: 'NASDAQ:AAPL', side: 'buy', type: 'limit', qty: 50, price: 200, filled: 0, status: 'open', created_at: minsAgo(90), updated_at: minsAgo(90) },
]

export const seedRuns: StrategyRun[] = [
  { id: 'rn1', strategy_id: 'st_macross', account_id: 'ac_paper', symbols: ['BINANCE:BTCUSDT'], params: { fast: 12, slow: 48 }, capital: 30000, status: 'running', pnl: 2100.4, started_at: RN1_START,
    logs: [{ at: RN1_START, level: 'info', text: '模拟盘启动：EMA12 / EMA48，4 小时线' }, { at: RN1_OPEN, level: 'info', text: 'EMA12 上穿 EMA48，开多 0.4 BTC @ 64200' }, { at: minsAgo(30), level: 'info', text: '持仓中，无新信号' }] },
  { id: 'rn2', strategy_id: 'st_grid', account_id: 'ac_paper', symbols: ['BINANCE:BTCUSDT.P'], params: { lower: 62000, upper: 72000, grids: 20, qty: 0.01 }, capital: 20000, status: 'running', pnl: -412.3, started_at: RN2_START,
    logs: [{ at: RN2_START, level: 'info', text: '模拟盘网格启动：62000 - 72000，20 格' }, { at: RN2_OPEN, level: 'info', text: '价格上穿 67800 格线，开空 0.3 @ 67800' }, { at: minsAgo(15), level: 'info', text: '挂卖 0.05 @ 68200' }, { at: minsAgo(8), level: 'warn', text: '资金费率 0.061% 偏高，空单在收费率' }] },
  { id: 'rn3', strategy_id: 'st_rsi', account_id: 'ac_paper', symbols: ['NASDAQ:NVDA', 'NASDAQ:AAPL'], params: { rsi: 14, low: 30, high: 65 }, capital: 30000, status: 'paused', pnl: 1210, started_at: daysAgo(12),
    logs: [{ at: daysAgo(12), level: 'info', text: '模拟盘启动' }, { at: daysAgo(2), level: 'info', text: '手动暂停' }] },
  { id: 'rn4', strategy_id: 'st_macross', account_id: 'ac_paper', symbols: ['BINANCE:ETHUSDT'], params: { fast: 9, slow: 36 }, capital: 30000, status: 'stopped', pnl: -846.2, started_at: daysAgo(28), stopped_at: daysAgo(16), stop_reason: '模拟盘跑了 12 天回撤超过 5%，手动停掉换参数',
    logs: [{ at: daysAgo(28), level: 'info', text: '模拟盘启动：EMA9 / EMA36' }, { at: daysAgo(22), level: 'info', text: 'EMA9 上穿 EMA36，开多 4.2 ETH @ 3190' }, { at: daysAgo(18), level: 'warn', text: '回撤 5.2%，超过预设 5%' }, { at: daysAgo(16), level: 'info', text: '手动停止，平仓 4.2 ETH @ 3010' }] },
  { id: 'rn5', strategy_id: 'st_grid', account_id: 'ac_paper', symbols: ['OKX:ETH-USDT-SWAP'], params: { lower: 3000, upper: 3800, grids: 16, qty: 0.1 }, capital: 15000, status: 'error', error: 'OKX 行情推送断开超过 5 分钟，网格已挂起', pnl: 312.8, started_at: daysAgo(9),
    logs: [{ at: daysAgo(9), level: 'info', text: '模拟盘网格启动：3000 - 3800，16 格' }, { at: minsAgo(240), level: 'error', text: 'OKX 行情推送断开超过 5 分钟，运行已挂起' }] },
]

export const seedRisk: RiskRules = { max_position_pct: 35, daily_loss_pct: 3, max_order_value: 50000, max_leverage: 10, confirm_above: 10000, halted: false }

/* ---------- 实盘评审和对账（TRD-08） ---------- */

/** 实盘评审清单：五项都由用户本人确认后，才能申请 trade:live、打开实盘开关 */
export type LiveCheckKey = 'audit' | 'recon' | 'incident' | 'drill' | 'paper'
export const LIVE_CHECKS: { key: LiveCheckKey; label: string; desc: string }[] = [
  { key: 'audit', label: '审计日志', desc: '一笔委托从下单、报单、成交到撤单的每一步都能查到，风控拦截和熔断也记' },
  { key: 'recon', label: '对账', desc: '实盘账户定时和交易所对余额、持仓、挂单，差异都处理完' },
  { key: 'incident', label: '异常演练', desc: '账户异常、委托被拒、风控拦截、熔断、对账差异都记审计、运行异常并通知；至少真的出过一次并查得到' },
  { key: 'drill', label: '全停演练', desc: '手动按一次一键全停，确认策略全停、挂单全撤、进入熔断，再解除' },
  { key: 'paper', label: '模拟盘两周记录', desc: '至少一个部署在模拟盘连续跑满 14 天，每天一条运行检查记录（TRD-05d）' },
]

export interface LiveReview {
  /** 每项评审用户确认通过的时间；没确认的没有。评审人是确认的人（正式版记界面操作者的名字，原型只有「我」） */
  confirmed: Partial<Record<LiveCheckKey, string>>
  /** trade:live 权限授予的时间；没申请或已收回的没有 */
  granted_at?: string
  /** 实盘开关：开了实盘账户才能下单、部署 */
  enabled: boolean
  enabled_at?: string
}
export const seedLiveReview: LiveReview = { confirmed: { audit: daysAgo(3), incident: daysAgo(3) }, enabled: false }

/** 对账的一处差异：本地记的和交易所返回的对不上 */
export interface ReconItem {
  id: string
  kind: 'balance' | 'position' | 'order'
  /** 给人看的对象：「ETH/USDT 持仓」「USDT 可用」 */
  label: string
  local: string
  remote: string
  /** 差异可能的原因 */
  note?: string
  /** 持仓差异：按交易所修正时把这个持仓的数量改成 remote_qty */
  position_id?: string
  remote_qty?: number
  /** 已处理的时间和方式 */
  resolved_at?: string
  resolution?: string
}
/** 一个实盘账户最近一次对账；模拟盘本地撮合，不对账 */
export interface Reconciliation {
  account_id: string
  at: string
  status: 'ok' | 'diff' | 'failed'
  /** 失败原因 */
  error?: string
  /** 这次对了多少项（余额、每个持仓、每笔挂单各算一项） */
  checked: number
  items: ReconItem[]
}
export const seedRecons: Reconciliation[] = [
  { account_id: 'ac_bn', at: minsAgo(12), status: 'diff', checked: 3, items: [
    { id: 'rc1', kind: 'position', label: 'ETH/USDT 持仓', local: '6.2', remote: '6.1938', note: '买入手续费按 ETH 扣了 0.0062，本地记的是委托数量', position_id: 'ps3', remote_qty: 6.1938 },
  ] },
  { account_id: 'ac_okx', at: minsAgo(240), status: 'failed', error: 'API Key 已过期，拉不到交易所数据', checked: 0, items: [] },
  { account_id: 'ac_futu', at: minsAgo(15), status: 'ok', checked: 4, items: [] },
  { account_id: 'ac_ht', at: minsAgo(30), status: 'ok', checked: 2, items: [] },
]

/** 持仓浮盈：按当前价现算 */
export function positionPnl(p: Position, at = Date.now()) {
  const i = instOf(p.symbol)
  const last = priceAt(p.symbol, at)
  const dir = p.side === 'long' ? 1 : -1
  const pnl = (last - p.avg_price) * p.qty * (i?.multiplier ?? 1) * dir
  return { last, pnl, pct: ((last - p.avg_price) / p.avg_price) * dir * (p.leverage ?? 1), value: last * p.qty * (i?.multiplier ?? 1) }
}
