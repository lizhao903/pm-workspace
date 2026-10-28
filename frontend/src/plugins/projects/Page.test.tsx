import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkObject } from '../../core/data'
import { resetRecentMemo } from './model'
import Page from './Page'

let seq = 0
function obj(p: Partial<WorkObject>): WorkObject {
  seq += 1
  return {
    id: `obj_${seq}`, ref: `PRJ-${seq}`, type_id: 'project', title: `项目${seq}`, body: '', status: 'planning', priority: '',
    owner: '', owner_id: null, category_id: null, project_id: null, source: 'manual', props: null, workdir: '',
    due_at: null, started_at: null, completed_at: null, archived_at: null, deleted_at: null,
    created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z', tags: [], link_count: 0, participants: [], ...p,
  } as WorkObject
}

const types = [{
  id: 'project', name: '项目', statuses: [
    { key: 'planning', label: '筹备中', color: '', terminal: false },
    { key: 'active', label: '进行中', color: '', terminal: false },
  ],
}]

// 内存里的对象表：POST、PATCH 改了再取就是新的
function fakeBackend(rows: WorkObject[]) {
  const calls: { method: string; path: string; body?: unknown }[] = []
  const json = (data: unknown, status = 200, meta?: unknown) =>
    new Response(JSON.stringify(status < 300 ? { data, meta } : data), { status })
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input), 'http://x')
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ method, path: u.pathname, body })
    if (u.pathname === '/api/objects' && method === 'GET') {
      const ty = u.searchParams.get('type')
      const pj = u.searchParams.get('project')
      const xs = rows.filter((o) => o.type_id === ty && !o.deleted_at && (!pj || o.project_id === pj))
      return json(xs, 200, { total: xs.length })
    }
    if (u.pathname === '/api/objects' && method === 'POST') {
      const o = obj({ ...body, title: body.title })
      rows.push(o)
      return json(o, 201)
    }
    const m = u.pathname.match(/^\/api\/objects\/([^/]+)$/)
    if (m) {
      const o = rows.find((r) => r.id === decodeURIComponent(m[1]))
      if (!o) return json({ error: { code: 'not_found', message: 'object not found' } }, 404)
      if (method === 'PATCH') Object.assign(o, body)
      if (method === 'DELETE') o.deleted_at = '2026-10-29T00:00:00Z'
      return json(o)
    }
    if (u.pathname === '/api/object-types') return json(types)
    if (/^\/api\/projects\/[^/]+\/stakeholders$/.test(u.pathname)) return json([], 200, { total: 0 })
    if (u.pathname === '/api/stakeholders' || u.pathname.startsWith('/api/dictionaries')) return json([])
    return json({ error: { code: 'not_found', message: u.pathname } }, 404)
  }))
  return calls
}

function mount(initial = '/projects') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createMemoryRouter([{ path: '/projects/*', element: <Page /> }], { initialEntries: [initial] })
  render(<QueryClientProvider client={qc}><RouterProvider router={router} /></QueryClientProvider>)
  return router
}

const cardNames = () => screen.queryAllByRole('button').filter((b) => b.classList.contains('pj-card')).map((b) => b.getAttribute('title'))

beforeEach(() => {
  localStorage.clear()
  resetRecentMemo()
})
afterEach(() => vi.unstubAllGlobals())

