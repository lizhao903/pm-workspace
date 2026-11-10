// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Agent, AgentProvider, AgentScenario } from '../../../core/data'
import { AgentsSection } from './AgentsSection'
import { scenarioOptions, scenarioProblem } from './model'

// Agent 的思考档位和场景默认 Agent（0045）

const prov: AgentProvider = {
  id: 'apv_l', name: '本机', kind: 'ollama', base_url: '', model: 'qwen3:4b', enabled: true, is_default: true, api_key_masked: '',
  has_api_key: false, extra: {}, created_at: '2026-10-29T00:00:00Z', updated_at: '2026-10-29T00:00:00Z',
}
const agent = (p: Partial<Agent> & { id: string }): Agent => ({
  name: p.id, desc: '', color: '#3d4fd6', avatar: { kind: 'text', value: '' }, provider_id: 'apv_l', model: 'qwen3:4b',
  instructions: '', skills: [], mcps: [], kbs: [], triggers: [{ kind: 'manual', detail: '' }], thinking: 'default', enabled: true,
  created_at: '2026-10-29T00:00:00Z', updated_at: '2026-10-29T00:00:00Z', ...p,
})

type Call = { method: string; path: string; body?: Record<string, unknown> }
function fakeBackend(agents: Agent[], scenarios: AgentScenario[]) {
  const calls: Call[] = []
  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(status < 300 ? { data, meta: Array.isArray(data) ? { total: data.length } : undefined } : data), { status })
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input), 'http://x')
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ method, path: u.pathname, body })
    if (u.pathname === '/api/agents' && method === 'GET') return json(agents)
    if (u.pathname === '/api/agents/scenarios') {
      if (method === 'PATCH') for (const [k, v] of Object.entries(body as Record<string, string>)) {
        const s = scenarios.find((x) => x.key === k)
        if (s) s.agent_id = v
      }
      return json(scenarios)
    }
    const m = u.pathname.match(/^\/api\/agents\/([^/]+)(\/[a-z]+)?$/)
    if (m) {
      const a = agents.find((x) => x.id === decodeURIComponent(m[1]))
      if (!a) return json({ error: { code: 'not_found', message: 'Agent 不存在' } }, 404)
      if (m[2] === '/grants') return json({ agent_id: a.id, grants: {}, effective: {} })
      if (method === 'PATCH') Object.assign(a, body)
      return json(a)
    }
    if (u.pathname === '/api/agent-providers') return json([prov])
    if (u.pathname === '/api/agent-runs') return json({ error: { code: 'not_found', message: 'not found' } }, 404)
    if (['/api/skills', '/api/knowledge-bases', '/api/connectors', '/api/categories', '/api/conversations'].includes(u.pathname)) return json([])
    return json({ error: { code: 'not_found', message: u.pathname } }, 404)
  }))
  return calls
}

function show(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createMemoryRouter([{ path: '/settings/*', element: <AgentsSection /> }], { initialEntries: [path] })
  render(<QueryClientProvider client={qc}><RouterProvider router={router} /></QueryClientProvider>)
}

const scenes = (): AgentScenario[] => [
  { key: 'sop_assist', label: 'SOP 编排助手', desc: '流程编辑器里的助手', agent_id: '' },
  { key: 'background', label: '其他后台调用', desc: '插件后台调模型', agent_id: 'ag_gone' },
]

afterEach(() => vi.unstubAllGlobals())

describe('Agent 的思考档位', () => {
  it('模型标签里选思考，保存只传 thinking；卡片上写出非默认的档位', async () => {
    const agents = [agent({ id: 'ag_1', name: '内容分诊' })]
    const calls = fakeBackend(agents, scenes())
    show('/settings/agents/ag_1')
    await userEvent.click(await screen.findByRole('tab', { name: /模型/ }))
    const sel = screen.getByRole('combobox', { name: /思考/ })
    expect(sel).toHaveValue('default')
    await userEvent.selectOptions(sel, 'off')
    expect(screen.getByText(/最快，适合分类、提取这类简单活/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ thinking: 'off' }))
  })

  it('列表卡片写出思考档位', async () => {
    fakeBackend([agent({ id: 'ag_1', name: '内容分诊', thinking: 'off' }), agent({ id: 'ag_2', name: '周报' })], scenes())
    show('/settings/agents')
    const card = await screen.findByRole('button', { name: '内容分诊' })
    expect(card).toHaveTextContent('思考：不思考')
    expect(screen.getByRole('button', { name: '周报' })).not.toHaveTextContent('思考')
  })
})

describe('场景默认 Agent', () => {
  it('列表页下方每个场景一个下拉，改了就存；选的 Agent 删了标红', async () => {
    const calls = fakeBackend([agent({ id: 'ag_1', name: '内容分诊' }), agent({ id: 'ag_2', name: '旧的', enabled: false })], scenes())
    show('/settings/agents')
    const box = await screen.findByRole('region', { name: '场景默认 Agent' })
    expect(within(box).getByText('选的 Agent 已删除，现在用默认服务商，换一个')).toBeInTheDocument()
    const assist = within(box).getByRole('combobox', { name: 'SOP 编排助手的默认 Agent' })
    expect(within(assist).getByRole('option', { name: '旧的（已停用）' })).toBeInTheDocument()
    await userEvent.selectOptions(assist, 'ag_1')
    await waitFor(() => expect(calls.find((c) => c.method === 'PATCH' && c.path === '/api/agents/scenarios')?.body).toEqual({ sop_assist: 'ag_1' }))
  })

  it('下拉选项和问题说明', () => {
    const list = [agent({ id: 'ag_1', name: 'A' }), agent({ id: 'ag_2', name: 'B', enabled: false })]
    expect(scenarioOptions('', list).map((o) => o.label)).toEqual(['不指定（用默认服务商）', 'A', 'B（已停用）'])
    expect(scenarioOptions('ag_x', list).at(-1)).toEqual({ value: 'ag_x', label: '已删除的 Agent' })
    expect(scenarioProblem('', list)).toBeUndefined()
    expect(scenarioProblem('ag_1', list)).toBeUndefined()
    expect(scenarioProblem('ag_2', list)).toBe('「B」已停用，现在用默认服务商')
  })
})
