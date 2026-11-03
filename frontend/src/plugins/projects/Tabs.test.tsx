import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { lazy } from 'react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkObject } from '../../core/data'
import { registerCoreObjectDrawer, type Disposable, type ObjectDrawerProps } from '../../core/plugin'
import Page from './Page'

let seq = 0
function obj(p: Partial<WorkObject>): WorkObject {
  seq += 1
  return {
    id: `obj_${seq}`, ref: `T-${seq}`, type_id: 'task', title: `对象${seq}`, body: '', status: 'todo', priority: '',
    owner: '', owner_id: null, category_id: null, project_id: null, source: 'manual', props: null, workdir: '',
    due_at: null, started_at: null, completed_at: null, archived_at: null, deleted_at: null,
    created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z', tags: [], link_count: 0, participants: [], ...p,
  } as WorkObject
}

const types = [
  { id: 'project', name: '项目', statuses: [{ key: 'active', label: '进行中', color: '', terminal: false }] },
  { id: 'task', name: '任务', statuses: [
    { key: 'todo', label: '待办', color: '', terminal: false },
    { key: 'done', label: '已完成', color: '', terminal: true },
  ] },
  { id: 'doc', name: '文档', statuses: [
    { key: 'draft', label: '草稿', color: '', terminal: false },
    { key: 'published', label: '已发布', color: '', terminal: true },
  ] },
]
const contacts = ['张甲', '李乙', '王丙', '赵丁', '钱戊'].map((name, i) => ({ id: `sh_${i}`, name, company: '', title: '', photo: '' }))

function fakeBackend(rows: WorkObject[], stakes: { stakeholder_id: string; role: string }[]) {
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
      const xs = rows.filter((o) => o.type_id === ty && (!pj || o.project_id === pj))
      return json(xs, 200, { total: xs.length })
    }
    const m = u.pathname.match(/^\/api\/objects\/([^/]+)$/)
    if (m) {
      const o = rows.find((r) => r.id === decodeURIComponent(m[1]))
      if (!o) return json({ error: { code: 'not_found', message: 'object not found' } }, 404)
      if (method === 'PATCH') Object.assign(o, body)
      return json(o)
    }
    if (u.pathname === '/api/object-types') return json(types)
    const sm = u.pathname.match(/^\/api\/projects\/([^/]+)\/stakeholders(?:\/([^/]+))?$/)
    if (sm) {
      const row = (x: { stakeholder_id: string; role: string }, i: number) =>
        ({ project_id: sm[1], focus: '', sort_order: i, created_at: '', updated_at: '', ...x })
      if (method === 'POST') { stakes.push({ stakeholder_id: body.stakeholder_id, role: body.role }); return json(row(stakes.at(-1)!, stakes.length - 1), 201) }
      if (method === 'DELETE') { stakes.splice(stakes.findIndex((s) => s.stakeholder_id === sm[2]), 1); return json(null) }
      return json(stakes.map(row), 200, { total: stakes.length })
    }
    if (u.pathname === '/api/stakeholders') return json(contacts)
    if (u.pathname === '/api/dictionaries/priority/items') return json([{ id: 'p0', dict_id: 'priority', key: 'P0', label: '紧急', color: '', description: '', sort_order: 10, meta: {}, archived_at: null }])
    if (u.pathname.startsWith('/api/dictionaries')) return json([])
    return json({ error: { code: 'not_found', message: u.pathname } }, 404)
  }))
  return calls
}

function mount(initial: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createMemoryRouter([{ path: '/projects/*', element: <Page /> }, { path: '*', element: <div>别的页</div> }], { initialEntries: [initial] })
  render(<QueryClientProvider client={qc}><RouterProvider router={router} /></QueryClientProvider>)
  return router
}

// 代替任务模块登记的抽屉：把收到的参数显示出来
function FakeDrawer({ objectId, init, onClose }: ObjectDrawerProps) {
  return <div role="dialog" aria-label="任务抽屉">{`id=${objectId ?? 'new'} project=${init?.project_id ?? ''}`}<button type="button" onClick={onClose}>关</button></div>
}

let reg: Disposable | null = null
beforeEach(() => {
  localStorage.clear()
  reg = registerCoreObjectDrawer({ typeId: 'task', drawer: lazy(async () => ({ default: FakeDrawer })) })
})
afterEach(() => {
  reg?.dispose()
  vi.unstubAllGlobals()
})

