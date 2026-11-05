import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startEventStream, type TradeAlert, type TradeAlertEvent, type TradeInstrument, type TradeWatchlist } from '../../core/data'
import MonitorPage from './MonitorPage'

// 判定在后端：页面只显示后端给的规则、当前值和触发记录；触发后靠 trade.alert_fired 刷新
const now = Date.now()
const iso = (ms: number) => new Date(ms).toISOString()

const BTC: TradeInstrument = {
  symbol: 'BINANCE:BTCUSDT', name: 'BTC/USDT', market: 'crypto', kind: 'spot', venue: 'Binance', digits: 1, lot: 0.00001, multiplier: 1,
  source: 'binance', updated_at: '',
}
const PERP: TradeInstrument = { ...BTC, symbol: 'BINANCE:BTCUSDT.P', name: 'BTC 永续', kind: 'perp' }
const WL: TradeWatchlist = { id: 'wl_1', name: '核心关注', symbols: ['BINANCE:BTCUSDT', 'SSE:600519'], position: 0, created_at: '', updated_at: '' }

const alertOf = (over: Partial<TradeAlert>): TradeAlert => ({
  id: 'al_1', symbol: 'BINANCE:BTCUSDT', cond: 'price_above', value: 70000, repeat: false, cooldown_min: 30, notify: ['app'], im_connector: '',
  enabled: true, note: '', last_fired_at: '', created_at: iso(now - 86400_000), updated_at: '', ...over,
})
const eventOf = (over: Partial<TradeAlertEvent>): TradeAlertEvent => ({
  id: 'ae_1', alert_id: 'al_1', symbol: 'BINANCE:BTCUSDT', cond: 'price_above', value: 70012.5, text: 'BTC/USDT 价格 70,012.5，上穿 70,000.0',
  price: 70012.5, note: '', at: iso(now - 60_000), read: false, im_status: '', im_error: '', ...over,
})

