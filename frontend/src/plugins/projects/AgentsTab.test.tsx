// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider, useLocation } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Agent, AgentSession, WorkObject } from '../../core/data'
import { AgentsTab } from './AgentsTab'
import { Overview } from './Overview'

const agent = (id: string, name: string, opts: Partial<Agent> = {}): Agent => ({
  id, name, desc: `${name}的说明`, color: '#3d4fd6', avatar: { kind: 'text', value: '' }, provider_id: 'apv_1', model: 'm',
  instructions: '', skills: [], mcps: [], kbs: [], triggers: [], enabled: true, created_at: '', updated_at: '', ...opts,
})
const AGENTS = [agent('ag_week', '周报助手'), agent('ag_off', '旧助手', { enabled: false }), agent('ag_sop', 'SOP 助手')]
const sess = (id: string, agent_id: string | null, updated_at: string, message_count = 2): AgentSession => ({
  id, title: `会话 ${id}`, object_id: null, provider_id: 'apv_1', model: 'm', workdir: '', agent_id, agent_deleted: false,
  created_at: updated_at, updated_at, message_count,
})

function project(props: Record<string, unknown>): WorkObject {
  return {
    id: 'obj_p', ref: 'PRJ-1', type_id: 'project', title: '工作台', body: '', status: 'active', priority: '', owner: '', owner_id: null,
    category_id: null, project_id: null, source: 'manual', props: { color: '#3d4fd6', ...props }, workdir: '/tmp/pj', due_at: null, started_at: null,
    completed_at: null, archived_at: null, deleted_at: null, created_at: '', updated_at: '', tags: [], link_count: 0, participants: [],
  } as WorkObject
}

function fakeBackend(p: WorkObject, sessions: AgentSession[] = []) {
  const calls: { method: string; path: string; body?: Record<string, unknown> }[] = []
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(status < 300 ? { data, meta: { total: Array.isArray(data) ? data.length : 0 } } : data), { status })
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input), 'http://x')
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ method, path: u.pathname, body })
    if (u.pathname === '/api/agents') return json(AGENTS)
    if (u.pathname === '/api/agent/sessions' && method === 'GET') return json(sessions)
    if (u.pathname === '/api/agent/sessions' && method === 'POST') {
      const s = sess('ags_new', body.agent_id, '2026-10-29T05:00:00Z', 0)
      sessions.push(s)
      return json(s, 201)
    }
    if (u.pathname === `/api/objects/${p.id}`) {
      if (method === 'PATCH') Object.assign(p, body)
      return json(p)
    }
    return json([])
  }))
  return calls
}

function Where() {
  const l = useLocation()
  return <div data-testid="where">{l.pathname + l.search}</div>
}

function mount(el: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createMemoryRouter([
    { path: '/projects/*', element: el },
    { path: '*', element: <Where /> },
  ], { initialEntries: ['/projects/obj_p/agents'] })
  render(<QueryClientProvider client={qc}><RouterProvider router={router} /></QueryClientProvider>)
  return router
}

const patches = (calls: ReturnType<typeof fakeBackend>) => calls.filter((c) => c.method === 'PATCH').map((c) => c.body?.props)

afterEach(() => vi.unstubAllGlobals())

