// 交易套件 trade（TRD-01a 起）：行情源、标的、自选，行情快照、K 线和推送（TRD-02a、TRD-02b）。
// 契约见 docs/api-contract.md「交易套件插件 trade」。只读行情，没有下单、撤单、划转、提币。
//
// 实时行情走插件自己的 SSE（GET /api/trade/stream），不走内核事件流；连不上（没有 EventSource、服务没起、代理断了）
// 时退回轮询 /quotes、/book、/funding，2 秒一次。价格只来自后端：交易所取不到时后端给缓存并标 stale，
// 界面照实显示「数据时间」，不在前端插值或模拟。
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import { request, requestEnvelope, requestList } from '../api'

export type TradeMarket = 'crypto' | 'cn' | 'hk' | 'us'
export type TradeKind = 'spot' | 'perp' | 'future' | 'option'
export type TradeInterval = '1m' | '5m' | '15m' | '1h' | '4h' | '1d' | '1w'

export type TradeInstrument = {
  symbol: string
  name: string
  market: TradeMarket
  kind: TradeKind
  venue: string
  digits: number
  lot: number
  multiplier: number
  expiry?: string
  underlying?: string
  strike?: number
  right?: 'call' | 'put'
  limit?: number
  source: string
  updated_at: string
}

export type TradeWatchlist = { id: string; name: string; symbols: string[]; position: number; created_at: string; updated_at: string }

export type TradeSourceHealth = { status: 'ok' | 'error' | 'idle'; error: string; since: string; last_ok_at: string; retry_at: string }
export type TradeSource = { id: string; name: string; coverage: { market: TradeMarket; kinds: TradeKind[] }[]; health: TradeSourceHealth }

/** live 实时；stale 交易所暂时取不到、给的是缓存；loading 还没取到；error 取失败且没缓存；no_source 没有行情源 */
export type TradeDataStatus = 'live' | 'stale' | 'loading' | 'error' | 'no_source'

export type TradeQuote = {
  symbol: string
  source: string
  status: TradeDataStatus
  error: string
  last: number
  bid: number
  ask: number
  open_24h: number
  high_24h: number
  low_24h: number
  volume_24h: number
  change: number
  /** 小数，0.0123 即 1.23% */
  change_pct: number
  /** 交易所给的数据时间，没有为空串 */
  at: string
  fetched_at: string
}

export type TradeLevel = { price: number; size: number }
export type TradeBook = {
  symbol: string; source: string; status: TradeDataStatus; error: string
  bids: TradeLevel[]; asks: TradeLevel[]; at: string; fetched_at: string
}
export type TradeFunding = {
  symbol: string; source: string; status: TradeDataStatus | 'unsupported'; error: string
  /** 小数，0.0001 即 0.01% */
  rate: number; next_time: string; at: string; fetched_at: string
}
export type TradeKline = { time: string; open: number; high: number; low: number; close: number; volume: number }
export type TradeKlineMeta = {
  symbol: string; interval: TradeInterval; source: string; status: TradeDataStatus; error: string; cached: boolean; fetched_at: string
}

export const tradeKeys = {
  all: ['trade'] as const,
  sources: ['trade', 'sources'] as const,
  watchlists: ['trade', 'watchlists'] as const,
  instruments: (q: string) => ['trade', 'instruments', q] as const,
  instrument: (symbol: string) => ['trade', 'instrument', symbol] as const,
  klines: (symbol: string, interval: TradeInterval) => ['trade', 'klines', symbol, interval] as const,
}

const seg = encodeURIComponent

