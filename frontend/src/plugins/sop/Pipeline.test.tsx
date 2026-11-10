// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider, useLocation } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SopPipeline, WorkObject } from '../../core/data'
import Pipeline from './Pipeline'

const TASK = {
  id: 'obj_t1', ref: 'TSK-0042', type_id: 'task', title: '登录页加验证码', body: '', status: 'doing', priority: 'P1', owner: '', owner_id: null,
  category_id: null, project_id: null, source: 'im', props: { stage: 'developing' }, workdir: '', due_at: null, started_at: null, completed_at: null,
  archived_at: null, deleted_at: null, created_at: '', updated_at: '', tags: [], link_count: 0, participants: [],
} as WorkObject

const T0 = Date.now() - 3 * 3600_000
const at = (min: number) => new Date(T0 + min * 60_000).toISOString()

// 审计接口给的是最近的在前
const AUDITS = [
  { id: 'au3', at: at(90), kind: 'stage', action: 'stage_change', actor: 'sop#spr_1', detail: { from: 'reviewing', to: 'developing' } },
  { id: 'au2', at: at(30), kind: 'stage', action: 'stage_change', actor: 'sop#spr_1', detail: { from: 'received', to: 'reviewing' } },
  { id: 'au1', at: at(0), kind: 'stage', action: 'stage_change', actor: 'im', detail: { from: '', to: 'received' } },
]

const PIPE: SopPipeline = {
  task_id: 'obj_t1',
  budget: { claude_runs: 30, claude_minutes: 412, max_runs: 30, max_minutes: 1440 },
  claude: [],
  runs: [{
    id: 'spr_1', flow_id: 'sop_im_dev_pipeline', flow_name: '研发 pipeline', title: '研发 pipeline · TSK-0042', status: 'waiting', started_at: at(91),
    steps: [
      { key: 'review', name: '研发评审', kind: 'claude_code', status: 'done', attempts: 3, round: 3, started_at: at(40), ended_at: at(85) },
      { key: 'dev', name: '研发', kind: 'claude_code', status: 'paused', attempts: 0, started_at: at(95),
        hold: { kind: 'runs', reason: '需求 TSK-0042 已经跑了 30 次 Claude Code，到了上限 30 次', since: at(95) } },
      { key: 'test', name: '跑测试', kind: 'projects_run_test', status: 'failed', attempts: 2, started_at: at(96), ended_at: at(97),
        error: '测试超时没跑完' },
    ],
  }],
  blockers: [
    { run_id: 'spr_1', run_title: '研发 pipeline · TSK-0042', flow_id: 'sop_im_dev_pipeline', flow_name: '研发 pipeline', step_key: 'dev',
      step_name: '研发', step_kind: 'claude_code', step_status: 'paused', wait: 'hold', reason: '需求 TSK-0042 已经跑了 30 次 Claude Code，到了上限 30 次',
      since: at(95), task_id: 'obj_t1' },
    { run_id: 'spr_1', run_title: '研发 pipeline · TSK-0042', flow_id: 'sop_im_dev_pipeline', flow_name: '研发 pipeline', step_key: 'accept',
      step_name: '人工验收', step_kind: 'decide', step_status: 'review', wait: 'decide', reason: '等人工判断走哪个分支', since: at(96), task_id: 'obj_t1',
      cases: [{ key: 'pass', label: '通过' }, { key: 'defect', label: '实现缺陷' }] },
  ],
}

function fakeBackend(o: { audits?: unknown; pipe?: SopPipeline } = {}) {
  const calls: { method: string; path: string; query: string; body?: Record<string, unknown> }[] = []
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(status < 300 ? { data, meta: { total: 0 } } : data), { status })
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input), 'http://x')
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ method, path: u.pathname, query: u.search, body })
    if (u.pathname === '/api/audits') return o.audits === 'off' ? json({ error: { code: 'internal', message: 'audit log is not configured on this server' } }, 500) : json(AUDITS)
    if (u.pathname === '/api/sop/pipeline/obj_t1') return json(o.pipe ?? PIPE)
    if (u.pathname === '/api/sop/runs/spr_1/actions') return json({ id: 'spr_1', flow: { steps: [] }, steps: [] })
    return json([])
  }))
  return calls
}