describe('项目列表', () => {
  it('按状态分组；搜索和状态筛选后不分组；数字不受搜索影响', async () => {
    fakeBackend([
      obj({ title: '工作台', status: 'active', workdir: '/Volumes/project/pm-workspace' }),
      obj({ title: '交易台', status: 'planning', body: '行情和下单' }),
      obj({ title: '视频号', status: 'active' }),
    ])
    mount()
    await screen.findByTitle('工作台')
    expect(screen.getAllByRole('region').map((r) => r.getAttribute('aria-label'))).toEqual(['筹备中', '进行中'])
    expect(screen.getByText('pm-workspace')).toBeInTheDocument()
    expect(screen.getAllByText('未设目录')).toHaveLength(2)

    await userEvent.type(screen.getByRole('searchbox', { name: '搜索项目' }), '下单')
    expect(cardNames()).toEqual(['交易台'])
    expect(screen.queryByRole('region')).toBeNull()
    const seg = screen.getByRole('group', { name: '状态' })
    expect(within(seg).getByRole('button', { name: /进行中/ })).toHaveTextContent('进行中2')

    await userEvent.click(screen.getByRole('button', { name: '清空' }))
    await userEvent.click(within(seg).getByRole('button', { name: /进行中/ }))
    expect(cardNames()).toEqual(['工作台', '视频号'])
  })

  it('打开过的项目排在前面；点进详情后顶栏「项目」回到列表', async () => {
    fakeBackend([obj({ title: '甲' }), obj({ title: '乙' }), obj({ title: '丙' })])
    const router = mount()
    await screen.findByTitle('甲')
    expect(cardNames()).toEqual(['甲', '乙', '丙'])
    await userEvent.click(screen.getByTitle('丙'))
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/projects\/obj_\d+$/))
    await screen.findByRole('tab', { name: '概览', selected: true })
    await userEvent.click(screen.getByRole('button', { name: '项目' }))
    expect(router.state.location.pathname).toBe('/projects')
    await screen.findByTitle('甲')
    expect(cardNames()).toEqual(['丙', '甲', '乙'])
    expect(JSON.parse(localStorage.getItem('pmw-projects-recent')!)[0]).toMatch(/^obj_/)
  })

  it('没有项目时引导新建；新建后打开设置标签，改目录会存到 workdir', async () => {
    const calls = fakeBackend([])
    const router = mount()
    await userEvent.click(await screen.findByRole('button', { name: '新建第一个项目' }))
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/projects\/obj_\d+\/settings$/))
    const post = calls.find((c) => c.method === 'POST')!
    expect(post.body).toMatchObject({ type_id: 'project', title: '新项目', props: { mark: { text: '', icon: 'folder' } } })

    const dir = await screen.findByRole('textbox', { name: '本地项目目录' })
    await userEvent.type(dir, '/tmp/pj')
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH' && (c.body as { workdir?: string }).workdir === '/tmp/pj')).toBe(true), { timeout: 2000 })
  })

  it('名称清空时不存，离开输入框恢复原名', async () => {
    const p = obj({ title: '工作台' })
    const calls = fakeBackend([p])
    mount(`/projects/${p.id}/settings`)
    const name = await screen.findByRole('textbox', { name: '名称' })
    await userEvent.clear(name)
    expect(screen.getByText('名称必填；不填的话离开输入框时恢复成「工作台」')).toBeInTheDocument()
    await userEvent.tab()
    expect(name).toHaveValue('工作台')
    await new Promise((r) => setTimeout(r, 700))
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false)
  })

  it('删除先确认，列出挂着的任务数；删完回到列表', async () => {
    const p = obj({ title: '工作台' })
    const rows = [p, obj({ type_id: 'task', title: '任务', project_id: p.id })]
    const calls = fakeBackend(rows)
    const router = mount(`/projects/${p.id}/settings`)
    await userEvent.click(await screen.findByRole('button', { name: '删除项目' }))
    await screen.findByText('只删项目记录，本地目录和文件不动；项目进回收站，可以恢复；1 个任务还挂在这个项目下，记录保留')
    await userEvent.click(screen.getByRole('button', { name: '删除' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/projects'))
    expect(calls.some((c) => c.method === 'DELETE' && c.path === `/api/objects/${p.id}`)).toBe(true)
  })

  it('打开的项目不存在时提示并能回列表', async () => {
    fakeBackend([])
    const router = mount('/projects/obj_nope')
    await screen.findByText('这个项目不存在或已删除')
    await userEvent.click(screen.getByRole('button', { name: '回到项目列表' }))
    expect(router.state.location.pathname).toBe('/projects')
  })
})
