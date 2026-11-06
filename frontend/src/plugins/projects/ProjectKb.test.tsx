import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider, useLocation } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProjectKbBlock, ProjectKbStrip } from './ProjectKb'

type Bound = { kb_id: string; kb: { id: string; name: string; desc: string; docs: number; agents: string[] } | null; missing: boolean }

const result = {
  project_id: 'obj_p1', name: '官网', ref: 'PRJ-1', kb_id: 'kb_1', kb_name: '官网 项目知识库', created: true,
  added: 3, updated: 0, removed: 0, unchanged: 0, skipped: 1, failed: 1,
  failures: [{ title: '材料', ref: '/x/材料', reason: '目录不存在：/x/材料' }], skips: [{ title: '合同.pdf', ref: '/x/合同.pdf', reason: '不支持的文件类型' }],
  sources: { files: 1 }, error: '', at: '2026-11-06T10:00:00Z',
}

function fakeBackend(start: Bound) {
  let cur = { project_id: 'obj_p1', auto_created: false, default_agent_id: 'ag_1', agent_attached: false, last_sync_at: null as string | null, last_result: null as unknown, ...start }
  const calls: { method: string; path: string; body?: Record<string, unknown> }[] = []
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(status < 300 ? { data } : data), { status })
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input), 'http://x')
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ method, path: u.pathname, body })
    if (u.pathname === '/api/projects/obj_p1/kb' && method === 'GET') return json(cur)
    if (u.pathname === '/api/projects/obj_p1/kb/sync') {
      cur = { ...cur, kb_id: 'kb_1', kb: { id: 'kb_1', name: '官网 项目知识库', desc: '', docs: 3, agents: ['ag_1'] }, agent_attached: true, last_sync_at: result.at, last_result: result }
      return json(result)
    }
    if (u.pathname === '/api/projects/obj_p1/kb' && method === 'PUT') {
      if (body.kb_id === '') cur = { ...cur, kb_id: '', kb: null }
      return json(cur)
    }
    if (u.pathname === '/api/knowledge-bases') return json([{ id: 'kb_1', name: '官网 项目知识库' }, { id: 'kb_2', name: '别的库' }])
    if (u.pathname === '/api/agents') return json([{ id: 'ag_1', name: '项目助手' }])
    return json({ error: { code: 'not_found', message: u.pathname } }, 404)
  }))
  return calls
}

function Where() {
  const loc = useLocation()
  return <div>{`到了 ${loc.pathname}${loc.search}`}</div>
}

function mount(el: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createMemoryRouter([{ path: '/projects/x', element: el }, { path: '/settings/kbs', element: <Where /> }], { initialEntries: ['/projects/x'] })
  render(<QueryClientProvider client={qc}><RouterProvider router={router} /></QueryClientProvider>)
}

afterEach(() => vi.unstubAllGlobals())

describe('项目知识库（TSK-0721）', () => {
  it('没绑时提示会自动新建；立即同步后显示汇总、失败原因，跳过的可展开', async () => {
    const calls = fakeBackend({ kb_id: '', kb: null, missing: false })
    mount(<ProjectKbBlock projectId="obj_p1" />)
    expect(await screen.findByText(/还没绑：第一次同步时自动新建/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '立即同步' }))
    expect(await screen.findByText(/新建了「官网 项目知识库」并绑定；新增 3、更新 0、移除 0、失败 1、跳过 1/)).toBeInTheDocument()
    expect(screen.getByText('材料：目录不存在：/x/材料')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '看跳过的 1 条' }))
    expect(screen.getByText('合同.pdf：不支持的文件类型')).toBeInTheDocument()
    expect(calls.some((c) => c.method === 'POST' && c.path === '/api/projects/obj_p1/kb/sync')).toBe(true)
    // 同步后显示篇数和已挂到默认 Agent
    expect(await screen.findByText(/已挂到项目默认 Agent「项目助手」/)).toBeInTheDocument()
  })

  it('选「不绑定」解绑；绑定的被删了有提示', async () => {
    const calls = fakeBackend({ kb_id: 'kb_9', kb: null, missing: true })
    mount(<ProjectKbBlock projectId="obj_p1" />)
    expect(await screen.findByText(/绑定的知识库已经删了/)).toBeInTheDocument()
    const sel = screen.getByRole('combobox', { name: '绑定的知识库' })
    await waitFor(() => expect(sel).not.toBeDisabled())
    await userEvent.selectOptions(sel, 'kb_2')
    await waitFor(() => expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ kb_id: 'kb_2' }))
  })

  it('资料标签的入口条：绑了的能打开知识库页', async () => {
    fakeBackend({ kb_id: 'kb_1', kb: { id: 'kb_1', name: '官网 项目知识库', desc: '', docs: 5, agents: [] }, missing: false })
    mount(<ProjectKbStrip projectId="obj_p1" onSettings={() => {}} />)
    expect(await screen.findByText(/项目知识库「官网 项目知识库」5 篇，还没同步过/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '打开知识库' }))
    expect(await screen.findByText('到了 /settings/kbs?kb=kb_1')).toBeInTheDocument()
  })
})
