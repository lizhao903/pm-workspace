// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider, useLocation } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SopFlow, SopRunBrief, WorkObject } from '../../core/data'
import { SopTab } from './SopTab'

const flow = (id: string, name: string, desc = ''): SopFlow => ({ id, name, desc, trigger: '', fields: [], steps: [], version: 1, created_at: '', updated_at: '' })
const FLOWS = [flow('sop_week', '周会纪要', '会后整理纪要'), flow('sop_fb', '客户反馈转需求'), flow('sop_rel', '发版检查')]
const run = (id: string, flow_id: string, status: SopRunBrief['status'], started_at: string): SopRunBrief => ({
  id, flow_id, flow_name: flow_id, flow_version: 1, title: `执行 ${id}`, step_through: false, stopped: false, status,
  started_at, updated_at: started_at, focus: 0, steps: [],
})

function project(sop_ids: unknown): WorkObject {
  return {
    id: 'obj_p', ref: 'PRJ-1', type_id: 'project', title: '工作台', body: '', status: 'active', priority: '', owner: '', owner_id: null,
    category_id: null, project_id: null, source: 'manual', props: { color: '#3d4fd6', sop_ids }, workdir: '', due_at: null, started_at: null,
    completed_at: null, archived_at: null, deleted_at: null, created_at: '', updated_at: '', tags: [], link_count: 0, participants: [],
  } as WorkObject
}

/** inputs：按执行 id 给输入，假后端按 input_key / input_value 筛（同契约） */
function fakeBackend(p: WorkObject, opts: { sop?: boolean; runs?: SopRunBrief[]; flows?: SopFlow[]; inputs?: Record<string, Record<string, string>> } = {}) {
  const calls: { method: string; path: string; body?: Record<string, unknown> }[] = []
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(status < 300 ? { data, meta: {} } : data), { status })
  const on = opts.sop ?? true
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input), 'http://x')
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ method, path: u.pathname, body })
    if (u.pathname === '/api/plugins') return json([{ id: 'sop', running: on, enabled: on, installed: on }])
    if (u.pathname.startsWith('/api/sop/') && !on) return json({ error: { code: 'not_found', message: 'plugin' } }, 404)
    if (u.pathname === '/api/sop/flows') return json(opts.flows ?? FLOWS)
    if (u.pathname === '/api/sop/runs') {
      const key = u.searchParams.get('input_key')
      if (!key) return json(opts.runs ?? [])
      const vals = (u.searchParams.get('input_value') ?? '').split(',')
      return json((opts.runs ?? []).filter((r) => vals.includes(opts.inputs?.[r.id]?.[key] ?? '\u0000')))
    }
    if (u.pathname === `/api/objects/${p.id}`) {
      if (method === 'PATCH') Object.assign(p, body)
      return json(p)
    }
    return json({ error: { code: 'not_found', message: u.pathname } }, 404)
  }))
  return calls
}

function Where() {
  const l = useLocation()
  return <div data-testid="where">{l.pathname + l.search + ((l.state as { back?: string } | null)?.back ? ` back=${(l.state as { back: string }).back}` : '')}</div>
}

function mount(p: WorkObject) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createMemoryRouter([
    { path: '/projects/*', element: <SopTab project={p} /> },
    { path: '*', element: <Where /> },
  ], { initialEntries: ['/projects/obj_p/sop'] })
  render(<QueryClientProvider client={qc}><RouterProvider router={router} /></QueryClientProvider>)
  return router
}

afterEach(() => vi.unstubAllGlobals())

