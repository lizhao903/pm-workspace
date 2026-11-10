// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserGoogleState, BrowserTabRecord } from '../../core/data'
import Page from './Page'
import { resetBrowserStore } from './store'

type Call = { method: string; path: string; body?: Record<string, unknown> }

const SIGNED_OUT: BrowserGoogleState = {
  signed_in: false, configured: true, account: null,
  drive: { id: 'cn_d', name: 'Google Drive', status: 'connected', error: '', account: '', scopes: [], authorized_at: null },
  calendar: { id: 'cn_c', name: 'Google 日历', status: 'connected', error: '', account: '', scopes: [], authorized_at: null },
}
const SIGNED_IN: BrowserGoogleState = {
  signed_in: true, configured: true,
  account: { email: 'chen.yi.pm@gmail.com', name: 'chen.yi.pm', scopes: ['drive.readonly'], connected_at: new Date(Date.now() - 3 * 60000).toISOString() },
  drive: { id: 'cn_d', name: 'Google Drive', status: 'connected', error: '', account: 'chen.yi.pm@gmail.com', scopes: ['drive.readonly'], authorized_at: '2026-10-29T10:00:00Z' },
  calendar: null,
}

const rec = (o: Partial<BrowserTabRecord> & Pick<BrowserTabRecord, 'id' | 'url'>): BrowserTabRecord => ({
  title: '', kind: 'web', history: [o.url], cursor: 0, pinned: false, position: 0, active: false, ...o,
})

function fakeBackend(opts: { tabs?: BrowserTabRecord[]; google?: BrowserGoogleState; failPut?: boolean; protos?: unknown[]; allow?: string[]; domains?: { enabled: boolean; suffix: string } } = {}) {
  const calls: Call[] = []
  const st = { tabs: opts.tabs ?? [], google: opts.google ?? SIGNED_OUT, failPut: !!opts.failPut, allow: ['127.0.0.1', 'localhost', ...(opts.allow ?? [])] }
  const entry = (host: string) => ({ host, note: '', builtin: host === '127.0.0.1' || host === 'localhost', created_at: null })
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(status < 300 ? { data, meta: { total: 0 } } : data), { status })
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input), 'http://x')
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ method, path: u.pathname, body })
    if (u.pathname === '/api/browser/tabs' && method === 'GET') return json(st.tabs)
    if (u.pathname === '/api/browser/tabs' && method === 'PUT') {
      if (st.failPut) return json({ error: { code: 'internal', message: 'down' } }, 500)
      st.tabs = body.tabs
      return json(st.tabs)
    }
    if (u.pathname === '/api/browser/allowlist' && method === 'GET') return json(st.allow.map(entry))
    if (u.pathname === '/api/browser/allowlist' && method === 'POST') {
      if (st.allow.includes(body.host)) return json({ error: { code: 'conflict', message: '已经在白名单里' } }, 409)
      st.allow.push(body.host)
      return json(entry(body.host), 201)
    }
    if (u.pathname === '/api/domains/settings' && opts.domains) return json({ resolve: 'hosts', ...opts.domains })
    if (u.pathname === '/api/browser/google') return json(st.google)
    if (u.pathname === '/api/browser/google/logout') {
      st.google = SIGNED_OUT
      return json({ disconnected: ['cn_d'], google: st.google })
    }
    if (u.pathname === '/api/browser/google/login') {
      if (!st.google.configured) return json({ error: { code: 'conflict', message: '先在设置 / 连接器里配好 Google Drive 的 OAuth 客户端' } }, 409)
      return json({ connector_id: 'cn_d', authorize_url: 'https://accounts.example/auth?x=1', redirect_uri: '', expires_at: '', calendar: null })
    }
    if (u.pathname === '/api/objects') return json([{ id: 'obj_p', type_id: 'project', title: '状态项目' }])
    if (u.pathname === '/api/projects/obj_p/prototypes') return json(opts.protos ?? [])
    if (u.pathname.endsWith('/start')) return json({})
    return json({ error: { code: 'not_found', message: u.pathname } }, 404)
  }))
  return { calls, st }
}

