import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Video, VideoCheckpoint, VideoLastRun } from '../../core/data'
import Page from './Page'

const T = '2026-10-29T08:00:00Z'
const cps = (x: Partial<Record<string, Omit<VideoCheckpoint, 'stage'>>> = {}): VideoCheckpoint[] =>
  (['plan', 'ch1', 'audio', 'distribution'] as const).map((stage) => ({ stage, state: 'pending', ...x[stage] }))
const vid = (x: Partial<Video>): Video => ({
  id: 'a', title: '第 1 集', orientations: ['landscape'], stage: 'web', checkpoints: cps({ plan: { state: 'passed' } }), root: '/tmp/a', chapters: 3,
  runners: [], created_at: T, updated_at: T, ...x,
})

type Call = { method: string; path: string; body?: Record<string, unknown> }

// 内存里的执行器接口：规则照 internal/plugins/video/runners.go 的 putRunner、runBlocked、run
function fakeBackend(seed: Video, opts: { failWith?: string } = {}) {
  const calls: Call[] = []
  const v: Video = { ...seed, runners: [...(seed.runners ?? [])] }
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(status < 300 ? { data, meta: Array.isArray(data) ? { total: data.length } : undefined } : data), { status })
  const err = (status: number, code: string, message: string) => json({ error: { code, message } }, status)
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input), 'http://x')
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ method, path: u.pathname, body })
    if (u.pathname === '/api/objects') return json([])
    if (u.pathname === '/api/video/series') return json([])
    if (u.pathname === '/api/video/artifacts') return json([])
    if (u.pathname === '/api/sop/flows') return json([{ id: 'sop_a', name: '录屏流程', desc: '', trigger: 'manual', fields: [], steps: [], version: 1 }])
    if (u.pathname === '/api/agents') return json([{ id: 'ag_a', name: '剪辑助手', desc: '', color: '#336699', avatar: 'bot' }])
    if (u.pathname === '/api/video/videos') return json([v])
    if (u.pathname === '/api/video/videos/a') return json(v)
    const m = u.pathname.match(/^\/api\/video\/videos\/a\/runners\/([a-z0-9]+)(\/run)?$/)
    if (!m) return err(404, 'not_found', '没有这个接口')
    const stage = m[1] as Video['stage']
    if (!m[2] && method === 'PUT') {
      v.runners = [...(v.runners ?? []).filter((r) => r.stage !== stage), { stage, ...body }]
      return json(v)
    }
    if (!m[2] && method === 'DELETE') {
      v.runners = (v.runners ?? []).filter((r) => r.stage !== stage)
      return json(v)
    }
    if (v.checkpoints.find((c) => c.stage === 'plan')?.state !== 'passed') return err(409, 'conflict', '「规划检查」还没通过，不能开始「网页开发」')
    if (v.last_run?.status === 'running') return err(409, 'conflict', '「网页开发」正在跑，等它跑完再试')
    const r = v.runners?.find((x) => x.stage === stage)
    if (!r) return err(409, 'conflict', '还没配执行器，先配一个再跑')
    if (opts.failWith) {
      v.last_run = { type: 'agent', id: '', stage, status: 'failed', started_at: T, ended_at: T, error: opts.failWith }
      return json(v)
    }
    v.last_run = { type: 'agent', id: 'run_1', stage, status: 'running', started_at: new Date().toISOString(), ref: 'ags_1' }
    return json(v, 202)
  }))
  return { calls, v, finish: (x: Partial<VideoLastRun>) => { v.last_run = { ...v.last_run!, ...x } } }
}

function show(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createMemoryRouter([{ path: '/videos/*', element: <Page /> }, { path: '/conversations', element: <div>会话页</div> }], { initialEntries: [path] })
  render(<QueryClientProvider client={qc}><RouterProvider router={router} /></QueryClientProvider>)
  return router
}

const box = async (stage: string) => screen.findByLabelText(`${stage}的执行器`)

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

