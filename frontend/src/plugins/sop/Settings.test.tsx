import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMemoryRouter, RouterProvider } from 'react-router'
import type { SopRun } from '../../core/data'
import { RunView } from './RunView'
import SopSettingsSection from './Settings'
import { SOP_SETTINGS_PATH, isQueued, runStepLook } from './model'

afterEach(() => vi.unstubAllGlobals())

describe('设置 > SOP 编排（SOP-07）', () => {
  it('读出上限和此刻的排队数，改了按契约 PATCH', async () => {
    const calls: { method: string; body: unknown }[] = []
    let cur = { model_concurrency: 2, running: 2, queued: 5, claude_concurrency: 3, claude_running: 0, claude_queued: 0, task_max_claude_runs: 30, task_max_claude_minutes: 1440, token_limit_supported: false }
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      const body = init?.body ? JSON.parse(String(init.body)) : undefined
      calls.push({ method, body })
      if (method === 'PATCH') cur = { ...cur, ...body }
      return new Response(JSON.stringify({ data: cur }))
    }))
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<QueryClientProvider client={qc}><SopSettingsSection /></QueryClientProvider>)
    const input = await screen.findByRole('spinbutton', { name: '同时调模型的步骤数' })
    expect(input).toHaveValue(2)
    expect(screen.getByText(/2 个步骤在调模型，5 个在排队/)).toBeInTheDocument()
    expect(screen.getByText(/本机推理慢时调小，消息多时多出来的步骤排队/)).toBeInTheDocument()
    const save = within(screen.getByRole('form', { name: '同时调模型的步骤数' })).getByRole('button', { name: '保存' })
    expect(save).toBeDisabled()
    await userEvent.clear(input)
    await userEvent.type(input, '1')
    await userEvent.click(save)
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('最多同时 1 个步骤调模型'))
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ model_concurrency: 1 })
  })
})

describe('设置 > SOP 编排 > 流水线治理（AUTO-12）', () => {
  it('读出 Claude Code 并发、每需求次数和时长上限，各自保存；0 是不限；说明 token 不支持', async () => {
    const calls: { method: string; body: unknown }[] = []
    let cur = { model_concurrency: 2, running: 0, queued: 0, claude_concurrency: 3, claude_running: 3, claude_queued: 2,
      task_max_claude_runs: 30, task_max_claude_minutes: 1440, token_limit_supported: false }
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      const body = init?.body ? JSON.parse(String(init.body)) : undefined
      calls.push({ method, body })
      if (method === 'PATCH' && body.task_max_claude_runs === 2000) {
        return new Response(JSON.stringify({ error: { code: 'validation', message: 'task_max_claude_runs 要是 0 到 1000 的整数' } }), { status: 400 })
      }
      if (method === 'PATCH') cur = { ...cur, ...body }
      return new Response(JSON.stringify({ data: cur }))
    }))
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<QueryClientProvider client={qc}><SopSettingsSection /></QueryClientProvider>)
    expect(await screen.findByRole('spinbutton', { name: '同时跑的 Claude Code 步骤数' })).toHaveValue(3)
    expect(screen.getByText(/3 个 Claude Code 步骤在跑，2 个在排队/)).toBeInTheDocument()
    expect(screen.getByLabelText('token 上限')).toHaveTextContent('只按次数和时长控制')

    const runs = screen.getByRole('form', { name: '每个需求最多跑 Claude Code 的次数' })
    const runsInput = within(runs).getByRole('spinbutton')
    expect(runsInput).toHaveValue(30)
    await userEvent.clear(runsInput)
    await userEvent.type(runsInput, '0')
    await userEvent.click(within(runs).getByRole('button', { name: '保存' }))
    await waitFor(() => expect(within(runs).getByRole('status')).toHaveTextContent('每个需求最多 不限'))
    expect(calls.filter((c) => c.method === 'PATCH').at(-1)?.body).toEqual({ task_max_claude_runs: 0 })

    await userEvent.clear(runsInput)
    await userEvent.type(runsInput, '2000')
    await userEvent.click(within(runs).getByRole('button', { name: '保存' }))
    await waitFor(() => expect(within(runs).getByRole('alert')).toHaveTextContent('0 到 1000 的整数'))

    const mins = screen.getByRole('form', { name: '每个需求 Claude Code 累计时长上限' })
    await userEvent.clear(within(mins).getByRole('spinbutton'))
    await userEvent.type(within(mins).getByRole('spinbutton'), '90')
    await userEvent.click(within(mins).getByRole('button', { name: '保存' }))
    await waitFor(() => expect(within(mins).getByRole('status')).toHaveTextContent('累计最多 90 分钟'))
  })
})

