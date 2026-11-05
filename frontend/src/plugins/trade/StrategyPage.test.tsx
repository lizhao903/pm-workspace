import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TradeBacktest, TradeBacktestResult, TradeStrategy } from '../../core/data'
import StrategyPage from './StrategyPage'

// 假后端：策略和回测都在内存里；回测发起后先排队，被查两次后变运行中，再查一次完成（模拟后端跑）
const T0 = Date.parse('2026-11-01T00:00:00Z')

function strategy(over: Partial<TradeStrategy> = {}): TradeStrategy {
  return {
    id: 'st_1', name: '双均线趋势', desc: 'EMA 金叉开多', mode: 'rules', symbols: ['BINANCE:BTCUSDT'], interval: '1h', direction: 'long',
    entry: { logic: 'all', rules: [{ id: 'r1', left: { kind: 'ind', ind: 'ema', params: [12] }, op: 'cross_up', right: { kind: 'ind', ind: 'ema', params: [48] } }] },
    exit: { logic: 'any', rules: [{ id: 'r2', left: { kind: 'ind', ind: 'ema', params: [12] }, op: 'cross_down', right: { kind: 'ind', ind: 'ema', params: [48] } }] },
    stop_loss: 6, take_profit: 0, position_pct: 30, code: '', params: { fast: 12, slow: 48 }, tags: ['趋势'],
    updated_at: new Date(T0).toISOString(), created_at: new Date(T0).toISOString(), ...over,
  }
}

function result(ret: number): TradeBacktestResult {
  const equity = Array.from({ length: 50 }, (_, i) => ({ t: T0 + i * 3_600_000, v: 100000 * (1 + (ret * i) / 49), bench: 100000 * (1 + 0.01 * i / 49) }))
  return {
    equity,
    trades: [
      { t: T0, symbol: 'BINANCE:BTCUSDT', side: 'buy', price: 70000.12, qty: 0.42, reason: '入场信号' },
      { t: T0 + 10 * 3_600_000, symbol: 'BINANCE:BTCUSDT', side: 'sell', price: 71000.5, qty: 0.42, pnl: 420.16, reason: '出场信号' },
    ],
    stats: { total_return: ret, annual: ret * 10, max_dd: 0.05, sharpe: 1.39, win_rate: 0.5, trades: 1, profit_factor: 1.3, bench_return: 0.01 },
    note: '',
  }
}

function backtest(id: string, over: Partial<TradeBacktest> = {}): TradeBacktest {
  const st = strategy()
  return {
    id, name: `${st.name} #1`, status: 'done', progress: 1, strategy_snapshot: st,
    config: { strategy_id: st.id, symbols: st.symbols, interval: '1h', bars: 1000, capital: 100000, fee_bp: 5, slippage_ticks: 1, params: { fast: 12, slow: 48 } },
    result: result(0.0312), created_at: new Date(T0 + 1000).toISOString(), finished_at: new Date(T0 + 2000).toISOString(),
    data_from: new Date(T0).toISOString(), data_to: new Date(T0 + 49 * 3_600_000).toISOString(), ...over,
  }
}

