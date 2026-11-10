// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IncidentsSection } from './IncidentsSection'

const ago = (m: number) => new Date(Date.now() - m * 60_000).toISOString()
const inc = (id: string, over: Record<string, unknown> = {}) => ({
  id, fingerprint: `front:tasks:route:${id}`, level: 'error', module: '任务', title: `标题 ${id}`, message: `描述 ${id}`,
  context: { 页面: '/tasks', 构建: 'index-abc.js' }, stack: 'TypeError: boom\n    at x (a.js:1)', status: 'open', note: '', count: 2,
  first_at: ago(120), last_at: ago(10), occurrences: [ago(10), ago(120)], task_id: null, source: 'frontend', ...over,
})
const prios = ['P0', 'P1', 'P2', 'P3'].map((key, i) => ({ id: `d${i}`, dict_id: 'priority', key, label: key, color: '', sort_order: i, archived_at: null, meta: {} }))
const statuses = [
  { key: 'todo', label: '待办', color: '', terminal: false }, { key: 'done', label: '已完成', color: '', terminal: true },
]

type Call = { method: string; path: string; body: unknown }
let calls: Call[]
let incidents: ReturnType<typeof inc>[]
let schedules: unknown[]
let failTask = false

beforeEach(() => {
  calls = []
  failTask = false
  schedules = []
  incidents = [
    inc('inc_a', { title: '打开任务页报错', count: 6 }),
    inc('inc_b', { level: 'warn', title: '同步慢', module: '连接器', fingerprint: 'conn:c1:sync' }),
    inc('inc_c', { status: 'tasked', task_id: 'obj_t1', title: '已转的' }),
    inc('inc_d', { status: 'ignored', title: '忽略的' }),
    inc('inc_e', { title: '原型崩了', module: '项目原型', fingerprint: 'proto:p1:crash', last_at: ago(5) }),
    inc('inc_f', { title: 'Claude Code 执行失败', module: 'Claude Code', fingerprint: 'claude:obj_1:failed', status: 'resolved' }),
  ]
  vi.stubGlobal('fetch', vi.fn((url: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(url), 'http://x')
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ method, path: u.pathname, body })
    const ok = (data: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify({ data, meta: Array.isArray(data) ? { total: data.length } : undefined }), { status }))
    const m = u.pathname.match(/^\/api\/incidents\/([^/]+)(\/task)?$/)
    if (u.pathname === '/api/incidents') return ok(incidents)
    if (m && method === 'PATCH') {
      const x = incidents.find((i) => i.id === m[1])!
      Object.assign(x, { status: body.status, note: '' })
      return ok(x)
    }
    if (m?.[2] && method === 'POST') {
      if (failTask) return Promise.resolve(new Response(JSON.stringify({ error: { code: 'internal', message: '库被锁了' } }), { status: 500 }))
      const x = incidents.find((i) => i.id === m[1])!
      Object.assign(x, { status: 'tasked', task_id: 'obj_new' })
      return ok({ incident: x, task: { id: 'obj_new', ref: 'TSK-0099' } }, 201)
    }
    if (u.pathname === '/api/schedules' && method === 'POST') {
      const s = { id: 'sch_new', ...body, next_run_at: null, created_at: '', updated_at: '' }
      schedules = [s]
      return ok(s, 201)
    }
    if (u.pathname === '/api/schedules') return ok(schedules)
    if (u.pathname === '/api/object-types') return ok([{ id: 'task', name: '待办', statuses }])
    if (u.pathname === '/api/objects/obj_t1') return ok({ id: 'obj_t1', ref: 'TSK-0007', title: '修任务页', status: 'done' })
    if (u.pathname === '/api/objects/obj_new') return ok({ id: 'obj_new', ref: 'TSK-0099', title: '新任务', status: 'todo' })
    if (u.pathname === '/api/dictionaries/priority/items') return ok(prios)
    if (u.pathname === '/api/stakeholders') return ok([])
    return new Promise<Response>(() => {})
  }))
})
afterEach(() => { vi.unstubAllGlobals() })

function renderSection(path = '/settings/incidents') {
  const router = createMemoryRouter([
    { path: '/settings/*', element: <IncidentsSection /> },
    { path: '/tasks/*', element: <div>任务页</div> },
  ], { initialEntries: [path] })
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return router
}

const table = () => document.querySelector('.inc-table') as HTMLElement
const rowOf = (title: string) => screen.getByText(title).closest('.inc-row') as HTMLElement

