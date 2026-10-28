import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyChange, localDay, type ObjectStatus, type WorkObject } from '../../core/data'
import { todayCardStore } from '../../core/plugin'
import Page from './Page'

const statuses: ObjectStatus[] = [
  { key: 'todo', label: '未开工', color: '', terminal: false },
  { key: 'doing', label: '进行中', color: '', terminal: false },
  { key: 'review', label: '待验收', color: '', terminal: false },
  { key: 'done', label: '已完成', color: '', terminal: true },
]
const terminal = new Set(statuses.filter((s) => s.terminal).map((s) => s.key))
const ago = new Date(Date.now() - 2 * 86400_000).toISOString()
const noon = (d: number) => { const x = new Date(); x.setDate(x.getDate() + d); x.setHours(12, 0, 0, 0); return x.toISOString() }
const prios = [
  { id: 'p0', dict_id: 'priority', type_id: null, key: 'P0', label: '最高', color: '', description: '', sort_order: 10, meta: {}, archived_at: null },
  { id: 'p1', dict_id: 'priority', type_id: null, key: 'P1', label: '高', color: '', description: '', sort_order: 20, meta: {}, archived_at: null },
  { id: 'p2', dict_id: 'priority', type_id: null, key: 'P2', label: '中', color: '', description: '', sort_order: 30, meta: {}, archived_at: null },
]

function task(id: string, title: string, p: Partial<WorkObject> = {}): WorkObject {
  return {
    id, type_id: 'task', ref: 'TSK-' + id.slice(-4), title, body: '', status: 'todo', priority: '', owner: '', owner_id: null,
    category_id: null, project_id: null, source: '', props: null, workdir: '', due_at: null, started_at: null, completed_at: null,
    archived_at: null, deleted_at: null, created_at: ago, updated_at: ago, tags: [], link_count: 0, participants: [], ...p,
  }
}

type Backend = {
  rows: WorkObject[]
  /** 不带 type 的聚合里的插件卡片 */
  pluginCards: { key: string; title: string; order: number; total: number; items: unknown[] }[]
  /** GET /api/plugins */
  plugins: { id: string }[]
  failToday?: boolean
}

// 内存里的后端：聚合、列表都按当前数据现算，改了状态之后再取就是新的
function fakeBackend(b: Backend) {
  const day = localDay(new Date())
  const open = () => b.rows.filter((t) => !terminal.has(t.status))
  const dueDay = (t: WorkObject) => (t.due_at ? localDay(new Date(t.due_at)) : '')
  const json = (data: unknown, meta?: unknown, status = 200) => new Response(JSON.stringify(status === 200 ? { data, meta } : data), { status })
  const card = (key: string, items: unknown[]) => ({ key, title: key, order: 0, total: items.length, items })
  const calls: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input), 'http://x')
    const method = init?.method ?? 'GET'
    calls.push(`${method} ${u.pathname}${u.search}`)
    const m = u.pathname.match(/^\/api\/objects\/([^/]+)(\/progress)?$/)
    if (u.pathname === '/api/today') {
      if (b.failToday) return json({ error: { code: 'internal', message: '聚合挂了' } }, undefined, 500)
      const kernel = [
        card('review', b.rows.filter((t) => t.status === 'review')),
        card('overdue', open().filter((t) => t.due_at && dueDay(t) < day)),
        card('due_today', open().filter((t) => dueDay(t) === day)),
        card('running', []),
      ]
      return json({ cards: u.searchParams.get('type') ? kernel : [...kernel, ...b.pluginCards] })
    }
    if (method === 'PATCH' && m) {
      const t = b.rows.find((r) => r.id === m[1])!
      Object.assign(t, JSON.parse(String(init!.body)))
      return json(t)
    }
    if (method === 'POST' && m?.[2]) {
      const t = b.rows.find((r) => r.id === m[1])!
      t.status = JSON.parse(String(init!.body)).status
      return json({ id: 'prg_1' })
    }
    if (u.pathname === '/api/object-types') return json([{ id: 'task', name: '待办', statuses }])
    if (u.pathname === '/api/dictionaries/priority/items') return json(prios)
    if (u.pathname === '/api/plugins') return json(b.plugins)
    if (u.pathname === '/api/schedules') return json([], { total: 0 })
    if (u.pathname === '/api/objects') {
      if (u.searchParams.get('type') !== 'task') return json([], { total: 0 })
      const pr = (u.searchParams.get('priority') ?? '').split(',').filter(Boolean)
      const out = open().filter((t) => !pr.length || pr.includes(t.priority))
      return json(out, { total: out.length })
    }
    if (m?.[2]) return json([], { total: 0 })
    if (m) return json(b.rows.find((r) => r.id === m[1]))
    if (u.pathname === '/api/artifacts/stats') return json({ total: 0 })
    if (u.pathname.startsWith('/api/agent/workdir')) return json({ path: '', exists: false, is_dir: false, writable: false, message: '' })
    return json([], { total: 0 })
  }))
  return calls
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createMemoryRouter([
    { path: '/today', element: <Page /> },
    { path: '/tasks/*', element: <div>任务页</div> },
  ], { initialEntries: ['/today'] })
  render(<QueryClientProvider client={qc}><RouterProvider router={router} /></QueryClientProvider>)
  return { qc, router }
}

