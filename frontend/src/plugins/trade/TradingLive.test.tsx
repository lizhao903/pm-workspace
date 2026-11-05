import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TradeAccount, TradeLiveCheck, TradeLiveGate, TradeRecon } from '../../core/data'
import TradingPage from './TradingPage'

// 交易账户（TRD-07b）和交易设置（TRD-08c）。假后端按契约回；评审、开关、trade:live 的真规则在后端测（livegate_test.go）。
const NOW = new Date().toISOString()

function paper(over: Partial<TradeAccount> = {}): TradeAccount {
  return {
    id: 'ac_p', name: '模拟盘', broker: '模拟', kind: 'exchange', markets: ['crypto'], paper: true, currency: 'USD', equity: 100000, available: 100000,
    margin_used: 0, status: 'connected', api_hint: '本地模拟撮合', permissions: ['read', 'trade'], updated_at: NOW, initial: 100000, balance: 100000,
    realized_pnl: 0, unrealized_pnl: 0, fees: 0, order_hold: 0, fee_bp: 5, slippage_ticks: 1, marks_status: 'live', created_at: NOW, ...over,
  }
}
function live(over: Partial<TradeAccount> = {}): TradeAccount {
  return paper({
    id: 'ac_bn', name: 'Binance 主账户', broker: 'Binance', paper: false, currency: 'USDT', equity: 1500.5, available: 1300.5, margin_used: 200,
    api_hint: '****WXYZ', permissions: ['read', 'trade'], fee_bp: 0, slippage_ticks: 0, connector_id: 'cn_1', key_permissions: ['read', 'trade'], want_trade: true,
    synced_at: NOW, recon: { status: 'diff', at: NOW, open: 1 }, ...over,
  })
}
const recon: TradeRecon = {
  account_id: 'ac_bn', at: NOW, status: 'diff', checked: 3, open: 1, max_pct: 0.1, threshold: 5, id: 'rcn_1',
  items: [{ id: 'rc_1', kind: 'position', label: 'ETH/USDT 持仓', local: '6.2', remote: '6.1938', key: 'spot:ETH', local_qty: 6.2, remote_qty: 6.1938, pct: 0.1, seen: 2, confirmed: true, created_at: NOW, updated_at: NOW }],
}
function check(key: TradeLiveCheck['key'], label: string, ok: boolean, over: Partial<TradeLiveCheck> = {}): TradeLiveCheck {
  return { key, label, desc: label + '的说明', ok, text: ok ? `${label}满足` : `${label}不满足`, go: ok ? undefined : 'risk', evidence: [{ label: `${label}证据`, href: `/api/trade/audit?action=${key}` }], ...over }
}
function gate(over: Partial<TradeLiveGate> = {}): TradeLiveGate {
  return {
    checks: [check('audit', '审计日志', true), check('recon', '对账', false, { go: 'accounts' }), check('incident', '异常演练', true), check('drill', '全停演练', false), check('paper', '模拟盘两周记录', false, { go: 'runs' })],
    review: { status: 'pending', missing: ['审计日志', '对账', '异常演练', '全停演练', '模拟盘两周记录'] }, granted: false, enabled: false, can_enable: false,
    blockers: ['评审还差 5 项没确认：审计日志、对账、异常演练、全停演练、模拟盘两周记录', '还没授予 trade:live 权限（在交易设置里申请，二次确认输入插件名）'],
    live_orders: false, note: '实盘下单还没上线（TRD-08d）', plugin_name: '交易套件', records: [], ...over,
  }
}

