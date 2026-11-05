import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TradeAccount, TradeHalt, TradeOrder, TradePosition, TradeRisk, TradeRun, TradeStrategy } from '../../core/data'
import TradingPage from './TradingPage'

// 假后端：账户、委托、持仓、部署、风控都在内存里。撮合、风控、二次确认按脚本回（真规则在后端测）
const NOW = new Date().toISOString()

function account(over: Partial<TradeAccount> = {}): TradeAccount {
  return {
    id: 'ac_1', name: '模拟盘', broker: '模拟', kind: 'exchange', markets: ['crypto'], paper: true, currency: 'USD', equity: 100120.5, available: 90000,
    margin_used: 10000, status: 'connected', api_hint: '本地模拟撮合', permissions: ['read', 'trade'], updated_at: NOW, initial: 100000, balance: 100000,
    realized_pnl: 0, unrealized_pnl: 120.5, fees: 0, order_hold: 0, fee_bp: 5, slippage_ticks: 1, marks_status: 'live', created_at: NOW, ...over,
  }
}
function order(id: string, over: Partial<TradeOrder> = {}): TradeOrder {
  return {
    id, account_id: 'ac_1', symbol: 'BINANCE:BTCUSDT', side: 'buy', type: 'limit', qty: 0.1, price: 60000, filled: 0, status: 'open', reduce_only: false,
    created_at: NOW, updated_at: NOW, leverage: 1, fee: 0, source: 'manual', triggered: false, confirmed: false, live: false, ...over,
  }
}
function position(over: Partial<TradePosition> = {}): TradePosition {
  return {
    id: 'ps_1', account_id: 'ac_1', symbol: 'BINANCE:BTCUSDT', name: 'BTC/USDT', side: 'long', qty: 0.2, avg_price: 70000, opened_at: NOW, cost: 14000,
    margin: 14000, last: 70602.5, value: 14120.5, pnl: 120.5, pct: 0.0086, mark_status: 'live', mark_at: NOW, ...over,
  }
}
function runOf(over: Partial<TradeRun> = {}): TradeRun {
  return {
    id: 'rn_1', strategy_id: 'st_1', account_id: 'ac_1', symbols: ['BINANCE:BTCUSDT'], params: { fast: 12 }, capital: 20000, status: 'running', pnl: 35.2,
    started_at: NOW, logs: [{ at: NOW, level: 'info', text: '模拟盘启动：BTC/USDT，分配 20,000 USD；1 时 K 线收盘时算信号' }], log_total: 1,
    strategy_name: '双均线趋势', interval: '1h', realized_pnl: 0, unrealized_pnl: 35.2, fees: 0, holdings: [], updated_at: NOW, ...over,
  }
}
const strategy: TradeStrategy = {
  id: 'st_1', name: '双均线趋势', desc: '', mode: 'rules', symbols: ['BINANCE:BTCUSDT'], interval: '1h', direction: 'long',
  entry: { logic: 'all', rules: [] }, exit: { logic: 'any', rules: [] }, stop_loss: 5, take_profit: 0, position_pct: 30, code: '', params: { fast: 12 },
  tags: [], updated_at: NOW, created_at: NOW,
}
function riskOf(over: Partial<TradeRisk> = {}): TradeRisk {
  return {
    max_position_pct: 35, daily_loss_pct: 3, max_order_value: 50000, max_leverage: 10, confirm_above: 10000, halted: false, updated_at: NOW,
    day: { date: NOW.slice(0, 10), start_equity: 100000, equity: 99500, pnl: -500, loss_used: 500, loss_limit: 3000, status: 'ok' }, ...over,
  }
}

type Init = { accounts?: TradeAccount[]; orders?: TradeOrder[]; positions?: TradePosition[]; runs?: TradeRun[]; risk?: TradeRisk; halts?: TradeHalt[] }