export const tradeApi = {
  sources: () => requestList<TradeSource>('/api/trade/sources').then((r) => r.data),
  instruments: (q: string, limit = 12) =>
    requestList<TradeInstrument>('/api/trade/instruments', { query: new URLSearchParams({ q, limit: String(limit) }) }).then((r) => r.data),
  instrument: (symbol: string) => request<TradeInstrument>('GET', '/api/trade/instruments/' + seg(symbol)),
  watchlists: () => requestList<TradeWatchlist>('/api/trade/watchlists').then((r) => r.data),
  addWatchlist: (body: { name: string; symbols?: string[] }) => request<TradeWatchlist>('POST', '/api/trade/watchlists', { body }),
  patchWatchlist: (id: string, body: { name?: string; symbols?: string[] }) => request<TradeWatchlist>('PATCH', '/api/trade/watchlists/' + seg(id), { body }),
  removeWatchlist: (id: string) => request<null>('DELETE', '/api/trade/watchlists/' + seg(id)),
  quotes: (symbols: string[]) =>
    requestList<TradeQuote>('/api/trade/quotes', { query: new URLSearchParams({ symbols: symbols.join(',') }) }).then((r) => r.data),
  book: (symbol: string, depth = 10) => request<TradeBook>('GET', '/api/trade/book', { query: new URLSearchParams({ symbol, depth: String(depth) }) }),
  funding: (symbol: string) => request<TradeFunding>('GET', '/api/trade/funding', { query: new URLSearchParams({ symbol }) }),
  klines: async (symbol: string, interval: TradeInterval, limit = 200) => {
    const r = await requestEnvelope<TradeKline[]>('GET', '/api/trade/klines', { query: new URLSearchParams({ symbol, interval, limit: String(limit) }) })
    return { data: r.data ?? [], meta: r.meta as unknown as TradeKlineMeta }
  },
}

export const useTradeSources = () => useQuery({ queryKey: tradeKeys.sources, queryFn: tradeApi.sources, refetchInterval: 30_000 })
export const useTradeWatchlists = () => useQuery({ queryKey: tradeKeys.watchlists, queryFn: tradeApi.watchlists })

/** 按名称或代码搜标的（标的表由后端每天从行情源同步） */
export function useTradeInstrumentSearch(q: string) {
  const kw = q.trim()
  return useQuery({ queryKey: tradeKeys.instruments(kw), queryFn: () => tradeApi.instruments(kw), enabled: kw.length > 0, staleTime: 60_000 })
}

/** 一个标的的静态信息；标的表里还没有（行情源还没同步）时为 undefined，界面按代码显示 */
export function useTradeInstrument(symbol: string) {
  return useQuery({
    queryKey: tradeKeys.instrument(symbol),
    queryFn: () => tradeApi.instrument(symbol).catch(() => null),
    enabled: !!symbol,
    staleTime: 10 * 60_000,
  })
}

/** K 线：一分钟重取一次（后端只补新收盘的那根），之间由实时价更新最后一根 */
export function useTradeKlines(symbol: string, interval: TradeInterval, limit = 200) {
  return useQuery({
    queryKey: tradeKeys.klines(symbol, interval),
    queryFn: () => tradeApi.klines(symbol, interval, limit),
    enabled: !!symbol,
    staleTime: 30_000,
    refetchInterval: 60_000,
  })
}

function useWatchlistMutation<A, R>(fn: (a: A) => Promise<R>) {
  const qc = useQueryClient()
  return useMutation({ mutationFn: fn, onSettled: () => qc.invalidateQueries({ queryKey: tradeKeys.watchlists }) })
}
export const useAddWatchlist = () => useWatchlistMutation(tradeApi.addWatchlist)
export const usePatchWatchlist = () =>
  useWatchlistMutation(({ id, ...body }: { id: string; name?: string; symbols?: string[] }) => tradeApi.patchWatchlist(id, body))
export const useRemoveWatchlist = () => useWatchlistMutation(tradeApi.removeWatchlist)

// ---- 实时行情 ----

export type TradeLiveTransport = 'sse' | 'poll' | 'connecting'
export type TradeLive = {
  quotes: Record<string, TradeQuote>
  book: TradeBook | null
  funding: TradeFunding | null
  sources: Record<string, TradeSourceHealth>
  transport: TradeLiveTransport
}

type StreamEvent = {
  type: 'ready' | 'quote' | 'book' | 'funding' | 'source'
  quote?: TradeQuote
  book?: TradeBook
  funding?: TradeFunding
  source?: TradeSourceHealth & { id: string }
}

const POLL_MS = 2_000
const SSE_RETRY_MS = [1_000, 2_000, 5_000, 10_000]