function fakeBackend() {
  const state = {
    alerts: [
      alertOf({ id: 'al_1', note: '突破前高考虑加仓', notify: ['app', 'im'], im_connector: 'cn_tg', last_fired_at: iso(now - 60_000) }),
      alertOf({ id: 'al_2', symbol: 'BINANCE:BTCUSDT.P', cond: 'funding_above', value: 0.05, repeat: true, cooldown_min: 480 }),
      alertOf({ id: 'al_3', symbol: 'SSE:600519', cond: 'pct_below', value: 4, enabled: false }),
    ],
    events: [eventOf({}), eventOf({ id: 'ae_0', at: iso(now - 3 * 86400_000), read: true, text: '旧的一条', im_status: 'unavailable', im_error: '没推' })],
    calls: [] as { method: string; path: string; body: unknown }[],
  }
  const json = (data: unknown, status = 200, meta?: unknown) => new Response(JSON.stringify(status < 300 ? { data, meta } : data), { status })
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input), 'http://x')
    const p = decodeURIComponent(u.pathname)
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    if (method !== 'GET') state.calls.push({ method, path: p, body })
    if (p === '/api/trade/watchlists') return json([WL], 200, { total: 1 })
    if (p === '/api/trade/instruments/BINANCE:BTCUSDT') return json(BTC)
    if (p === '/api/trade/instruments/BINANCE:BTCUSDT.P') return json(PERP)
    if (p.startsWith('/api/trade/instruments/')) return json({ error: { code: 'not_found', message: 'x' } }, 404)
    if (p === '/api/trade/instruments') return json([BTC, PERP], 200, { total: 2 })
    if (p === '/api/trade/quotes') {
      const syms = (u.searchParams.get('symbols') ?? '').split(',')
      return json(syms.map((s) => s === 'BINANCE:BTCUSDT'
        ? { symbol: s, source: 'binance', status: 'live', error: '', last: 70012.5, bid: 0, ask: 0, open_24h: 69000, high_24h: 0, low_24h: 0, volume_24h: 0, change: 1012.5, change_pct: 0.0147, at: iso(now), fetched_at: iso(now) }
        : { symbol: s, source: '', status: 'no_source', error: '', last: 0, bid: 0, ask: 0, open_24h: 0, high_24h: 0, low_24h: 0, volume_24h: 0, change: 0, change_pct: 0, at: '', fetched_at: '' }))
    }
    if (p === '/api/trade/klines') {
      const sym = u.searchParams.get('symbol') ?? ''
      const na = sym.startsWith('SSE:')
      return json([], 200, { symbol: sym, interval: '1m', source: na ? '' : 'binance', status: na ? 'no_source' : 'live', error: '', cached: true, fetched_at: '' })
    }
    if (p === '/api/trade/alerts' && method === 'GET') return json(state.alerts, 200, { total: state.alerts.length })
    if (p === '/api/trade/alerts' && method === 'POST') {
      const a = alertOf({ ...body, id: 'al_new' })
      state.alerts = [a, ...state.alerts]
      return json(a, 201)
    }
    if (p === '/api/trade/alerts/values') {
      return json([
        { alert_id: 'al_1', symbol: 'BINANCE:BTCUSDT', cond: 'price_above', status: 'ok', error: '', value: 70012.5, price: 70012.5, at: iso(now) },
        { alert_id: 'al_2', symbol: 'BINANCE:BTCUSDT.P', cond: 'funding_above', status: 'stale', error: 'Binance 被限频', value: null, price: 0, at: iso(now) },
      ])
    }
    if (p === '/api/trade/alerts/preview') {
      return json({ alert_id: '', symbol: u.searchParams.get('symbol'), cond: u.searchParams.get('cond'), status: 'ok', error: '', value: 70012.5, price: 70012.5, at: iso(now) })
    }
    const m = /^\/api\/trade\/alerts\/([^/]+)(\/rearm)?$/.exec(p)
    if (m && method === 'PATCH') {
      state.alerts = state.alerts.map((a) => (a.id === m[1] ? { ...a, ...body } : a))
      return json(state.alerts.find((a) => a.id === m[1]))
    }
    if (m && m[2] && method === 'POST') {
      state.alerts = state.alerts.map((a) => (a.id === m[1] ? { ...a, last_fired_at: '' } : a))
      return json(state.alerts.find((a) => a.id === m[1]))
    }
    if (p === '/api/trade/alert-events') {
      const limit = Number(u.searchParams.get('limit') ?? 50)
      return json(state.events.slice(0, limit), 200, { total: state.events.length, unread: state.events.filter((e) => !e.read).length, limit, offset: 0 })
    }
    if (p === '/api/trade/alert-events/read') {
      const ids: string[] | undefined = body?.ids
      state.events = state.events.map((e) => (!ids || ids.includes(e.id) ? { ...e, read: true } : e))
      return json({ updated: 1 })
    }
    if (p === '/api/connectors/defs') return json([{ tool: 'telegram', label: 'Telegram', category: 'im', color: '', desc: '', can_send: true, auth: ['token'], fields: [], tools: [], source: 'core' }])
    if (p === '/api/connectors') return json([{ id: 'cn_tg', tool: 'telegram', name: '个人 Telegram', status: 'connected' }])
    return json({ error: { code: 'not_found', message: p } }, 404)
  }))
  return state
}

/** 假的 EventSource：测试里往内核事件流里塞一条 */
class FakeES {
  static last: FakeES | null = null
  readyState = 1
  onopen: ((ev: Event) => unknown) | null = null
  onmessage: ((ev: MessageEvent) => unknown) | null = null
  onerror: ((ev: Event) => unknown) | null = null
  constructor() { FakeES.last = this }
  close() { this.readyState = 2 }
  emit(data: unknown) { this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(data) })) }
}

function setup(entry = '/monitor') {
  const backend = fakeBackend()
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const stop = startEventStream(qc, { EventSource: FakeES })
  const router = createMemoryRouter([
    { path: '/monitor', element: <MonitorPage /> },
    { path: '/markets', element: <div>行情页</div> },
  ], { initialEntries: [entry] })
  render(<QueryClientProvider client={qc}><RouterProvider router={router} /></QueryClientProvider>)
  return { backend, router, stop }
}

afterEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
})

