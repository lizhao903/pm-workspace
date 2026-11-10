// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetTerminalStore } from './store'
import Page from './Page'

// xterm 在 jsdom 里跑不起来，换成一个只显示会话 id 的格子
vi.mock('./XTerm', () => ({
  XTerm: ({ session }: { session: string }) => <div data-testid="xterm">{session}</div>,
}))

type Call = { method: string; path: string; body?: Record<string, unknown> }

function fakeBackend(opts: { sessions?: { id: string; cwd: string; status: string }[]; limit?: number } = {}) {
  const calls: Call[] = []
  const sessions = [...(opts.sessions ?? [])]
  let n = 0
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(status < 300 ? { data, meta: { total: 0 } } : data), { status })
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input), 'http://x')
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ method, path: u.pathname, body })
    if (u.pathname === '/api/terminal/sessions' && method === 'GET') return json(sessions)
    if (u.pathname === '/api/terminal/sessions' && method === 'POST') {
      if (sessions.filter((s) => s.status === 'running').length >= (opts.limit ?? 16)) {
        return json({ error: { code: 'conflict', message: '最多 16 个' } }, 409)
      }
      const s = { id: `pn_${++n}`, cwd: body?.cwd || '/Users/me', status: 'running' }
      sessions.push(s)
      return json(s, 201)
    }
    const del = u.pathname.match(/^\/api\/terminal\/sessions\/([^/]+)$/)
    if (del && method === 'DELETE') {
      const i = sessions.findIndex((s) => s.id === del[1])
      if (i >= 0) sessions.splice(i, 1)
      return json(null)
    }
    if (u.pathname === '/api/objects') return json([{ id: 'obj_p', type_id: 'project', title: '工作台项目', workdir: '/w/app' }])
    if (u.pathname === '/api/fs/shortcuts') return json([{ label: '主目录', path: '/Users/me' }])
    if (u.pathname.endsWith('/prototypes')) return json([])
    return json({ error: { code: 'not_found', message: u.pathname } }, 404)
  }))
  return { calls, sessions }
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}><Page /></QueryClientProvider>)
}

const panes = () => screen.queryAllByTestId('xterm').filter((e) => !e.closest('[hidden]'))

describe('终端页', () => {
  beforeEach(() => {
    resetTerminalStore()
    localStorage.clear()
  })
  afterEach(() => vi.unstubAllGlobals())

  it('第一次打开在第一个有目录的项目里开一格，标签叫工作台', async () => {
    const be = fakeBackend()
    renderPage()
    await waitFor(() => expect(panes()).toHaveLength(1))
    expect(be.calls.find((c) => c.method === 'POST')?.body).toEqual({ cwd: '/w/app' })
    expect(screen.getByRole('tab', { selected: true })).toHaveTextContent('工作台')
  })

  it('拆到 4 格后拆分按钮置灰；关一格结束它的会话', async () => {
    const be = fakeBackend()
    const user = userEvent.setup()
    renderPage()
    await waitFor(() => expect(panes()).toHaveLength(1))
    for (const k of [2, 3, 4]) {
      await user.click(screen.getAllByRole('button', { name: '向右拆分' })[0])
      await waitFor(() => expect(panes()).toHaveLength(k))
    }
    expect(screen.getByRole('tab', { selected: true })).toHaveTextContent('4')
    for (const b of screen.getAllByRole('button', { name: '向右拆分' })) expect(b).toBeDisabled()
    expect(be.sessions).toHaveLength(4)
    await user.click(screen.getAllByRole('button', { name: '关闭窗格' })[1])
    await waitFor(() => expect(be.calls.filter((c) => c.method === 'DELETE')).toHaveLength(1))
    expect(panes().map((e) => e.textContent)).toEqual(['pn_1', 'pn_3', 'pn_4'])
  })

  it('刷新后按会话列表接回，没记着的会话收进标签，不新开', async () => {
    const be = fakeBackend({ sessions: [{ id: 'pn_a', cwd: '/w/app', status: 'running' }, { id: 'pn_b', cwd: '/w/api', status: 'running' }] })
    renderPage()
    await waitFor(() => expect(panes().map((e) => e.textContent)).toEqual(['pn_a', 'pn_b']))
    expect(be.calls.some((c) => c.method === 'POST')).toBe(false)
  })

  it('关掉最后一个标签马上补一个新的', async () => {
    const be = fakeBackend()
    const user = userEvent.setup()
    renderPage()
    await waitFor(() => expect(panes()).toHaveLength(1))
    await user.click(screen.getByRole('button', { name: '关闭标签页' }))
    await waitFor(() => expect(panes().map((e) => e.textContent)).toEqual(['pn_2']))
    expect(be.calls.filter((c) => c.method === 'DELETE').map((c) => c.path)).toEqual(['/api/terminal/sessions/pn_1'])
  })

  it('双击改名，回车保存，Esc 放弃', async () => {
    fakeBackend()
    const user = userEvent.setup()
    renderPage()
    await waitFor(() => expect(panes()).toHaveLength(1))
    const tab = screen.getByRole('tab', { selected: true })
    await user.dblClick(tab)
    const input = within(tab).getByRole('textbox', { name: '标签名' })
    await user.clear(input)
    await user.type(input, ' 后端 {Enter}')
    expect(screen.getByRole('tab', { selected: true })).toHaveTextContent('后端')
    await user.dblClick(screen.getByRole('tab', { selected: true }))
    await user.type(screen.getByRole('textbox', { name: '标签名' }), 'xx{Escape}')
    expect(screen.getByRole('tab', { selected: true })).toHaveTextContent('后端')
    expect(screen.getByRole('tab', { selected: true })).not.toHaveTextContent('xx')
  })

  it('会话到上限时提示，不新开', async () => {
    fakeBackend({ sessions: [{ id: 'pn_a', cwd: '/w/app', status: 'running' }], limit: 1 })
    const user = userEvent.setup()
    renderPage()
    await waitFor(() => expect(panes()).toHaveLength(1))
    await user.click(screen.getByRole('button', { name: '新标签页' }))
    expect(await screen.findByRole('status')).toHaveTextContent('最多同时开 16 个终端，先关掉几个')
    expect(screen.getAllByRole('tab')).toHaveLength(1)
    await act(async () => {})
  })
})
