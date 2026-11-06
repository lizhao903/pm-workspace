import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Artifact, ArtifactObjectSummary, ObjectStatus, WorkObject } from '../../core/data'
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

// 产出物（TSK-0497）：按对象汇总和某个对象的产出物，各测试自己设
let outputs: ArtifactObjectSummary[] = []
let arts: Artifact[] = []
const summary = (id: string, byKind: Record<string, number>, p: Partial<ArtifactObjectSummary> = {}): ArtifactObjectSummary => ({
  object_id: id, object_ref: 'TSK-' + id.slice(-4), object_title: '', object_type: 'task', status: 'todo', project_id: null, project_title: '',
  completed_at: null, total: Object.values(byKind).reduce((a, b) => a + b, 0), by_kind: byKind, by_source: { mcp: 1 }, last_at: yesterday, ...p,
})
const art = (id: string, objectId: string, p: Partial<Artifact>): Artifact => ({
  id, object_id: objectId, session_id: null, run_id: null, title: '', path: '', base_dir: '', url: '', platform: 'local', size: 0,
  source: 'mcp', note: '', kind: '', display_kind: 'other', created_at: yesterday, updated_at: yesterday, rel_path: '', ...p,
})

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
    if (u.pathname === '/api/artifacts/by-object') {
      const kind = u.searchParams.get('kind')
      const by_kind: Record<string, number> = {}
      for (const o of outputs) for (const [k, n] of Object.entries(o.by_kind)) by_kind[k] = (by_kind[k] ?? 0) + n
      const objs = outputs.filter((o) => !kind || o.by_kind[kind])
      return json({ objects: objs, total: objs.reduce((n, o) => n + o.total, 0), by_kind, by_source: {} })
    }
    if (u.pathname === '/api/artifacts') {
      const out = arts.filter((a) => a.object_id === u.searchParams.get('object_id'))
      return json(out, { total: out.length })
    }
    if (u.pathname.startsWith('/api/agent/workdir')) return json({ path: '', exists: false, is_dir: false, writable: false, message: '' })
    return json([], { total: 0 })
  }))
  return calls
}

function renderPage(entry = '/tasks') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createMemoryRouter([{ path: '/tasks/*', element: <Page /> }], { initialEntries: [entry] })
  render(<QueryClientProvider client={qc}><RouterProvider router={router} /></QueryClientProvider>)
  return router
}

describe('任务页走数据访问层', () => {
  afterEach(() => { vi.unstubAllGlobals(); outputs = []; arts = [] })

  it('地址带 ?t=<id>（命令面板打开）：打开那条任务的抽屉，参数从地址里去掉', async () => {
    fakeBackend([task('obj_0001', '第一条'), task('obj_0002', '命令面板搜到的')])
    const router = renderPage('/tasks?t=obj_0002')
    const drawer = await screen.findByRole('dialog')
    expect(within(drawer).getByDisplayValue('命令面板搜到的')).toBeInTheDocument()
    await waitFor(() => expect(router.state.location.search).toBe(''))
  })

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

  it('任务行显示产出数量与类型，点开停在产出物面板；「无产出」和状态组合（TSK-0497）', async () => {
    outputs = [summary('obj_0001', { commit: 2, doc: 1 })]
    fakeBackend([task('obj_0001', '有产出的'), task('obj_0002', '做完了没产出', { status: 'done' }), task('obj_0003', '还没做')])
    const router = renderPage()

    const badge = await screen.findByRole('button', { name: 'TSK-0001 的产出物：3 · 提交 2 文档 1' })
    expect(screen.getAllByText(/^产出 /)).toHaveLength(1)

    // 已完成 + 无产出 = 做完了却没留下东西的
    await userEvent.selectOptions(screen.getByRole('combobox', { name: '产出' }), 'without')
    await userEvent.click(within(screen.getByRole('group', { name: '状态' })).getByRole('button', { name: /^已完成/ }))
    expect(await screen.findByText('做完了没产出')).toBeInTheDocument()
    expect(screen.queryByText('有产出的')).not.toBeInTheDocument()
    expect(screen.queryByText('还没做')).not.toBeInTheDocument()

    await userEvent.selectOptions(screen.getByRole('combobox', { name: '产出' }), 'with')
    await userEvent.click(within(screen.getByRole('group', { name: '状态' })).getByRole('button', { name: /^全部/ }))
    expect(await screen.findByText('有产出的')).toBeInTheDocument()
    expect(screen.queryByText('还没做')).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'TSK-0001 的产出物：3 · 提交 2 文档 1' }))
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    await waitFor(() => {
      const sp = new URLSearchParams(router.state.location.search)
      expect(sp.get('tab')).toBe('dev')
      expect(sp.get('focus')).toBe('artifacts')
    })
    expect(badge).toBeTruthy()
  })

  it('产出物视图：二级菜单「视图」组里的一项，按任务列出，类型在后端筛，展开看每件产出、跳到任务（TSK-0497）', async () => {
    outputs = [
      summary('obj_0001', { commit: 2, doc: 1 }, { object_title: '有提交', project_title: '项目甲', project_id: 'obj_p1' }),
      summary('obj_0002', { code: 1 }, { object_title: '只有执行扫出来的', status: 'done', completed_at: yesterday }),
    ]
    arts = [
      art('art_1', 'obj_0001', { note: '[commit] sha=a1b2c3d4 branch=feat/x 修了列表', path: '/repo', kind: 'commit', display_kind: 'commit' }),
      art('art_2', 'obj_0001', { url: 'https://x.atlassian.net/wiki/1', title: '方案页', kind: 'doc', display_kind: 'doc', source: 'manual' }),
      art('art_3', 'obj_0002', { path: '/repo/x.go', rel_path: 'x.go', source: 'run', display_kind: 'code' }),
    ]
    const calls = fakeBackend([task('obj_0001', '有提交'), task('obj_0002', '只有执行扫出来的', { status: 'done' })])
    const router = renderPage('/tasks/outputs')

    expect(await screen.findByText('2 条任务有产出')).toBeInTheDocument()
    const row1 = await screen.findByRole('group', { name: 'TSK-0001 有提交' })
    expect(within(row1).getByText('3 · 提交 2 文档 1')).toBeInTheDocument()
    expect(within(row1).getByText('项目甲')).toBeInTheDocument()
    expect(screen.getByRole('group', { name: 'TSK-0002 只有执行扫出来的' })).toBeInTheDocument()

    // 类型筛选交给后端，按 display_kind
    const kinds = screen.getByRole('group', { name: '类型' })
    await userEvent.click(within(kinds).getByRole('button', { name: /^代码/ }))
    await waitFor(() => expect(calls.some((c) => c.startsWith('GET /api/artifacts/by-object') && c.includes('kind=code'))).toBe(true))
    await waitFor(() => expect(screen.queryByRole('group', { name: 'TSK-0001 有提交' })).not.toBeInTheDocument())
    await userEvent.click(within(kinds).getByRole('button', { name: /^全部/ }))

    // 展开看每件产出：提交号、链接新窗口打开
    await userEvent.click(within(await screen.findByRole('group', { name: 'TSK-0001 有提交' })).getByRole('button', { expanded: false }))
    const list = await screen.findByRole('list', { name: 'TSK-0001 的产出物' })
    expect(within(list).getByText('a1b2c3d')).toBeInTheDocument()
    expect(within(list).getByRole('link', { name: '方案页' })).toHaveAttribute('target', '_blank')

    await userEvent.click(screen.getByRole('button', { name: '在任务里看' }))
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    expect(new URLSearchParams(router.state.location.search).get('focus')).toBe('artifacts')
  })
})
