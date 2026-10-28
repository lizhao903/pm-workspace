import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ObjectStatus, WorkObject } from '../../core/data'
import Page from './Page'

const statuses: ObjectStatus[] = [
  { key: 'todo', label: '待办', color: '', terminal: false },
  { key: 'doing', label: '进行中', color: '', terminal: false },
  { key: 'done', label: '已完成', color: '', terminal: true },
]
const terminal = new Set(statuses.filter((s) => s.terminal).map((s) => s.key))
const yesterday = new Date(Date.now() - 2 * 86400_000).toISOString()

function task(id: string, title: string, p: Partial<WorkObject> = {}): WorkObject {
  return {
    id, type_id: 'task', ref: 'TSK-' + id.slice(-4), title, body: '', status: 'todo', priority: '', owner: '', owner_id: null,
    category_id: null, project_id: null, source: '', props: null, workdir: '', due_at: null, started_at: null, completed_at: null,
    archived_at: null, deleted_at: null, created_at: yesterday, updated_at: yesterday, tags: [], link_count: 0, participants: [], ...p,
  }
}

// 内存里的后端：列表、计数都按当前数据现算，改了状态之后再取就是新的
function fakeBackend(rows: WorkObject[]) {
  const isOverdue = (t: WorkObject) => !!t.due_at && t.due_at < new Date().toISOString() && !terminal.has(t.status)
  const json = (data: unknown, meta?: unknown) => new Response(JSON.stringify({ data, meta }), { status: 200 })
  const calls: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input), 'http://x')
    const method = init?.method ?? 'GET'
    calls.push(`${method} ${u.pathname}${u.search}`)
    const m = u.pathname.match(/^\/api\/objects\/([^/]+)$/)
    if (method === 'PATCH' && m) {
      const t = rows.find((r) => r.id === m[1])!
      Object.assign(t, JSON.parse(String(init!.body)))
      return json(t)
    }
    if (u.pathname === '/api/object-types') return json([{ id: 'task', name: '任务', statuses }])
    if (u.pathname === '/api/counts') return json({ overdue: rows.filter(isOverdue).length, by_type: {}, total: rows.length })
    if (u.pathname === '/api/objects') {
      if (u.searchParams.get('type') !== 'task') return json([], { total: 0 })
      const out = u.searchParams.get('overdue') === 'true' ? rows.filter(isOverdue) : rows
      return json(out, { total: out.length })
    }
    if (m) return json(rows.find((r) => r.id === m[1]))
    if (u.pathname === '/api/artifacts/stats') return json({ total: 0 })
    if (u.pathname.startsWith('/api/agent/workdir')) return json({ path: '', exists: false, is_dir: false, writable: false, message: '' })
    return json([], { total: 0 })
  }))
  return calls
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createMemoryRouter([{ path: '/tasks/*', element: <Page /> }], { initialEntries: ['/tasks'] })
  return render(<QueryClientProvider client={qc}><RouterProvider router={router} /></QueryClientProvider>)
}

describe('任务页走数据访问层', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('在抽屉里改状态保存后，不刷新页面，列表分段和逾期徽标都更新', async () => {
    const calls = fakeBackend([task('obj_0001', '过期没做的', { due_at: yesterday }), task('obj_0002', '没截止的')])
    renderPage()

    const overdue = await screen.findByRole('group', { name: '逾期' })
    expect(within(overdue).getByText('过期没做的')).toBeInTheDocument()
    expect(await screen.findByText('1 条过了截止日还没完成')).toBeInTheDocument()

    await userEvent.click(within(overdue).getByRole('button', { name: /过期没做的/ }))
    const drawer = await screen.findByRole('dialog')
    await userEvent.click(within(within(drawer).getByRole('radiogroup', { name: '状态' })).getByRole('radio', { name: '已完成' }))
    await userEvent.click(within(drawer).getByRole('button', { name: '保存' }))

    expect(calls).toContain('PATCH /api/objects/obj_0001')
    // 默认只看未完成：逾期段消失，徽标跟着变
    await waitFor(() => expect(screen.queryByRole('group', { name: '逾期' })).not.toBeInTheDocument())
    expect(await screen.findByText('没有逾期的任务')).toBeInTheDocument()
    expect(screen.getByRole('group', { name: '无截止' })).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