function fakeBackend(init: { strategies?: TradeStrategy[]; backtests?: TradeBacktest[]; failPatch?: boolean } = {}) {
  const state = {
    strategies: init.strategies ?? [strategy()],
    backtests: init.backtests ?? [] as TradeBacktest[],
    calls: [] as { method: string; path: string; body?: unknown }[],
    failPatch: init.failPatch ?? false,
    polls: {} as Record<string, number>,
  }
  let n = 0
  const json = (data: unknown, status = 200, meta?: unknown) => new Response(JSON.stringify(status < 300 ? { data, meta } : data), { status })
  const err = (code: string, message: string, status: number) => json({ error: { code, message } }, status)
  const brief = (b: TradeBacktest) => {
    const { result: r, sweep: _s, ...rest } = b
    return { ...rest, stats: r?.stats, note: r?.note }
  }
  // 每查一次推进一步：queued → running → done
  const advance = (b: TradeBacktest) => {
    const k = (state.polls[b.id] = (state.polls[b.id] ?? 0) + 1)
    if (b.status === 'queued' && k >= 2) Object.assign(b, { status: 'running', progress: 0.4 })
    else if (b.status === 'running' && k >= 3) Object.assign(b, { status: 'done', progress: 1, result: result(0.05), finished_at: new Date().toISOString() })
  }
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input), 'http://x')
    const p = decodeURIComponent(u.pathname)
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    state.calls.push({ method, path: p + u.search, body })
    if (p === '/api/trade/strategies' && method === 'GET') return json(state.strategies, 200, { total: state.strategies.length })
    if (p === '/api/trade/strategies' && method === 'POST') {
      const st = strategy({ id: `st_new${++n}`, name: '新策略', desc: '', symbols: [], entry: { logic: 'all', rules: [] }, exit: { logic: 'any', rules: [] }, params: {}, tags: [], updated_at: new Date().toISOString() })
      state.strategies.unshift(st)
      return json(st, 201)
    }
    const sm = p.match(/^\/api\/trade\/strategies\/(.+)$/)
    if (sm) {
      const st = state.strategies.find((x) => x.id === sm[1])
      if (!st) return err('not_found', '策略不存在', 404)
      if (method === 'PATCH') {
        if (state.failPatch) return err('internal', '磁盘满了', 500)
        Object.assign(st, body, { updated_at: new Date().toISOString() })
        return json(st)
      }
      if (method === 'DELETE') {
        state.strategies = state.strategies.filter((x) => x !== st)
        return json(null)
      }
      return json(st)
    }
    if (p === '/api/trade/backtests' && method === 'GET') {
      state.backtests.forEach(advance)
      return json(state.backtests.map(brief), 200, { total: state.backtests.length })
    }
    if (p === '/api/trade/backtests' && method === 'POST') {
      const st = state.strategies.find((x) => x.id === body.strategy_id)!
      const b = backtest(`bk_new${++n}`, {
        name: `${st.name} #${state.backtests.filter((x) => x.config.strategy_id === st.id).length + 1}`, status: 'queued', progress: 0, result: undefined,
        finished_at: undefined, data_from: undefined, data_to: undefined, strategy_snapshot: { ...st }, created_at: new Date().toISOString(),
        config: { strategy_id: st.id, symbols: st.symbols, interval: st.interval, bars: body.bars, capital: body.capital, fee_bp: body.fee_bp, slippage_ticks: body.slippage_ticks, params: body.params },
      })
      state.backtests.unshift(b)
      return json(b, 201)
    }
    if (p === '/api/trade/backtests/compare') {
      const ids = (u.searchParams.get('ids') ?? '').split(',')
      return json(ids.map((id) => state.backtests.find((b) => b.id === id)), 200, { total: ids.length })
    }
    const bm = p.match(/^\/api\/trade\/backtests\/([^/]+)(\/rerun|\/sweep)?$/)
    if (bm) {
      const b = state.backtests.find((x) => x.id === bm[1])
      if (!b) return err('not_found', '回测不存在', 404)
      if (bm[2] === '/sweep') {
        const sw = { param: body.param, at: new Date().toISOString(), points: body.values.map((v: number) => ({ value: v, total_return: v / 1000, max_dd: 0.05, sharpe: v / 10 })) }
        b.sweep = sw
        return json(sw)
      }
      if (bm[2] === '/rerun') {
        const nb = backtest(`bk_new${++n}`, {
          name: `${b.strategy_snapshot.name} #${state.backtests.length + 1}`, status: 'queued', progress: 0, result: undefined, created_at: new Date().toISOString(),
          config: { ...b.config, params: { ...b.config.params, ...(body?.params ?? {}) } },
        })
        state.backtests.unshift(nb)
        return json(nb, 201)
      }
      if (method === 'DELETE') {
        state.backtests = state.backtests.filter((x) => x !== b)
        return json(null)
      }
      advance(b)
      return json(b)
    }
    if (p === '/api/trade/instruments') {
      return json([{ symbol: 'BINANCE:ETHUSDT', name: 'ETH/USDT', market: 'crypto', kind: 'spot', venue: 'Binance', digits: 2, lot: 0.0001, multiplier: 1, source: 'binance', updated_at: '' }], 200, { total: 1 })
    }
    return err('not_found', p, 404)
  }))
  return state
}

function setup(path = '/strategy', init?: Parameters<typeof fakeBackend>[0]) {
  const backend = fakeBackend(init)
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createMemoryRouter([{ path: '/strategy/*', element: <StrategyPage /> }], { initialEntries: [path] })
  render(<QueryClientProvider client={qc}><RouterProvider router={router} /></QueryClientProvider>)
  return { backend, router }
}

