// SOP 的定时触发（TSK-0463）：草稿初值、卡片显示、触发方式选项，和编排页里配规则、改回别的触发方式时的确认
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Schedule, SopFlow, SopNodeType } from '../../core/data'
import { describeRule, intervalOf, modeOf, withMode } from '../../core/ui/scheduleRule'
import Page from './Page'
import { draftScheduleOf, fieldsWithoutDefault, scheduleStateOf, triggerOptionsOf } from './schedule'

const RULE = { freq: 'weekly' as const, time: '18:00', weekdays: [1], day: 1, date: '', cron: '' }
const SCHED: Schedule = {
  id: 'sch_1', name: '周报', enabled: true, rule: RULE, action: { kind: 'sop', sop_id: 'sop_w', managed: true },
  next_run_at: '2026-11-09T10:00:00Z', created_at: '', updated_at: '',
}

describe('定时规则：每隔几小时', () => {
  it('存成 cron，按「每隔」显示和编辑', () => {
    const r = withMode({ ...RULE, freq: 'daily' }, 'interval')
    expect(r).toMatchObject({ freq: 'cron', cron: '0 */2 * * *' })
    expect(modeOf(r)).toBe('interval')
    expect(intervalOf({ freq: 'cron', cron: '15 */6 * * *' })).toEqual({ hours: 6, minute: 15 })
    expect(intervalOf({ freq: 'cron', cron: '0 9 * * 1' })).toBeNull()
    expect(describeRule({ ...r, cron: '30 */4 * * *' })).toBe('每隔 4 小时（第 30 分）')
    // 从每隔换到 Cron 不沿用每隔的表达式
    expect(withMode(r, 'cron').cron).toBe('0 9 * * 1')
  })
})

describe('流程的定时', () => {
  const now = new Date('2026-11-05T10:00:00')
  it('草稿初值：有那条定时任务取它的规则；旧的 weekly 没有那条时按每周一 18:00；不是定时的没有', () => {
    expect(draftScheduleOf({ trigger: 'schedule', schedule: SCHED }, now)).toMatchObject({ trigger: 'schedule', sched: { rule: { freq: 'weekly', time: '18:00' }, enabled: true } })
    expect(draftScheduleOf({ trigger: 'weekly', schedule: null }, now)).toMatchObject({ trigger: 'schedule', sched: { rule: { freq: 'weekly', time: '18:00', weekdays: [1] } } })
    expect(draftScheduleOf({ trigger: 'daily', schedule: null }, now)).toMatchObject({ sched: { rule: { freq: 'daily', time: '09:00' } } })
    expect(draftScheduleOf({ trigger: 'schedule', schedule: null }, now)).toEqual({ trigger: 'schedule', sched: undefined })
    expect(draftScheduleOf({ trigger: 'im', schedule: null }, now)).toEqual({ trigger: 'im' })
  })

  it('卡片显示：规则和下次执行；停用；定时没有那一条是「未配置」', () => {
    expect(scheduleStateOf({ trigger: 'manual', schedule: null }, now)).toEqual({ kind: 'none' })
    expect(scheduleStateOf({ trigger: 'schedule', schedule: null }, now)).toEqual({ kind: 'unset' })
    expect(scheduleStateOf({ trigger: 'schedule', schedule: SCHED }, now)).toMatchObject({ kind: 'set', rule: '每周一 18:00', enabled: true })
    expect(scheduleStateOf({ trigger: 'schedule', schedule: { ...SCHED, enabled: false, next_run_at: null } }, now)).toMatchObject({ next: '已停用' })
  })

  it('必填又没默认值的字段', () => {
    expect(fieldsWithoutDefault([
      { key: 'a', label: '周次', type: 'text', required: true },
      { key: 'b', label: '备注', type: 'text', required: true, default: 'x' },
      { key: 'c', label: '可选', type: 'text' },
    ])).toEqual(['周次'])
  })

  it('触发方式选项：旧的定时类不列，正好一项定时', () => {
    expect(triggerOptionsOf([]).map((x) => x.value)).toEqual(['manual', 'im', 'schedule'])
    const items = [{ key: 'manual', label: '手动' }, { key: 'daily', label: '每天 09:00' }, { key: 'weekly', label: '每周一 18:00' }]
    expect(triggerOptionsOf(items)).toEqual([{ value: 'manual', label: '手动' }, { value: 'schedule', label: '定时' }])
    expect(triggerOptionsOf([...items, { key: 'schedule', label: '按时间' }]).filter((x) => x.label.includes('时'))).toEqual([{ value: 'schedule', label: '按时间' }])
  })
})

/* ---------- 编排页 ---------- */

const TYPES: SopNodeType[] = [{ kind: 'auto', group: '基础', branching: false, required: [] }]
const FLOW: SopFlow = {
  id: 'sop_w', name: '周报', desc: '', trigger: 'schedule', version: 2, created_at: '', updated_at: '', schedule: SCHED,
  fields: [{ key: 'week', label: '周次', type: 'text', required: true }],
  steps: [{ key: 'a', name: '整理', kind: 'auto', after: [] }],
  layout: { __start: { x: 60, y: 80 }, a: { x: 400, y: 80 } },
}

