// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 运行中心页（P0-O1）：打桩 fetch，/api/runs/all 按 query 在桩里筛；停止、重新执行、取消各记一条。
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunCenterItem } from '../../core/data/runCenter'
import Page from './Page'

const row = (over: Partial<RunCenterItem> = {}): RunCenterItem => ({
  kind: 'agent',
  id: 'ar_1',
  status: 'running',
  title: '分诊助手',
  sub: '收到 slack 消息',
  summary: '正在执行',
  started_at: new Date(Date.now() - 120_000).toISOString(),
  finished_at: null,
  pending: 0,
  agent_id: 'ag_1',
  agent_name: '分诊助手',
  trigger: '收到 slack 消息',
  session_id: 'ags_1',
  object_id: '',
  object_ref: '',
  object_title: '',
  harness: '',
  ...over,
})
const taskRow = (over: Partial<RunCenterItem> = {}): RunCenterItem =>
  row({ kind: 'task', id: 'run_t1', title: 'TSK-0001 修登录', sub: 'Claude Code', summary: '跑测试', session_id: null, object_id: 'obj_1', object_ref: 'TSK-0001', object_title: '修登录', ...over })

let rows: RunCenterItem[] = []
let acted: string[] = []
let searches: string[] = []

function backend(input: RequestInfo | URL): Promise<Response> {
  const url = new URL(String(input), 'http://x')
  const json = (data: unknown, meta?: unknown, status = 200) =>
    Promise.resolve(new Response(JSON.stringify({ data, meta }), { status }))
  if (url.pathname === '/api/runs/all') {
    searches.push(url.search)
    const st = url.searchParams.get('status')
    const src = url.searchParams.get('source')
    const out = rows.filter((r) => (!st || r.status === st) && (!src || r.kind === src))
    return json(out, { total: out.length })
  }
  const agentAct = /^\/api\/agent-runs\/([^/]+)\/(stop|retry)$/.exec(url.pathname)
  if (agentAct) {
    acted.push(`${agentAct[2]}:${agentAct[1]}`)
    const r = rows.find((x) => x.id === agentAct[1])
    if (agentAct[2] === 'stop') {
      if (!r || r.status !== 'running') return json({ error: { code: 'conflict', message: '这次执行已经不在跑了' } }, undefined, 409)
      r.status = 'canceled'
      r.finished_at = new Date().toISOString()
      return json({ run_id: r.id, status: 'canceled' })
    }
    if (!r || (r.status !== 'failed' && r.status !== 'canceled')) return json({ error: { code: 'conflict', message: '这次执行不能重试' } }, undefined, 409)
    return json({ run: { ...r, id: r.id + '_retry', status: 'running' }, session_id: 'ags_new' }, undefined, 202)
  }
  const cancel = /^\/api\/runs\/([^/]+)\/cancel$/.exec(url.pathname)
  if (cancel) {
    acted.push(`cancel:${cancel[1]}`)
    const r = rows.find((x) => x.id === cancel[1])
    if (!r || r.status !== 'running') return json({ error: { code: 'conflict', message: '这次执行已经不在跑了' } }, undefined, 409)
    r.status = 'canceled'
    r.finished_at = new Date().toISOString()
    return json({ run_id: r.id, status: 'canceled' })
  }
  return json([])
}

function show() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createMemoryRouter([
    { path: '/', element: <Page /> },
    { path: '/conversations', element: <p>会话页</p> },
    { path: '/conversations/runs', element: <p>执行记录页</p> },
    { path: '/tasks', element: <p>任务页</p> },
  ], { initialEntries: ['/'] })
  render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>)
  return router
}
const rowEl = (id: string) => document.querySelector<HTMLElement>(`[data-run-center="${id}"]`)

beforeEach(() => {
  rows = []
  acted = []
  searches = []
  vi.stubGlobal('fetch', vi.fn(backend))
})
afterEach(() => vi.unstubAllGlobals())

describe('运行中心', () => {
  it('Agent 行和任务行一页列出：状态、标题、sub、说明；状态和来源在后端筛', async () => {
    rows = [row(), row({ id: 'ar_2', status: 'failed', title: '周报助手', sub: '定时触发', summary: '模型不可用' }), taskRow()]
    show()
    expect(await screen.findByText('分诊助手')).toBeInTheDocument()
    expect(screen.getByText('收到 slack 消息')).toBeInTheDocument()
    expect(screen.getByText('模型不可用')).toBeInTheDocument()
    expect(screen.getByText('TSK-0001 修登录')).toBeInTheDocument()
    expect(within(rowEl('ar_1')!).getByText('执行中')).toBeInTheDocument()
    expect(within(rowEl('run_t1')!).getByText('执行中')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('tab', { name: '失败' }))
    await waitFor(() => expect(searches.some((q) => q.includes('status=failed'))).toBe(true))
    await waitFor(() => expect(rowEl('ar_1')).toBeNull())
    expect(rowEl('ar_2')).not.toBeNull()

    await userEvent.click(screen.getByRole('button', { name: '任务' }))
    await waitFor(() => expect(searches.some((q) => q.includes('source=task'))).toBe(true))
    await waitFor(() => expect(rowEl('ar_2')).toBeNull())
  })

  it('Agent 行：在跑的能停止、失败的能重新执行、有会话的能去会话（P0-O1）', async () => {
    rows = [row(), row({ id: 'ar_2', status: 'failed' })]
    const router = show()
    await waitFor(() => expect(rowEl('ar_1')).not.toBeNull())
    const a1 = rowEl('ar_1')!
    await userEvent.click(within(a1).getByRole('button', { name: '停止' }))
    await waitFor(() => expect(acted).toEqual(['stop:ar_1']))
    await waitFor(() => expect(a1.dataset.status).toBe('canceled'))

    const a2 = rowEl('ar_2')!
    await userEvent.click(within(a2).getByRole('button', { name: '重新执行' }))
    await waitFor(() => expect(acted).toContain('retry:ar_2'))

    await userEvent.click(within(rowEl('ar_1')!).getByRole('button', { name: '打开会话' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/conversations'))
    expect(router.state.location.search).toBe('?s=ags_1')
  })

  it('任务行：在跑的能取消，能打开任务抽屉的执行记录（P0-O1）', async () => {
    rows = [taskRow()]
    const router = show()
    await waitFor(() => expect(rowEl('run_t1')).not.toBeNull())
    await userEvent.click(within(rowEl('run_t1')!).getByRole('button', { name: '取消' }))
    await waitFor(() => expect(acted).toEqual(['cancel:run_t1']))
    await waitFor(() => expect(rowEl('run_t1')!.dataset.status).toBe('canceled'))

    await userEvent.click(within(rowEl('run_t1')!).getByRole('button', { name: '打开任务' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/tasks'))
    expect(router.state.location.search).toBe('?t=obj_1&tab=runs&run=run_t1')
  })
})