function fakeBackend(init: { accounts?: TradeAccount[]; gate?: TradeLiveGate } = {}) {
  const state = { accounts: init.accounts ?? [paper(), live()], gate: init.gate ?? gate(), recon: structuredClone(recon), calls: [] as { method: string; path: string; body?: Record<string, unknown> }[] }
  const json = (data: unknown, status = 200, meta?: unknown) => new Response(JSON.stringify(status < 300 ? { data, meta } : data), { status })
  const err = (status: number, error: Record<string, unknown>) => json({ error }, status)
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, req?: RequestInit) => {
    const u = new URL(String(input), 'http://x')
    const p = decodeURIComponent(u.pathname)
    const method = req?.method ?? 'GET'
    const body = req?.body ? JSON.parse(String(req.body)) as Record<string, unknown> : undefined
    state.calls.push({ method, path: p + u.search, body })
    if (p === '/api/trade/accounts' && method === 'GET') return json(state.accounts, 200, { total: state.accounts.length })
    if (p === '/api/trade/accounts' && method === 'POST') {
      const a = live({ id: 'ac_ok', name: String(body?.name ?? 'OKX 账户'), broker: 'OKX', connector_id: String(body?.connector_id), recon: { status: 'ok', at: NOW, open: 0 } })
      state.accounts.push(a)
      return json(a, 201)
    }
    if (p === '/api/trade/accounts/ac_bn/snapshot') {
      return json({ account_id: 'ac_bn', synced_at: NOW, baseline_at: NOW, status: 'connected', equity: 1500.5, available: 1300.5, margin_used: 200, marks_status: 'live', key_permissions: ['read', 'trade'], fail_count: 0,
        balances: [{ asset: 'USDT', free: 1000, locked: 0, total: 1000, value: 1000, wallet: 'spot' }],
        positions: [{ symbol: 'BINANCE:ETHUSDT', name: 'ETH/USDT', kind: 'spot', side: 'long', qty: 6.1938, avg_price: 0, last: 3000, pnl: 0, margin: 0, key: 'spot:ETH', account_id: 'ac_bn' }],
        orders: [] })
    }
    if (p === '/api/trade/accounts/ac_bn/fills') return json([], 200, { total: 0 })
    if (p === '/api/trade/accounts/ac_bn/recon' && method === 'GET') return json(state.recon)
    const rs = p.match(/^\/api\/trade\/accounts\/ac_bn\/recon\/items\/(\w+)\/resolve$/)
    if (rs) {
      Object.assign(state.recon.items[0], { resolved_at: NOW, method: body?.action, resolution: body?.action === 'adopt' ? '按交易所修正了本地记录' : `标为已核实，本地记录不改：${String(body?.note)}` })
      state.recon.open = 0
      return json(state.recon)
    }
    if (p === '/api/trade/live' && method === 'GET') return json(state.gate)
    if (p === '/api/trade/live/checks/audit/confirm') return err(403, { code: 'forbidden', reason: 'not_user', message: '实盘评审「审计日志」只能由用户本人在界面上操作，不接受 Agent、脚本或接口代为提交（这次的来源：me（api））' })
    if (p === '/api/trade/live/checks/incident/confirm') {
      state.gate.checks[2] = { ...state.gate.checks[2], confirmed_at: NOW, reviewer: 'me' }
      return json(state.gate)
    }
    if (p === '/api/plugins/trade/permissions/grant') return err(403, { code: 'forbidden', message: '插件 trade 现在不能授予 trade:live：实盘评审还差 5 项没确认' })
    if (p === '/api/plugins/trade/disable') return err(409, { code: 'conflict', message: '插件 trade 现在不能停用：还有 1 个部署在跑、2 笔挂单，先到交易里一键全停' })
    if (p === '/api/trade/audit') return json([{ id: 1, at: NOW, action: 'place', target_type: 'trade_order', target_id: 'od_1', summary: '下单：买入 0.1 BTC/USDT', origin: 'manual', actor: 'user', order_id: 'od_1', detail: {} }], 200, { total: 1 })
    if (p === '/api/connectors/defs') {
      return json([{ tool: 'okx_account', label: 'OKX 交易账户', category: 'market', color: '', desc: '', can_send: false, auth: ['token'], tools: [], source: 'trade',
        fields: [{ key: 'api_key', label: 'API Key', kind: 'secret', required: true }, { key: 'api_secret', label: 'Secret Key', kind: 'secret', required: true }, { key: 'passphrase', label: 'Passphrase', kind: 'secret', required: true }] }])
    }
    if (p === '/api/connectors' && method === 'POST') return json({ id: 'cn_new', tool: body?.tool, name: body?.name, status: 'connecting' }, 201)
    if (p === '/api/connectors/cn_new/test') return json({ ok: true, account: 'OKX ****m9Lk · 只读', message: '', connector: { id: 'cn_new', tool: 'okx_account', name: 'x', status: 'connected' } })
    if (p === '/api/connectors/cn_new' && method === 'DELETE') return json({ id: 'cn_new' })
    if (p === '/api/trade/risk') return json({ max_position_pct: 35, daily_loss_pct: 3, max_order_value: 50000, max_leverage: 10, confirm_above: 10000, halted: false, updated_at: NOW, day: { date: NOW.slice(0, 10), start_equity: 1, equity: 1, pnl: 0, loss_used: 0, loss_limit: 1, status: 'ok' } })
    if (p === '/api/trade/orders') return json([], 200, { total: 0, active: 0, history: 0 })
    if (p === '/api/trade/runs') return json([], 200, { total: 0, running: 0, paused: 0, stopped: 0, error: 0, pnl: 0 })
    if (p === '/api/trade/positions' || p === '/api/trade/strategies' || p === '/api/trade/risk/halts' || p === '/api/trade/watchlists') return json([], 200, { total: 0 })
    if (p === '/api/trade/quotes') return json([], 200, { total: 0 })
    if (p.startsWith('/api/trade/instruments/')) return json({ symbol: 'BINANCE:BTCUSDT', name: 'BTC/USDT', market: 'crypto', kind: 'spot', venue: 'Binance', digits: 2, lot: 0.00001, multiplier: 1, source: 'binance', updated_at: NOW })
    return err(404, { code: 'not_found', message: p })
  }))
  return state
}