describe('排队中的步骤', () => {
  it('running 且带 queue 才算排队，显示「排队中」', () => {
    expect(isQueued({ status: 'running', queue: { ahead: 0 } })).toBe(true)
    expect(isQueued({ status: 'running' })).toBe(false)
    expect(isQueued({ status: 'done', queue: { ahead: 1 } })).toBe(false)
    expect(runStepLook({ status: 'running', queue: { ahead: 3 } }).label).toBe('排队中')
    expect(runStepLook({ status: 'running' }).label).toBe('执行中')
    expect(runStepLook({ status: 'paused', hold: { kind: 'runs', reason: 'x', since: '' } }).label).toBe('超出上限')
    expect(runStepLook({ status: 'paused', hold: { kind: 'runs', reason: 'x', since: '', released: true } }).label).toBe('待确认输入')
  })
})

describe('运行页里排队中的步骤', () => {
  it('流程图和检查器都显示「排队中」，带去设置的入口', async () => {
    const run: SopRun = {
      id: 'spr_1', flow_id: 'sop_a', flow_name: '消息分流', flow_version: 1, title: '消息分流 · x', input: {}, step_through: false, stopped: false,
      status: 'running', source: 'im', started_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      flow: { id: 'sop_a', name: '消息分流', desc: '', trigger: 'IM', fields: [], version: 1, created_at: '', updated_at: '',
        steps: [{ key: 'c', name: '分类', kind: 'ai' }] },
      steps: [{ key: 'c', status: 'running', input: {}, output: null, attempts: 1, queue: { ahead: 4 },
        log: [{ at: new Date().toISOString(), text: '排队等模型（前面还有 4 个）' }] }],
    }
    const router = createMemoryRouter([
      { path: '/sop/*', element: <RunView run={run} onBack={() => {}} onAct={async () => {}} onRerun={() => {}} busy={false} branching={() => false} /> },
      { path: '/settings/*', element: <div>设置页</div> },
    ], { initialEntries: ['/sop/runs/spr_1'] })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: [], meta: { total: 0 } }))))
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<QueryClientProvider client={qc}><RouterProvider router={router} /></QueryClientProvider>)
    expect(screen.getByRole('button', { name: /步骤 1 分类，排队中/ })).toBeInTheDocument()
    expect(screen.getByText(/前面还有 4 个/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '调整同时调模型的步骤数' }))
    await waitFor(() => expect(router.state.location.pathname).toBe(SOP_SETTINGS_PATH))
  })
})

describe('运行页里超出上限暂停的步骤（AUTO-12）', () => {
  it('显示原因，能放行这一次（confirm-input）、跳过、去设置调上限；排 Claude Code 名额时文案不同', async () => {
    const now = new Date().toISOString()
    const run: SopRun = {
      id: 'spr_1', flow_id: 'sop_p', flow_name: '研发 pipeline', flow_version: 1, title: '研发 pipeline · x', input: {}, step_through: false, stopped: false,
      status: 'waiting', source: 'manual', started_at: now, updated_at: now,
      flow: { id: 'sop_p', name: '研发 pipeline', desc: '', trigger: 'manual', fields: [], version: 1, created_at: '', updated_at: '',
        steps: [{ key: 'dev', name: '研发', kind: 'claude_code' }, { key: 'cases', name: '测试用例', kind: 'claude_code' }] },
      steps: [
        { key: 'dev', status: 'paused', input: {}, output: null, attempts: 0, log: [],
          hold: { kind: 'duration', reason: '需求 TSK-0001 Claude Code 累计跑了 1450 分钟，到了上限 1440 分钟', since: now } },
        { key: 'cases', status: 'running', input: {}, output: null, attempts: 1, log: [], queue: { ahead: 1, slot: 'claude_code' } },
      ],
    }
    const acts: unknown[] = []
    const router = createMemoryRouter([
      { path: '/sop/*', element: <RunView run={run} onBack={() => {}} onAct={async (a) => { acts.push(a) }} onRerun={() => {}} busy={false} branching={() => false} /> },
      { path: '/settings/*', element: <div>设置页</div> },
    ], { initialEntries: ['/sop/runs/spr_1'] })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: [], meta: { total: 0 } }))))
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<QueryClientProvider client={qc}><RouterProvider router={router} /></QueryClientProvider>)
    expect(screen.getByRole('button', { name: /步骤 1 研发，超出上限/ })).toBeInTheDocument()
    expect(screen.getByText(/累计跑了 1450 分钟/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '放行这一次' }))
    expect(acts).toEqual([{ kind: 'confirm-input', step: 0 }])
    await userEvent.click(screen.getByRole('button', { name: /步骤 2 测试用例/ }))
    expect(screen.getByText(/在等 Claude Code 名额，前面还有 1 个/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '调整同时跑的 Claude Code 步骤数' }))
    await waitFor(() => expect(router.state.location.pathname).toBe(SOP_SETTINGS_PATH))
  })
})
