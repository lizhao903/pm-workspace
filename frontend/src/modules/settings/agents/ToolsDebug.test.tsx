// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// Agent 配置页的工具与权限标签和右边的调试对话（AG-02b）：打桩 fetch，连接器、授权、调试流都在内存里。
import { QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { queryClient, type Agent, type AgentProvider, type ChatEvent, type Connector } from '../../../core/data'
import { AgentsSection } from './AgentsSection'

const prov: AgentProvider = {
  id: 'apv_a', name: 'Anthropic', kind: 'anthropic', base_url: '', model: 'claude-haiku-5-5', enabled: true, is_default: true, api_key_masked: '',
  has_api_key: true, extra: {}, created_at: '', updated_at: '',
}
const baseAgent: Agent = {
  id: 'ag_1', name: '周报助手', desc: '', color: '#3d4fd6', avatar: { kind: 'text', value: '' }, provider_id: 'apv_a', model: 'claude-haiku-5-5',
  instructions: '', skills: [], mcps: [], kbs: [], triggers: [{ kind: 'manual', detail: '' }], enabled: true, created_at: '', updated_at: '',
}
const conn = (p: Partial<Connector> & { id: string }): Connector => ({
  tool: 'github', name: p.id, account: '', status: 'connected', error: '', auth_mode: 'token', config: {}, secret_hints: {}, direction: 'both',
  interval: 5, tools: [], tools_at: '2026-10-29T00:00:00Z', last_tested_at: null, last_sync_at: null, available: true, created_at: '', updated_at: '', ...p,
})
const GH = conn({
  id: 'cn_1', name: '公司 GitHub', tools: [
    { name: 'list_issues', desc: '列 issue', write: false, mode: 'auto' },
    { name: 'create_issue', desc: '建 issue', write: true, mode: 'confirm' },
    { name: 'merge_pr', desc: '合并 PR', write: true, mode: 'auto' },
  ],
})

type Call = { method: string; path: string; body?: Record<string, unknown> }
const sse = (events: ChatEvent[]) => new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''), {
  status: 200, headers: { 'Content-Type': 'text/event-stream' },
})

let calls: Call[] = []
let agent: Agent
let grants: Record<string, string>
// 调试流：按次序取
let debugRounds: ChatEvent[][] = []

beforeEach(() => {
  calls = []
  agent = { ...baseAgent }
  grants = { read_tasks: 'auto', read_contacts: 'auto' }
  debugRounds = []
  queryClient.clear()
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input), 'http://x')
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ method, path: u.pathname, body })
    const json = (data: unknown, status = 200) => new Response(JSON.stringify({ data, meta: Array.isArray(data) ? { total: data.length } : undefined }), { status })
    if (u.pathname === '/api/agents' && method === 'GET') return json([agent])
    if (u.pathname === '/api/agents/ag_1' && method === 'GET') return json(agent)
    if (u.pathname === '/api/agents/ag_1' && method === 'PATCH') { agent = { ...agent, ...body }; return json(agent) }
    if (u.pathname === '/api/agents/ag_1/grants') {
      if (method === 'PUT') grants = { ...(body?.grants as Record<string, string>) }
      return json({ agent_id: 'ag_1', grants, effective: grants })
    }
    if (u.pathname === '/api/agents/debug/chat' || u.pathname.startsWith('/api/agent/tool-calls/')) return sse(debugRounds.shift() ?? [])
    if (u.pathname === '/api/agent-providers') return json([prov])
    if (u.pathname === '/api/connectors') return json([GH])
    if (u.pathname === '/api/connectors/defs') return json([{ tool: 'github', label: 'GitHub', category: 'dev', color: '', desc: '', can_send: false, auth: ['token'], fields: [], tools: [], source: 'core' }])
    return json([])
  }))
})
afterEach(() => vi.unstubAllGlobals())

function show(path = '/settings/agents/ag_1') {
  const router = createMemoryRouter([{ path: '/settings/*', element: <AgentsSection /> }], { initialEntries: [path] })
  render(<QueryClientProvider client={queryClient}><RouterProvider router={router} /></QueryClientProvider>)
  return router
}

const row = (sel: string) => document.querySelector<HTMLElement>(sel)!