function setup(path: string, init?: Parameters<typeof fakeBackend>[0]) {
  const backend = fakeBackend(init)
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createMemoryRouter([{ path: '/trading/*', element: <TradingPage /> }, { path: '/settings/*', element: <div>设置</div> }], { initialEntries: [path] })
  render(<QueryClientProvider client={qc}><RouterProvider router={router} /></QueryClientProvider>)
  return { backend, router }
}

afterEach(() => vi.unstubAllGlobals())

describe('交易账户', () => {
  it('模拟盘和实盘分开显示；实盘账户的下单入口不可用并说明要先过实盘评审；对账抽屉处理差异', async () => {
    const { backend } = setup('/trading/accounts')
    const card = await screen.findByRole('region', { name: 'Binance 主账户' })
    expect(within(card).getByText('实盘')).toBeInTheDocument()
    expect(within(card).getByText('****WXYZ')).toBeInTheDocument()
    const order = within(card).getByRole('button', { name: '下单' })
    expect(order).toBeDisabled()
    expect(order.getAttribute('title')).toContain('要先过实盘评审')
    expect(within(card).getByText(/要先过实盘评审（交易设置）/)).toBeInTheDocument()
    expect(within(screen.getByRole('region', { name: '模拟盘' })).getByText('本地撮合，不用对账')).toBeInTheDocument()

    await userEvent.click(within(card).getByRole('button', { name: /1 处差异/ }))
    const drawer = await screen.findByRole('dialog', { name: '对账' })
    expect(await within(drawer).findByText('ETH/USDT 持仓')).toBeInTheDocument()
    // 标为已核实要写备注
    await userEvent.click(within(drawer).getByRole('button', { name: '标为已核实' }))
    const ok = within(drawer).getAllByRole('button', { name: '标为已核实' }).at(-1)!
    expect(ok).toBeDisabled()
    await userEvent.type(within(drawer).getByLabelText('核实备注'), '交易所漏回报')
    await userEvent.click(ok)
    await waitFor(() => expect(backend.calls.find((c) => c.path.endsWith('/resolve'))?.body).toEqual({ action: 'verify', note: '交易所漏回报' }))
    expect(await within(drawer).findByText(/标为已核实，本地记录不改：交易所漏回报/)).toBeInTheDocument()
  })

  it('下单抽屉里实盘账户归到不可用，原因写要先过实盘评审', async () => {
    setup('/trading/orders?symbol=BINANCE%3ABTCUSDT&side=buy')
    const drawer = await screen.findByRole('dialog', { name: '下单' })
    await userEvent.click(await within(drawer).findByRole('button', { name: /其他 1 个账户不可用/ }))
    expect(within(drawer).getByText(/实盘账户：要先过实盘评审/)).toBeInTheDocument()
  })

  it('新增交易所账户：建连接器、测试连接、通过后建账户；只读默认', async () => {
    const { backend } = setup('/trading/accounts')
    await userEvent.click((await screen.findAllByRole('button', { name: '新增账户' }))[0])
    const drawer = await screen.findByRole('dialog', { name: '新增交易账户' })
    await userEvent.click(within(drawer).getByRole('button', { name: /OKX/ }))
    expect(within(drawer).getByRole('button', { name: '保存' })).toBeDisabled()
    expect(within(drawer).getByRole('button', { name: /富途/ })).toBeDisabled()
    await userEvent.click(within(drawer).getByRole('button', { name: '测试连接' }))
    expect(await within(drawer).findByText('没填 API Key')).toBeInTheDocument()
    await userEvent.type(await within(drawer).findByLabelText(/^API Key/), 'okx-key-m9Lk')
    await userEvent.type(within(drawer).getByLabelText(/^Secret Key/), 's')
    await userEvent.type(within(drawer).getByLabelText(/^Passphrase/), 'p')
    await userEvent.click(within(drawer).getByRole('button', { name: '测试连接' }))
    expect(await within(drawer).findByText('OKX ****m9Lk · 只读')).toBeInTheDocument()
    expect(backend.calls.find((c) => c.method === 'POST' && c.path === '/api/connectors')?.body).toMatchObject({
      tool: 'okx_account', auth_mode: 'token', secrets: { api_key: 'okx-key-m9Lk', api_secret: 's', passphrase: 'p' },
    })
    await userEvent.click(within(drawer).getByRole('button', { name: '保存' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '新增交易账户' })).not.toBeInTheDocument())
    expect(backend.calls.find((c) => c.method === 'POST' && c.path === '/api/trade/accounts')?.body).toEqual({ connector_id: 'cn_new', name: 'OKX 账户', trade: false })
    // 用上了的连接器不删
    expect(backend.calls.some((c) => c.method === 'DELETE')).toBe(false)
  })

  it('放弃新增时删掉测试时建的连接器', async () => {
    const { backend } = setup('/trading/accounts')
    await userEvent.click((await screen.findAllByRole('button', { name: '新增账户' }))[0])
    const drawer = await screen.findByRole('dialog', { name: '新增交易账户' })
    await userEvent.click(within(drawer).getByRole('button', { name: /OKX/ }))
    for (const f of [/^API Key/, /^Secret Key/, /^Passphrase/]) await userEvent.type(await within(drawer).findByLabelText(f), 'x')
    await userEvent.click(within(drawer).getByRole('button', { name: '测试连接' }))
    await within(drawer).findByText('OKX ****m9Lk · 只读')
    await userEvent.click(within(drawer).getByRole('button', { name: '取消' }))
    await waitFor(() => expect(backend.calls.some((c) => c.method === 'DELETE' && c.path === '/api/connectors/cn_new')).toBe(true))
  })
})

