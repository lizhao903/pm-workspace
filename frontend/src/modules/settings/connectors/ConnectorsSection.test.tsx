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
const mcp: ConnectorDef = {
  tool: 'custom_mcp', label: 'MCP 服务', category: 'custom', color: '#7a4fd6', desc: '接一个 MCP 服务', can_send: false, auth: ['none', 'oauth2', 'token'],
  fields: [
    { key: 'url', label: '服务地址', kind: 'text', placeholder: 'https://mcp.example.com/mcp', required: true },
    { key: 'transport', label: '传输方式', kind: 'select', options: ['Streamable HTTP', 'SSE'], default: 'Streamable HTTP', required: true },
    { key: 'token', label: 'Token', kind: 'secret', required: true, auth: ['token'] },
    { key: 'token_header', label: '请求头', kind: 'text', default: 'Authorization', required: false, auth: ['token'] },
    { key: 'token_prefix', label: '前缀', kind: 'text', default: 'Bearer', required: false, auth: ['token'] },
  ],
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
      const c = conn({ id: 'cn_new', tool: body.tool, name: body.name, auth_mode: body.auth_mode, status: 'connecting', secret_hints: hints, config: body.config ?? {} })
      rows = [c, ...rows]
      return ok(c, 201)
    }
    const m = /^\/api\/connectors\/([^/]+)(?:\/(\w+))?(?:\/(\w+))?$/.exec(path)!
    const [id, action] = [m[1], m[2]]
    if (action === 'oauth' && m[3] === 'start') {
      return ok({ authorize_url: `http://127.0.0.1:9/authorize?state=s_${id}`, redirect_uri: 'http://127.0.0.1:9/api/connectors/oauth/callback', expires_at: new Date(Date.now() + 600_000).toISOString() })
    }
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
        if (body.auth_mode !== undefined) next.auth_mode = body.auth_mode
        if (body.config !== undefined) next.config = { ...r.config, ...body.config }
        if (body.icon !== undefined) next.icon = body.icon
        if (body.secrets !== undefined) next.secret_hints = { ...r.secret_hints, ...Object.fromEntries(Object.keys(body.secrets).map((k) => [k, 'tok…wxyz'])) }
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

  it('按定义渲染认证方式和凭证字段；定义没有 OAuth 配置时去授权置灰；接入后自动测一次', async () => {
    const calls = stub([github], [])
    renderPage()
    const card = await screen.findByLabelText('研发协作')
    expect(card).toHaveTextContent('GitHub')
    expect(card).toHaveTextContent('还没有接入')
    await userEvent.click(within(card).getByRole('button', { name: '接入' }))
    const drawer = screen.getByRole('dialog')
    expect(within(drawer).getByText('接入 GitHub')).toBeInTheDocument()
    expect(within(drawer).getByRole('button', { name: 'OAuth 2.0' })).toHaveAttribute('aria-pressed', 'true')
    expect(within(drawer).getByRole('button', { name: '接入并去 GitHub 授权' })).toBeDisabled()
    expect(drawer).toHaveTextContent('这个连接器还不支持 OAuth 授权')
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

  it('右上「添加连接器」打开目录，接过的写「再接一个」；第二个实例默认名称加序号（CONN-04）', async () => {
    const calls = stub([github, mcp], [conn({ id: 'cn_m', tool: 'custom_mcp', name: 'MCP 服务', auth_mode: 'none', config: { url: 'http://a/mcp' } })])
    renderPage()
    await screen.findByText('MCP 服务', { selector: '.cn-name' })
    // 卡片上也能再接一个
    expect(within(screen.getByLabelText('自定义')).getByRole('button', { name: '再接一个' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '添加连接器' }))
    const cat = screen.getByRole('dialog', { name: '添加连接器' })
    expect(within(cat).getByRole('button', { name: '接入 GitHub' })).toBeInTheDocument()
    expect(within(cat).getByText('已接 1 个')).toBeInTheDocument()
    await userEvent.click(within(cat).getByRole('button', { name: '再接一个 MCP 服务' }))
    const drawer = screen.getByRole('dialog')
    expect(within(drawer).getByText('接入 MCP 服务')).toBeInTheDocument()
    expect(within(drawer).getByDisplayValue('MCP 服务 2')).toBeInTheDocument()
    expect(drawer).toHaveTextContent('stdio（起本机进程）下一步支持')
    // 无授权时没有 Token 字段；切到 Token 出现 Token、请求头、前缀和预览
    expect(within(drawer).queryByText('请求头')).toBeNull()
    await userEvent.click(within(drawer).getByRole('button', { name: 'Token' }))
    expect(within(drawer).getByDisplayValue('Authorization')).toBeInTheDocument()
    expect(drawer).toHaveTextContent('请求时带上：Authorization: Bearer ••••••')
    await userEvent.click(within(drawer).getByRole('button', { name: '无授权' }))
    await userEvent.type(within(drawer).getByPlaceholderText('https://mcp.example.com/mcp'), 'http://127.0.0.1:9/mcp')
    await userEvent.click(within(drawer).getByRole('button', { name: '接入' }))
    expect(writes(calls)[0]).toEqual(['POST', '/api/connectors', {
      tool: 'custom_mcp', name: 'MCP 服务 2', auth_mode: 'none', enabled: true,
      config: { url: 'http://127.0.0.1:9/mcp', transport: 'Streamable HTTP', token_header: 'Authorization', token_prefix: 'Bearer' },
    }])
  })

  it('改了地址保存后不关抽屉，提示重新测试；凭证只显示脱敏（CONN-04）', async () => {
    const calls = stub([mcp], [conn({ id: 'cn_m', tool: 'custom_mcp', name: '笔记', auth_mode: 'token', config: { url: 'http://a/mcp', transport: 'SSE', token_header: 'Authorization', token_prefix: 'Bearer' }, secret_hints: { token: 'tok…abcd' } })])
    renderPage()
    await userEvent.click(await screen.findByText('笔记'))
    const drawer = screen.getByRole('dialog')
    expect(drawer).toHaveTextContent('当前：tok…abcd')
    const url = within(drawer).getByDisplayValue('http://a/mcp')
    await userEvent.clear(url)
    await userEvent.type(url, 'http://b/mcp')
    await userEvent.type(within(drawer).getByPlaceholderText('不改就留空'), 'new-token-123456')
    await userEvent.click(within(drawer).getByRole('button', { name: '保存' }))
    expect(await within(screen.getByRole('dialog')).findByText(/改了地址或认证/)).toBeInTheDocument()
    expect(writes(calls)).toEqual([['PATCH', '/api/connectors/cn_m', { config: { url: 'http://b/mcp' }, secrets: { token: 'new-token-123456' } }]])
    expect(screen.getByRole('dialog')).toHaveTextContent('当前：tok…wxyz')
    expect(document.body.textContent).not.toContain('new-token-123456')
    await userEvent.click(within(within(screen.getByRole('dialog')).getByRole('status')).getByRole('button', { name: '测试连接' }))
    expect(writes(calls).at(-1)).toEqual(['POST', '/api/connectors/cn_m/test', {}])
  })

  describe('OAuth 授权（CONN-04b）', () => {
    const custom: ConnectorDef = {
      tool: 'custom_openapi', label: 'OpenAPI 接口', category: 'custom', color: '#2563eb', desc: '', can_send: false, auth: ['oauth2', 'token'],
      fields: [
        { key: 'base_url', label: '接口地址', kind: 'text', required: true },
        { key: 'token', label: 'Token', kind: 'secret', required: true, auth: ['token'] },
        { key: 'oauth_client_id', label: 'Client ID', kind: 'text', required: true, auth: ['oauth2'] },
        { key: 'oauth_client_secret', label: 'Client Secret', kind: 'secret', required: false, auth: ['oauth2'] },
        { key: 'oauth_auth_url', label: '授权地址', kind: 'text', required: true, auth: ['oauth2'] },
        { key: 'oauth_token_url', label: '令牌地址', kind: 'text', required: true, auth: ['oauth2'] },
      ],
      tools: [], source: 'core',
      oauth: {
        auth_url: '', token_url: '', scopes: null, auth_url_field: 'oauth_auth_url', token_url_field: 'oauth_token_url', scopes_field: 'oauth_scopes',
        client_id_field: 'oauth_client_id', client_secret_field: 'oauth_client_secret', builtin: false,
      },
    }
    const cfg = { base_url: 'http://127.0.0.1:9/api', oauth_client_id: 'cid', oauth_auth_url: 'http://127.0.0.1:9/authorize', oauth_token_url: 'http://127.0.0.1:9/token' }
    const unauth = { authorized_at: null, expires_at: null, refreshed_at: null, refresh_failed_at: null, scope: '' }

    function popup() {
      const w = { location: { href: '' }, opener: {} as unknown, close: vi.fn() }
      vi.stubGlobal('open', vi.fn(() => w))
      return w
    }
    // 回调窗口经 BroadcastChannel 报结果
    const report = (msg: { ok: boolean; connector: string; message: string }) => {
      const ch = new BroadcastChannel('pmw-connector-oauth')
      ch.postMessage(msg)
      ch.close()
    }

    it('没填 Client ID、授权地址时置灰并写明差什么', async () => {
      stub([custom], [conn({ id: 'cn_o', tool: 'custom_openapi', name: '内部接口', auth_mode: 'oauth2', status: 'connecting', config: { base_url: cfg.base_url }, oauth: unauth })])
      renderPage()
      await userEvent.click(await screen.findByText('内部接口'))
      const drawer = screen.getByRole('dialog')
      expect(within(drawer).getByRole('button', { name: '去 OpenAPI 接口 授权' })).toBeDisabled()
      expect(drawer).toHaveTextContent('先填 Client ID、授权地址、令牌地址，才能去授权')
    })

    it('去授权：发起后新窗口跳到授权地址，回调报成功后重取到已授权、已连接', async () => {
      const w = popup()
      let rows = [conn({ id: 'cn_o', tool: 'custom_openapi', name: '内部接口', auth_mode: 'oauth2', status: 'connecting', config: cfg, oauth: unauth })]
      const calls = stub([custom], rows)
      renderPage()
      await userEvent.click(await screen.findByText('内部接口'))
      const drawer = screen.getByRole('dialog')
      await userEvent.click(within(drawer).getByRole('button', { name: '去 OpenAPI 接口 授权' }))
      expect(await within(drawer).findByText('等待授权…')).toBeInTheDocument()
      expect(w.location.href).toBe('http://127.0.0.1:9/authorize?state=s_cn_o')
      expect(writes(calls)).toEqual([['POST', '/api/connectors/cn_o/oauth/start', { return_to: 'http://localhost:3000/settings/connectors' }]])
      // 后端换完令牌、测过一次：实例已授权、已连接
      rows = [{ ...rows[0], status: 'connected', account: 'octocat', oauth: { ...unauth, authorized_at: '2026-10-29T03:00:00Z', expires_at: '2026-12-29T03:00:00Z' } }]
      stub([custom], rows)
      report({ ok: true, connector: 'cn_o', message: '授权完成' })
      expect(await within(drawer).findByText('授权完成，已连接')).toBeInTheDocument()
      expect(drawer).toHaveTextContent('已授权：octocat')
      expect(within(drawer).getByRole('button', { name: '重新授权' })).toBeEnabled()
    })

    it('回调报失败：停止等待，写出原因，可以再点', async () => {
      const w = popup()
      stub([custom], [conn({ id: 'cn_o', tool: 'custom_openapi', name: '内部接口', auth_mode: 'oauth2', status: 'connecting', config: cfg, oauth: unauth })])
      renderPage()
      await userEvent.click(await screen.findByText('内部接口'))
      const drawer = screen.getByRole('dialog')
      await userEvent.click(within(drawer).getByRole('button', { name: '去 OpenAPI 接口 授权' }))
      await within(drawer).findByText('等待授权…')
      report({ ok: false, connector: 'cn_o', message: '对方没有授权：access_denied' })
      expect(await within(drawer).findByRole('alert')).toHaveTextContent('授权没完成：对方没有授权：access_denied')
      expect(within(drawer).getByRole('button', { name: '去 OpenAPI 接口 授权' })).toBeEnabled()
      expect(w.close).not.toHaveBeenCalled()
    })

    it('改了配置没保存时先保存再发起', async () => {
      popup()
      const calls = stub([custom], [conn({ id: 'cn_o', tool: 'custom_openapi', name: '内部接口', auth_mode: 'token', status: 'connected', config: cfg, oauth: null })])
      renderPage()
      await userEvent.click(await screen.findByText('内部接口'))
      const drawer = screen.getByRole('dialog')
      await userEvent.click(within(drawer).getByRole('button', { name: 'OAuth 2.0' }))
      await userEvent.click(within(drawer).getByRole('button', { name: '保存并去 OpenAPI 接口 授权' }))
      await within(drawer).findByText('等待授权…')
      expect(writes(calls)).toEqual([
        ['PATCH', '/api/connectors/cn_o', { auth_mode: 'oauth2' }],
        ['POST', '/api/connectors/cn_o/oauth/start', { return_to: 'http://localhost:3000/settings/connectors' }],
      ])
    })
  })
})