function fakeBackend(init: Init = {}) {
  const state = {
    accounts: init.accounts ?? [account()],
    orders: init.orders ?? [] as TradeOrder[],
    positions: init.positions ?? [] as TradePosition[],
    runs: init.runs ?? [] as TradeRun[],
    risk: init.risk ?? riskOf(),
    halts: init.halts ?? [] as TradeHalt[],
    calls: [] as { method: string; path: string; body?: Record<string, unknown> }[],
  }
  let n = 0
  const json = (data: unknown, status = 200, meta?: unknown) => new Response(JSON.stringify(status < 300 ? { data, meta } : data), { status })
  const err = (status: number, error: Record<string, unknown>) => json({ error }, status)
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, req?: RequestInit) => {
    const u = new URL(String(input), 'http://x')
    const p = decodeURIComponent(u.pathname)
    const method = req?.method ?? 'GET'
    const body = req?.body ? JSON.parse(String(req.body)) as Record<string, unknown> : undefined
    state.calls.push({ method, path: p + u.search, body })
    const active = () => state.orders.filter((o) => o.status === 'open')
    if (p === '/api/trade/accounts' && method === 'GET') return json(state.accounts, 200, { total: state.accounts.length })
    if (p === '/api/trade/accounts' && method === 'POST') {
      const a = account({ id: `ac_new${++n}`, unrealized_pnl: 0, equity: 100000, available: 100000, margin_used: 0 })
      state.accounts.push(a)
      return json(a, 201)
    }
    if (p === '/api/trade/orders' && method === 'GET') {
      const st = u.searchParams.get('status')
      const rows = state.orders.filter((o) => !st || (st === 'active' ? o.status === 'open' : o.status !== 'open'))
      const limit = Number(u.searchParams.get('limit') ?? 200)
      return json(rows.slice(0, limit), 200, { total: rows.length, active: active().length, history: state.orders.length - active().length })
    }
    if (p === '/api/trade/orders' && method === 'POST') {
      const value = Number(body!.qty) * 70000
      if (value > state.risk.confirm_above && !body!.confirmed) {
        return err(409, { code: 'conflict', reason: 'confirm', message: '金额超过二次确认线', value, confirm_above: state.risk.confirm_above })
      }
      if (value > state.risk.max_order_value) {
        const blocks = [`单笔金额 $${value.toLocaleString('en-US')} 超过上限 $50,000`, '下单后 BTC/USDT 占该账户权益 98.0%，超过单标的上限 35%']
        const o = order(`od_rej${++n}`, { ...body, status: 'rejected', reject_reason: blocks.join('；') } as Partial<TradeOrder>)
        state.orders.unshift(o)
        return err(409, { code: 'conflict', reason: 'risk', message: '风控未通过：' + blocks.join('；'), blocks, order: o })
      }
      const o = order(`od_${++n}`, { ...body, status: 'open' } as Partial<TradeOrder>)
      state.orders.unshift(o)
      return json(o, 201)
    }
    if (p === '/api/trade/orders/cancel-all') {
      const k = active().length
      active().forEach((o) => Object.assign(o, { status: 'canceled', reject_reason: '手动撤单' }))
      return json({ canceled: k })
    }
    const om = p.match(/^\/api\/trade\/orders\/([^/]+)(\/cancel)?$/)
    if (om) {
      const o = state.orders.find((x) => x.id === om[1])!
      if (om[2]) Object.assign(o, { status: 'canceled', reject_reason: '手动撤单' })
      else Object.assign(o, body)
      return json(o)
    }
    if (p === '/api/trade/positions') return json(state.positions, 200, { total: state.positions.length })
    const pm = p.match(/^\/api\/trade\/positions\/([^/]+)\/close$/)
    if (pm) {
      const ps = state.positions.find((x) => x.id === pm[1])!
      if (!body?.confirmed) return err(409, { code: 'conflict', reason: 'confirm', message: '金额超过二次确认线', value: 14120.5, confirm_above: 10000 })
      const o = order(`od_cl${++n}`, { side: 'sell', type: 'market', qty: ps.qty, price: undefined, source: 'close', confirmed: true })
      state.orders.unshift(o)
      return json(o, 201)
    }
    if (p === '/api/trade/fills') return json([], 200, { total: 0 })
    if (p === '/api/trade/runs' && method === 'GET') {
      const rs = state.runs
      return json(rs, 200, { total: rs.length, running: rs.filter((r) => r.status === 'running').length, paused: 0, stopped: 0, error: 0, pnl: 0 })
    }
    if (p === '/api/trade/runs' && method === 'POST') {
      if (state.risk.halted) return err(409, { code: 'conflict', reason: 'halted', message: '熔断中，不能启动新运行；先到风控解除熔断' })
      const r = runOf({ id: `rn_new${++n}`, capital: Number(body!.capital), params: body!.params as Record<string, number> })
      state.runs.unshift(r)
      return json(r, 201)
    }
    const rm = p.match(/^\/api\/trade\/runs\/([^/]+)(?:\/(pause|resume|stop))?$/)
    if (rm) {
      const r = state.runs.find((x) => x.id === rm[1])!
      if (rm[2] === 'pause') r.status = 'paused'
      if (rm[2] === 'resume') {
        if (state.risk.halted) return err(409, { code: 'conflict', reason: 'halted', message: '熔断中，不能启动新运行；先到风控解除熔断' })
        r.status = 'running'
      }
      if (rm[2] === 'stop') Object.assign(r, { status: 'stopped', stop_reason: '手动停止', stopped_at: NOW })
      return json(r)
    }
    if (p === '/api/trade/risk' && method === 'GET') return json(state.risk)
    if (p === '/api/trade/risk' && method === 'PATCH') {
      Object.assign(state.risk, body)
      return json(state.risk)
    }
    if (p === '/api/trade/risk/kill') {
      const runs = state.runs.filter((r) => r.status !== 'stopped')
      runs.forEach((r) => Object.assign(r, { status: 'stopped', stop_reason: '一键全停：' + (body?.reason ?? '手动一键全停') }))
      const k = active().length
      active().forEach((o) => Object.assign(o, { status: 'canceled' }))
      const reason = String(body?.reason ?? '手动一键全停')
      Object.assign(state.risk, { halted: true, halted_reason: reason, halted_at: NOW, halt_id: 'hl_1' })
      state.halts.unshift({ id: 'hl_1', kind: 'manual', reason, at: NOW, runs_stopped: runs.length, orders_canceled: k })
      return json({ halted: true, reason, at: NOW, halt_id: 'hl_1', kind: 'manual', runs_stopped: runs.length, orders_canceled: k, remaining_runs: [], remaining_orders: [], failed: [] })
    }
    if (p === '/api/trade/risk/release') {
      if (!body?.reason) return err(400, { code: 'validation', message: '解除原因不能为空' })
      Object.assign(state.risk, { halted: false, halted_reason: undefined, halted_at: undefined })
      Object.assign(state.halts[0], { released_at: NOW, release_reason: body.reason })
      return json(state.risk)
    }
    if (p === '/api/trade/risk/halts') return json(state.halts, 200, { total: state.halts.length })
    if (p === '/api/trade/strategies') return json([strategy], 200, { total: 1 })
    if (p === '/api/trade/quotes') {
      return json([{ symbol: 'BINANCE:BTCUSDT', source: 'binance', status: 'live', error: '', last: 70000, bid: 69999, ask: 70001, open_24h: 0, high_24h: 0, low_24h: 0, volume_24h: 0, change: 0, change_pct: 0, at: NOW, fetched_at: NOW }], 200, { total: 1 })
    }
    if (p === '/api/trade/book' || p === '/api/trade/funding') return err(404, { code: 'not_found', message: 'x' })
    if (p.startsWith('/api/trade/instruments/')) {
      return json({ symbol: 'BINANCE:BTCUSDT', name: 'BTC/USDT', market: 'crypto', kind: 'spot', venue: 'Binance', digits: 2, lot: 0.00001, multiplier: 1, source: 'binance', updated_at: NOW })
    }
    if (p === '/api/trade/watchlists') return json([], 200, { total: 0 })
    return err(404, { code: 'not_found', message: p })
  }))
  return state
}