function Loc() {
  const l = useLocation()
  return <output data-testid="loc">{l.pathname + l.search}</output>
}

function renderPage(path = '/browser') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}><MemoryRouter initialEntries={[path]}><Page /><Loc /></MemoryRouter></QueryClientProvider>)
}

const tabs = () => screen.getAllByRole('tab')
const puts = (calls: Call[]) => calls.filter((c) => c.method === 'PUT')
const lastPut = (calls: Call[]) => puts(calls).at(-1)?.body?.tabs as BrowserTabRecord[]

describe('浏览器页', () => {
  beforeEach(() => resetBrowserStore())
  afterEach(() => vi.unstubAllGlobals())

  it('从后端恢复标签：顺序、当前标签、各自的前进后退都在', async () => {
    fakeBackend({
      tabs: [
        rec({ id: 'bt_1', url: 'https://a.com', title: 'a.com', position: 0 }),
        rec({ id: 'bt_2', url: 'https://c.com', title: 'c.com', position: 1, active: true, history: ['about:home', 'https://b.com', 'https://c.com', 'https://d.com'], cursor: 2 }),
        rec({ id: 'bt_3', url: 'about:home', title: '新标签页', kind: 'home', position: 2 }),
      ],
    })
    renderPage()
    await waitFor(() => expect(tabs()).toHaveLength(3))
    expect(tabs().map((t) => t.getAttribute('aria-label'))).toEqual(['a.com', 'c.com', '新标签页'])
    expect(screen.getByRole('tab', { selected: true })).toHaveAccessibleName('c.com')
    expect(screen.getByRole('textbox', { name: '地址栏' })).toHaveValue('c.com')
    expect(screen.getByRole('button', { name: '后退' })).toBeEnabled()
    expect(screen.getByRole('button', { name: '前进' })).toBeEnabled()
    await userEvent.click(screen.getByRole('tab', { name: 'a.com' }))
    expect(screen.getByRole('button', { name: '后退' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '前进' })).toBeDisabled()
  })

  it('开标签、输地址、后退后整体 PUT：历史和游标跟着存', async () => {
    const be = fakeBackend()
    const user = userEvent.setup()
    renderPage()
    await waitFor(() => expect(tabs()).toHaveLength(1))
    const addr = screen.getByRole('textbox', { name: '地址栏' })
    await user.type(addr, 'example.com{Enter}')
    expect(screen.getByRole('tab', { selected: true })).toHaveAccessibleName('example.com')
    await user.click(screen.getByRole('button', { name: '新标签页' }))
    await user.type(screen.getByRole('textbox', { name: '地址栏' }), 'b.org{Enter}')
    await user.type(screen.getByRole('textbox', { name: '地址栏' }), 'c.org{Enter}')
    await user.click(screen.getByRole('button', { name: '后退' }))
    await waitFor(() => expect(lastPut(be.calls)?.[1]?.cursor).toBe(1), { timeout: 3000 })
    const saved = lastPut(be.calls)
    expect(saved.map((t) => [t.url, t.history, t.cursor, t.active])).toEqual([
      ['https://example.com', ['about:home', 'https://example.com'], 1, false],
      ['https://b.org', ['about:home', 'https://b.org', 'https://c.org'], 1, true],
    ])
    expect(saved[0].id).toMatch(/^bt_[0-9a-f]{16}$/)
  })

  it('原型没在运行时显示启动提示，点「启动原型」调项目插件', async () => {
    const be = fakeBackend({ protos: [{ id: 'pt_1', project_id: 'obj_p', name: '状态看板', port: 7790, status: 'stopped', error: '' }] })
    const user = userEvent.setup()
    renderPage()
    await waitFor(() => expect(tabs()).toHaveLength(1))
    await waitFor(() => expect(screen.getByText('状态看板')).toBeInTheDocument())
    await user.type(screen.getByRole('textbox', { name: '地址栏' }), '7790{Enter}')
    expect(screen.getByRole('tab', { selected: true })).toHaveAccessibleName('状态看板 · 状态项目')
    expect(screen.getByText('这个原型没在运行')).toBeInTheDocument()
    expect(document.querySelector('iframe')).toBeNull()
    await user.click(screen.getByRole('button', { name: '启动原型' }))
    await waitFor(() => expect(be.calls.some((c) => c.method === 'POST' && c.path === '/api/projects/obj_p/prototypes/pt_1/start')).toBe(true))
  })

  it('右键菜单：固定、关闭其他；固定的不能关', async () => {
    fakeBackend({ tabs: [rec({ id: 'bt_1', url: 'https://a.com', title: 'a.com' }), rec({ id: 'bt_2', url: 'https://b.com', title: 'b.com', position: 1, active: true })] })
    const user = userEvent.setup()
    renderPage()
    await waitFor(() => expect(tabs()).toHaveLength(2))
    fireEvent.contextMenu(screen.getByRole('tab', { name: 'b.com' }), { clientX: 10, clientY: 10 })
    await user.click(screen.getByRole('menuitem', { name: '固定标签页' }))
    expect(tabs().map((t) => t.getAttribute('aria-label'))).toEqual(['b.com', 'a.com'])
    fireEvent.contextMenu(screen.getByRole('tab', { name: 'b.com' }), { clientX: 10, clientY: 10 })
    expect(screen.getByRole('menuitem', { name: '关闭' })).toBeDisabled()
    await user.click(screen.getByRole('menuitem', { name: '关闭其他标签页' }))
    expect(tabs()).toHaveLength(1)
  })

  it('关掉最后一个标签补一个新标签页', async () => {
    fakeBackend({ tabs: [rec({ id: 'bt_1', url: 'https://a.com', title: 'a.com', active: true })] })
    const user = userEvent.setup()
    renderPage()
    await waitFor(() => expect(tabs()).toHaveLength(1))
    await user.click(within(tabs()[0]).getByRole('button', { name: '关闭标签页' }))
    expect(tabs()).toHaveLength(1)
    expect(tabs()[0]).toHaveAccessibleName('新标签页')
  })

  it('保存失败不打断浏览，提示「标签没保存上」，点重试再存', async () => {
    const be = fakeBackend({ failPut: true })
    const user = userEvent.setup()
    renderPage()
    await waitFor(() => expect(tabs()).toHaveLength(1))
    await user.type(screen.getByRole('textbox', { name: '地址栏' }), 'a.com{Enter}')
    const warn = await screen.findByRole('button', { name: /标签没保存上，刷新会丢/ }, { timeout: 3000 })
    be.st.failPut = false
    await user.click(warn)
    await waitFor(() => expect(screen.queryByRole('button', { name: /标签没保存上/ })).toBeNull())
    expect(lastPut(be.calls)[0].url).toBe('https://a.com')
  })

  it('别的模块用 ?open= 打开：新开一个标签；同一地址的切过去', async () => {
    fakeBackend({ tabs: [rec({ id: 'bt_1', url: 'https://a.com', title: 'a.com', active: true })] })
    renderPage('/browser?open=7790&title=看板')
    await waitFor(() => expect(tabs()).toHaveLength(2))
    expect(screen.getByRole('tab', { selected: true })).toHaveAccessibleName('看板')
  })

  it('没登录显示「登录 Google」，没配 OAuth 客户端时登录弹窗给「去配置」', async () => {
    fakeBackend({ google: { ...SIGNED_OUT, configured: false, drive: null, calendar: null } })
    const user = userEvent.setup()
    renderPage()
    await waitFor(() => expect(tabs()).toHaveLength(1))
    await user.click(screen.getAllByRole('button', { name: '登录 Google' })[0])
    const dlg = await screen.findByRole('dialog', { name: '登录 Google' })
    await waitFor(() => expect(within(dlg).getByText(/先在设置 \/ 连接器里配好 Google Drive 的 OAuth 客户端/)).toBeInTheDocument())
    await user.click(within(dlg).getByRole('button', { name: '去配置' }))
    // 没有 Drive 实例时按工具打开新建抽屉（POL-01）
    await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent('/settings/connectors?tool=gdrive'))
  })

  it('登录：允许后新窗口打开授权页，轮询到授权完成就关弹窗换成头像', async () => {
    const be = fakeBackend()
    const popup = { opener: {}, location: { href: '' }, close: vi.fn() }
    vi.stubGlobal('open', vi.fn(() => popup))
    const user = userEvent.setup()
    renderPage()
    await waitFor(() => expect(tabs()).toHaveLength(1))
    await user.click(screen.getAllByRole('button', { name: '登录 Google' })[0])
    const dlg = await screen.findByRole('dialog', { name: '登录 Google' })
    expect(within(dlg).getByRole('checkbox', { name: '查看 Google Drive 文件' })).toBeDisabled()
    expect(within(dlg).getByRole('checkbox', { name: '查看和编辑 Google 日历日程' })).toBeChecked()
    await user.click(within(dlg).getByRole('button', { name: '允许' }))
    await waitFor(() => expect(popup.location.href).toBe('https://accounts.example/auth?x=1'))
    expect(popup.opener).toBeNull()
    expect(be.calls.find((c) => c.path === '/api/browser/google/login')?.body).toEqual({ return_to: 'http://localhost:3000/browser' })
    expect(within(dlg).getByText(/正在等你在 Google 的页面完成授权/)).toBeInTheDocument()
    be.st.google = SIGNED_IN
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '登录 Google' })).toBeNull(), { timeout: 5000 })
    expect(screen.getByRole('button', { name: 'Google 账号 chen.yi.pm@gmail.com' })).toBeInTheDocument()
  })

  it('账号面板列出授权范围；退出登录不弹确认，断开后换回「登录 Google」', async () => {
    const be = fakeBackend({ google: SIGNED_IN })
    const user = userEvent.setup()
    renderPage()
    await user.click(await screen.findByRole('button', { name: 'Google 账号 chen.yi.pm@gmail.com' }))
    const panel = screen.getByRole('dialog', { name: 'Google 账号' })
    expect(within(panel).getByText('3 分钟前登录')).toBeInTheDocument()
    expect(within(panel).getByText('查看 Google Drive 文件').closest('.br-scope-line')).not.toHaveClass('off')
    expect(within(panel).getByText('查看和编辑 Google 日历日程').closest('.br-scope-line')).toHaveClass('off')
    await user.click(within(panel).getByRole('button', { name: '退出登录' }))
    await waitFor(() => expect(be.calls.some((c) => c.path === '/api/browser/google/logout')).toBe(true))
    await waitFor(() => expect(screen.getAllByRole('button', { name: '登录 Google' }).length).toBeGreaterThan(0))
  })

  it('不在白名单的网页不挂 iframe，出卡片；「在系统浏览器打开」开新窗口', async () => {
    fakeBackend({ tabs: [rec({ id: 'bt_1', url: 'https://example.com', title: 'example.com', active: true })] })
    const open = vi.fn()
    vi.stubGlobal('open', open)
    const user = userEvent.setup()
    renderPage()
    expect(await screen.findByText('这个站点不能在这里打开')).toBeInTheDocument()
    expect(screen.getByText('example.com 不在白名单里，多数网站不允许嵌入显示')).toBeInTheDocument()
    expect(document.querySelector('iframe')).toBeNull()
    expect(within(screen.getByRole('alert')).queryByRole('button', { name: '继续等' })).toBeNull()
    await user.click(within(screen.getByRole('alert')).getByRole('button', { name: '在系统浏览器打开' }))
    expect(open).toHaveBeenCalledWith('https://example.com', '_blank', 'noopener')
  })

  it('「加进白名单再试」：POST 主机，刷回白名单后同一地址改用 iframe', async () => {
    const be = fakeBackend({ tabs: [rec({ id: 'bt_1', url: 'https://example.com/a?b=1', title: 'example.com', active: true })] })
    const user = userEvent.setup()
    renderPage()
    await user.click(await screen.findByRole('button', { name: '加进白名单再试' }))
    await waitFor(() => expect(document.querySelector('iframe')?.getAttribute('src')).toBe('https://example.com/a?b=1'))
    expect(be.calls.find((c) => c.method === 'POST' && c.path === '/api/browser/allowlist')?.body).toEqual({ host: 'example.com' })
    expect(screen.queryByText('这个站点不能在这里打开')).toBeNull()
  })

  it('本机地址、白名单里的主机、开着的内网域名后缀直接嵌入', async () => {
    fakeBackend({
      tabs: [
        rec({ id: 'bt_1', url: 'http://127.0.0.1:7778', title: '原型', kind: 'proto', active: true }),
        rec({ id: 'bt_2', url: 'https://docs.example.com', title: 'docs', position: 1 }),
        rec({ id: 'bt_3', url: 'https://wiki.bro.lan', title: 'wiki', position: 2 }),
      ],
      allow: ['docs.example.com'],
      domains: { enabled: true, suffix: 'bro.lan' },
    })
    renderPage()
    await waitFor(() => expect(document.querySelectorAll('iframe')).toHaveLength(3))
    expect(screen.queryByText('这个站点不能在这里打开')).toBeNull()
  })

  it('内网域名关着时，后缀下的主机不算白名单', async () => {
    fakeBackend({ tabs: [rec({ id: 'bt_1', url: 'https://wiki.bro.lan', title: 'wiki', active: true })], domains: { enabled: false, suffix: 'bro.lan' } })
    renderPage()
    expect(await screen.findByText('wiki.bro.lan 不在白名单里，多数网站不允许嵌入显示')).toBeInTheDocument()
  })

  it('白名单内 8 秒没 load 盖一层卡片；「继续等」收起，再等 8 秒再出；load 了就不再出', async () => {
    fakeBackend({ tabs: [rec({ id: 'bt_1', url: 'http://127.0.0.1:7791', title: '慢', kind: 'proto', active: true })] })
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      renderPage()
      await waitFor(() => expect(document.querySelector('iframe')).not.toBeNull())
      act(() => { vi.advanceTimersByTime(7900) })
      expect(screen.queryByText('这个站点不能在这里打开')).toBeNull()
      act(() => { vi.advanceTimersByTime(200) })
      expect(screen.getByText('127.0.0.1 8 秒还没加载完，可能不允许嵌入显示')).toBeInTheDocument()
      expect(document.querySelector('iframe')).not.toBeNull()
      fireEvent.click(screen.getByRole('button', { name: '继续等' }))
      expect(screen.queryByText('这个站点不能在这里打开')).toBeNull()
      act(() => { vi.advanceTimersByTime(8000) })
      expect(screen.getByRole('button', { name: '继续等' })).toBeInTheDocument()
      fireEvent.load(document.querySelector('iframe')!)
      expect(screen.queryByText('这个站点不能在这里打开')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('授权回调回到的窗口只显示结果，不读标签', async () => {
    const be = fakeBackend()
    renderPage('/browser?oauth=error&connector=cn_d&message=用户拒绝了授权')
    expect(screen.getByText('授权没完成')).toBeInTheDocument()
    expect(screen.getByText('用户拒绝了授权')).toBeInTheDocument()
    expect(be.calls.some((c) => c.path === '/api/browser/tabs')).toBe(false)
  })
})