describe('项目的 SOP 标签', () => {
  it('没关联时空状态；从下拉关联一个，存进 props.sop_ids 末尾，别的 props 不动', async () => {
    const p = project(undefined)
    const calls = fakeBackend(p)
    mount(p)
    expect(await screen.findByText('还没关联 SOP')).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: '最近执行' })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: /关联 SOP/ }))
    await userEvent.click(await screen.findByRole('option', { name: /客户反馈转需求/ }))
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true))
    const patch = calls.find((c) => c.method === 'PATCH')!
    expect(patch.body?.props).toEqual({ color: '#3d4fd6', sop_ids: ['sop_fb'] })
  })

  it('列关联的流程（已删的跳过），取消关联立即存；最近执行只算关联的流程', async () => {
    const p = project(['sop_week', 'sop_gone', 'sop_fb'])
    const calls = fakeBackend(p, { runs: [
      run('spr_1', 'sop_week', 'waiting', '2026-10-29T00:00:00Z'), run('spr_2', 'sop_rel', 'done', '2026-10-29T01:00:00Z'),
      run('spr_3', 'sop_fb', 'failed', '2026-10-28T00:00:00Z'),
    ] })
    mount(p)
    const list = await screen.findByRole('list', { name: '关联的 SOP' })
    expect(within(list).getAllByRole('listitem').map((x) => x.querySelector('b')?.textContent)).toEqual(['周会纪要', '客户反馈转需求'])
    expect(within(list).getByText('会后整理纪要')).toBeInTheDocument()

    const recent = await screen.findByRole('region', { name: '最近执行' })
    const rows = within(recent).getAllByRole('button')
    expect(rows.map((b) => b.textContent)).toEqual([expect.stringContaining('执行 spr_1'), expect.stringContaining('执行 spr_3')])
    expect(within(recent).getByText('待我处理')).toBeInTheDocument()
    expect(within(recent).getByText('失败')).toBeInTheDocument()

    const fb = within(list).getAllByRole('listitem')[1]
    await userEvent.click(within(fb).getByRole('button', { name: '取消关联' }))
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true))
    expect(calls.find((c) => c.method === 'PATCH')!.body?.props).toEqual({ color: '#3d4fd6', sop_ids: ['sop_week', 'sop_gone'] })
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
  })

  it('都已关联时下拉提示；点「执行」去流程详情并带 start=1', async () => {
    const p = project(['sop_week', 'sop_fb', 'sop_rel'])
    fakeBackend(p)
    mount(p)
    await screen.findByRole('list', { name: '关联的 SOP' })
    await userEvent.click(screen.getByRole('button', { name: /关联 SOP/ }))
    expect(await screen.findByText('SOP 都已经关联了')).toBeInTheDocument()
    await userEvent.keyboard('{Escape}')
    const first = screen.getAllByRole('listitem')[0]
    await userEvent.click(within(first).getByRole('button', { name: '执行' }))
    expect(screen.getByTestId('where')).toHaveTextContent('/sop/flows/sop_week?start=1')
  })

  it('点名称去流程详情，点执行记录去运行页并记下来处', async () => {
    const p = project(['sop_week'])
    fakeBackend(p, { runs: [run('spr_1', 'sop_week', 'done', '2026-10-29T00:00:00Z')] })
    const router = mount(p)
    await userEvent.click(await screen.findByRole('button', { name: /执行 spr_1/ }))
    expect(screen.getByTestId('where')).toHaveTextContent('/sop/runs/spr_1 back=/projects/obj_p/sop')
    await router.navigate('/projects/obj_p/sop')
    await userEvent.click(await screen.findByRole('button', { name: /周会纪要/ }))
    expect(screen.getByTestId('where')).toHaveTextContent(/^\/sop\/flows\/sop_week$/)
  })

  it('SOP 插件没启用时提示去插件管理', async () => {
    const p = project(['sop_week'])
    fakeBackend(p, { sop: false })
    mount(p)
    expect(await screen.findByText('SOP 编排插件还没启用')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /关联 SOP/ })).toBeNull()
  })
})

