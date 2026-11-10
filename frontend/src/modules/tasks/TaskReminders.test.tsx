// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Schedule, WorkObject } from '../../core/data'
import { TaskReminders } from './TaskReminders'

const at = new Date().toISOString()
const task = {
  id: 'obj_1', type_id: 'task', ref: 'TSK-0001', title: '导出改成分批写', body: '', status: 'todo', priority: '', owner: '', owner_id: null,
  category_id: null, project_id: null, source: '', props: {}, workdir: '', due_at: null, started_at: null, completed_at: null, archived_at: null,
  deleted_at: null, created_at: at, updated_at: at, tags: [], link_count: 0, participants: [],
} as WorkObject

const tomorrow = new Date(Date.now() + 86400_000)
const pad = (n: number) => String(n).padStart(2, '0')
const ymd = `${tomorrow.getFullYear()}-${pad(tomorrow.getMonth() + 1)}-${pad(tomorrow.getDate())}`

function sched(p: Partial<Schedule>): Schedule {
  return {
    id: 'sch_1', name: '提醒：问报价', enabled: true, rule: { freq: 'once', time: '15:00', weekdays: [], day: 1, date: ymd, cron: '' },
    action: { kind: 'remind', title: '问报价', body: '', object_id: 'obj_1' }, project_id: null, next_run_at: `${ymd}T15:00:00+08:00`, created_at: at, updated_at: at, ...p,
  }
}

function setup(rows: Schedule[]) {
  const json = (data: unknown, status = 200) => new Response(JSON.stringify({ data }), { status })
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input), 'http://x')
    const method = init?.method ?? 'GET'
    if (u.pathname === '/api/schedules' && method === 'GET') return json(u.searchParams.get('object_id') === 'obj_1' ? rows : [])
    if (u.pathname === '/api/schedules' && method === 'POST') {
      const body = JSON.parse(String(init?.body)) as Schedule
      return json({ ...body, id: 'sch_new', next_run_at: null, created_at: at, updated_at: at }, 201)
    }
    if (method === 'DELETE') return json(null)
    return json([])
  })
  vi.stubGlobal('fetch', fn)
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={qc}><TaskReminders task={task} /></QueryClientProvider>)
  return { fn, region: screen.getByRole('region', { name: '提醒' }) }
}

const calls = (fn: ReturnType<typeof vi.fn>, method: string) =>
  fn.mock.calls.filter(([, init]) => ((init as RequestInit | undefined)?.method ?? 'GET') === method)

afterEach(() => { vi.unstubAllGlobals() })

describe('任务抽屉里的提醒', () => {
  it('按任务查已有的提醒，能取消', async () => {
    const { fn, region } = setup([sched({}), sched({ id: 'sch_2', action: { kind: 'remind', title: '跟进', body: '', object_id: 'obj_1' }, enabled: false, next_run_at: null,
      rule: { freq: 'once', time: '09:00', weekdays: [], day: 1, date: '2026-01-01', cron: '' } })])
    expect(await within(region).findByText('问报价')).toBeInTheDocument()
    expect(within(region).getByText('明天 15:00')).toBeInTheDocument()
    expect(within(region).getByText('跟进')).toBeInTheDocument()
    const u = new URL(String(calls(fn, 'GET').find(([i]) => String(i).startsWith('/api/schedules?'))![0]), 'http://x')
    expect(u.searchParams.get('object_id')).toBe('obj_1')

    await userEvent.click(within(region).getByRole('button', { name: '取消' }))
    await waitFor(() => expect(calls(fn, 'DELETE')).toHaveLength(1))
    expect(String(calls(fn, 'DELETE')[0][0])).toBe('/api/schedules/sch_1')
  })

  it('「设个提醒」默认任务标题、明天 09:00，提交只提醒一次并关联这条任务', async () => {
    const { fn, region } = setup([])
    expect(await within(region).findByText(/还没有提醒/)).toBeInTheDocument()
    await userEvent.click(within(region).getByRole('button', { name: '设个提醒' }))
    const title = within(region).getByRole('textbox', { name: /提醒标题/ })
    expect(title).toHaveValue('导出改成分批写')
    expect(within(region).getByLabelText('提醒日期')).toHaveValue(ymd)
    expect(within(region).getByLabelText('提醒时间')).toHaveValue('09:00')

    // 标题清空不让设
    await userEvent.clear(title)
    await userEvent.click(within(region).getByRole('button', { name: '设好了' }))
    expect(within(region).getByText('提醒标题必填')).toBeInTheDocument()
    expect(calls(fn, 'POST')).toHaveLength(0)

    await userEvent.type(title, '问后端排期')
    await userEvent.click(within(region).getByRole('button', { name: '设好了' }))
    await waitFor(() => expect(calls(fn, 'POST')).toHaveLength(1))
    const body = JSON.parse(String((calls(fn, 'POST')[0][1] as RequestInit).body))
    expect(body).toMatchObject({
      name: '提醒：问后端排期', enabled: true, rule: { freq: 'once', date: ymd, time: '09:00' },
      action: { kind: 'remind', title: '问后端排期', body: '', object_id: 'obj_1' },
    })
    await waitFor(() => expect(within(region).queryByRole('button', { name: '设好了' })).not.toBeInTheDocument())
  })
})