describe('工具与权限（SPEC-settings-9.15 到 9.20）', () => {
  it('内置能力按组列，只读两档、写三档；写设为自动出警告；?tab=tools 直接打开', async () => {
    show('/settings/agents/ag_1?tab=tools')
    expect(await screen.findByRole('tab', { name: /工具与权限/, selected: true })).toBeInTheDocument()
    await waitFor(() => expect(document.querySelector('[data-ability="write_tasks"]')).not.toBeNull())
    expect(screen.getByRole('group', { name: 'SOP' })).toBeInTheDocument()
    expect(within(row('[data-ability="read_tasks"]')).getAllByRole('radio').map((b) => b.textContent)).toEqual(['关闭', '自动'])
    expect(within(row('[data-ability="read_tasks"]')).getByRole('radio', { name: '自动' })).toBeChecked()
    expect(within(row('[data-ability="read_content"]')).getByText('只能读挂载的知识库里的资料')).toBeInTheDocument()
    const w = row('[data-ability="write_tasks"]')
    expect(within(w).getAllByRole('radio').map((b) => b.textContent)).toEqual(['关闭', '需确认', '自动'])
    await userEvent.click(within(w).getByRole('radio', { name: '自动' }))
    expect(within(w).getByRole('radio', { name: '自动' })).toHaveClass('risky')
    expect(screen.getByText('「新建 / 更新任务」设为自动：Agent 会直接执行，不再等你确认。')).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /工具与权限/ })).toHaveTextContent('3')
  })

  it('挂连接器：只读默认自动、写默认关闭并展开；上限为需确认的写工具选不到自动；卸下清掉它的授权；保存先存挂载再整组存授权', async () => {
    show('/settings/agents/ag_1?tab=tools')
    expect(await screen.findByText(/还没挂 MCP 或连接器/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '挂载' }))
    const menu = screen.getByRole('menu', { name: '挂载' })
    expect(within(menu).getByText('GitHub · 3 个可用工具')).toBeInTheDocument()
    await userEvent.click(within(menu).getByRole('menuitem'))
    const card = row('[data-conn="cn_1"]')
    expect(within(card).getByText('开了 1 / 3 个工具')).toBeInTheDocument()
    const create = row('[data-tool="create_issue"]')
    expect(within(create).getAllByRole('radio').map((b) => b.textContent)).toEqual(['关闭', '需确认'])
    expect(within(create).getByText(/连接器要求确认/)).toBeInTheDocument()
    expect(within(create).getByRole('radio', { name: '关闭' })).toBeChecked()
    expect(within(row('[data-tool="list_issues"]')).getByRole('radio', { name: '自动' })).toBeChecked()
    await userEvent.click(within(create).getByRole('radio', { name: '需确认' }))
    expect(within(card).getByText('开了 2 / 3 个工具')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true))
    const patch = calls.find((c) => c.method === 'PATCH')!
    const put = calls.find((c) => c.method === 'PUT')!
    expect(calls.indexOf(patch)).toBeLessThan(calls.indexOf(put))
    expect(patch.body).toEqual({ mcps: ['cn_1'] })
    expect(put.body).toEqual({ grants: { read_tasks: 'auto', read_contacts: 'auto', 'conn:cn_1:list_issues': 'auto', 'conn:cn_1:create_issue': 'confirm' } })
    expect(await screen.findByRole('button', { name: '已保存' })).toBeDisabled()

    // 卸下：conn:cn_1:* 一起清掉
    await userEvent.click(within(row('[data-conn="cn_1"]')).getByRole('button', { name: '卸下 公司 GitHub' }))
    expect(screen.getByText(/还没挂 MCP 或连接器/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(2))
    expect(calls.filter((c) => c.method === 'PUT')[1].body).toEqual({ grants: { read_tasks: 'auto', read_contacts: 'auto' } })
  })
})