export type TradeLiveOptions = {
  /** 测试里换成假的或 null（强制轮询）；默认用浏览器的 */
  EventSource?: (new (url: string) => EventSource) | null
}

/**
 * 订阅一组标的的实时价，外加 focus 的盘口和资金费率。先连 SSE；连不上就轮询，同时按退避再试 SSE。
 * symbols 变了重连（按排序后的内容比较，同一组不重连）。
 */
export function useTradeLive(symbols: string[], focus: string, opts: TradeLiveOptions = {}): TradeLive {
  const key = useMemo(() => [...new Set(symbols)].sort().join(','), [symbols])
  const [state, setState] = useState<TradeLive>({ quotes: {}, book: null, funding: null, sources: {}, transport: 'connecting' })
  const ES = opts.EventSource === undefined ? (typeof EventSource === 'undefined' ? null : EventSource) : opts.EventSource

  useEffect(() => {
    const syms = key ? key.split(',') : []
    if (!syms.length && !focus) return
    let stopped = false
    let es: EventSource | null = null
    let pollTimer: ReturnType<typeof setTimeout> | undefined
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    let attempt = 0

    const apply = (e: StreamEvent) => {
      setState((s) => {
        switch (e.type) {
          case 'quote':
            return e.quote ? { ...s, quotes: { ...s.quotes, [e.quote.symbol]: e.quote } } : s
          case 'book':
            return e.book && e.book.symbol === focus ? { ...s, book: e.book } : s
          case 'funding':
            return e.funding && e.funding.symbol === focus ? { ...s, funding: e.funding } : s
          case 'source': {
            if (!e.source) return s
            const { id, ...h } = e.source
            return { ...s, sources: { ...s.sources, [id]: h } }
          }
          default:
            return { ...s, transport: 'sse' }
        }
      })
    }

    const poll = async () => {
      pollTimer = undefined
      if (stopped || es) return
      try {
        const [qs, book, funding] = await Promise.all([
          syms.length ? tradeApi.quotes(syms) : Promise.resolve([] as TradeQuote[]),
          focus ? tradeApi.book(focus).catch(() => null) : Promise.resolve(null),
          focus ? tradeApi.funding(focus).catch(() => null) : Promise.resolve(null),
        ])
        if (stopped || es) return
        setState((s) => ({
          ...s, transport: 'poll',
          quotes: { ...s.quotes, ...Object.fromEntries(qs.map((q) => [q.symbol, q])) },
          book: book ?? s.book, funding: funding ?? s.funding,
        }))
      } catch {
        // 后端也连不上：保留最后的值，下一轮再试
      }
      if (!stopped && !es) pollTimer = setTimeout(() => void poll(), POLL_MS)
    }

    const connect = () => {
      retryTimer = undefined
      if (stopped || !ES) return
      const q = new URLSearchParams({ symbols: syms.join(',') })
      if (focus) q.set('focus', focus)
      const src = new ES('/api/trade/stream?' + q.toString())
      es = src
      src.onmessage = (m) => {
        attempt = 0
        if (pollTimer) {
          clearTimeout(pollTimer)
          pollTimer = undefined
        }
        try {
          apply(JSON.parse(String(m.data)) as StreamEvent)
        } catch {
          // 不认识的一条跳过
        }
      }
      src.onerror = () => {
        if (stopped || es !== src) return
        // 不管浏览器会不会自己重连，都关掉自己管：先轮询顶上，再按退避重试
        src.close()
        es = null
        if (!pollTimer) void poll()
        retryTimer = setTimeout(connect, SSE_RETRY_MS[Math.min(attempt++, SSE_RETRY_MS.length - 1)])
      }
    }

    if (ES) connect()
    else void poll()
    return () => {
      stopped = true
      es?.close()
      es = null
      if (pollTimer) clearTimeout(pollTimer)
      if (retryTimer) clearTimeout(retryTimer)
    }
  }, [key, focus, ES])

  // 换标的后，旧标的的盘口、资金费率不显示；报价按 symbol 存，保留着（切回来不闪）
  return {
    ...state,
    book: state.book?.symbol === focus ? state.book : null,
    funding: state.funding?.symbol === focus ? state.funding : null,
  }
}
