// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { describe, expect, it } from 'vitest'
import type { TradeQuote } from '../../core/data'
import { digitsFor, guessInstrument, withLive, type Bar } from './model'

const t0 = Date.UTC(2026, 10, 4, 12, 0)
const bars: Bar[] = [{ t: t0 - 900_000, o: 1, h: 2, l: 1, c: 2, v: 1 }, { t: t0, o: 100, h: 101, l: 99, c: 100, v: 1 }]
const q = (over: Partial<TradeQuote>): TradeQuote => ({
  symbol: 'BINANCE:BTCUSDT', source: 'binance', status: 'live', error: '', last: 105, bid: 0, ask: 0, open_24h: 0, high_24h: 0, low_24h: 0,
  volume_24h: 0, change: 0, change_pct: 0, at: new Date(t0 + 60_000).toISOString(), fetched_at: '', ...over,
})

describe('行情页的纯函数', () => {
  it('实时价并进最后一根；缓存价、区间外的价不动', () => {
    expect(withLive(bars, q({}), '15m')[1]).toEqual({ t: t0, o: 100, h: 105, l: 99, c: 105, v: 1 })
    expect(withLive(bars, q({ status: 'stale' }), '15m')).toBe(bars)
    expect(withLive(bars, q({ at: new Date(t0 + 900_000).toISOString() }), '15m')).toBe(bars)
    expect(withLive(bars, undefined, '15m')).toBe(bars)
  })

  it('标的表里没有时按 symbol 推市场、品种、名称', () => {
    expect(guessInstrument('BINANCE:ETHUSDT.P')).toMatchObject({ market: 'crypto', kind: 'perp', name: 'ETH 永续', venue: 'Binance' })
    expect(guessInstrument('OKX:BTC-USDT')).toMatchObject({ market: 'crypto', kind: 'spot', name: 'BTC/USDT' })
    expect(guessInstrument('SSE:600519')).toMatchObject({ market: 'cn', kind: 'spot' })
    expect(guessInstrument('HKEX:00700').market).toBe('hk')
    expect(digitsFor(undefined, 78000)).toBe(1)
    expect(digitsFor(undefined, 0.5)).toBe(4)
  })
})