describe('项目 SOP 标签的自动反向关联', () => {
  const auto = [
    flow('sop_week', '周会纪要'),
    // 流程里写了本项目的编号
    { ...flow('sop_def', '读项目档案'), steps: [{ key: 'a', name: '读档案', kind: 'projects_get_profile', config: { project: 'PRJ-1' } }] } as SopFlow,
    // 编号只是前缀相同，不算
    { ...flow('sop_near', '别的项目'), steps: [{ key: 'a', name: 'x', kind: 'ai', config: { project: 'PRJ-10' } }] } as SopFlow,
    flow('sop_name', '工作台 · 按生产代码更新原型'),
    flow('sop_namex', '工作台周报'),
    flow('sop_ran', '发版检查'),
    flow('sop_obj', '客户回访'),
  ]

  it('没手动关联的流程按引用、执行、流程名自动列出并写明原因；前缀相同的编号、名字没分隔的不算', async () => {
    const p = project(['sop_week'])
    fakeBackend(p, {
      flows: auto,
      runs: [run('spr_in', 'sop_ran', 'done', '2026-10-29T00:00:00Z'), { ...run('spr_ob', 'sop_obj', 'done', '2026-10-28T00:00:00Z'), object_id: 'obj_p' }],
      inputs: { spr_in: { project_id: 'PRJ-1' } },
    })
    mount(p)
    const list = await screen.findByRole('list', { name: '关联的 SOP' })
    await waitFor(() => expect(within(list).getAllByRole('listitem')).toHaveLength(5))
    const items = within(list).getAllByRole('listitem')
    expect(items.map((x) => x.querySelector('b')?.firstChild?.textContent)).toEqual(['周会纪要', '读项目档案', '工作台 · 按生产代码更新原型', '发版检查', '客户回访'])
    expect(within(items[0]).queryByText('自动')).toBeNull()
    expect(within(items[1]).getByText('流程里引用了本项目')).toBeInTheDocument()
    expect(within(items[2]).getByText('流程名以项目名开头')).toBeInTheDocument()
    expect(within(items[3]).getByText('执行时用的是本项目')).toBeInTheDocument()
    expect(within(items[4]).getByText('执行时用的是本项目')).toBeInTheDocument()
    // 自动关联的流程的执行也进最近执行
    const recent = await screen.findByRole('region', { name: '最近执行' })
    expect(within(recent).getAllByRole('button').map((b) => b.textContent)).toEqual([expect.stringContaining('spr_in'), expect.stringContaining('spr_ob')])
  })

  it('固定关联进 sop_ids；不自动关联进 sop_ids_hidden，能一键恢复', async () => {
    const p = project(['sop_week'])
    const calls = fakeBackend(p, { flows: auto })
    mount(p)
    const list = await screen.findByRole('list', { name: '关联的 SOP' })
    const item = (name: string) => within(list).getAllByRole('listitem').find((li) => li.textContent?.includes(name))!
    await waitFor(() => expect(item('读项目档案')).toBeTruthy())
    await userEvent.click(within(item('读项目档案')).getByRole('button', { name: '固定关联' }))
    await waitFor(() => expect(calls.filter((c) => c.method === 'PATCH')).toHaveLength(1))
    expect(calls.filter((c) => c.method === 'PATCH').at(-1)!.body?.props).toMatchObject({ sop_ids: ['sop_week', 'sop_def'] })

    await userEvent.click(within(item('工作台 · 按生产代码更新原型')).getByRole('button', { name: '不自动关联' }))
    await waitFor(() => expect(calls.filter((c) => c.method === 'PATCH')).toHaveLength(2))
    expect(calls.filter((c) => c.method === 'PATCH').at(-1)!.body?.props).toMatchObject({ sop_ids_hidden: ['sop_name'] })
    expect(await screen.findByText(/1 个流程设成了不自动关联/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '恢复' }))
    await waitFor(() => expect(calls.filter((c) => c.method === 'PATCH')).toHaveLength(3))
    expect(calls.filter((c) => c.method === 'PATCH').at(-1)!.body?.props).toMatchObject({ sop_ids_hidden: [] })
  })
})
