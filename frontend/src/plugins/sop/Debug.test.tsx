// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SopDebug, SopFlow, SopNodeType, SopSkip } from '../../core/data'
import Page from './Page'

// TSK-0491：编排页调试的结果就地显示在画布和节点面板；流程详情列出最近未发起。

const TYPES: SopNodeType[] = [
  { kind: 'decide', group: '逻辑', branching: true, default_cases: [{ key: 'yes', label: '是' }, { key: 'no', label: '否' }], required: [], effect: 'compute' },
  { kind: 'task', group: '外部', branching: false, required: [{ key: 'title', label: '标题' }], effect: 'write' },
  { kind: 'review', group: '人工', branching: false, required: [], effect: 'human' },
]

const FLOW: SopFlow = {
  id: 'sop_dbg', name: '消息分诊', desc: '', trigger: 'im', version: 2, created_at: '', updated_at: '',
  fields: [],
  steps: [
    { key: 'd', name: '@我吗', kind: 'decide', after: [], cases: [{ key: 'yes', label: '是' }, { key: 'no', label: '否' }],
      cond: { logic: 'and', items: [{ field: 'relevance', op: 'eq', value: 'me' }] } },
    { key: 't', name: '建任务', kind: 'task', after: ['d'], branch: { of: 'd', case: 'yes' }, config: { title: '跟进' } },
    { key: 'n', name: '不管', kind: 'review', after: ['d'], branch: { of: 'd', case: 'no' } },
  ],
  layout: { __start: { x: 60, y: 80 }, d: { x: 400, y: 80 }, t: { x: 700, y: 40 }, n: { x: 700, y: 200 } },
  im: { conversations: [], relevance: [], relevance_mode: 'include', order: 1, stop: false },
}

const DEBUG: SopDebug = {
  id: 'sdb_1', flow_id: 'sop_dbg', flow_name: '消息分诊', trigger: 'im', source: 'latest_run', message_id: 'msg_1',
  message: { id: 'msg_1', text: '@Broleez 帮我看下', sender: 'Lin', conversation: '#product', relevance: '@我' },
  input: { message_id: 'msg_1', relevance: 'me' }, status: 'done', summary: '用消息 msg_1 调试。「@我吗」走「是」。「建任务」将建任务「跟进」（没真做）。',
  notes: [], skip_models: false, issues: [], started_at: new Date().toISOString(), ms: 12,
  steps: [
    { key: 'd', name: '@我吗', kind: 'decide', effect: 'compute', status: 'done', input: { relevance: 'me' }, output: { relevance: 'me' },
      route: 'yes', route_label: '是', route_reason: '条件成立',
      cond: { logic: 'and', text: 'relevance 等于 me', result: true, items: [{ field: 'relevance', op: 'eq', op_label: '等于', value: 'me', actual: 'me', found: true, ok: true }] },
      fields: [], ms: 1 },
    { key: 't', name: '建任务', kind: 'task', effect: 'write', status: 'simulated', input: { relevance: 'me' }, output: { relevance: 'me', task: { ref: '(调试占位)' } },
      action: { text: '将建任务「跟进」', params: [{ key: 'title', label: '标题', value: '跟进' }] }, note: '写操作：调试不执行',
      fields: [{ path: 'task.ref', type: 'string', label: '任务编号', declared: true, sample: '(调试占位)' }, { path: 'task.extra', type: 'string', label: '未声明', declared: false, sample: 'x' }], ms: 0 },
    { key: 'n', name: '不管', kind: 'review', effect: 'human', status: 'bypassed', input: null, output: null, note: '所在分支没被选中，不执行', fields: [], ms: 0 },
  ],
}

const SKIPS: SopSkip[] = [
  { id: 'spk_1', flow_id: 'sop_dbg', source: 'im', source_ref: 'msg_9', reason: 'stopped', detail: '被排在前面的「忽略机器人」拦截', info: {}, at: new Date().toISOString() },
]

type Call = { method: string; path: string; body?: Record<string, unknown> }

