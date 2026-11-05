import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EtfAnomaly, EtfDaily, EtfFund, EtfMetrics, EtfRule } from '../../core/data'
import Page from './Page'

type Call = { method: string; path: string; query: string; body?: Record<string, unknown> }

const FUNDS: EtfFund[] = [
  { symbol: '510300', name: '沪深300ETF', track_index: '沪深300', category: '宽基', manager: '', market: 'SH', secid: '1.510300', underlying: '000300', launch_date: '', updated_at: '' },
  { symbol: '159915', name: '创业板ETF', track_index: '创业板指', category: '宽基', manager: '', market: 'SZ', secid: '0.159915', underlying: '399006', launch_date: '', updated_at: '' },
]
const daily = (symbol: string, date: string, shares: number): EtfDaily => ({
  date, symbol, shares, nav: 4, price: 4.175, open: 4, high: 4, low: 4, volume: 0, amount: 1e9, change_pct: 2.03, change_amount: 0,
  amplitude: 0, turnover_rate: 0, aum: shares * 4, premium_discount: 0.05, iopv: 4.1728, premium_basis: 'iopv', source: 'eastmoney', updated_at: '',
})
const METRICS: EtfMetrics[] = [{
  date: '2026-11-04', symbol: '510300', share_change_pct: 12.5, net_inflow: 2.5e9, inflow_streak: 3, amount_ratio: 1.2, share_pctile: null,
  aum_pctile: null, premium_pctile: null, tracking_error: null, excess_return: null, aum_change_pct: 12.5, premium_discount: 0.053,
  premium_basis: 'iopv', review_flag: 'pending_review', updated_at: '',
}]
const anomaly = (id: string, over: Partial<EtfAnomaly> = {}): EtfAnomaly => ({
  id, date: '2026-11-04', symbol: '510300', fund_name: '沪深300ETF', rule_id: 'ear_share_jump', rule_name: '份额单日骤变',
  metric: 'share_change_pct', value: 12.5, threshold: 2, operator: 'abs_gt', severity: 'warn', status: 'open', flag: 'pending_review',
  detail: '份额日变动 12.50%，规则 绝对值 > 2.00%', created_at: '', updated_at: '', handled_at: '', ...over,
})
const RULES: EtfRule[] = [
  { id: 'ear_share_jump', name: '份额单日骤变', scope: 'all', scope_value: '', metric: 'share_change_pct', operator: 'abs_gt', threshold: 2,
    window_days: 1, severity: 'warn', enabled: true, builtin: true, created_at: '', updated_at: '' },
  { id: 'ear_tracking_error', name: '跟踪误差扩大', scope: 'all', scope_value: '', metric: 'tracking_error', operator: 'gt', threshold: 1,
    window_days: 20, severity: 'critical', enabled: true, builtin: true, created_at: '', updated_at: '' },
]

function fakeBackend(opts: { empty?: boolean } = {}) {
  const calls: Call[] = []
  const st = {
    anomalies: [anomaly('eae_1'), anomaly('eae_2', { severity: 'critical', rule_id: 'ear_tracking_error', rule_name: '跟踪误差扩大', flag: '', status: 'acked', handled_at: '2026-11-04T08:00:00Z' })],
    rules: RULES.map((r) => ({ ...r })),
  }
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(status < 300 ? { data, meta: {} } : data), { status })
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input), 'http://x')
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ method, path: u.pathname, query: u.search, body })
    const p = u.pathname
    if (p === '/api/etf/funds') return json(FUNDS)
    if (p === '/api/etf/daily') return json(opts.empty ? [] : [daily('510300', '2026-11-04', 4.5e10), daily('510300', '2026-11-03', 4e10), daily('159915', '2026-11-04', 4.3e10)])
    if (p === '/api/etf/metrics') return json(opts.empty ? [] : METRICS)
    if (p === '/api/etf/anomalies') {
      const sev = u.searchParams.get('severity')
      const status = u.searchParams.get('status')
      return json(st.anomalies.filter((a) => (!sev || a.severity === sev) && (!status || a.status === status)))
    }
    const ack = p.match(/^\/api\/etf\/anomalies\/(.+)\/ack$/)
    if (ack && method === 'POST') {
      const a = st.anomalies.find((x) => x.id === ack[1])!
      a.status = body.status
      return json(a)
    }
    if (p === '/api/etf/rules' && method === 'GET') return json(st.rules)
    if (p === '/api/etf/rules' && method === 'POST') {
      const r = { ...RULES[0], ...body, id: 'ear_new', builtin: false }
      st.rules.push(r)
      return json(r, 201)
    }
    const rp = p.match(/^\/api\/etf\/rules\/(.+)$/)
    if (rp && method === 'PATCH') {
      const r = st.rules.find((x) => x.id === rp[1])!
      Object.assign(r, body)
      return json(r)
    }
    if (p === '/api/etf/collect') return json({ date: '2026-11-04', source: 'eastmoney', upserted: 10, skipped: 0, indexes: 7, metrics: 10, hits: 3, new_hits: 1, errors: [] })
    return json({ error: { code: 'not_found', message: p } }, 404)
  }))
  return { calls, st }
}

function renderPage(path = '/etf') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}><MemoryRouter initialEntries={[path]}><Page /></MemoryRouter></QueryClientProvider>)
}