describe('调试对话（SPEC-settings-9.31、9.32）', () => {
  it('示例问题直接发，带上没保存的授权；需确认的出卡片，确认后看到结果和接着的回复；清空', async () => {
    debugRounds = [
      [
        { type: 'delta', text: '我准备建一条任务。' },
        { type: 'confirm', id: 'dbg_1', name: 'create_object', args: '{"title":"周五前整理演示环境"}', summary: '新建「周五前整理演示环境」' },
        { type: 'done', session_id: '', message_id: '' },
      ],
      [
        { type: 'tool_call', name: 'create_object', args: '{"title":"周五前整理演示环境"}' },
        { type: 'tool_result', name: 'create_object', summary: '已新建 TSK-0042「周五前整理演示环境」' },
        { type: 'delta', text: '建好了。' },
        { type: 'done', session_id: '', message_id: '' },
      ],
    ]
    show('/settings/agents/ag_1?tab=tools')
    await waitFor(() => expect(document.querySelector('[data-ability="write_tasks"]')).not.toBeNull())
    await userEvent.click(within(row('[data-ability="write_tasks"]')).getByRole('radio', { name: '需确认' }))
    const panel = screen.getByRole('complementary', { name: '调试' })
    expect(within(panel).getByText('用当前配置试一试，不留会话记录')).toBeInTheDocument()
    await userEvent.click(within(panel).getByRole('button', { name: '建一条任务：周五前整理演示环境' }))
    const req = await waitFor(() => { const c = calls.find((x) => x.path === '/api/agents/debug/chat'); expect(c).toBeDefined(); return c! })
    expect(req.body).toMatchObject({
      agent_id: 'ag_1', provider_id: 'apv_a', messages: [{ role: 'user', content: '建一条任务：周五前整理演示环境' }],
      grants: { read_tasks: 'auto', read_contacts: 'auto', write_tasks: 'confirm' },
    })
    const ok = await within(panel).findByRole('button', { name: '确认执行' })
    expect(within(panel).getByText('等你确认')).toBeInTheDocument()
    await userEvent.click(ok)
    expect(await within(panel).findByText('建好了。')).toBeInTheDocument()
    expect(calls.some((c) => c.method === 'POST' && c.path === '/api/agent/tool-calls/dbg_1/confirm')).toBe(true)
    expect(within(panel).getByText('已确认执行')).toBeInTheDocument()
    expect(within(panel).getByText('已新建 TSK-0042「周五前整理演示环境」')).toBeInTheDocument()
    // 调试不建会话
    expect(calls.some((c) => c.path.startsWith('/api/agent/sessions') && c.method === 'POST')).toBe(false)

    await userEvent.click(within(panel).getByRole('button', { name: '清空' }))
    expect(within(panel).getByText('试着问它')).toBeInTheDocument()
  })

  it('⌘Enter 发送，第二句带上前面的对话；授权没开的提示要开哪项并能切到工具与权限', async () => {
    debugRounds = [
      [{ type: 'delta', text: '有 3 条任务。' }, { type: 'done', session_id: '', message_id: '' }],
      [
        { type: 'tool_call', name: 'create_object', args: '{}' },
        { type: 'tool_result', name: 'create_object', summary: 'create_object 没有授权，没有执行' },
        { type: 'done', session_id: '', message_id: '' },
      ],
    ]
    show()
    const panel = await screen.findByRole('complementary', { name: '调试' })
    const box = within(panel).getByRole('textbox', { name: '调试消息' })
    await userEvent.type(box, '查任务')
    await userEvent.keyboard('{Meta>}{Enter}{/Meta}')
    expect(await within(panel).findByText('有 3 条任务。')).toBeInTheDocument()
    await userEvent.type(box, '建一条')
    await userEvent.click(within(panel).getByRole('button', { name: '发送' }))
    await waitFor(() => expect(calls.filter((c) => c.path === '/api/agents/debug/chat')).toHaveLength(2))
    expect(calls.filter((c) => c.path === '/api/agents/debug/chat')[1].body?.messages).toEqual([
      { role: 'user', content: '查任务' }, { role: 'assistant', content: '有 3 条任务。' }, { role: 'user', content: '建一条' },
    ])
    await userEvent.click(await within(panel).findByRole('button', { name: /新建工作对象/ }))
    expect(within(panel).getByText(/这件事要用到「新建 \/ 更新任务」/)).toBeInTheDocument()
    await userEvent.click(within(panel).getByRole('button', { name: '可以在左边「工具与权限」里打开' }))
    expect(screen.getByRole('tab', { name: /工具与权限/, selected: true })).toBeInTheDocument()
  })
})
