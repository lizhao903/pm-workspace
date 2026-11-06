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
function fakeBackend(opts: { flows?: SopFlow[]; failAct?: boolean; workspaces?: unknown[]; plugins?: unknown[] } = {}) {
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
    if (u.pathname === '/api/sop/flows' && method === 'POST') {
      const f: SopFlow = { ...body, id: `sop_${flows.length + 1}`, version: 1, created_at: now(), updated_at: now() }
      flows.push(f)
      return json(f, 201)
    }
    if (u.pathname === '/api/sop/flows') return json(flows, 200, { total: flows.length })
    if (u.pathname === '/api/workspaces' && opts.workspaces) return json(opts.workspaces)
    if (u.pathname === '/api/plugins' && opts.plugins) return json(opts.plugins)
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
    // 已经在流程里了，空状态指向右上的「执行」（T-03）
    expect(screen.getByText('点右上「执行」跑一次')).toBeInTheDocument()

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

  // TSK-0486：最近 500 条全是已完成时，较早的失败执行仍在待我处理；菜单数字和今日同一个口径；阶段任务也列；已重跑的不算
  it('待我处理不受最近 500 条限制：较早的失败执行、停在等人阶段的任务都列，菜单数字同今日', async () => {
    const user = userEvent.setup()
    const at = (h: number) => new Date(Date.parse('2026-11-02T06:10:00Z') + h * 3_600_000).toISOString()
    const run = (id: string, status: SopRunBrief['status'], h: number, extra: Partial<SopRunBrief> = {}): SopRunBrief => ({
      id, flow_id: FLOW.id, flow_name: FLOW.name, flow_version: 1, title: `执行 ${id}`, step_through: false, stopped: false, status,
      started_at: at(h), updated_at: at(h), focus: 0, steps: [{ key: 'extract', name: '整理反馈', kind: 'template', status: status === 'failed' ? 'failed' : 'done' }], ...extra,
    })
    // 「最近 500 条」：都是后来的已完成执行，外加一条已重跑过的失败执行
    const recent = [run('spr_new1', 'done', 40), run('spr_new2', 'done', 39), run('spr_relaunched', 'failed', 38, { relaunched_to: 'spr_new1' })]
    // 后端按 status=running,waiting,failed 回：不含已重跑的
    const open = [run('spr_old', 'failed', 0)]
    const queries: string[] = []
    const json = (data: unknown) => new Response(JSON.stringify({ data, meta: { total: (data as unknown[]).length } }))
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const u = new URL(String(input), 'http://x')
      if (u.pathname === '/api/sop/flows') return json([FLOW])
      if (u.pathname === '/api/sop/node-types') return json([])
      if (u.pathname === '/api/sop/runs') {
        queries.push(u.search)
        return json(u.searchParams.get('status') ? open : recent)
      }
      if (u.pathname === '/api/sop/waiting') {
        return json([{ run_id: 'spr_old', run_title: '执行 spr_old', flow_id: FLOW.id, flow_name: FLOW.name, step_key: 'extract', step_name: '整理反馈',
          step_kind: 'template', step_status: 'failed', wait: 'failed', reason: '模型连不上', since: at(0), task_id: 'obj_a' }])
      }
      if (u.pathname === '/api/objects') {
        return json([
          { id: 'obj_a', type_id: 'task', ref: 'TSK-0001', title: '加验证码', props: { stage: 'accepting' }, updated_at: at(1) },
          { id: 'obj_b', type_id: 'task', ref: 'TSK-0002', title: '导出报表', props: { stage: 'confirm_project' }, updated_at: at(2) },
        ])
      }
      return new Response(JSON.stringify({ error: { code: 'not_found', message: u.pathname } }), { status: 404 })
    }))
    const router = renderPage('/sop/waiting')
    expect(await screen.findByText('执行 spr_old')).toBeInTheDocument()
    expect(queries).toContain('?status=running%2Cwaiting%2Cfailed&limit=500')
    // 已重跑的失败执行、已完成的都不在待我处理
    expect(screen.queryByText('执行 spr_relaunched')).not.toBeInTheDocument()
    expect(screen.queryByText('执行 spr_new1')).not.toBeInTheDocument()
    // 阶段任务：已有等人步骤算到它头上的（TSK-0001）不重复列
    const group = screen.getByRole('group', { name: '停在等人阶段的任务' })
    expect(within(group).getByText('TSK-0002 导出报表')).toBeInTheDocument()
    expect(screen.queryByText('TSK-0001 加验证码')).not.toBeInTheDocument()
    // 菜单数字同今日：1 个等人步骤 + 1 个阶段任务
    const nav = screen.getByRole('navigation', { name: 'SOP' })
    await waitFor(() => expect(within(nav).getByTitle('2 项需要处理')).toBeInTheDocument())
    await user.click(within(group).getByRole('button', { name: /TSK-0002 导出报表/ }))
    expect(router.state.location.pathname).toBe('/tasks')
    expect(router.state.location.search).toBe('?t=obj_b&tab=pipeline')
  })

  it('执行记录的状态分段也算上较早的失败执行', async () => {
    const recent: SopRunBrief[] = []
    const old: SopRunBrief = {
      id: 'spr_old', flow_id: FLOW.id, flow_name: FLOW.name, flow_version: 1, title: '较早的失败', step_through: false, stopped: false, status: 'failed',
      started_at: '2026-11-02T06:10:00Z', updated_at: '2026-11-02T06:10:00Z', focus: 0, steps: [],
    }
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const u = new URL(String(input), 'http://x')
      const json = (data: unknown[]) => new Response(JSON.stringify({ data, meta: { total: data.length } }))
      if (u.pathname === '/api/sop/flows') return json([FLOW])
      if (u.pathname === '/api/sop/runs') return json(u.searchParams.get('status') ? [old] : recent)
      return json([])
    }))
    renderPage('/sop')
    expect(await screen.findByText('较早的失败')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^失败/ })).toHaveTextContent('失败1')
  })

  it('详情的触发方式显示中文名；复制出新流程并进它的编排页', async () => {
    const user = userEvent.setup()
    const { calls } = fakeBackend({ flows: [{ ...FLOW, trigger: 'manual' }] })
    const router = renderPage('/sop/flows/sop_fb')
    expect(await screen.findByText('触发：手动')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '复制' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/sop/flows/sop_2/edit'))
    const post = calls.find((c) => c.method === 'POST' && c.path === '/api/sop/flows')!.body!
    expect(post).toMatchObject({ name: '客户反馈转需求 副本', trigger: 'manual', steps: FLOW.steps, fields: FLOW.fields })
  })

  it('用到当前工作台没开的插件节点的流程：流程库和详情标「需要视频模块」，排在最后', async () => {
    const user = userEvent.setup()
    const video: SopFlow = { ...FLOW, id: 'sop_video_weekly', name: '视频周更', steps: [{ key: 'a', name: '文稿处理', kind: 'video_run_stage' }] }
    fakeBackend({
      flows: [video, FLOW],
      workspaces: [{ id: 'ws_pm', name: '产品经理工作台', modules: ['today', 'sop'], plugins: ['sop'], groups: [], home: 'today' }],
      plugins: [{ id: 'video', name: '视频创作', provides: { modules: ['videos'], sop_nodes: ['video_run_stage'] } }],
    })
    const router = renderPage('/sop/library')
    expect(await screen.findByText('需要视频模块')).toBeInTheDocument()
    const cards = screen.getAllByRole('button', { name: /客户反馈转需求|视频周更/ })
    expect(cards.map((c) => c.textContent?.includes('视频周更'))).toEqual([false, true])
    await user.click(cards[1])
    expect(router.state.location.pathname).toBe('/sop/flows/sop_video_weekly')
    expect(await screen.findByText('需要视频模块')).toBeInTheDocument()
  })

  it('流程已删除时详情说明', async () => {
    fakeBackend({ flows: [] })
    renderPage('/sop/flows/sop_gone')
    expect(await screen.findByText('这个 SOP 已经删除')).toBeInTheDocument()
  })
})