describe('今日页', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    todayCardStore.removeOwner('hello')
    todayCardStore.removeOwner('demo')
  })

  it('今天的任务：逾期、今天截止、高优先级；点任务打开抽屉，点完成后该行消失，不需要刷新', async () => {
    const b: Backend = {
      rows: [
        task('obj_0001', '过期没做的', { due_at: noon(-3) }),
        task('obj_0002', '今天要交的', { due_at: noon(0) }),
        task('obj_0003', '最高优先级', { priority: 'P0' }),
        task('obj_0004', '高优先级在做', { priority: 'P1', status: 'doing' }),
        task('obj_0005', '高优先级没开工', { priority: 'P1' }),
      ],
      pluginCards: [], plugins: [],
    }
    const calls = fakeBackend(b)
    renderPage()

    const sec = await screen.findByRole('region', { name: '今天的任务' })
    const list = await within(sec).findByRole('button', { name: /过期没做的/ })
    expect(within(list).getByText('逾期')).toBeInTheDocument()
    expect(within(sec).getByRole('button', { name: /今天要交的/ })).toHaveTextContent('今天')
    expect(within(sec).getByRole('button', { name: /最高优先级/ })).toBeInTheDocument()
    expect(await within(sec).findByRole('button', { name: /高优先级在做/ })).toHaveTextContent('进行中')
    expect(within(sec).queryByText('高优先级没开工')).not.toBeInTheDocument()
    expect(screen.getByText('个任务逾期').previousSibling).toHaveTextContent('1')

    // 点圆圈以外：在今日页上打开抽屉
    await userEvent.click(within(sec).getByText('今天要交的'))
    const drawer = await screen.findByRole('dialog')
    expect(within(drawer).getByDisplayValue('今天要交的')).toBeInTheDocument()
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

    // 完成圆圈：直接改状态，不打开抽屉
    await userEvent.click(within(sec).getByRole('button', { name: '标为已完成：TSK-0001' }))
    expect(calls).toContain('PATCH /api/objects/obj_0001')
    await waitFor(() => expect(within(sec).queryByText('过期没做的')).not.toBeInTheDocument())
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByText('个任务逾期').previousSibling).toHaveTextContent('0')
  })

  it('任务待验收：组头一直有查看全部，点圆圈先确认，确认后等于验收通过并从列表消失', async () => {
    const b: Backend = {
      rows: [task('obj_0011', '等你看的', { status: 'review', due_at: noon(0) })],
      pluginCards: [], plugins: [],
    }
    const calls = fakeBackend(b)
    renderPage()

    const needs = await screen.findByRole('region', { name: '需要你处理' })
    expect(await within(needs).findByText('TSK-0011 等你看的')).toBeInTheDocument()
    expect(within(needs).getByText('去验收')).toBeInTheDocument()

    const sec = screen.getByRole('region', { name: '今天的任务' })
    await userEvent.click(within(sec).getByRole('button', { name: '验收通过：TSK-0011' }))
    const ask = await screen.findByRole('alertdialog')
    await userEvent.click(within(ask).getByRole('button', { name: '验收通过' }))
    expect(calls).toContain('POST /api/objects/obj_0011/progress')
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
    await waitFor(() => expect(within(sec).queryByText('等你看的')).not.toBeInTheDocument())
    expect(within(needs).getByText('都处理完了')).toBeInTheDocument()
  })

  it('查看全部去任务页并带上待验收筛选', async () => {
    fakeBackend({ rows: [task('obj_0021', '待验收一', { status: 'review' })], pluginCards: [], plugins: [] })
    const { router } = renderPage()
    await userEvent.click(await screen.findByRole('button', { name: '查看全部' }))
    expect(router.state.location.pathname).toBe('/tasks')
    expect(router.state.location.search).toBe('?status=review')
  })

  it('插件卡片按 order 合并；停用插件后对应卡片消失', async () => {
    const b: Backend = {
      rows: [],
      pluginCards: [{ key: 'demo_inbox', title: '示例收件箱', order: 50, total: 2, items: [{ title: '第一条' }, { title: '第二条' }] }],
      plugins: [{ id: 'demo' }],
    }
    fakeBackend(b)
    // 只有前端的插件：接口里没有它的卡片也照常显示
    todayCardStore.add('hello', { key: 'hello_greeting', title: '示例插件', order: 10, plugin: 'hello', render: ({ data }) => <p>{data === undefined ? '没有后端' : '有数据'}</p> })
    // 有后端的插件：前端注册了渲染，用接口给的数据
    todayCardStore.add('demo', { key: 'demo_inbox', title: '示例收件箱', plugin: 'demo', render: ({ data }) => <p>{data ? `共 ${(data as { total: number }).total} 封` : '还没取到'}</p> })
    const { qc } = renderPage()

    const cards = await screen.findByRole('region', { name: '插件卡片' })
    await within(cards).findByText('共 2 封')
    expect(within(cards).getByText('没有后端')).toBeInTheDocument()
    expect(within(cards).getAllByRole('region').map((r) => r.getAttribute('data-card'))).toEqual(['hello_greeting', 'demo_inbox'])

    // 停用 demo：后端不再返回它的卡片，前端撤掉注册；失效规则刷新今日
    b.pluginCards = []
    b.plugins = []
    act(() => { todayCardStore.removeOwner('demo') })
    await act(() => applyChange(qc, { kind: 'plugin' }))
    await waitFor(() => expect(screen.queryByText('共 2 封')).not.toBeInTheDocument())
    expect(screen.getByText('没有后端')).toBeInTheDocument()

    act(() => { todayCardStore.removeOwner('hello') })
    await waitFor(() => expect(screen.queryByRole('region', { name: '插件卡片' })).not.toBeInTheDocument())
  })

  it('后端插件今天没内容时，前端注册的卡片不显示；前端没注册渲染的插件卡片按通用样式显示', async () => {
    fakeBackend({
      rows: [],
      pluginCards: [{ key: 'im_mentions', title: '与我相关', order: 100, total: 3, items: [{ title: '有人提到你' }] }],
      plugins: [{ id: 'demo' }, { id: 'im' }],
    })
    todayCardStore.add('demo', { key: 'demo_inbox', title: '示例收件箱', plugin: 'demo', render: () => <p>不该出现</p> })
    renderPage()
    const cards = await screen.findByRole('region', { name: '插件卡片' })
    expect(await within(cards).findByText('共 3 条')).toBeInTheDocument()
    expect(within(cards).getByText('有人提到你')).toBeInTheDocument()
    expect(screen.queryByText('不该出现')).not.toBeInTheDocument()
  })

  it('聚合接口失败：整页报错带重试，不显示成都处理完了', async () => {
    const b: Backend = { rows: [], pluginCards: [], plugins: [], failToday: true }
    fakeBackend(b)
    renderPage()
    expect(await screen.findByText('今日没加载出来')).toBeInTheDocument()
    expect(screen.queryByText('都处理完了')).not.toBeInTheDocument()
    b.failToday = false
    await userEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(await screen.findByText('都处理完了')).toBeInTheDocument()
    expect(screen.getByText('今天没有要赶的任务')).toBeInTheDocument()
    expect(screen.getByText('今天没有定时任务')).toBeInTheDocument()
  })
})
