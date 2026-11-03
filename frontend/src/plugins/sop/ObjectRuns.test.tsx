import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider, useLocation } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SopFlow, SopRunBrief, WorkObject } from '../../core/data'
import ObjectRuns from './ObjectRuns'

const FLOW: SopFlow = {
  id: 'sop_fb', name: '客户反馈归类', desc: '', trigger: 'manual', version: 1, created_at: '', updated_at: '',
  fields: [
    { key: 'title', label: '标题', type: 'text', required: true },
    { key: 'detail', label: '详情', type: 'textarea' },
    { key: 'owner', label: '负责人', type: 'text' },
  ],
  steps: [{ key: 'sort', name: '归类', kind: 'ai' }, { key: 'check', name: '人工检查', kind: 'review' }],
}
const TASK = {
  id: 'obj_t1', ref: 'TSK-0042', type_id: 'task', title: '整理客户反馈', body: '把上周的反馈归类', status: 'doing', priority: 'P1', owner: '',
  owner_id: 'stk_1', owner_name: '林予安', category_id: null, project_id: null, source: 'manual', props: null, workdir: '', due_at: null,
  started_at: null, completed_at: null, archived_at: null, deleted_at: null, created_at: '', updated_at: '', tags: [], link_count: 0, participants: [],
} as WorkObject
const brief = (id: string, status: SopRunBrief['status'], o: Partial<SopRunBrief> = {}): SopRunBrief => ({
  id, flow_id: 'sop_fb', flow_name: '客户反馈归类', flow_version: 1, title: `客户反馈归类 · ${id}`, step_through: false, stopped: false, status,
  object_id: 'obj_t1', started_at: new Date().toISOString(), updated_at: '', focus: 1,
  steps: [{ key: 'sort', name: '归类', kind: 'ai', status: 'done' }, { key: 'check', name: '人工检查', kind: 'review', status: status === 'done' ? 'done' : 'review' }],
  ...o,
})

function fakeBackend(runs: SopRunBrief[]) {
  const calls: { method: string; path: string; query: string; body?: Record<string, unknown> }[] = []
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(status < 300 ? { data, meta: { total: 0 } } : data), { status })
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input), 'http://x')
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ method, path: u.pathname, query: u.search, body })
    if (u.pathname === '/api/sop/flows') return json([FLOW])
    if (u.pathname === '/api/sop/runs') return json(runs.filter((r) => r.object_id === u.searchParams.get('object_id')))
    if (u.pathname === '/api/sop/flows/sop_fb/runs' && method === 'POST') {
      const r = { ...brief('spr_new', 'waiting'), flow: FLOW, input: body?.input, steps: [] }
      runs.unshift(brief('spr_new', 'waiting'))
      return json(r, 201)
    }
    if (u.pathname === '/api/agents') return json([{ id: 'ag_1', name: '分诊助手', enabled: true }])
    if (u.pathname === '/api/object-types') return json([{ id: 'task', statuses: [{ key: 'doing', label: '进行中' }] }])
    return json([])
  }))
  return calls
}

function Where() {
  const l = useLocation()
  return <div data-testid="where">{l.pathname} back={(l.state as { back?: string } | null)?.back}</div>
}

function mount(focus?: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createMemoryRouter([
    { path: '/tasks', element: <ObjectRuns object={TASK} returnTo="/tasks?t=obj_t1" focus={focus} /> },
    { path: '*', element: <Where /> },
  ], { initialEntries: ['/tasks'] })
  render(<QueryClientProvider client={qc}><RouterProvider router={router} /></QueryClientProvider>)
  return router
}

afterEach(() => vi.unstubAllGlobals())

describe('任务详情里的 SOP 执行（SOP-06）', () => {
  it('按任务取执行，子流程不单列；行上有流程名、状态、进度；点开去运行页，返回回到任务', async () => {
    const calls = fakeBackend([brief('spr_1', 'waiting', { source: 'agent', source_ref: 'ag_1', source_name: '旧名字' }),
      brief('spr_child', 'waiting', { parent_run_id: 'spr_1', source: 'subflow' }), brief('spr_0', 'done', { source: 'manual' }),
      brief('spr_other', 'done', { object_id: 'obj_t2' })])
    const router = mount()
    const region = await screen.findByRole('region', { name: 'SOP 执行' })
    await waitFor(() => expect(region.querySelectorAll('[data-run]')).toHaveLength(2))
    expect(calls.find((c) => c.path === '/api/sop/runs')?.query).toContain('object_id=obj_t1')
    const row = region.querySelector('[data-run="spr_1"]') as HTMLElement
    expect(within(row).getByText('客户反馈归类')).toBeInTheDocument()
    expect(within(row).getByText('待我处理')).toBeInTheDocument()
    // 来源写在进度前面，Agent 名字现查
    expect(await within(row).findByText('Agent：分诊助手 · 1/2 步 · 停在「人工检查」等你处理')).toBeInTheDocument()
    expect(within(region.querySelector('[data-run="spr_0"]') as HTMLElement).getByText('手动 · 2 步全部完成')).toBeInTheDocument()
    await userEvent.click(row)
    expect(router.state.location.pathname).toBe('/sop/runs/spr_1')
    // 返回回到这条任务的 SOP 标签，并定位刚才那次执行
    expect(screen.getByTestId('where').textContent).toContain('back=/tasks?t=obj_t1&tab=sop&sop_run=spr_1')
  })

  it('宿主传来要定位的执行：那一行高亮；定位的是子流程时高亮它的父执行', async () => {
    fakeBackend([brief('spr_1', 'waiting'), brief('spr_child', 'waiting', { parent_run_id: 'spr_1', source: 'subflow' }), brief('spr_0', 'done')])
    mount('spr_child')
    const region = await screen.findByRole('region', { name: 'SOP 执行' })
    await waitFor(() => expect(region.querySelector('[data-run="spr_1"]')).toHaveClass('lit'))
    expect(region.querySelector('[data-run="spr_1"]')).toHaveAttribute('aria-current', 'true')
    expect(region.querySelector('[data-run="spr_0"]')).not.toHaveClass('lit')
  })

  it('没有执行时空状态；「执行 SOP」选流程后按任务预填，发起带 object_id，留在任务里并刷出新的一条', async () => {
    const calls = fakeBackend([])
    mount()
    expect(await screen.findByText('还没有执行过 SOP')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /执行 SOP/ }))
    await userEvent.click(await screen.findByRole('option', { name: /客户反馈归类/ }))
    const dlg = await screen.findByRole('dialog', { name: '执行 客户反馈归类' })
    expect(within(dlg).getByText(/关联任务 TSK-0042 整理客户反馈/)).toBeInTheDocument()
    expect(within(dlg).getByDisplayValue('整理客户反馈')).toBeInTheDocument()
    expect(within(dlg).getByDisplayValue('把上周的反馈归类')).toBeInTheDocument()
    expect(within(dlg).getByDisplayValue('林予安')).toBeInTheDocument()
    await userEvent.click(within(dlg).getByRole('button', { name: '开始执行' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '执行 客户反馈归类' })).toBeNull())
    const post = calls.find((c) => c.method === 'POST')!
    expect(post.body).toEqual({ input: { title: '整理客户反馈', detail: '把上周的反馈归类', owner: '林予安' }, step_through: false, object_id: 'obj_t1' })
    const region = screen.getByRole('region', { name: 'SOP 执行' })
    await waitFor(() => expect(region.querySelector('[data-run="spr_new"]')).not.toBeNull())
  })
})