type Call = { method: string; path: string; body?: Record<string, unknown> }

function fakeBackend() {
  const calls: Call[] = []
  const flows: SopFlow[] = [structuredClone(FLOW)]
  const json = (data: unknown, status = 200) => new Response(JSON.stringify({ data, meta: Array.isArray(data) ? { total: data.length } : undefined }), { status })
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input), 'http://x')
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ method, path: u.pathname, body })
    if (u.pathname === '/api/sop/node-types') return json(TYPES)
    if (u.pathname === '/api/schedules/preview') return json({ rule: body.rule, next_runs: ['2026-11-06T01:00:00Z', '2026-11-07T01:00:00Z'], time_zone: 'Asia/Shanghai' })
    if (u.pathname === '/api/sop/flows' && method === 'POST') {
      const f = { ...body, id: 'sop_new', version: 1, created_at: '', updated_at: '', schedule: body.schedule ? { ...SCHED, id: 'sch_new', rule: body.schedule.rule } : null }
      return json(f, 201)
    }
    if (u.pathname === '/api/sop/flows') return json(flows)
    const one = u.pathname.match(/^\/api\/sop\/flows\/([^/]+)$/)
    if (one) {
      if (method === 'PATCH') flows[0] = { ...flows[0], ...body, version: flows[0].version + 1, schedule: body.schedule_off === 'delete' ? null : flows[0].schedule }
      return json(flows[0])
    }
    return json([])
  }))
  return calls
}

function renderPage(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createMemoryRouter([{ path: '/sop/*', element: <Page /> }], { initialEntries: [path] })
  render(<QueryClientProvider client={qc}><RouterProvider router={router} /></QueryClientProvider>)
  return router
}

const openStart = async () => fireEvent.keyDown(await screen.findByRole('button', { name: '开始节点' }), { key: 'Enter' })

afterEach(() => vi.unstubAllGlobals())

describe('编排页的定时触发', () => {
  it('开始节点里配规则、预览接下来几次、提示必填没默认值；保存带上 schedule', async () => {
    const user = userEvent.setup()
    const calls = fakeBackend()
    renderPage('/sop/flows/sop_w/edit')
    await openStart()
    const panel = screen.getByRole('complementary', { name: '开始节点' })
    expect(within(panel).getByRole('combobox', { name: '触发方式' })).toHaveValue('schedule')
    expect(within(panel).getByRole('combobox', { name: '频率' })).toHaveValue('weekly')
    expect(within(panel).getByText(/「周次」是必填又没有默认值/)).toBeInTheDocument()
    await waitFor(() => expect(within(panel).getAllByText(/^(今天|明天|周.|\d\d-\d\d) \d\d:\d\d$/).length).toBe(2))
    await user.selectOptions(within(panel).getByRole('combobox', { name: '频率' }), 'monthly')
    await user.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true))
    expect(calls.find((c) => c.method === 'PATCH')!.body).toMatchObject({ trigger: 'schedule', schedule: { rule: { freq: 'monthly', time: '18:00' }, enabled: true } })
  })

  it('从定时改成手动：保存前问停用还是删掉', async () => {
    const user = userEvent.setup()
    const calls = fakeBackend()
    renderPage('/sop/flows/sop_w/edit')
    await openStart()
    const panel = screen.getByRole('complementary', { name: '开始节点' })
    await user.selectOptions(within(panel).getByRole('combobox', { name: '触发方式' }), 'manual')
    await user.click(screen.getByRole('button', { name: '保存' }))
    const dlg = await screen.findByRole('alertdialog', { name: '不再定时执行？' })
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false)
    await user.click(within(dlg).getByRole('radio', { name: /删掉/ }))
    await user.click(within(dlg).getByRole('button', { name: '保存' }))
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true))
    const body = calls.find((c) => c.method === 'PATCH')!.body!
    expect(body).toMatchObject({ trigger: 'manual', schedule_off: 'delete' })
    expect(body.schedule).toBeUndefined()
  })

  it('新建选定时：默认每天 09:00', async () => {
    const user = userEvent.setup()
    const calls = fakeBackend()
    renderPage('/sop/new')
    await openStart()
    const panel = screen.getByRole('complementary', { name: '开始节点' })
    await user.selectOptions(within(panel).getByRole('combobox', { name: '触发方式' }), 'schedule')
    expect(within(panel).getByRole('combobox', { name: '频率' })).toHaveValue('daily')
    await user.click(screen.getByRole('button', { name: '添加节点' }))
    await user.click(within(screen.getByRole('dialog', { name: '选择节点' })).getByRole('button', { name: /自动执行/ }))
    await user.type(screen.getByRole('textbox', { name: 'SOP 名称' }), '早报')
    await user.click(screen.getByRole('button', { name: '发布' }))
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path === '/api/sop/flows')).toBe(true))
    expect(calls.find((c) => c.method === 'POST' && c.path === '/api/sop/flows')!.body).toMatchObject({ trigger: 'schedule', schedule: { rule: { freq: 'daily', time: '09:00' }, enabled: true } })
  })
})
