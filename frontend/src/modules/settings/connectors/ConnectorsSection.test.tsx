import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Connector, ConnectorDef } from '../../../core/data'
import { ConnectorsSection } from './ConnectorsSection'

// 按定义渲染：这里的 GitHub 是测试用的假定义，验证真实连接器登记后不用改前端
const github: ConnectorDef = {
  tool: 'github', label: 'GitHub', category: 'dev', color: 'black', desc: '仓库、Issue、PR', can_send: false, auth: ['oauth2', 'token'],
  fields: [{ key: 'token', label: '个人访问令牌', kind: 'secret', placeholder: 'ghp_…', required: false }],
  tools: [], source: 'core',
}
const slack: ConnectorDef = {
  tool: 'slack', label: 'Slack', category: 'im', color: 'purple', desc: '频道与私信', can_send: false, auth: ['token'],
  fields: [{ key: 'bot_token', label: 'Bot Token', kind: 'secret', required: true }], tools: [], source: 'core',
}

function conn(p: Partial<Connector> & { id: string; tool: string }): Connector {
  return {
    name: p.tool, account: '', status: 'connected', error: '', auth_mode: 'token', config: {}, secret_hints: {}, direction: 'receive',
    interval: 0, tools: [], tools_at: null, last_tested_at: null, last_sync_at: null, available: true,
    created_at: '2026-10-29T00:00:00Z', updated_at: '2026-10-29T00:00:00Z', ...p,
  }
}

type Call = { method: string; path: string; body: unknown }

function stub(defs: ConnectorDef[], rows: Connector[]) {
  const calls: Call[] = []
  const ok = (data: unknown, status = 200) => new Response(JSON.stringify({ data }), { status })
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).replace(/^https?:\/\/[^/]+/, '')
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ method, path, body })
    if (path === '/api/connectors/defs') return new Response(JSON.stringify({ data: defs.length ? defs : null, meta: { total: defs.length } }))
    if (path === '/api/connectors' && method === 'GET') return new Response(JSON.stringify({ data: rows, meta: { total: rows.length } }))
    if (path === '/api/connectors' && method === 'POST') {
      const hints = Object.fromEntries(Object.keys(body.secrets ?? {}).map((k) => [k, 'ghp…abcd']))
      const c = conn({ id: 'cn_new', tool: body.tool, name: body.name, auth_mode: body.auth_mode, status: 'connecting', secret_hints: hints })
      rows = [c, ...rows]
      return ok(c, 201)
    }
    const m = /^\/api\/connectors\/([^/]+)(?:\/(\w+))?$/.exec(path)!
    const [id, action] = [m[1], m[2]]
    if (action === 'test') {
      rows = rows.map((r) => (r.id === id ? { ...r, status: 'connected' as const, account: 'octocat', error: '' } : r))
      return ok({ ok: true, account: 'octocat', message: '连接正常', connector: rows.find((r) => r.id === id) })
    }
    if (method === 'PATCH') {
      rows = rows.map((r) => {
        if (r.id !== id) return r
        const next = { ...r }
        if (body.name !== undefined) next.name = body.name
        if (body.enabled !== undefined) next.status = body.enabled ? 'connecting' : 'paused'
        return next
      })
      return ok(rows.find((r) => r.id === id))
    }
    if (method === 'DELETE') {
      const gone = rows.find((r) => r.id === id)
      rows = rows.filter((r) => r.id !== id)
      return ok(gone)
    }
    return new Response('{}', { status: 404 })
  }))
  return calls
}

const writes = (calls: Call[]) => calls.filter((c) => c.method !== 'GET').map((c) => [c.method, c.path, c.body])

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={qc}><ConnectorsSection /></QueryClientProvider>)
}

afterEach(() => { vi.unstubAllGlobals() })