describe('盯盘页接接口（TRD-03b）', () => {
  it('规则、当前值、触发记录都来自后端；停了的行情照实写', async () => {
    const { stop } = setup()
    const rules = await screen.findByRole('table')
    await waitFor(() => expect(within(rules).getByText('突破前高考虑加仓')).toBeInTheDocument())
    expect(screen.getByText('2 条提醒启用中')).toBeInTheDocument()
    // 当前值：al_1 是后端算的 70,012.5；al_2 的行情停了写「行情已停」；停用的 al_3 写 -
    await waitFor(() => expect(within(rules).getByText('70,012.5')).toBeInTheDocument())
    expect(within(rules).getByText('行情已停')).toBeInTheDocument()
    expect(within(rules).getByText('IM：个人 Telegram')).toBeInTheDocument()
    expect(within(rules).getByText('重复 · 冷却 480 分')).toBeInTheDocument()
    // 触发记录：一条未读，旧的那条标「IM 未推送」
    expect(await screen.findByText('1 条未读')).toBeInTheDocument()
    expect(screen.getByText('BTC/USDT 价格 70,012.5，上穿 70,000.0')).toBeInTheDocument()
    expect(screen.getByText('IM 未推送')).toBeInTheDocument()
    // 盯盘墙：A 股没有行情源
    expect(screen.getByText('未接行情源', { selector: '.mo-cell-na' })).toBeInTheDocument()
    stop()
  })

  it('启停、重新上膛、全部已读都走接口', async () => {
    const { backend, stop } = setup()
    const rules = await screen.findByRole('table')
    await waitFor(() => expect(within(rules).getByText('突破前高考虑加仓')).toBeInTheDocument())
    await userEvent.click(within(rules).getByRole('button', { name: '重新上膛' }))
    await waitFor(() => expect(backend.calls).toContainEqual({ method: 'POST', path: '/api/trade/alerts/al_1/rearm', body: undefined }))
    const switches = within(rules).getAllByRole('switch')
    await userEvent.click(switches[2])
    await waitFor(() => expect(backend.calls).toContainEqual({ method: 'PATCH', path: '/api/trade/alerts/al_3', body: { enabled: true } }))
    await waitFor(() => expect(screen.getByText('3 条提醒启用中')).toBeInTheDocument())
    await userEvent.click(screen.getByRole('button', { name: '全部已读' }))
    await waitFor(() => expect(backend.calls).toContainEqual({ method: 'POST', path: '/api/trade/alert-events/read', body: {} }))
    await waitFor(() => expect(screen.queryByText('1 条未读')).not.toBeInTheDocument())
    stop()
  })

  it('新建提醒：抽屉里当前值由后端算，保存发 POST', async () => {
    const { backend, stop } = setup()
    await screen.findByRole('table')
    await userEvent.click(screen.getAllByRole('button', { name: '新建提醒' })[0])
    const drawer = await screen.findByRole('dialog', { name: '新建提醒' })
    await waitFor(() => expect(within(drawer).getByTestId('mo-cur')).toHaveTextContent('70,012.5'))
    // 现货没有资金费率条件
    const cond = within(drawer).getByLabelText('条件') as HTMLSelectElement
    expect([...cond.options].map((o) => o.value)).not.toContain('funding_above')
    await userEvent.click(within(drawer).getByRole('button', { name: '填入当前值' }))
    expect(within(drawer).getByLabelText('阈值')).toHaveValue('70012.5')
    await userEvent.click(within(drawer).getByRole('button', { name: '保存' }))
    await waitFor(() => expect(backend.calls.find((c) => c.method === 'POST' && c.path === '/api/trade/alerts')?.body).toEqual({
      symbol: 'BINANCE:BTCUSDT', cond: 'price_above', value: 70012.5, repeat: false, cooldown_min: 30, notify: ['app'], im_connector: '', enabled: true, note: '',
    }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '新建提醒' })).not.toBeInTheDocument())
    stop()
  })

  it('行情页「设提醒」带标的过来直接打开新建抽屉；后端触发的提醒实时出现在触发记录里', async () => {
    const { backend, router, stop } = setup('/monitor?new=alert&symbol=BINANCE%3ABTCUSDT.P')
    const drawer = await screen.findByRole('dialog', { name: '新建提醒' })
    await waitFor(() => expect(within(drawer).getByText('BTC 永续')).toBeInTheDocument())
    const cond = within(drawer).getByLabelText('条件') as HTMLSelectElement
    expect([...cond.options].map((o) => o.value)).toContain('funding_above')
    await waitFor(() => expect(router.state.location.search).toBe(''))

    // 后端触发：事件流来一条 trade.alert_fired，触发记录重取
    backend.events = [eventOf({ id: 'ae_2', text: 'BTC 永续 资金费率 0.0610%，高于 0.05%', at: iso(Date.now()) }), ...backend.events]
    act(() => FakeES.last?.emit({ id: '9', type: 'trade.alert_fired', at: iso(Date.now()), payload: { ...backend.events[0], notify: ['app'] } }))
    expect(await screen.findByText('BTC 永续 资金费率 0.0610%，高于 0.05%')).toBeInTheDocument()
    expect(screen.getByText('2 条未读')).toBeInTheDocument()
    stop()
  })
})