describe('项目的任务标签', () => {
  it('列这个项目的任务，默认未完成；新建任务打开任务抽屉并预填本项目', async () => {
    const p = obj({ type_id: 'project', title: '工作台' })
    const rows = [p, obj({ title: '做列表', project_id: p.id, priority: 'P0' }), obj({ title: '已做完', project_id: p.id, status: 'done' }), obj({ title: '别的项目' })]
    fakeBackend(rows, [])
    mount(`/projects/${p.id}/tasks`)
    const list = await screen.findByRole('list', { name: '项目任务' })
    expect(within(list).getByText('做列表')).toBeInTheDocument()
    // 优先级标签是编号加字典名称（L-07）
    expect(await within(list).findByText('P0 紧急')).toBeInTheDocument()
    expect(within(list).queryByText('已做完')).toBeNull()
    expect(within(list).queryByText('别的项目')).toBeNull()

    await userEvent.click(screen.getByRole('button', { name: /全部/ }))
    expect(within(list).getByText('已做完')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: '新建任务' }))
    expect(await screen.findByRole('dialog', { name: '任务抽屉' })).toHaveTextContent(`id=new project=${p.id}`)
    await userEvent.click(screen.getByRole('button', { name: '关' }))

    await userEvent.click(within(list).getByText('做列表'))
    expect(await screen.findByRole('dialog', { name: '任务抽屉' })).toHaveTextContent(`id=${rows[1].id}`)
  })

  it('完成圆圈直接改状态，不打开抽屉', async () => {
    const p = obj({ type_id: 'project' })
    const t = obj({ title: '做列表', project_id: p.id })
    const calls = fakeBackend([p, t], [])
    mount(`/projects/${p.id}/tasks`)
    await userEvent.click(await screen.findByRole('button', { name: `标为已完成：${t.ref}` }))
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH' && (c.body as { status?: string })?.status === 'done')).toBe(true))
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe('项目的干系人标签', () => {
  it('按角色顺序显示：决策人、对接人、负责人、参与、知会', async () => {
    const p = obj({ type_id: 'project' })
    fakeBackend([p], [
      { stakeholder_id: 'sh_0', role: 'informed' }, { stakeholder_id: 'sh_1', role: 'member' }, { stakeholder_id: 'sh_2', role: 'owner' },
      { stakeholder_id: 'sh_3', role: 'contact' }, { stakeholder_id: 'sh_4', role: 'decider' },
    ])
    mount(`/projects/${p.id}/stakeholders`)
    const table = await screen.findByRole('table', { name: '干系人' })
    await within(table).findByText('钱戊')
    const roles = within(table).getAllByRole('combobox').map((s) => (s as HTMLSelectElement).selectedOptions[0].textContent)
    expect(roles).toEqual(['决策人', '对接人', '负责人', '参与', '知会'])
    expect(within(table).getAllByRole('row').slice(1).map((r) => within(r).getByTitle('打开联系人').querySelector('b')?.textContent))
      .toEqual(['钱戊', '赵丁', '王丙', '李乙', '张甲'])
  })

  it('移除走 DELETE，联系人本身不动', async () => {
    const p = obj({ type_id: 'project' })
    const calls = fakeBackend([p], [{ stakeholder_id: 'sh_0', role: 'member' }])
    mount(`/projects/${p.id}/stakeholders`)
    await screen.findByText('张甲')
    await userEvent.click(screen.getByRole('button', { name: '移除' }))
    await screen.findByText('还没有干系人')
    expect(calls.filter((c) => c.method === 'DELETE').map((c) => c.path)).toEqual([`/api/projects/${p.id}/stakeholders/sh_0`])
  })
})

describe('项目的文档标签', () => {
  it('列属于本项目的文档；移除只清 project_id', async () => {
    const p = obj({ type_id: 'project' })
    const d = obj({ type_id: 'doc', title: '权限 PRD', status: 'draft', project_id: p.id })
    const calls = fakeBackend([p, d, obj({ type_id: 'doc', title: '别的文档' })], [])
    mount(`/projects/${p.id}/docs`)
    const table = await screen.findByRole('table', { name: '项目文档' })
    expect(within(table).getByText('权限 PRD')).toBeInTheDocument()
    expect(within(table).getByRole('columnheader', { name: '来源' })).toBeInTheDocument()
    expect(within(table).getByText('文档库')).toBeInTheDocument()
    expect(within(table).queryByText('别的文档')).toBeNull()
    await userEvent.click(within(table).getByRole('button', { name: '移除' }))
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH' && c.path === `/api/objects/${d.id}`)).toBe(true))
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ project_id: null })
  })
})