describe('设置 / 运行异常列表（SPEC-settings-18）', () => {
  it('顶栏数字、默认只看未处理、各状态带数量，最近的在前', async () => {
    renderSection()
    await screen.findByText('打开任务页报错')
    expect(screen.getByText('3 个未处理，2 个是错误')).toBeInTheDocument()
    const titles = [...table().querySelectorAll('.inc-row:not(.inc-th) .inc-title')].map((x) => x.textContent)
    expect(titles).toEqual(['原型崩了', '打开任务页报错', '同步慢'])
    const seg = screen.getByRole('group', { name: '状态' })
    expect(within(seg).getByRole('button', { name: /已转任务/ })).toHaveTextContent('1')
    await userEvent.click(within(seg).getByRole('button', { name: /全部/ }))
    expect(screen.getByText('忽略的')).toBeInTheDocument()
    // 已转任务的行写任务编号，任务完成了加「已完成」
    expect(await within(rowOf('已转的')).findByText('TSK-0007 已完成')).toBeInTheDocument()
    // 次数 5 次以上标热
    expect(within(rowOf('打开任务页报错')).getByText('6')).toHaveClass('hot')
  })

  it('级别、模块、搜索筛选；筛空写「没有匹配的异常」', async () => {
    renderSection()
    await screen.findByText('打开任务页报错')
    await userEvent.click(within(screen.getByRole('group', { name: '级别' })).getByRole('button', { name: '警告' }))
    expect(screen.queryByText('打开任务页报错')).toBeNull()
    expect(screen.getByText('同步慢')).toBeInTheDocument()
    await userEvent.click(within(screen.getByRole('group', { name: '级别' })).getByRole('button', { name: '全部级别' }))
    // 模块下拉：已知模块按顺序在前，页面所属模块在后
    const sel = screen.getByRole('combobox', { name: '模块' })
    expect([...sel.querySelectorAll('option')].map((o) => o.textContent)).toEqual(['全部模块', '连接器', '项目原型', 'Claude Code', '任务'])
    await userEvent.selectOptions(sel, '项目原型')
    expect(screen.getByText('原型崩了')).toBeInTheDocument()
    expect(screen.queryByText('同步慢')).toBeNull()
    await userEvent.selectOptions(sel, '')
    await userEvent.type(screen.getByRole('searchbox', { name: '搜索异常' }), '不存在的')
    expect(screen.getByText('没有匹配的异常')).toBeInTheDocument()
  })

  it('未处理为空时写「没有未处理的异常」', async () => {
    incidents = [inc('inc_x', { status: 'resolved', title: '修好的' })]
    renderSection()
    expect(await screen.findByText('没有未处理的异常')).toBeInTheDocument()
    expect(screen.getByText('0 个未处理')).toBeInTheDocument()
  })

  it('同模块同指纹前缀到 5 条合并成一行，点开展开', async () => {
    incidents = Array.from({ length: 5 }, (_, i) => inc(`c${i}`, { module: '连接器', fingerprint: `conn:c${i}:auth`, title: `连接器 ${i} 连接失败`, last_at: ago(i + 1) }))
    renderSection()
    const g = await screen.findByText('连接器 · 5 条')
    expect(screen.getByText('最近：连接器 0 连接失败')).toBeInTheDocument()
    expect(screen.queryByText('连接器 3 连接失败')).toBeNull()
    await userEvent.click(g)
    expect(screen.getByText('连接器 3 连接失败')).toBeInTheDocument()
  })
})

