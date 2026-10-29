import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Connector, ConnectorDef } from '../../core/data'
import { ChannelPanel } from './ChannelPanel'

const def = (tool: string, label: string): ConnectorDef => ({ tool, label, category: 'im', color: '#611f69', desc: `${label} 渠道`, can_send: true, auth: ['token'], fields: [], tools: [], source: 'im' })
const DEFS = [def('slack', 'Slack'), def('telegram', 'Telegram'), { ...def('gdrive', 'Google Drive'), category: 'docs' }]

function conn(p: Partial<Connector> = {}): Connector {
  return {
    id: 'cn_sl', tool: 'slack', name: '公司 Slack', account: 'pmw（UBOT）', status: 'connected', error: '', auth_mode: 'token',
    config: { channels: '#product' }, secret_hints: { bot_token: 'xoxb…good', signing_secret: 'sig…cret' }, direction: 'both', interval: 5,
    tools: [], tools_at: null, last_tested_at: null, last_sync_at: new Date(Date.now() - 120_000).toISOString(), available: true,
    created_at: '', updated_at: '', ...p,
  }
}

type Call = { method: string; path: string; body?: Record<string, unknown> }

function backend(opts: { list?: Connector[]; syncFails?: string } = {}) {
  const calls: Call[] = []
  let list = opts.list ?? []
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(status < 300 ? { data } : data), { status })
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input), 'http://x')
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ method, path: u.pathname, body })
    if (u.pathname === '/api/connectors/defs') return json(DEFS)
    if (u.pathname === '/api/connectors' && method === 'GET') return json(list)
    if (u.pathname === '/api/connectors' && method === 'POST') {
      const c = conn({ id: 'cn_new', name: body.name, status: 'connecting', config: body.config, interval: body.interval, last_sync_at: null,
        secret_hints: { bot_token: 'xoxb…test' } })
      list = [c]
      return json(c, 201)
    }
    const m = u.pathname.match(/^\/api\/connectors\/([^/]+)(\/test)?$/)
    if (m && m[2]) {
      const c = { ...list.find((x) => x.id === m[1])!, status: 'connected' as const, account: 'pmw（UBOT）' }
      list = list.map((x) => (x.id === c.id ? c : x))
      return json({ ok: true, account: c.account, message: '连接正常', connector: c })
    }
    if (m && method === 'PATCH') {
      const c = { ...list.find((x) => x.id === m[1])!, status: body.enabled === false ? 'paused' as const : 'connecting' as const }
      list = list.map((x) => (x.id === c.id ? c : x))
      return json(c)
    }
    if (u.pathname.endsWith('/sync')) {
      if (opts.syncFails) return json({ error: { code: 'sync_failed', message: `同步失败：${opts.syncFails}` } }, 502)
      return json({ connector_id: 'cn_sl', adapter: 'slack', ids: ['msg_1', 'msg_2'], duplicates: 0 })
    }
    return json([])
  }))
  return calls
}

function renderPanel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const onManageAll = vi.fn()
  render(<QueryClientProvider client={qc}><ChannelPanel onClose={() => {}} onManageAll={onManageAll} /></QueryClientProvider>)
  return { onManageAll }
}

afterEach(() => { vi.unstubAllGlobals() })

describe('渠道配置', () => {
  it('空状态给接入 Slack、Telegram 两个入口；接入 Slack 填 Token 和 Signing Secret，保存后自动测试', async () => {
    const calls = backend()
    renderPanel()
    expect(await screen.findByText('还没接入 IM 渠道')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /接入 Telegram/ })).toBeEnabled()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /接入 Slack/ }))
    const form = screen.getByRole('form', { name: 'Slack 渠道配置' })
    await user.click(within(form).getByRole('button', { name: '接入并测试' }))
    expect(within(form).getByText('必填')).toBeInTheDocument()
    await user.type(within(form).getByLabelText(/Bot Token/), 'xoxb-test')
    await user.type(within(form).getByLabelText(/Signing Secret/), 'sig-secret')
    await user.type(within(form).getByLabelText(/监听频道/), '#product')
    await user.click(within(form).getByRole('button', { name: '接入并测试' }))
    expect(await screen.findByText('已连上 pmw（UBOT）')).toBeInTheDocument()
    const post = calls.find((c) => c.method === 'POST' && c.path === '/api/connectors')
    expect(post?.body).toMatchObject({ tool: 'slack', direction: 'both', interval: 5, config: { channels: '#product' },
      secrets: { bot_token: 'xoxb-test', signing_secret: 'sig-secret' } })
    // 明文不留在输入框，只显示脱敏提示
    expect(screen.getByLabelText(/Bot Token/)).toHaveValue('')
    expect(screen.getByText(/已保存（xoxb…test）/)).toBeInTheDocument()
  })

  it('渠道卡片：状态、账号、最近同步、出错原因；立即同步、测试连接、停用', async () => {
    const calls = backend({ list: [conn({ status: 'error', error: 'Slack 拒绝了 Bot Token（invalid_auth）' })] })
    renderPanel()
    const card = await screen.findByRole('listitem', { name: '公司 Slack' })
    expect(within(card).getByText('异常')).toBeInTheDocument()
    expect(within(card).getByText(/出错原因：Slack 拒绝了 Bot Token/)).toBeInTheDocument()
    expect(within(card).getByText(/最近同步 2 分钟前/)).toBeInTheDocument()
    expect(within(card).getByText('账号 pmw（UBOT）')).toBeInTheDocument()
    // 已接过 Slack，只剩 Telegram 可接
    expect(screen.queryByRole('button', { name: /接入 Slack/ })).toBeNull()
    expect(screen.getByRole('button', { name: /接入 Telegram/ })).toBeInTheDocument()
    const user = userEvent.setup()
    await user.click(within(card).getByRole('button', { name: '立即同步' }))
    expect(await within(card).findByText('收到 2 条新消息')).toBeInTheDocument()
    expect(calls.some((c) => c.method === 'POST' && c.path === '/api/im/connectors/cn_sl/sync')).toBe(true)
    await user.click(within(card).getByRole('button', { name: '测试连接' }))
    expect(await within(card).findByText('连接正常 · pmw（UBOT）')).toBeInTheDocument()
    await user.click(within(card).getByRole('button', { name: '停用' }))
    expect(await within(card).findByText('已停用')).toBeInTheDocument()
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ enabled: false })
    expect(within(card).getByRole('button', { name: '立即同步' })).toBeDisabled()
  })

  it('同步失败写出原因；配置打开已有实例的表单', async () => {
    backend({ list: [conn()], syncFails: 'Slack 拒绝了 Bot Token（invalid_auth）' })
    renderPanel()
    const card = await screen.findByRole('listitem', { name: '公司 Slack' })
    const user = userEvent.setup()
    await user.click(within(card).getByRole('button', { name: '立即同步' }))
    expect(await within(card).findByText('Slack 拒绝了 Bot Token（invalid_auth）')).toBeInTheDocument()
    await user.click(within(card).getByRole('button', { name: '配置' }))
    const form = screen.getByRole('form', { name: 'Slack 渠道配置' })
    expect(within(form).getByDisplayValue('#product')).toBeInTheDocument()
    expect(within(form).getByRole('button', { name: '保存并测试' })).toBeInTheDocument()
  })
})