afterEach(() => vi.unstubAllGlobals())

describe('策略页', () => {
  it('策略库：列出策略、按模式筛、搜索；新建后进编辑页', async () => {
    const { backend, router } = setup('/strategy', { backtests: [backtest('bk_1')] })
    const table = await screen.findByRole('table', { name: '策略库' })
    expect(within(table).getByText('双均线趋势')).toBeInTheDocument()
    // 最近回测列：总收益和回撤、夏普
    expect(within(table).getByText('+3.12%')).toBeInTheDocument()
    expect(within(table).getByText('回撤 5.00% · 夏普 1.39')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /代码/ }))
    expect(screen.getByText('没有匹配的策略')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /全部/ }))
    await userEvent.type(screen.getByLabelText('搜策略'), 'BTC')
    expect(within(screen.getByRole('table', { name: '策略库' })).getByText('双均线趋势')).toBeInTheDocument()

    await userEvent.click(screen.getAllByRole('button', { name: /新建策略/ })[0])
    await waitFor(() => expect(router.state.location.pathname).toBe('/strategy/s/st_new1'))
    expect(backend.calls.some((c) => c.method === 'POST' && c.path === '/api/trade/strategies')).toBe(true)
    // 新建的空策略：开始回测不可点，写明原因
    expect(await screen.findByText('先选至少一个标的')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: '开始回测' }).every((b) => (b as HTMLButtonElement).disabled)).toBe(true)
  })

  it('编辑页：改动自动保存；发起回测后最近一次回测从排队走到完成', async () => {
    const { backend } = setup('/strategy/s/st_1')
    const name = await screen.findByDisplayValue('双均线趋势')
    await userEvent.clear(name)
    await userEvent.type(name, '均线 v2')
    await waitFor(() => expect(backend.calls.some((c) => c.method === 'PATCH' && (c.body as TradeStrategy).name === '均线 v2')).toBe(true), { timeout: 3000 })
    // 名称清空时不传 name，其余照存，并提示必填
    await userEvent.clear(name)
    name.blur()
    expect(await screen.findByText('名称不能为空，其余改动照常保存')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: '1000' }))
    await userEvent.click(within(screen.getByRole('region', { name: '快速回测' })).getByRole('button', { name: '开始回测' }))
    await waitFor(() => expect(backend.calls.find((c) => c.method === 'POST' && c.path === '/api/trade/backtests')).toBeTruthy())
    const post = backend.calls.find((c) => c.method === 'POST' && c.path === '/api/trade/backtests')!
    expect(post.body).toEqual({ strategy_id: 'st_1', bars: 1000, capital: 100000, fee_bp: 5, slippage_ticks: 1, params: { fast: 12, slow: 48 } })
    // 发起前先把没存的存掉：最后一次 PATCH 不带 name
    const lastPatch = backend.calls.filter((c) => c.method === 'PATCH').at(-1)!
    expect((lastPatch.body as TradeStrategy).name).toBeUndefined()
    const last = screen.getByRole('region', { name: '最近一次回测' })
    await waitFor(() => expect(within(last).getByText('+5.00%')).toBeInTheDocument(), { timeout: 6000 })
    expect(within(last).getByText('1 笔')).toBeInTheDocument()
  }, 15_000)

  it('自动保存失败时显示原因和重试', async () => {
    setup('/strategy/s/st_1', { failPatch: true })
    await userEvent.type(await screen.findByLabelText('说明'), '！')
    expect(await screen.findByText(/保存失败，磁盘满了/, {}, { timeout: 3000 })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument()
  })

  it('回测记录：勾两条已完成的对比', async () => {
    const b2 = backtest('bk_2', { name: '双均线趋势 #2', result: result(-0.02), created_at: new Date(T0 + 5000).toISOString() })
    const { backend } = setup('/strategy/backtests', { backtests: [backtest('bk_1'), b2, backtest('bk_3', { name: '双均线趋势 #3', status: 'failed', result: undefined, error: '数据缺失：缺一段' })] })
    const table = await screen.findByRole('table', { name: '回测记录' })
    expect(within(table).getByLabelText('勾选 双均线趋势 #3 做对比')).toBeDisabled()
    await userEvent.click(within(table).getByLabelText('勾选 双均线趋势 #1 做对比'))
    expect(screen.getByText('再勾一条就能对比')).toBeInTheDocument()
    await userEvent.click(within(table).getByLabelText('勾选 双均线趋势 #2 做对比'))
    await userEvent.click(screen.getByRole('button', { name: '对比 2 条' }))
    const cmp = await screen.findByRole('region', { name: '对比' })
    await waitFor(() => expect(within(cmp).getByText('总收益')).toBeInTheDocument())
    expect(backend.calls.some((c) => c.path.startsWith('/api/trade/backtests/compare?ids=bk_2%2Cbk_1') || c.path.startsWith('/api/trade/backtests/compare?ids=bk_1%2Cbk_2'))).toBe(true)
    // 按状态筛
    await userEvent.click(screen.getByRole('button', { name: /失败/ }))
    expect(within(screen.getByRole('table', { name: '回测记录' })).getAllByRole('row')).toHaveLength(2)
  })

  it('回测报告：统计、扫参（后端跑，结果留着）、按扫描值回测', async () => {
    const { backend, router } = setup('/strategy/backtests/bk_1', { backtests: [backtest('bk_1')] })
    expect(await screen.findByRole('heading', { name: '双均线趋势 #1' })).toBeInTheDocument()
    expect(screen.getByText('总收益')).toBeInTheDocument()
    expect(screen.getAllByText('+3.12%').length).toBeGreaterThan(0)
    expect(screen.getByText('2 笔成交，1 笔平仓')).toBeInTheDocument()
    const sweep = screen.getByRole('region', { name: '参数扫描' })
    await userEvent.click(within(sweep).getByRole('button', { name: '开始扫描' }))
    await waitFor(() => expect(within(sweep).getByRole('table', { name: '扫描结果' })).toBeInTheDocument())
    const call = backend.calls.find((c) => c.path === '/api/trade/backtests/bk_1/sweep')!
    expect(call.body).toEqual({ param: 'fast', values: [6, 9, 12, 15, 18, 24] })
    expect(within(sweep).getByText('按夏普最高的是 fast = 24')).toBeInTheDocument()
    const rows = within(sweep).getAllByRole('row')
    await userEvent.click(within(rows[2]).getByRole('button', { name: '回测' }))
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/strategy\/backtests\/bk_new/))
    expect(backend.calls.find((c) => c.path === '/api/trade/backtests/bk_1/rerun')!.body).toEqual({ params: { fast: 9 } })
    expect(await screen.findByText('回测进行中', {}, { timeout: 4000 })).toBeInTheDocument()
  })

  it('回测报告：失败写原因，不在了给出返回', async () => {
    setup('/strategy/backtests/bk_3', { backtests: [backtest('bk_3', { status: 'failed', result: undefined, error: '数据缺失：BINANCE:BTCUSDT 1h 只取到 300 根' })] })
    expect(await screen.findByText('数据缺失：BINANCE:BTCUSDT 1h 只取到 300 根')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: '重新回测' }).length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: '部署' })).toBeDisabled()
  })

  it('删除策略（回测记录保留）、删除一条回测记录', async () => {
    const { backend, router } = setup('/strategy/s/st_1', { backtests: [backtest('bk_1')] })
    await userEvent.click(await screen.findByRole('button', { name: '删除策略' }))
    expect(screen.getByText('删除后不能恢复，已有的回测记录保留')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '删除' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/strategy'))
    expect(backend.calls.some((c) => c.method === 'DELETE' && c.path === '/api/trade/strategies/st_1')).toBe(true)
    expect(await screen.findByText('还没有策略')).toBeInTheDocument()

    await router.navigate('/strategy/backtests/bk_1')
    await userEvent.click(await screen.findByRole('button', { name: '删除这条回测记录' }))
    await userEvent.click(screen.getByRole('button', { name: '删除' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/strategy/backtests'))
    expect(await screen.findByText('还没有回测')).toBeInTheDocument()
  })

  it('打开不存在的回测', async () => {
    setup('/strategy/backtests/bk_nope')
    expect(await screen.findByText('这条回测记录不在了')).toBeInTheDocument()
  })

  it('打开已删除的策略', async () => {
    setup('/strategy/s/st_gone')
    expect(await screen.findByText('这个策略已经删除')).toBeInTheDocument()
  })
})