function setup(path: string, init?: Init) {
  const backend = fakeBackend(init)
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createMemoryRouter([
    { path: '/trading/*', element: <TradingPage /> },
    { path: '/strategy/*', element: <div>策略页</div> },
    { path: '/markets', element: <div>行情页</div> },
  ], { initialEntries: [path] })
  render(<QueryClientProvider client={qc}><RouterProvider router={router} /></QueryClientProvider>)
  return { backend, router }
}

afterEach(() => vi.unstubAllGlobals())

describe('交易页', () => {
  it('没有模拟盘账户时就地建一个；总览标明模拟盘、显示权益和风控', async () => {
    const { backend } = setup('/trading', { accounts: [] })
    await userEvent.click(await screen.findByRole('button', { name: '建一个模拟盘账户' }))
    expect(backend.calls.some((c) => c.method === 'POST' && c.path === '/api/trade/accounts')).toBe(true)
    expect(await screen.findByText('总权益（USD）')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '交易总览' })).toBeInTheDocument()
    expect(screen.getAllByText('模拟盘').length).toBeGreaterThan(0)
    expect(screen.getByText('$500 / $3,000')).toBeInTheDocument()
  })

  it('下单：二次确认用后端给的金额，确认后带 confirmed 重提；风控拦截原样逐条显示', async () => {
    const { backend } = setup('/trading/orders?symbol=BINANCE%3ABTCUSDT&side=buy')
    const drawer = await screen.findByRole('dialog', { name: '下单' })
    await userEvent.click(within(drawer).getByRole('button', { name: '市价' }))
    await userEvent.type(within(drawer).getByLabelText('数量'), '1')
    await waitFor(() => expect(within(drawer).getByText(/市价，约 70,000.00/)).toBeInTheDocument())
    // 预检查只提示，不拦提交
    expect(within(drawer).getByText('预检查')).toBeInTheDocument()
    await userEvent.click(within(drawer).getByRole('button', { name: '买入 1' }))
    expect(await screen.findByText('$70,000')).toBeInTheDocument()
    expect(screen.getByText(/超过 \$10,000 二次确认线/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '确认买入' }))
    const block = await within(drawer).findByRole('alert')
    expect(within(block).getByText('风控未通过')).toBeInTheDocument()
    expect(within(block).getByText('单笔金额 $70,000 超过上限 $50,000')).toBeInTheDocument()
    expect(within(block).getByText('下单后 BTC/USDT 占该账户权益 98.0%，超过单标的上限 35%')).toBeInTheDocument()
    const posts = backend.calls.filter((c) => c.method === 'POST' && c.path === '/api/trade/orders')
    expect(posts.map((c) => c.body?.confirmed)).toEqual([undefined, true])
    expect(posts[0].body).toMatchObject({ account_id: 'ac_1', symbol: 'BINANCE:BTCUSDT', side: 'buy', type: 'market', qty: 1 })

    // 改小数量重新下：通过，抽屉关掉，页面顶上写结果
    await userEvent.clear(within(drawer).getByLabelText('数量'))
    await userEvent.type(within(drawer).getByLabelText('数量'), '0.1')
    await userEvent.click(within(drawer).getByRole('button', { name: '买入 0.1' }))
    expect(await screen.findByText(/已下单：买入 0.1 BTC\/USDT，挂单中/)).toBeInTheDocument()
    expect(screen.queryByRole('dialog', { name: '下单' })).not.toBeInTheDocument()
  })

  it('委托：当前、历史，改价、撤单', async () => {
    const { backend } = setup('/trading/orders', { orders: [order('od_1'), order('od_2', { side: 'sell', price: 80000 }), order('od_3', { status: 'rejected', reject_reason: '可用资金不足：需要 7000，可用 10' })] })
    const table = await screen.findByRole('table', { name: '当前委托' })
    expect(within(table).getAllByRole('row')).toHaveLength(3)
    await userEvent.click(within(table).getAllByRole('button', { name: '改价' })[0])
    const input = screen.getByLabelText('新价格')
    await userEvent.clear(input)
    await userEvent.type(input, '61000{Enter}')
    await waitFor(() => expect(backend.calls.some((c) => c.method === 'PATCH' && c.path === '/api/trade/orders/od_1' && c.body?.price === 61000)).toBe(true))
    await userEvent.click(within(table).getAllByRole('button', { name: '撤单' })[1])
    await waitFor(() => expect(backend.calls.some((c) => c.path === '/api/trade/orders/od_2/cancel')).toBe(true))
    await userEvent.click(screen.getByRole('button', { name: /历史委托/ }))
    expect(await screen.findByText('可用资金不足：需要 7000，可用 10')).toBeInTheDocument()
  })

  it('持仓：现价盈亏来自后端；平仓超过确认线时就地确认', async () => {
    const { backend, router } = setup('/trading/positions', { positions: [position()] })
    const table = await screen.findByRole('table', { name: '持仓' })
    expect(await within(table).findByText('70,602.50')).toBeInTheDocument()
    expect(within(table).getByText('+120.50')).toBeInTheDocument()
    await userEvent.click(within(table).getByRole('button', { name: '平仓' }))
    await userEvent.click(within(table).getByRole('button', { name: '市价全平' }))
    expect(await within(table).findByText(/超过 \$10,000 二次确认线/)).toBeInTheDocument()
    await userEvent.click(within(table).getByRole('button', { name: '确认平仓' }))
    expect(await screen.findByText(/已下平仓单：卖出 0.2 BTC\/USDT/)).toBeInTheDocument()
    expect(backend.calls.filter((c) => c.path === '/api/trade/positions/ps_1/close').map((c) => c.body?.confirmed)).toEqual([undefined, true])
    await userEvent.click(within(table).getByRole('button', { name: '看图' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/markets'))
  })

  it('策略运行：从策略「部署」打开抽屉，策略选好；暂停、停止要确认', async () => {
    const { backend } = setup('/trading/runs?deploy=st_1', { runs: [runOf()] })
    const drawer = await screen.findByRole('dialog', { name: '新建策略运行' })
    await waitFor(() => expect(within(drawer).getByText('双均线趋势')).toBeInTheDocument())
    await userEvent.clear(within(drawer).getByLabelText('分配资金'))
    await userEvent.type(within(drawer).getByLabelText('分配资金'), '15000')
    await userEvent.click(within(drawer).getByRole('button', { name: '启动运行' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '新建策略运行' })).not.toBeInTheDocument())
    expect(backend.calls.find((c) => c.method === 'POST' && c.path === '/api/trade/runs')!.body).toEqual({
      strategy_id: 'st_1', account_id: 'ac_1', symbols: ['BINANCE:BTCUSDT'], capital: 15000, params: { fast: 12 },
    })
    const card = (await screen.findAllByRole('region', { name: '部署 双均线趋势' }))[1]
    await userEvent.click(within(card).getByRole('button', { name: '暂停' }))
    await waitFor(() => expect(backend.calls.some((c) => c.path === '/api/trade/runs/rn_1/pause')).toBe(true))
    await userEvent.click(await within(card).findByRole('button', { name: '停止' }))
    expect(within(card).getByText('停止后撤掉这个部署的挂单，持仓保留、不自动平仓')).toBeInTheDocument()
    await userEvent.click(within(card).getByRole('button', { name: '确认停止' }))
    await waitFor(() => expect(backend.calls.some((c) => c.path === '/api/trade/runs/rn_1/stop')).toBe(true))
  })

  it('熔断中新建运行：后端拒绝的原因原样显示', async () => {
    setup('/trading/runs', { risk: riskOf({ halted: true, halted_reason: '手动一键全停', halted_at: NOW }) })
    expect((await screen.findAllByText('熔断中')).length).toBeGreaterThan(0)
    await userEvent.click(screen.getAllByRole('button', { name: '新建运行' })[0])
    const drawer = await screen.findByRole('dialog', { name: '新建策略运行' })
    expect(within(drawer).getByRole('button', { name: '启动运行' })).toBeDisabled()
    expect(within(drawer).getByText('不能启动新运行，先到风控解除熔断')).toBeInTheDocument()
  })

  it('风控：一键全停二次确认、显示结果；熔断条解除要写原因；改规则', async () => {
    const { backend } = setup('/trading/risk', { runs: [runOf()], orders: [order('od_1'), order('od_2')] })
    expect(await screen.findByRole('progressbar', { name: '当日亏损进度' })).toHaveAttribute('aria-valuenow', '17')
    const sec = screen.getByText('行情异常、策略失控时用').closest('section')!
    await userEvent.click(within(sec).getByRole('button', { name: '一键全停' }))
    await userEvent.click(within(sec).getByRole('button', { name: '确认全停' }))
    expect(await screen.findByText('一键全停完成：停掉 1 个部署，撤掉 2 笔挂单，持仓保留；已进入熔断')).toBeInTheDocument()
    expect(backend.calls.find((c) => c.path === '/api/trade/risk/kill')!.body).toEqual({ reason: '风控页手动一键全停' })

    // 熔断条和熔断记录
    expect(await screen.findByText(/所有策略已停止、挂单已撤/)).toBeInTheDocument()
    expect(await screen.findByText(/停掉 1 个部署、撤掉 2 笔挂单/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '解除熔断' }))
    const confirm = screen.getByRole('button', { name: '确认解除' })
    expect(confirm).toBeDisabled()
    await userEvent.type(screen.getByLabelText('解除原因'), '行情恢复')
    await userEvent.click(confirm)
    await waitFor(() => expect(backend.calls.find((c) => c.path === '/api/trade/risk/release')?.body).toEqual({ reason: '行情恢复' }))
    expect(await screen.findByText('解除原因：行情恢复')).toBeInTheDocument()

    const lev = screen.getByLabelText('合约最大杠杆')
    await userEvent.clear(lev)
    await userEvent.type(lev, '5{Enter}')
    await waitFor(() => expect(backend.calls.some((c) => c.method === 'PATCH' && c.path === '/api/trade/risk' && c.body?.max_leverage === 5)).toBe(true))
  })

  it('二级菜单的一键全停：确认后执行', async () => {
    const { backend } = setup('/trading')
    const nav = await screen.findByRole('navigation', { name: '交易' })
    await userEvent.click(within(nav).getByRole('button', { name: '一键全停' }))
    await userEvent.click(within(nav).getByRole('button', { name: '确认全停' }))
    await waitFor(() => expect(backend.calls.some((c) => c.path === '/api/trade/risk/kill')).toBe(true))
    expect(backend.calls.find((c) => c.path === '/api/trade/risk/kill')!.body).toEqual({})
  })
})