function fakeBackend() {
  const calls: Call[] = []
  const json = (data: unknown, meta?: Record<string, unknown>) =>
    new Response(JSON.stringify({ data, meta: meta ?? (Array.isArray(data) ? { total: data.length } : undefined) }), { status: 200 })
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input), 'http://x')
    const method = init?.method ?? 'GET'
    calls.push({ method, path: u.pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    if (u.pathname === '/api/sop/node-types') return json(TYPES)
    if (u.pathname === '/api/sop/debug') return json(DEBUG)
    if (u.pathname === '/api/sop/flows/sop_dbg/skips') return json(SKIPS, { total: 1, reasons: { stopped: 1, filtered: 4 } })
    if (u.pathname === '/api/sop/flows') return json([FLOW])
    if (u.pathname === '/api/sop/flows/sop_dbg') return json(FLOW)
    return json([])
  }))
  return { calls }
}

function renderPage(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createMemoryRouter([{ path: '/sop/*', element: <Page /> }], { initialEntries: [path] })
  render(<QueryClientProvider client={qc}><RouterProvider router={router} /></QueryClientProvider>)
}

afterEach(() => vi.unstubAllGlobals())

describe('SOP 调试（TSK-0491）', () => {
  it('调试结果就地显示：画布角标、走过的分支、节点面板的条件真实值和将做什么；不保存、不发起执行', async () => {
    const user = userEvent.setup()
    const { calls } = fakeBackend()
    renderPage('/sop/flows/sop_dbg/edit')
    await user.click(await screen.findByRole('button', { name: /^调试/ }))
    const bar = screen.getByRole('region', { name: '调试' })
    await user.click(within(bar).getByRole('button', { name: '开始调试' }))
    await within(bar).findByText(/将建任务「跟进」（没真做）/)
    expect(within(bar).getByText('@Broleez 帮我看下')).toBeInTheDocument()
    const req = calls.find((c) => c.path === '/api/sop/debug')!.body!
    expect(req).toMatchObject({ flow_id: 'sop_dbg', skip_models: false })
    expect((req.draft as { steps: unknown[] }).steps).toHaveLength(3)
    expect(calls.some((c) => c.method !== 'GET' && c.path !== '/api/sop/debug' && c.path !== '/api/sop/step-fields')).toBe(false)

    const task = screen.getByRole('button', { name: '节点 建任务' })
    expect(within(task).getByText('模拟')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '节点 不管' })).toHaveClass('dbg-node-bypassed')

    // 选中分支节点：默认就是「调试」页，条件逐条带真实值
    fireEvent.keyDown(screen.getByRole('button', { name: '节点 @我吗' }), { key: 'Enter' })
    const panel = screen.getByRole('complementary', { name: '节点属性' })
    expect(within(panel).getByRole('tab', { name: /调试/ })).toHaveAttribute('aria-selected', 'true')
    expect(within(panel).getByText('走「是」分支：条件成立')).toBeInTheDocument()
    const row = within(panel).getByRole('table').querySelector('tbody tr')!
    expect(row).toHaveTextContent('relevance')
    expect(row).toHaveTextContent('成立')

    // 写节点：将做什么、渲染后的配置、没声明的字段标出来
    fireEvent.keyDown(task, { key: 'Enter' })
    await waitFor(() => expect(within(panel).getByText('将做什么（没执行）')).toBeInTheDocument())
    expect(within(panel).getAllByText('将建任务「跟进」').length).toBeGreaterThan(0)
    expect(within(panel).getByText('task.extra').closest('.sop-field-pick')).toHaveClass('undeclared')
    expect(within(panel).getAllByText('未声明').length).toBeGreaterThan(0)
  })

  it('流程详情列出最近未发起，默认不看过滤不符', async () => {
    const { calls } = fakeBackend()
    renderPage('/sop/flows/sop_dbg')
    expect(await screen.findByText('被排在前面的「忽略机器人」拦截')).toBeInTheDocument()
    const q = calls.find((c) => c.path === '/api/sop/flows/sop_dbg/skips')!
    expect(q).toBeTruthy()
    expect(screen.getByRole('combobox', { name: '按原因筛' })).toHaveValue('-filtered')
    expect(screen.getByRole('button', { name: '模拟 IM 触发' })).toBeInTheDocument()
  })
})
