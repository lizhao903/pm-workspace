import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ObjectStatus, Schedule, ScheduleRun } from '../../core/data'
import Page from './Page'

const statuses: ObjectStatus[] = [
  { key: 'todo', label: '待办', color: '', terminal: false },
  { key: 'done', label: '已完成', color: '', terminal: true },
]
const later = (d: number) => new Date(Date.now() + d * 86400_000).toISOString()

function sch(id: string, name: string, p: Partial<Schedule> = {}): Schedule {
  return {
    id, name, enabled: true, rule: { freq: 'weekly', time: '09:00', weekdays: [1], day: 1, date: '', cron: '' },
    action: { kind: 'task', title: '整理周会议程', desc: '', priority: 'P2', assignee: '', due_days: 0 },
    next_run_at: later(3), created_at: '', updated_at: '', ...p,
  }
}

// 内存里的后端：定时任务、执行记录、预览，立即执行时记一条并「建出」任务
function fakeBackend(rows: Schedule[], runs: Record<string, ScheduleRun[]> = {}) {
  const json = (data: unknown, meta?: unknown, status = 200) => new Response(JSON.stringify({ data, meta }), { status })
  const calls: string[] = []
  let n = 0
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input), 'http://x')
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push(`${method} ${u.pathname}`)
    if (u.pathname === '/api/object-types') return json([{ id: 'task', name: '任务', statuses }])
    if (u.pathname === '/api/counts') return json({ overdue: 0, by_type: {}, total: 0 })
    if (u.pathname === '/api/schedules/preview') return json({ rule: body.rule, next_runs: [later(4), later(11), later(18)], time_zone: 'Asia/Shanghai' })
    if (u.pathname === '/api/schedules' && method === 'POST') {
      const s = sch(`sch_new${++n}`, body.name, { ...body, next_run_at: later(4) })
      rows.unshift(s)
      return json(s, undefined, 201)
    }
    if (u.pathname === '/api/schedules') return json(rows, { total: rows.length })
    const m = u.pathname.match(/^\/api\/schedules\/([^/]+)(\/runs|\/run)?$/)
    if (m) {
      const s = rows.find((r) => r.id === m[1])!
      if (method === 'PATCH') { Object.assign(s, body); return json(s) }
      if (m[2] === '/runs') return json((runs[s.id] ?? []).slice(0, Number(u.searchParams.get('limit') ?? 50)))
      if (m[2] === '/run') {
        const r: ScheduleRun = {
          id: `srn_${++n}`, schedule_id: s.id, at: new Date().toISOString(), status: 'ok', ok: true, text: '建了任务 TSK-0099', manual: true,
          missed: 0, object_id: 'obj_99', ref: 'TSK-0099', started_at: '', finished_at: '',
        }
        runs[s.id] = [r, ...(runs[s.id] ?? [])]
        return json(r, undefined, 201)
      }
      return json(s)
    }
    return json([], { total: 0 })
  }))
  return calls
}

function renderPage(path = '/tasks/schedules') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createMemoryRouter([{ path: '/tasks/*', element: <Page /> }], { initialEntries: [path] })
  return render(<QueryClientProvider client={qc}><RouterProvider router={router} /></QueryClientProvider>)
}

describe('定时任务页（TASK-04a）', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('列表：启用的在上、停用的收在「已停用」段，行尾开关立刻启停', async () => {
    const calls = fakeBackend([sch('sch_a', '周会前整理议程'), sch('sch_b', '合同续签提醒', { enabled: false, next_run_at: null })])
    renderPage()
    expect(await screen.findByText('周会前整理议程')).toBeInTheDocument()
    expect(screen.getByText('每周一 09:00')).toBeInTheDocument()
    expect(screen.queryByText('合同续签提醒')).not.toBeInTheDocument()
    expect(within(screen.getByRole('group', { name: '已停用' })).getByText('1')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('checkbox', { name: '启用「周会前整理议程」' }))
    expect(calls).toContain('PATCH /api/schedules/sch_a')
    // 停用后移到收起的段里
    await waitFor(() => expect(screen.queryByText('周会前整理议程')).not.toBeInTheDocument())
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    // 搜索时停用的也展开
    await userEvent.type(screen.getByRole('searchbox', { name: '搜索定时任务' }), '合同')
    expect(await screen.findByText('合同续签提醒')).toBeInTheDocument()
  })

  it('新建：必填项挡住，填好后创建，抽屉切到这条的查看状态', async () => {
    const calls = fakeBackend([])
    renderPage()
    expect(await screen.findByText('还没有定时任务')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '新建定时任务' }))
    const drawer = await screen.findByRole('dialog', { name: '新建定时任务' })
    await userEvent.click(within(drawer).getByRole('button', { name: '创建' }))
    expect(within(drawer).getAllByText('名称必填').length).toBeGreaterThan(0)
    expect(calls).not.toContain('POST /api/schedules')

    await userEvent.type(within(drawer).getByPlaceholderText('比如：周会前整理议程'), '写周报')
    await userEvent.type(within(drawer).getByPlaceholderText('比如：整理 {{date}} 周会议程'), '本周周报')
    expect(await within(drawer).findByText(/每周一 09:00，接下来/)).toBeInTheDocument()
    await userEvent.click(within(drawer).getByRole('button', { name: '创建' }))
    expect(calls).toContain('POST /api/schedules')
    const view = await screen.findByRole('dialog', { name: '定时任务 写周报' })
    expect(within(view).getByText('还没执行过')).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: '写周报' })).toBeInTheDocument()
  })

  it('立即执行一次：执行记录多一条带「手动」，建出的任务编号可点', async () => {
    const calls = fakeBackend([sch('sch_a', '周会前整理议程')])
    renderPage('/tasks/schedules?open=sch_a')
    const drawer = await screen.findByRole('dialog', { name: '定时任务 周会前整理议程' })
    expect(await within(drawer).findByText('还没执行过')).toBeInTheDocument()
    await userEvent.click(within(drawer).getByRole('button', { name: '立即执行一次' }))
    expect(calls).toContain('POST /api/schedules/sch_a/run')
    expect(await within(drawer).findByRole('button', { name: 'TSK-0099' })).toBeInTheDocument()
    expect(within(drawer).getByText('手动')).toBeInTheDocument()
    expect(within(drawer).getByText('1 次')).toBeInTheDocument()
  })

  it('有没保存的改动时先保存再执行', async () => {
    const calls = fakeBackend([sch('sch_a', '周会前整理议程')])
    renderPage('/tasks/schedules?open=sch_a')
    const drawer = await screen.findByRole('dialog', { name: '定时任务 周会前整理议程' })
    await userEvent.click(within(drawer).getByRole('radio', { name: '每天' }))
    await userEvent.click(within(drawer).getByRole('button', { name: '保存并执行一次' }))
    await waitFor(() => expect(calls).toContain('POST /api/schedules/sch_a/run'))
    expect(calls.indexOf('PATCH /api/schedules/sch_a')).toBeLessThan(calls.indexOf('POST /api/schedules/sch_a/run'))
  })
})