describe('宽基监控页', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('份额与资金流：最新一天每只一行，样本不足显示横线，份额跳变标待核', async () => {
    fakeBackend()
    renderPage()
    const table = await screen.findByRole('table')
    const rows = within(table).getAllByRole('row')
    expect(rows).toHaveLength(3)
    const r300 = rows[1]
    expect(r300).toHaveTextContent('510300')
    expect(r300).toHaveTextContent('450.00 亿份')
    expect(r300).toHaveTextContent('+12.50%')
    expect(r300).toHaveTextContent('25.00 亿元')
    expect(r300).toHaveTextContent('流入 3 天')
    expect(r300).toHaveTextContent('IOPV')
    expect(r300).toHaveTextContent('待核')
    expect(within(r300).getByRole('img', { name: /近 2 天份额增加/ })).toBeInTheDocument()
    // 159915 没有指标：份额变动、净流入都是横线
    expect(rows[2]).toHaveTextContent('—')
    expect(screen.getByText('2026-11-04')).toBeInTheDocument()
    expect(screen.getByText('1 只 / 0 只')).toBeInTheDocument()
    // 标签上的未处理数
    expect(await screen.findByLabelText('1 条未处理')).toBeInTheDocument()
    // 越过内置阈值的格子标红：这里都没越过；摘要「未处理异动」点了切到异动标签
    expect(r300.querySelector('.etf-hot')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: /未处理异动/ }))
    expect(await screen.findByText(/份额日变动 12.50%/)).toBeInTheDocument()
  })

  it('没有数据时提示立即采集，点了回采集结果', async () => {
    const { calls } = fakeBackend({ empty: true })
    renderPage()
    expect(await screen.findByText('还没有采集到数据')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '立即采集' }))
    expect(await screen.findByText(/已采集 2026-11-04：10 只宽基的份额与行情、7 条跟踪指数行情，算完指标，新增 1 条异动，已发通知/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '知道了' }))
    expect(screen.queryByText(/已采集/)).not.toBeInTheDocument()
    expect(calls.some((c) => c.method === 'POST' && c.path === '/api/etf/collect')).toBe(true)
  })

  it('异动：默认只看未处理，确认后消失；按状态筛出已处理的可以撤回', async () => {
    const { calls } = fakeBackend()
    renderPage('/etf?tab=anomalies')
    expect(await screen.findByText(/份额日变动 12.50%/)).toBeInTheDocument()
    expect(screen.queryByText('跟踪误差扩大', { exact: false })).not.toBeInTheDocument()
    expect(screen.getByText('待核')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '确认' }))
    await waitFor(() => expect(calls.some((c) => c.path === '/api/etf/anomalies/eae_1/ack' && c.body?.status === 'acked')).toBe(true))
    expect(await screen.findByText('没有符合条件的异动')).toBeInTheDocument()

    const statusSeg = screen.getByRole('group', { name: '状态' })
    expect(within(statusSeg).getByRole('button', { name: /已确认\s*2/ })).toBeInTheDocument()
    await userEvent.click(within(statusSeg).getByRole('button', { name: /已确认/ }))
    expect(await screen.findByText(/跟踪误差扩大/)).toBeInTheDocument()
    await userEvent.click(within(screen.getByRole('group', { name: '严重度' })).getByRole('button', { name: /严重\s*1/ }))
    expect(screen.queryByText(/份额单日骤变/)).not.toBeInTheDocument()
    const undo = await screen.findAllByRole('button', { name: '撤回' })
    await userEvent.click(undo[0])
    await waitFor(() => expect(calls.some((c) => c.path === '/api/etf/anomalies/eae_2/ack' && c.body?.status === 'open')).toBe(true))
  })

  it('规则：启停走 PATCH，编辑改阈值，新建要填名称', async () => {
    const { calls, st } = fakeBackend()
    renderPage('/etf?tab=rules')
    expect(await screen.findByText('份额日变动 绝对值 > 2.00%')).toBeInTheDocument()
    expect(screen.getAllByText('内置')).toHaveLength(2)

    await userEvent.click(screen.getByRole('switch', { name: '启用 跟踪误差扩大' }))
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH' && c.path === '/api/etf/rules/ear_tracking_error' && c.body?.enabled === false)).toBe(true))

    await userEvent.click(screen.getAllByRole('button', { name: '编辑' })[0])
    const thr = screen.getByLabelText('阈值')
    await userEvent.clear(thr)
    await userEvent.type(thr, '3.5')
    await userEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(st.rules[0].threshold).toBe(3.5))
    expect(await screen.findByText('份额日变动 绝对值 > 3.50%')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: '新建规则' }))
    expect(screen.getByRole('button', { name: '新建' })).toBeDisabled()
    await userEvent.type(screen.getByRole('textbox', { name: /名称/ }), '300 放量')
    await userEvent.selectOptions(screen.getByLabelText('指标'), '量比（倍）')
    await userEvent.selectOptions(screen.getByLabelText('比较'), 'gt')
    await userEvent.selectOptions(screen.getByLabelText('范围'), '某只 ETF')
    await userEvent.selectOptions(screen.getByLabelText('ETF'), '510300 沪深300ETF')
    await userEvent.click(screen.getByRole('button', { name: '新建' }))
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path === '/api/etf/rules')).toBe(true))
    const post = calls.find((c) => c.method === 'POST' && c.path === '/api/etf/rules')!
    expect(post.body).toMatchObject({ name: '300 放量', metric: 'amount_ratio', operator: 'gt', threshold: 2, scope: 'symbol', scope_value: '510300', severity: 'warn', enabled: true })
  })
})
