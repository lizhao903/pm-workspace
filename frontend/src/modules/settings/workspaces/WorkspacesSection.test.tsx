import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkspacesSection } from './WorkspacesSection'

const groups = [
  { id: 'g1', name: '', modules: ['today'], collapsed: false },
  { id: 'g2', name: '工作', modules: ['projects', 'tasks', 'library'], collapsed: false },
]
const pm = {
  id: 'ws_pm', name: '产品经理工作台', role: '产品经理', description: '', groups, modules: ['today', 'projects', 'tasks', 'library'],
  home: 'today', mark: null, plugins: ['projects'], template: 'ws_pm', position: 1, created_at: '', updated_at: '',
}
const templates = [
  {
    id: 'ws_trader', role: '交易员', name: '交易工作台', description: '看盘盯盘、策略回测、账户执行和风控', home: 'markets', mark: null,
    groups: [{ name: '', modules: ['today'] }, { name: '行情', modules: ['markets', 'monitor'] }, { name: '策略与执行', modules: ['strategy', 'trading'] }, { name: '资讯', modules: ['messages', 'library'] }],
    modules: ['today', 'markets', 'monitor', 'strategy', 'trading', 'messages', 'library'],
    plugins: ['markets', 'monitor', 'strategy', 'trading', 'im'],
  },
  { id: 'custom', role: '自定义', name: '我的工作台', description: '从空白开始，自己挑模块', home: 'today', mark: null, groups: [{ name: '', modules: ['today'] }], modules: ['today'], plugins: [] },
]
const plugins = [{ id: 'projects', name: '项目', installed: false, enabled: false, running: false }]

type Call = { method: string; url: string; body: unknown }
let calls: Call[]

beforeEach(() => {
  calls = []
  vi.stubGlobal('fetch', vi.fn((url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url)
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ method, url: u, body })
    const ok = (data: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify({ data }), { status }))
    if (method === 'POST' && u.endsWith('/api/workspaces')) return ok({ ...pm, id: 'ws_new', name: body.name, template: body.template }, 201)
    if (method === 'PATCH') return ok({ ...pm, ...body, modules: body.groups.flatMap((g: { modules: string[] }) => g.modules) })
    if (u.includes('/api/workspaces/templates')) return ok(templates)
    if (u.includes('/api/workspaces')) return ok([pm])
    if (u.includes('/api/plugins')) return ok(plugins)
    return new Promise<Response>(() => {})
  }))
})
afterEach(() => { vi.unstubAllGlobals() })

function renderSection() {
  const router = createMemoryRouter([{ path: '*', element: <WorkspacesSection /> }], { initialEntries: ['/settings/workspace'] })
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return router
}

describe('工作台与模块', () => {
  it('选「交易员」模板：提示需要交易套件，还没有这个插件显示「尚未提供」；先不装照样新建', async () => {
    renderSection()
    await userEvent.click(await screen.findByRole('button', { name: '新建工作台' }))
    const card = await screen.findByRole('button', { name: /交易员/ })
    expect(card).toHaveTextContent('需要插件：交易套件（行情、盯盘、策略与回测、交易执行）：尚未提供')
    await userEvent.click(card)
    const dialog = await screen.findByRole('alertdialog', { name: '「交易工作台」需要的插件还没装好' })
    expect(dialog).toHaveTextContent('交易套件（行情、盯盘、策略与回测、交易执行）：尚未提供')
    expect(dialog).toHaveTextContent('IM 消息：尚未提供')
    await userEvent.click(within(dialog).getByRole('button', { name: '先不装，照样新建' }))
    await vi.waitFor(() => expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ template: 'ws_trader', name: '交易工作台' }))
  })

  it('不缺插件的模板直接新建', async () => {
    renderSection()
    await userEvent.click(await screen.findByRole('button', { name: '新建工作台' }))
    await userEvent.click(await screen.findByRole('button', { name: /自定义/ }))
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    await vi.waitFor(() => expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ template: 'custom', name: '我的工作台' }))
  })

  it('缺的插件能装时给去插件管理的入口', async () => {
    const router = renderSection()
    const sec = await screen.findByRole('region', { name: '需要的插件' })
    expect(await within(sec).findByText('项目：未安装')).toBeInTheDocument()
    await userEvent.click(within(sec).getByRole('button', { name: '去插件管理安装' }))
    expect(router.state.location.pathname).toBe('/settings/plugins')
  })

  it('模块上移：整组写回后端，需要的插件跟着模块重算', async () => {
    renderSection()
    await userEvent.click(await screen.findByRole('button', { name: '任务上移' }))
    await vi.waitFor(() => expect(calls.find((c) => c.method === 'PATCH')).toBeTruthy())
    const p = calls.find((c) => c.method === 'PATCH')!
    expect(p.url).toContain('/api/workspaces/ws_pm')
    expect(p.body).toEqual({
      groups: [groups[0], { ...groups[1], modules: ['tasks', 'projects', 'library'] }],
      plugins: ['projects'],
    })
  })

  it('停用模块后进「未启用」，默认模块的下拉里没有它', async () => {
    renderSection()
    const grp = await screen.findByRole('group', { name: '工作' })
    const row = within(grp).getByText('文档').closest('.mod-row') as HTMLElement
    await userEvent.click(within(row).getByRole('button', { name: '停用' }))
    const off = await screen.findByRole('region', { name: '未启用的模块' })
    expect(within(off).getByText('文档')).toBeInTheDocument()
    expect(within(screen.getByRole('combobox', { name: '默认打开' })).queryByRole('option', { name: '文档' })).not.toBeInTheDocument()
  })
})