function Where() {
  const l = useLocation()
  return <div data-testid="where">{l.pathname} back={(l.state as { back?: string } | null)?.back}</div>
}

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createMemoryRouter([
    { path: '/tasks', element: <Pipeline object={TASK} returnTo="/tasks?t=obj_t1" /> },
    { path: '*', element: <Where /> },
  ], { initialEntries: ['/tasks'] })
  render(<QueryClientProvider client={qc}><RouterProvider router={router} /></QueryClientProvider>)
  return router
}

afterEach(() => vi.unstubAllGlobals())

describe('任务详情的流水线（SPEC-sop-16）', () => {
  it('阶段变化取审计 kind=stage，和执行、步骤合成一条时间线；阶段耗时、轮次、重试、预算都显示', async () => {
    const calls = fakeBackend()
    mount()
    const list = await screen.findByRole('list', { name: '时间线' })
    expect(calls.find((c) => c.path === '/api/audits')?.query).toContain('target_id=obj_t1')
    expect(calls.find((c) => c.path === '/api/audits')?.query).toContain('kind=stage')
    const items = within(list).getAllByRole('listitem').map((li) => li.textContent ?? '')
    // 早的在前：已接收 → 评审中 → 评审那一步 → 开发中 → 执行开始 → 研发 → 跑测试
    expect(items[0]).toContain('已接收')
    expect(items[0]).toContain('停留 30 分钟')
    expect(items[1]).toContain('已接收 → 评审中')
    expect(items[2]).toContain('研发评审')
    expect(items[2]).toContain('第 3 轮')
    expect(items[3]).toContain('开发中')
    expect(items[3]).toContain('已停留')
    expect(items[4]).toContain('执行「研发 pipeline」开始')
    expect(items[5]).toContain('超出上限暂停')
    expect(items[6]).toContain('重试 1 次')
    expect(items[6]).toContain('测试超时没跑完')
    const stages = screen.getByLabelText('阶段耗时')
    expect(stages).toHaveTextContent('已接收30 分钟评审中1 小时开发中')
    expect(screen.getByLabelText('预算')).toHaveTextContent('Claude Code 已跑 30 次 / 上限 30 次，累计 412 分钟 / 上限 1440 分钟')
  })

  it('卡点能直接处理：超出上限点放行发 confirm-input，人工判断按分支发 route；去执行页带返回地址', async () => {
    const calls = fakeBackend()
    const router = mount()
    const blocks = await screen.findByLabelText('卡点')
    expect(within(blocks).getByText('超出上限暂停')).toBeInTheDocument()
    await userEvent.click(within(blocks).getByRole('button', { name: '放行这一次' }))
    await waitFor(() => expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ kind: 'confirm-input', step: 'dev' }))
    await userEvent.click(within(blocks).getByRole('button', { name: '走「实现缺陷」' }))
    await waitFor(() => expect(calls.filter((c) => c.method === 'POST')[1]?.body).toEqual({ kind: 'route', step: 'accept', route: 'defect' }))
    await userEvent.click(within(blocks).getAllByRole('button', { name: '去执行页' })[0])
    await waitFor(() => expect(router.state.location.pathname).toBe('/sop/runs/spr_1'))
    expect(screen.getByTestId('where')).toHaveTextContent('back=/tasks?t=obj_t1&tab=pipeline')
  })

  it('没开审计时只列自动执行；没有任何记录时说还没进流水线', async () => {
    fakeBackend({ audits: 'off', pipe: { ...PIPE, runs: [], blockers: [], budget: { claude_runs: 0, claude_minutes: 0, max_runs: 30, max_minutes: 0 } } })
    mount()
    expect(await screen.findByText(/没开审计，看不到阶段变化/)).toBeInTheDocument()
    expect(screen.queryByLabelText('预算')).toBeNull()
  })
})