describe('项目的 Agent 标签（PR-21）', () => {
  it('没配 Agent、没有会话时两个空状态；从下拉加一个，停用的不可选，存进 props.agent_ids 末尾', async () => {
    const p = project({})
    const calls = fakeBackend(p)
    mount(<AgentsTab project={p} />)
    expect(await screen.findByText('还没给项目配 Agent')).toBeInTheDocument()
    expect(await screen.findByText('还没有项目会话；点上面的「对话」开一个')).toBeInTheDocument()
    expect(screen.getByText('第一个是默认项目 Agent；在这里开的会话归到这个项目，能读这个项目的材料和文档')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /加 Agent/ }))
    expect(await screen.findByRole('option', { name: /旧助手/ })).toHaveAttribute('aria-disabled', 'true')
    await userEvent.click(screen.getByRole('option', { name: /SOP 助手/ }))
    await waitFor(() => expect(patches(calls)).toHaveLength(1))
    expect(patches(calls)[0]).toEqual({ color: '#3d4fd6', agent_ids: ['ag_sop'] })
  })

  it('第一个带「默认」；设为默认挪到第一个，移除只改 agent_ids，已删的 Agent 不显示', async () => {
    const p = project({ agent_ids: ['ag_week', 'ag_gone', 'ag_sop'] })
    const calls = fakeBackend(p)
    mount(<AgentsTab project={p} />)
    const list = await screen.findByRole('list', { name: '项目 Agent' })
    const items = within(list).getAllByRole('listitem')
    expect(items.map((x) => x.querySelector('b')?.textContent)).toEqual(['周报助手', 'SOP 助手'])
    expect(within(items[0]).getByText('默认')).toBeInTheDocument()
    expect(within(items[0]).queryByRole('button', { name: '设为默认' })).toBeNull()
    await userEvent.click(within(items[1]).getByRole('button', { name: '设为默认' }))
    await waitFor(() => expect(patches(calls)).toHaveLength(1))
    expect(patches(calls)[0]).toMatchObject({ agent_ids: ['ag_sop', 'ag_week', 'ag_gone'] })
    await userEvent.click(within(items[0]).getByRole('button', { name: '移除' }))
    await waitFor(() => expect(patches(calls)).toHaveLength(2))
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
  })

  it('停用的 Agent「对话」置灰；点名称去设置的 Agent 页', async () => {
    const p = project({ agent_ids: ['ag_off', 'ag_week'] })
    fakeBackend(p)
    mount(<AgentsTab project={p} />)
    const items = within(await screen.findByRole('list', { name: '项目 Agent' })).getAllByRole('listitem')
    expect(within(items[0]).getByText('已停用')).toBeInTheDocument()
    expect(within(items[0]).getByRole('button', { name: '对话' })).toBeDisabled()
    await userEvent.click(within(items[1]).getByRole('button', { name: /周报助手/ }))
    expect(screen.getByTestId('where')).toHaveTextContent('/settings/agents/ag_week')
  })

  it('「对话」建挂这个 Agent 的会话（工作目录用项目目录），记进 session_ids 最前，就在项目里打开，不跳到会话页', async () => {
    const p = project({ agent_ids: ['ag_week'], session_ids: ['ags_old'] })
    const calls = fakeBackend(p)
    const router = mount(<AgentsTab project={p} />)
    const items = within(await screen.findByRole('list', { name: '项目 Agent' })).getAllByRole('listitem')
    await userEvent.click(within(items[0]).getByRole('button', { name: '对话' }))
    await waitFor(() => expect(router.state.location.pathname + router.state.location.search).toBe('/projects/obj_p/agents?s=ags_new'))
    const pane = await screen.findByRole('region', { name: '项目会话' })
    expect(await within(pane).findByRole('textbox')).toBeInTheDocument()
    expect(within(pane).getByText('会话 ags_new')).toBeInTheDocument()
    // 「返回」关掉对话，回到列表
    await userEvent.click(within(pane).getByRole('button', { name: '返回' }))
    await waitFor(() => expect(router.state.location.search).toBe(''))
    expect(screen.queryByRole('region', { name: '项目会话' })).toBeNull()
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ title: '新会话', agent_id: 'ag_week', workdir: '/tmp/pj' })
    expect(patches(calls)[0]).toMatchObject({ agent_ids: ['ag_week'], session_ids: ['ags_new', 'ags_old'] })
  })

  it('项目里的会话：只列记下的、有消息的，按更新倒序；多于 10 条时显示总数和就地展开；点了打开会话', async () => {
    const ids = Array.from({ length: 12 }, (_, i) => `ags_${String(i).padStart(2, '0')}`)
    const sessions = [
      ...ids.map((id, i) => sess(id, i === 0 ? 'ag_gone' : 'ag_week', `2026-10-${String(10 + i).padStart(2, '0')}T00:00:00Z`)),
      sess('ags_other', 'ag_week', '2026-10-29T00:00:00Z'),
      sess('ags_empty', 'ag_week', '2026-10-29T00:00:00Z', 0),
    ]
    const p = project({ agent_ids: ['ag_week'], session_ids: [...ids, 'ags_empty'] })
    fakeBackend(p, sessions)
    const router = mount(<AgentsTab project={p} />)
    const box = await screen.findByRole('region', { name: '项目里的会话' })
    await within(box).findByText('会话 ags_11')
    expect(within(box).getByRole('heading')).toHaveTextContent('项目里的会话 12')
    const rows = () => within(box).getAllByRole('button').filter((b) => b.textContent?.includes('会话 ags'))
    expect(rows()).toHaveLength(10)
    expect(rows()[0]).toHaveTextContent('会话 ags_11')
    expect(within(box).queryByText('会话 ags_other')).toBeNull()
    await userEvent.click(within(box).getByRole('button', { name: /显示全部/ }))
    expect(rows()).toHaveLength(12)
    expect(within(box).getByRole('button', { name: '收起' })).toBeInTheDocument()
    await userEvent.click(rows()[0])
    expect(router.state.location.pathname + router.state.location.search).toBe('/projects/obj_p/agents?s=ags_11')
    expect(rows()[0]).toHaveAttribute('aria-current', 'true')
    const pane = await screen.findByRole('region', { name: '项目会话' })
    await userEvent.click(within(pane).getByRole('button', { name: '在会话页打开' }))
    expect(screen.getByTestId('where')).toHaveTextContent('/conversations?s=ags_11')
  })
})

