import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SopFlow, SopRun, SopRunBrief, SopStepStatus } from '../../core/data'
import Page from './Page'

const FLOW: SopFlow = {
  id: 'sop_fb', name: '客户反馈转需求', desc: '把反馈提炼成诉求', trigger: '手动', version: 1, created_at: '', updated_at: '',
  fields: [{ key: 'customer', label: '客户', type: 'text', required: true }, { key: 'message', label: '反馈原文', type: 'textarea' }],
  steps: [
    { key: 'extract', name: '整理反馈', kind: 'template', config: { template: '{{customer}}' } },
    { key: 'confirm', name: '确认诉求清单', kind: 'review' },
    { key: 'end', name: '结束', kind: 'end' },
  ],
}

type Call = { method: string; path: string; body?: Record<string, unknown> }

// 内存里的极简引擎：发起后第一步完成，停在人工检查；放行后跑完
function fakeBackend(opts: { flows?: SopFlow[]; failAct?: boolean } = {}) {
  const calls: Call[] = []
  const runs: SopRun[] = []
  const flows = opts.flows ?? [FLOW]
  const now = () => new Date().toISOString()
  const status = (r: SopRun) => {
    const ss = r.steps.map((s) => s.status)
    if (r.stopped) return 'stopped' as const
    if (ss.includes('failed')) return 'failed' as const
    if (ss.includes('review') || ss.includes('paused')) return 'waiting' as const
    if (ss.every((s) => s === 'done')) return 'done' as const
    return 'running' as const
  }
  const brief = (r: SopRun): SopRunBrief => ({
    id: r.id, flow_id: r.flow_id, flow_name: r.flow_name, flow_version: 1, title: r.title, step_through: r.step_through, stopped: r.stopped,
    status: r.status, started_at: r.started_at, updated_at: r.updated_at, focus: Math.max(0, r.steps.findIndex((s) => s.status === 'review')),
    steps: r.steps.map((s, i) => ({ key: s.key, name: r.flow.steps[i].name, kind: r.flow.steps[i].kind, status: s.status })),
  })
  const json = (data: unknown, status = 200, meta?: unknown) => new Response(JSON.stringify(status < 300 ? { data, meta } : data), { status })
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input), 'http://x')
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ method, path: u.pathname, body })
    if (u.pathname === '/api/sop/flows') return json(flows, 200, { total: flows.length })
    if (u.pathname === '/api/sop/node-types') return json([{ kind: 'decide', group: '逻辑', branching: true, required: [] }])
    if (u.pathname === '/api/sop/runs') return json(runs.map(brief), 200, { total: runs.length })
    const start = u.pathname.match(/^\/api\/sop\/flows\/([^/]+)\/runs$/)
    if (start && method === 'POST') {
      const f = flows.find((x) => x.id === start[1])!
      const st: SopStepStatus[] = ['done', 'review', 'pending']
      const r: SopRun = {
        id: `spr_${runs.length + 1}`, flow_id: f.id, flow_name: f.name, flow_version: 1, flow: f, title: `${f.name} · ${body.input.customer}`,
        input: body.input, step_through: !!body.step_through, stopped: false, status: 'waiting', started_at: now(), updated_at: now(),
        steps: f.steps.map((s, i) => ({
          key: s.key, status: st[i], input: i < 2 ? { text: body.input.customer } : null, output: i < 2 ? { text: body.input.customer } : null,
          attempts: i < 2 ? 1 : 0, log: i === 1 ? [{ at: now(), text: '已就绪，等待人工检查' }] : [], started_at: i < 2 ? now() : undefined,
        })),
      }
      r.status = status(r)
      runs.unshift(r)
      return json(r, 201)
    }
    const one = u.pathname.match(/^\/api\/sop\/runs\/([^/]+)(\/actions)?$/)
    if (one) {
      const r = runs.find((x) => x.id === one[1])
      if (!r) return json({ error: { code: 'not_found', message: '执行不存在' } }, 404)
      if (one[2]) {
        if (opts.failAct) return json({ error: { code: 'conflict', message: '步骤状态不对' } }, 409)
        if (body.kind === 'approve') {
          r.steps[1] = { ...r.steps[1], status: 'done', output: body.output ?? r.steps[1].output, edited: body.output ? 'output' : undefined }
          r.steps[2] = { ...r.steps[2], status: 'done', input: r.steps[1].output, output: r.steps[1].output, attempts: 1 }
          r.ended_at = now()
        }
        if (body.kind === 'stop') { r.stopped = true; r.ended_at = now(); r.steps[1].status = 'pending' }
        r.status = status(r)
      }
      return json(r)
    }
    return json({ error: { code: 'not_found', message: u.pathname } }, 404)
  }))
  return { calls, runs }
}

function renderPage(path = '/sop') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createMemoryRouter([{ path: '/sop/*', element: <Page /> }], { initialEntries: [path] })
  render(<QueryClientProvider client={qc}><RouterProvider router={router} /></QueryClientProvider>)
  return router
}