describe('交易设置', () => {
  it('评审清单带证据；条件不满足不能确认；代为提交被拒原样显示；实盘开关不可用并写原因', async () => {
    const { backend } = setup('/trading/settings')
    const sw = await screen.findByRole('switch', { name: '实盘开关' })
    expect(sw).toBeDisabled()
    expect(screen.getByText(/不能打开：评审还差 5 项没确认/)).toBeInTheDocument()
    expect(screen.getByText('实盘下单还没上线（TRD-08d）')).toBeInTheDocument()
    const recon = screen.getByLabelText('对账')
    expect(within(recon).getByRole('button', { name: '确认通过' })).toBeDisabled()
    expect(within(recon).getByRole('button', { name: '去处理' })).toBeInTheDocument()

    // 后端拒绝（来源不是用户本人）：原样写原因
    await userEvent.click(within(screen.getByLabelText('审计日志')).getByRole('button', { name: '确认通过' }))
    expect(await screen.findByText(/只能由用户本人在界面上操作/)).toBeInTheDocument()
    await userEvent.click(within(screen.getByLabelText('异常演练')).getByRole('button', { name: '确认通过' }))
    expect(await within(screen.getByLabelText('异常演练')).findByText(/已确认 ·.*me/)).toBeInTheDocument()

    // 证据：审计在抽屉里查
    await userEvent.click(within(screen.getByLabelText('审计日志')).getByRole('button', { name: '审计日志证据' }))
    const drawer = await screen.findByRole('dialog', { name: '证据' })
    expect(await within(drawer).findByText('下单：买入 0.1 BTC/USDT')).toBeInTheDocument()
    expect(backend.calls.some((c) => c.path === '/api/trade/audit?action=audit')).toBe(true)

    // 评审没通过：申请 trade:live 不可点
    expect(screen.getByRole('button', { name: '申请 trade:live' })).toBeDisabled()
  })

  it('评审通过后申请 trade:live 要输入插件名；后端不同意时原样显示', async () => {
    const passed = gate({ review: { status: 'passed', at: NOW, reviewer: 'me', missing: [] }, blockers: ['还没授予 trade:live 权限'] })
    const { backend } = setup('/trading/settings', { gate: passed })
    await userEvent.click(await screen.findByRole('button', { name: '申请 trade:live' }))
    const ok = screen.getByRole('button', { name: '确认申请' })
    expect(ok).toBeDisabled()
    await userEvent.type(screen.getByLabelText('输入插件名确认'), 'trade')
    expect(ok).toBeDisabled()
    await userEvent.clear(screen.getByLabelText('输入插件名确认'))
    await userEvent.type(screen.getByLabelText('输入插件名确认'), '交易套件')
    await userEvent.click(ok)
    await waitFor(() => expect(backend.calls.find((c) => c.path === '/api/plugins/trade/permissions/grant')?.body).toEqual({ permission: 'trade:live', confirm: '交易套件' }))
    expect(await screen.findByText(/现在不能授予 trade:live/)).toBeInTheDocument()
  })

  it('停用插件被拦：原样写后端原因，给去一键全停', async () => {
    const { router } = setup('/trading/settings')
    await userEvent.click(await screen.findByRole('button', { name: '停用交易插件' }))
    await userEvent.click(screen.getByRole('button', { name: '停用' }))
    expect(await screen.findByText(/还有 1 个部署在跑、2 笔挂单，先到交易里一键全停/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '去一键全停' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/trading/risk'))
  })
})