describe('概览的项目 Agent 块（PR-21）', () => {
  it('显示默认 Agent（已删的跳过），「和它对话」开项目会话，切到 Agent 标签就地打开', async () => {
    const p = project({ agent_ids: ['ag_gone', 'ag_sop', 'ag_week'] })
    const calls = fakeBackend(p)
    const onTab = vi.fn()
    mount(<Overview project={p} onTab={onTab} />)
    const block = await screen.findByRole('region', { name: '项目 Agent' })
    expect(await within(block).findByText('SOP 助手')).toBeInTheDocument()
    // TSK-0718：只显示名字，不带头像和说明
    expect(within(block).queryByText('SOP 助手的说明')).toBeNull()
    expect(block.querySelector('.agent-av')).toBeNull()
    // 概览不再有「原型运行中」数字卡片（原型块还在）
    expect(screen.queryByText('原型运行中')).toBeNull()
    await userEvent.click(within(block).getByRole('button', { name: '和它对话' }))
    await waitFor(() => expect(onTab).toHaveBeenCalledWith('agents', 's=ags_new'))
    expect(calls.find((c) => c.method === 'POST')?.body).toMatchObject({ agent_id: 'ag_sop' })
  })

  it('默认 Agent 停用时「和它对话」置灰', async () => {
    const p = project({ agent_ids: ['ag_off'] })
    fakeBackend(p)
    mount(<Overview project={p} onTab={() => {}} />)
    const block = await screen.findByRole('region', { name: '项目 Agent' })
    expect(await within(block).findByRole('button', { name: '和它对话' })).toBeDisabled()
    expect(block).toHaveTextContent('已停用')
  })

  it('没配 Agent 时显示去设置，点了切到 Agent 标签', async () => {
    const p = project({})
    fakeBackend(p)
    const onTab = vi.fn()
    mount(<Overview project={p} onTab={onTab} />)
    const block = await screen.findByRole('region', { name: '项目 Agent' })
    expect(block).toHaveTextContent('还没设置。去设置')
    await userEvent.click(within(block).getByRole('button', { name: '去设置' }))
    expect(onTab).toHaveBeenCalledWith('agents')
  })
})