afterEach(() => vi.unstubAllGlobals())

describe('SOP 页面', () => {
  it('没有执行时是执行记录的空状态，菜单有三个视图', async () => {
    fakeBackend()
    renderPage()
    expect(await screen.findByText('没有执行记录')).toBeInTheDocument()
    const nav = screen.getByRole('navigation', { name: 'SOP' })
    expect(within(nav).getByRole('button', { name: /执行记录/ })).toHaveAttribute('aria-current', 'page')
    expect(within(nav).getByRole('button', { name: /流程库.*1 个标准流程/ })).toBeInTheDocument()
  })

  it('流程库点卡片进详情，执行：必填没填不发起，填了发起并打开运行页，放行后跑完', async () => {
    const user = userEvent.setup()
    const { calls } = fakeBackend()
    const router = renderPage('/sop/library')
    await user.click(await screen.findByRole('button', { name: /客户反馈转需求/ }))
    expect(router.state.location.pathname).toBe('/sop/flows/sop_fb')
    expect(await screen.findByText('客户（必填）')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '执行' }))
    const drawer = await screen.findByRole('dialog', { name: '执行 客户反馈转需求' })
    await user.click(within(drawer).getByRole('button', { name: '开始执行' }))
    expect(within(drawer).getByText('必填')).toBeInTheDocument()
    expect(calls.some((c) => c.method === 'POST')).toBe(false)

    await user.type(within(drawer).getByRole('textbox', { name: /客户/ }), '梁晚晴')
    await user.click(within(drawer).getByRole('button', { name: '开始执行' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/sop/runs/spr_1'))
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ input: { customer: '梁晚晴', message: '' }, step_through: false })

    // 停在人工检查
    expect(await screen.findByText('需要你检查')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '通过，继续执行' }))
    await waitFor(() => expect(screen.queryByText('需要你检查')).not.toBeInTheDocument())
    expect(calls.find((c) => c.path.endsWith('/actions'))?.body).toEqual({ kind: 'approve', step: 1 })
    expect(await screen.findByRole('button', { name: '用同样的输入再执行' })).toBeInTheDocument()
  })

  it('改输出时 JSON 写错不提交；改对了带 output 放行，节点标「人」', async () => {
    const user = userEvent.setup()
    const { calls, runs } = fakeBackend()
    renderPage('/sop/flows/sop_fb')
    await user.click(await screen.findByRole('button', { name: '执行' }))
    const drawer = await screen.findByRole('dialog')
    await user.type(within(drawer).getByRole('textbox', { name: /客户/ }), '何嘉宁')
    await user.click(within(drawer).getByRole('button', { name: '开始执行' }))
    await user.click(await screen.findByRole('button', { name: '修改输出' }))
    const box = screen.getByRole('textbox', { name: '修改输出' })
    await user.clear(box)
    await user.type(box, '[[1]')
    await user.click(screen.getByRole('button', { name: '保存修改并放行' }))
    expect(screen.getByRole('alert')).toHaveTextContent('需要是一个 JSON 对象')
    expect(calls.some((c) => c.path.endsWith('/actions'))).toBe(false)

    await user.clear(box)
    await user.type(box, '{{"text":"改过"}')
    await user.click(screen.getByRole('button', { name: '保存修改并放行' }))
    await waitFor(() => expect(runs[0].steps[1].edited).toBe('output'))
    expect(calls.find((c) => c.path.endsWith('/actions'))?.body).toEqual({ kind: 'approve', step: 1, output: { text: '改过' } })
    expect(await screen.findByTitle('输出被人工修改')).toBeInTheDocument()
  })

  it('动作失败时提示原因', async () => {
    const user = userEvent.setup()
    fakeBackend({ failAct: true })
    renderPage('/sop/flows/sop_fb')
    await user.click(await screen.findByRole('button', { name: '执行' }))
    const drawer = await screen.findByRole('dialog')
    await user.type(within(drawer).getByRole('textbox', { name: /客户/ }), '甲')
    await user.click(within(drawer).getByRole('button', { name: '开始执行' }))
    await user.click(await screen.findByRole('button', { name: '通过，继续执行' }))
    expect(await screen.findByText(/操作没成功：步骤状态不对/)).toBeInTheDocument()
  })

  it('待我处理只列等人的；执行不存在时说明并能返回', async () => {
    const user = userEvent.setup()
    fakeBackend()
    const router = renderPage('/sop/waiting')
    expect(await screen.findByText('没有等你处理的执行')).toBeInTheDocument()
    await router.navigate('/sop/runs/spr_x')
    expect(await screen.findByText('这次执行不存在')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '返回' }))
    expect(router.state.location.pathname).toBe('/sop')
  })

  it('流程已删除时详情说明', async () => {
    fakeBackend({ flows: [] })
    renderPage('/sop/flows/sop_gone')
    expect(await screen.findByText('这个 SOP 已经删除')).toBeInTheDocument()
  })
})