describe('运行异常抽屉（SPEC-settings-19）', () => {
  it('看详情、忽略', async () => {
    renderSection()
    await userEvent.click(await screen.findByText('打开任务页报错'))
    const d = await screen.findByRole('dialog', { name: '运行异常 打开任务页报错' })
    expect(within(d).getByText(/任务 · 错误 · 共 6 次/)).toBeInTheDocument()
    expect(within(d).getByText('index-abc.js')).toBeInTheDocument()
    expect(within(d).getByText(/TypeError: boom/)).toBeInTheDocument()
    await userEvent.click(within(d).getByRole('button', { name: '忽略' }))
    await waitFor(() => expect(calls).toContainEqual({ method: 'PATCH', path: '/api/incidents/inc_a', body: { status: 'ignored' } }))
  })

  it('转研发任务：标题、描述、优先级预填，建任务调转任务接口', async () => {
    renderSection()
    await userEvent.click(await screen.findByText('打开任务页报错'))
    const d = await screen.findByRole('dialog', { name: '运行异常 打开任务页报错' })
    await userEvent.click(within(d).getByRole('button', { name: '转为研发任务' }))
    expect(within(d).getByDisplayValue('[异常] 任务：打开任务页报错')).toBeInTheDocument()
    const desc = within(d).getByLabelText('描述') as HTMLTextAreaElement
    expect(desc.value).toMatch(/^【运行异常】任务 · 错误/)
    expect(desc.value).toMatch(/期望：系统能自己处理这种情况/)
    // 错误 5 次以上预填 P0
    await waitFor(() => expect(within(d).getByRole('radio', { name: 'P0' })).toHaveAttribute('aria-checked', 'true'))
    await userEvent.click(within(d).getByRole('button', { name: '建任务' }))
    await waitFor(() => expect(calls.find((c) => c.method === 'POST' && c.path === '/api/incidents/inc_a/task')?.body).toMatchObject({
      title: '[异常] 任务：打开任务页报错', priority: 'P0',
    }))
  })

  it('建任务失败：表单不收起，红字写原因', async () => {
    failTask = true
    renderSection()
    await userEvent.click(await screen.findByText('打开任务页报错'))
    const d = await screen.findByRole('dialog', { name: '运行异常 打开任务页报错' })
    await userEvent.click(within(d).getByRole('button', { name: '转为研发任务' }))
    await userEvent.click(within(d).getByRole('button', { name: '建任务' }))
    expect(await within(d).findByText(/没建成任务：.*库被锁了/)).toBeInTheDocument()
    expect(within(d).getByRole('button', { name: '建任务' })).toBeInTheDocument()
  })

  it('已转任务且任务已完成：提示标为已解决；已忽略的能重新打开', async () => {
    const router = renderSection('/settings/incidents?open=inc_c')
    const d = await screen.findByRole('dialog', { name: '运行异常 已转的' })
    expect(await within(d).findByText('TSK-0007 修任务页')).toBeInTheDocument()
    expect(within(d).getByText(/任务已经完成了/)).toBeInTheDocument()
    expect(within(d).queryByRole('button', { name: '转为研发任务' })).toBeNull()
    // 打开过就从地址里去掉 open
    await waitFor(() => expect(router.state.location.search).toBe(''))
    await userEvent.click(within(d).getByRole('button', { name: '打开任务' }))
    expect(router.state.location.pathname).toBe('/tasks')
    expect(router.state.location.search).toBe('?t=obj_t1')
  })

  it('已忽略的写「再次出现时会重新打开」，重新打开回到未处理', async () => {
    renderSection('/settings/incidents?open=inc_d')
    const d = await screen.findByRole('dialog', { name: '运行异常 忽略的' })
    expect(within(d).getByText('已忽略：再次出现时会重新打开')).toBeInTheDocument()
    await userEvent.click(within(d).getByRole('button', { name: '重新打开' }))
    await waitFor(() => expect(calls).toContainEqual({ method: 'PATCH', path: '/api/incidents/inc_d', body: { status: 'open' } }))
  })

  it('打开的异常不存在：抽屉不打开', async () => {
    renderSection('/settings/incidents?open=inc_nope')
    await screen.findByText('打开任务页报错')
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe('自动巡检', () => {
  it('没有巡检定时任务：一键开启，按每天 9:00、只看错误建一条', async () => {
    renderSection()
    await userEvent.click(await screen.findByRole('button', { name: '开启自动巡检' }))
    await waitFor(() => expect(calls.find((c) => c.method === 'POST' && c.path === '/api/schedules')?.body).toMatchObject({
      name: '运行异常巡检', enabled: true, rule: { freq: 'daily', time: '09:00' }, action: { kind: 'incident_sweep', min_level: 'error', min_count: 1 },
    }))
    const bar = await screen.findByText('自动巡检：每天 09:00，只看错误')
    expect(bar.closest('[data-testid="incident-sweep"]')!.querySelector('a')).toHaveAttribute('href', '/tasks/schedules?open=sch_new')
  })

  it('已有巡检定时任务：写条件，给去定时任务页的链接', async () => {
    schedules = [{
      id: 'sch_1', name: '巡检', enabled: true, rule: { freq: 'weekly', time: '10:00', weekdays: [1] },
      action: { kind: 'incident_sweep', min_level: 'warn', min_count: 3 }, next_run_at: null, created_at: '', updated_at: '',
    }]
    renderSection()
    expect(await screen.findByText('自动巡检：每周一 10:00，错误和警告，至少 3 次')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '开启自动巡检' })).toBeNull()
  })
})
