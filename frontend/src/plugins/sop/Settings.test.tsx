import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
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
    let cur = { model_concurrency: 2, running: 2, queued: 5 }
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
    const save = screen.getByRole('button', { name: '保存' })
    expect(save).toBeDisabled()
    await userEvent.clear(input)
    await userEvent.type(input, '1')
    await userEvent.click(save)
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('最多同时 1 个步骤调模型'))
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ model_concurrency: 1 })
  })
})

describe('排队中的步骤', () => {
  it('running 且带 queue 才算排队，显示「排队中」', () => {
    expect(isQueued({ status: 'running', queue: { ahead: 0 } })).toBe(true)
    expect(isQueued({ status: 'running' })).toBe(false)
    expect(isQueued({ status: 'done', queue: { ahead: 1 } })).toBe(false)
    expect(runStepLook({ status: 'running', queue: { ahead: 3 } }).label).toBe('排队中')
    expect(runStepLook({ status: 'running' }).label).toBe('执行中')
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
