import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { reminderTask, type AppNotification } from '../data'
import { ReminderPopups } from './ReminderPopups'

const at = new Date().toISOString()
const note = (p: Partial<AppNotification>): AppNotification => ({
  id: 'ntf_1', at, kind: 'schedule.remind', level: 'info', title: '回电话', body: '给客户回电话', object_id: 'obj_1',
  data: { schedule_id: 'sch_1', run_id: 'srn_1', object_id: 'obj_1', type_id: 'task', ref: 'TSK-0001' }, read_at: null, ...p,
})

function setup(list: AppNotification[], onOpenTask = vi.fn()) {
  const json = (data: unknown) => new Response(JSON.stringify({ data, meta: { total: data instanceof Array ? data.length : 0 } }), { status: 200 })
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input), 'http://x')
    if (u.pathname === '/api/notifications') return json(list)
    if (init?.method === 'POST') return json(list[0])
    return json([])
  })
  vi.stubGlobal('fetch', fn)
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={qc}><ReminderPopups onOpenTask={onOpenTask} /></QueryClientProvider>)
  return { fn, onOpenTask }
}

afterEach(() => { vi.unstubAllGlobals() })

describe('提醒弹窗', () => {
  it('只弹没看的提醒；点「打开任务」打开关联的任务并标已读', async () => {
    const { fn, onOpenTask } = setup([note({}), note({ id: 'ntf_2', kind: 'run.finished', title: 'TSK-0002 执行完成' })])
    const card = await screen.findByRole('alert')
    expect(within(card).getByText('回电话')).toBeInTheDocument()
    expect(within(card).getByText('给客户回电话')).toBeInTheDocument()
    expect(screen.queryByText('TSK-0002 执行完成')).not.toBeInTheDocument()
    const u = new URL(String(fn.mock.calls[0][0]), 'http://x')
    expect(u.searchParams.get('unread')).toBe('true')

    await userEvent.click(within(card).getByRole('button', { name: '打开任务 TSK-0001' }))
    expect(onOpenTask).toHaveBeenCalledWith('obj_1')
    await waitFor(() => expect(fn.mock.calls.some(([i, init]) => String(i) === '/api/notifications/ntf_1/read' && (init as RequestInit).method === 'POST')).toBe(true))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('「知道了」只标已读；没关联任务的不给打开', async () => {
    const { fn } = setup([note({ object_id: '', data: { schedule_id: 'sch_2' }, title: '喝水', body: '' })])
    const card = await screen.findByRole('alert')
    expect(within(card).queryByRole('button', { name: /打开任务/ })).not.toBeInTheDocument()
    await userEvent.click(within(card).getAllByRole('button', { name: '知道了' })[1])
    await waitFor(() => expect(fn.mock.calls.some(([i]) => String(i) === '/api/notifications/ntf_1/read')).toBe(true))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('关联的不是任务时不给跳转', () => {
    expect(reminderTask(note({}))).toEqual({ id: 'obj_1', ref: 'TSK-0001' })
    expect(reminderTask(note({ data: { type_id: 'requirement' } }))).toBeNull()
    expect(reminderTask(note({ object_id: '' }))).toBeNull()
  })
})