describe('连接器页', () => {
  it('后端还没登记任何定义时是空状态，统计全为 0', async () => {
    stub([], [])
    renderPage()
    expect(await screen.findByText('还没有可以接入的工具')).toBeInTheDocument()
    expect(screen.getByLabelText('统计')).toHaveTextContent('已连接0异常0已断开 / 暂停0可接未接0')
  })

  it('按定义渲染认证方式和凭证字段；OAuth 还测不了；接入后自动测一次', async () => {
    const calls = stub([github], [])
    renderPage()
    const card = await screen.findByLabelText('研发协作')
    expect(card).toHaveTextContent('GitHub')
    expect(card).toHaveTextContent('还没有接入')
    await userEvent.click(within(card).getByRole('button', { name: '接入' }))
    const drawer = screen.getByRole('dialog')
    expect(within(drawer).getByText('接入 GitHub')).toBeInTheDocument()
    expect(within(drawer).getByRole('button', { name: 'OAuth 2.0' })).toHaveAttribute('aria-pressed', 'true')
    expect(within(drawer).getByRole('button', { name: '去 GitHub 授权' })).toBeDisabled()
    await userEvent.click(within(drawer).getByRole('button', { name: 'Token' }))
    await userEvent.type(within(drawer).getByPlaceholderText('ghp_…'), 'ghp_secret_value_1234')
    await userEvent.click(within(drawer).getByRole('button', { name: '接入' }))
    expect(await within(screen.getByRole('dialog')).findByText(/连接正常 · octocat/)).toBeInTheDocument()
    expect(writes(calls)).toEqual([
      ['POST', '/api/connectors', { tool: 'github', name: 'GitHub', auth_mode: 'token', enabled: true, secrets: { token: 'ghp_secret_value_1234' } }],
      ['POST', '/api/connectors/cn_new/test', {}],
    ])
    // 明文不回显：输入框清空，只剩后端给的提示
    expect(screen.getByRole('dialog')).toHaveTextContent('当前：ghp…abcd')
    expect(within(screen.getByRole('dialog')).getByPlaceholderText('不改就留空')).toHaveValue('')
    expect(document.body.textContent).not.toContain('ghp_secret_value_1234')
  })

  it('编辑时凭证空着保存不带 secrets；不是必填的凭证可以确认后清掉', async () => {
    const calls = stub([github], [conn({ id: 'cn_g', tool: 'github', name: '公司 GitHub', account: 'octocat', secret_hints: { token: 'ghp…zzzz' } })])
    renderPage()
    await userEvent.click(await screen.findByText('公司 GitHub'))
    const drawer = screen.getByRole('dialog')
    expect(drawer).toHaveTextContent('当前：ghp…zzzz')
    await userEvent.click(within(drawer).getByRole('button', { name: '清除' }))
    const confirm = screen.getByRole('alertdialog')
    expect(writes(calls)).toEqual([])
    await userEvent.click(within(confirm).getByRole('button', { name: '清除' }))
    expect(writes(calls)).toEqual([['PATCH', '/api/connectors/cn_g', { secrets: { token: '' } }]])
    const name = within(screen.getByRole('dialog')).getByDisplayValue('公司 GitHub')
    await userEvent.clear(name)
    await userEvent.type(name, 'GitHub 个人')
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '保存' }))
    expect(writes(calls).at(-1)).toEqual(['PATCH', '/api/connectors/cn_g', { name: 'GitHub 个人' }])
  })

  it('即时通讯类有消息方向和拉取间隔，平台不能发时收发置灰', async () => {
    stub([slack], [])
    renderPage()
    await userEvent.click(within(await screen.findByLabelText('即时通讯')).getByRole('button', { name: '接入' }))
    const drawer = screen.getByRole('dialog')
    expect(within(drawer).getByRole('button', { name: '收发（可在工作台回复）' })).toBeDisabled()
    expect(within(drawer).getByRole('combobox', { name: '拉取间隔' })).toHaveValue('5')
    await userEvent.click(within(drawer).getByRole('button', { name: '接入' }))
    expect(drawer).toHaveTextContent('还没填：Bot Token')
  })

  it('行上断开先确认，变暂停；异常的给「重连」，点了直接测', async () => {
    const calls = stub([github, slack], [
      conn({ id: 'cn_g', tool: 'github', name: '公司 GitHub' }),
      conn({ id: 'cn_s', tool: 'slack', name: '公司 Slack', status: 'error', error: 'token revoked' }),
    ])
    renderPage()
    const g = (await screen.findByText('公司 GitHub')).closest<HTMLElement>('[data-connector]')!
    await userEvent.click(within(g).getByRole('button', { name: '断开' }))
    expect(g).toHaveTextContent('断开后收不到消息，Agent 也调不了它的工具')
    expect(writes(calls)).toEqual([])
    await userEvent.click(within(g).getByRole('button', { name: '断开' }))
    expect(writes(calls)).toEqual([['PATCH', '/api/connectors/cn_g', { enabled: false }]])
    expect(await within(g).findByText('已暂停')).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    const s = screen.getByText('公司 Slack').closest<HTMLElement>('[data-connector]')!
    expect(s.closest('.cn-card')).toHaveClass('cn-card-bad')
    await userEvent.click(within(s).getByRole('button', { name: '重连' }))
    expect(writes(calls).at(-1)).toEqual(['POST', '/api/connectors/cn_s/test', {}])
    expect(await within(s).findByText('已连接')).toBeInTheDocument()
  })

  it('插件停用后它的工具不在分类里、实例归「提供方已停用」，重新启用后回来；缓存里的旧定义进来时重新取（CONN-02）', async () => {
    const echo: ConnectorDef = { ...slack, tool: 'demo_echo', label: '示例连接器', category: 'other', source: 'demo' }
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const mount = () => render(<QueryClientProvider client={qc}><ConnectorsSection /></QueryClientProvider>)
    const row = (available: boolean) => conn({ id: 'cn_e', tool: 'demo_echo', name: '示例实例', available })

    stub([github, echo], [row(true)])
    let view = mount()
    expect(await within(await screen.findByRole('region', { name: '其他' })).findByText('示例实例')).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: '提供方已停用' })).toBeNull()
    view.unmount()

    // 停用：定义列表里没有了，实例 available=false；定义的缓存还新鲜，也要重新取
    stub([github], [row(false)])
    view = mount()
    const off = await screen.findByRole('region', { name: '提供方已停用' })
    expect(within(off).getByText('示例实例')).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: '其他' })).toBeNull()
    expect(screen.getByRole('button', { name: /全部分类/ })).toHaveTextContent('1')
    view.unmount()

    // 重新启用：回到原来的分类，实例原样
    stub([github, echo], [row(true)])
    mount()
    expect(await within(await screen.findByRole('region', { name: '其他' })).findByText('示例实例')).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: '提供方已停用' })).toBeNull()
  })
})
