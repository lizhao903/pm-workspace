// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TradeInstrument, TradeKline, TradeQuote, TradeWatchlist } from '../../core/data'
import MarketsPage from './MarketsPage'

// jsdom 没有 EventSource：行情页退回轮询 /quotes、/book、/funding，正好测降级路径
const now = new Date()
const iso = (ms: number) => new Date(ms).toISOString()

const BTC: TradeInstrument = {
  symbol: 'BINANCE:BTCUSDT', name: 'BTC/USDT', market: 'crypto', kind: 'spot', venue: 'Binance', digits: 2, lot: 0.00001, multiplier: 1,
  source: 'binance', updated_at: '',
}
const WL: TradeWatchlist = { id: 'wl_1', name: '核心关注', symbols: ['BINANCE:BTCUSDT', 'SSE:600519'], position: 0, created_at: '', updated_at: '' }

function quote(over: Partial<TradeQuote> = {}): TradeQuote {
  return {
    symbol: 'BINANCE:BTCUSDT', source: 'binance', status: 'live', error: '', last: 78129.31, bid: 78129.31, ask: 78129.32,
    open_24h: 77104.01, high_24h: 78718, low_24h: 75736.38, volume_24h: 15072.14, change: 1025.3, change_pct: 0.0133,
    at: iso(now.getTime()), fetched_at: iso(now.getTime()), ...over,
  }
}

const bar0 = Math.floor(now.getTime() / (15 * 60_000)) * 15 * 60_000
const KLINES: TradeKline[] = [2, 1, 0].map((k) => ({ time: iso(bar0 - k * 15 * 60_000), open: 78000 + k, high: 78300, low: 77900, close: 78100 - k, volume: 10 + k }))

function fakeBackend() {
  const state = { btc: quote(), calls: [] as string[] }
  const json = (data: unknown, status = 200, meta?: unknown) => new Response(JSON.stringify(status < 300 ? { data, meta } : data), { status })
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const u = new URL(String(input), 'http://x')
    const p = u.pathname
    state.calls.push(p + u.search)
    if (p === '/api/trade/watchlists') return json([WL], 200, { total: 1 })
    if (p === '/api/trade/sources') {
      return json([{ id: 'binance', name: 'Binance', coverage: [], health: { status: state.btc.status === 'stale' ? 'error' : 'ok', error: state.btc.error, since: '', last_ok_at: '', retry_at: '' } }])
    }
    if (p === '/api/trade/instruments/BINANCE%3ABTCUSDT' || p === '/api/trade/instruments/BINANCE:BTCUSDT') return json(BTC)
    if (p.startsWith('/api/trade/instruments/')) return json({ error: { code: 'not_found', message: 'x' } }, 404)
    if (p === '/api/trade/quotes') {
      const syms = (u.searchParams.get('symbols') ?? '').split(',')
      return json(syms.map((s) => (s === 'BINANCE:BTCUSDT' ? state.btc : { ...quote({ symbol: s, source: '', status: 'no_source', last: 0, change: 0, change_pct: 0, at: '', fetched_at: '' }) })), 200, { total: syms.length })
    }
    if (p === '/api/trade/book') {
      return json({ symbol: 'BINANCE:BTCUSDT', source: 'binance', status: 'live', error: '', at: '', fetched_at: '',
        bids: [{ price: 78129.31, size: 8.4 }, { price: 78129.3, size: 0.1 }], asks: [{ price: 78129.32, size: 1.8 }, { price: 78129.33, size: 0.01 }] })
    }
    if (p === '/api/trade/funding') return json({ symbol: 'BINANCE:BTCUSDT', source: 'binance', status: 'unsupported', error: '', rate: 0, next_time: '', at: '', fetched_at: '' })
    if (p === '/api/trade/klines') {
      return json(KLINES, 200, { symbol: 'BINANCE:BTCUSDT', interval: '15m', source: 'binance', status: 'live', error: '', cached: false, fetched_at: '' })
    }
    return json({ error: { code: 'not_found', message: p } }, 404)
  }))
  return state
}

function setup() {
  const backend = fakeBackend()
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createMemoryRouter([
    { path: '/markets', element: <MarketsPage /> },
    { path: '/trading', element: <div>交易页</div> },
    { path: '/monitor', element: <div>盯盘页</div> },
  ], { initialEntries: ['/markets'] })
  render(<QueryClientProvider client={qc}><RouterProvider router={router} /></QueryClientProvider>)
  return { backend, router }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('行情页接真实数据（TRD-02b）', () => {
  it('价格、盘口来自后端，标明数据源；没接数据源的市场不显示价格', async () => {
    setup()
    const head = await screen.findByText('78,129.31', { selector: '.mk-last' })
    expect(head).toBeInTheDocument()
    expect(screen.getAllByText('BTC/USDT').length).toBeGreaterThan(0)
    // A 股那一行：数据源未接，没有价格
    await waitFor(() => expect(screen.getByText('数据源未接', { selector: '.mk-na' })).toBeInTheDocument())
    // 数据源框：来源、状态、更新方式（没有 EventSource，退回轮询）
    const src = screen.getByLabelText('数据源')
    await waitFor(() => expect(within(src).getByText('Binance 公开行情')).toBeInTheDocument())
    expect(within(src).getByText('实时')).toBeInTheDocument()
    expect(within(src).getByText('轮询，2 秒')).toBeInTheDocument()
    // 盘口两档
    expect(screen.getByText('卖1')).toBeInTheDocument()
    expect(screen.getByText('买2')).toBeInTheDocument()
  })

  it('交易所取不到时价格停住、标成缓存并提示，不继续跳', async () => {
    const { backend } = setup()
    await screen.findByText('78,129.31', { selector: '.mk-last' })
    backend.btc = quote({ status: 'stale', error: 'Binance 返回 429（被限频）' })
    const src = screen.getByLabelText('数据源')
    await waitFor(() => expect(within(src).getByText('缓存')).toBeInTheDocument(), { timeout: 4000 })
    expect(screen.getByText('78,129.31', { selector: '.mk-last' })).toBeInTheDocument()
    expect(within(src).getByText(/被限频/)).toBeInTheDocument()
  })

  it('期权板显示数据源未接；买入去交易页（模拟盘），设提醒去盯盘', async () => {
    const { router } = setup()
    await screen.findByText('78,129.31', { selector: '.mk-last' })
    await userEvent.click(screen.getByRole('button', { name: '期权' }))
    expect(screen.getByText('期权数据源未接')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '看盘' }))
    await userEvent.click(await screen.findByRole('button', { name: /^买入/ }))
    expect(router.state.location.pathname).toBe('/trading')
    expect(new URLSearchParams(router.state.location.search).get('paper')).toBe('1')
    expect(new URLSearchParams(router.state.location.search).get('symbol')).toBe('BINANCE:BTCUSDT')
  })
})