describe('阶段执行器', () => {
  it('规划检查通过后：配技能执行器，一键开始网页开发，运行中按钮不可点，能跳到会话', async () => {
    const be = fakeBackend(vid({}))
    const router = show('/videos/v/a')
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: '配执行器' }))
    const edit = await box('网页开发')
    expect(within(edit).getByRole('combobox')).toHaveValue('sk_video')
    await user.type(within(edit).getByPlaceholderText(/按 Phase 1/), '  先做横屏  ')
    await user.click(within(edit).getByRole('button', { name: '保存' }))
    await waitFor(() => expect(be.calls.some((c) => c.method === 'PUT')).toBe(true))
    expect(be.calls.find((c) => c.method === 'PUT')).toMatchObject({ path: '/api/video/videos/a/runners/web', body: { type: 'skill', ref_id: 'sk_video', prompt: '先做横屏' } })

    const card = await box('网页开发')
    expect(within(card).getByText('网页演示做视频')).toBeInTheDocument()
    await user.click(within(card).getByRole('button', { name: '运行' }))
    expect(await within(card).findByRole('button', { name: '运行中…' })).toBeDisabled()
    expect(within(card).getByText(/正在跑，开始于/)).toBeInTheDocument()
    expect(within(card).queryByRole('button', { name: '修改' })).toBeNull()
    expect(be.calls.find((c) => c.path.endsWith('/run'))).toMatchObject({ method: 'POST', body: {} })

    await user.click(within(card).getByRole('button', { name: '打开会话' }))
    expect(router.state.location.pathname).toBe('/conversations')
    expect(router.state.location.search).toBe('?s=ags_1')
  })

  it('在跑时轮询，跑完显示登记了几个产出物', async () => {
    const be = fakeBackend(vid({ runners: [{ stage: 'web', type: 'skill', ref_id: 'sk_video' }] }))
    show('/videos/v/a')
    const user = userEvent.setup()
    const card = await box('网页开发')
    await user.click(within(card).getByRole('button', { name: '运行' }))
    await within(card).findByText(/正在跑/)
    be.finish({ status: 'done', ended_at: new Date().toISOString(), artifact_ids: ['vaf_1'] })
    expect(await within(card).findByText(/登记了 1 个产出物，待验收/, undefined, { timeout: 5000 })).toBeInTheDocument()
    expect(within(card).getByRole('button', { name: '运行' })).toBeEnabled()
  }, 10000)

  it('发起时就失败：显示原因，按钮变成重试', async () => {
    fakeBackend(vid({ runners: [{ stage: 'web', type: 'skill', ref_id: 'sk_video' }] }), { failWith: '还没确认 process:spawn 权限' })
    show('/videos/v/a')
    const user = userEvent.setup()
    const card = await box('网页开发')
    await user.click(within(card).getByRole('button', { name: '运行' }))
    expect(await within(card).findByText(/运行失败：还没确认 process:spawn 权限/)).toBeInTheDocument()
    expect(within(card).getByRole('button', { name: '重试' })).toBeEnabled()
  })

  it('前置检查不过（409）照后端原文提示', async () => {
    fakeBackend(vid({ checkpoints: cps(), runners: [{ stage: 'web', type: 'skill', ref_id: 'sk_video' }] }))
    show('/videos/v/a')
    const user = userEvent.setup()
    const card = await box('网页开发')
    await user.click(within(card).getByRole('button', { name: '运行' }))
    expect(await within(card).findByRole('alert')).toHaveTextContent('「规划检查」还没通过，不能开始「网页开发」')
  })

  it('换成 SOP、Agent 从后端列表里挑；不用执行器就删掉', async () => {
    const be = fakeBackend(vid({ runners: [{ stage: 'web', type: 'agent', ref_id: '剪辑助手' }] }))
    show('/videos/v/a')
    const user = userEvent.setup()
    let card = await box('网页开发')
    // ref_id 是名称也认得
    expect(await within(card).findByText('剪辑助手')).toBeInTheDocument()
    await user.click(within(card).getByRole('button', { name: '修改' }))
    card = await box('网页开发')
    expect(within(card).getByRole('combobox')).toHaveValue('ag_a')
    await user.click(within(card).getByRole('button', { name: 'SOP' }))
    expect(within(card).getByRole('combobox')).toHaveValue('sop_a')
    await user.click(within(card).getByRole('button', { name: '不用执行器' }))
    await waitFor(() => expect(be.calls.some((c) => c.method === 'DELETE')).toBe(true))
    expect(await screen.findByRole('button', { name: '配执行器' })).toBeInTheDocument()
  })

  it('不是当前阶段的不给运行；已删除的执行器写明', async () => {
    fakeBackend(vid({ stage: 'script', checkpoints: cps(), runners: [{ stage: 'web', type: 'agent', ref_id: 'ag_gone' }] }))
    show('/videos/v/a')
    const card = await box('网页开发')
    expect(await within(card).findByText('已删除的Agent')).toBeInTheDocument()
    expect(within(card).queryByRole('button', { name: '运行' })).toBeNull()
    await act(async () => {})
  })
})
