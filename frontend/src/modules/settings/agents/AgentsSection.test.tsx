import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Agent, AgentImpact, AgentProvider } from '../../../core/data'
import { AgentsSection } from './AgentsSection'
import { AGENT_COLORS } from './model'

function prov(p: Partial<AgentProvider> & { id: string }): AgentProvider {
  return {
    name: p.id, kind: 'anthropic', base_url: '', model: 'claude-haiku-5-5', enabled: true, is_default: false, api_key_masked: '',
    has_api_key: true, extra: {}, created_at: '2026-10-29T00:00:00Z', updated_at: '2026-10-29T00:00:00Z', ...p,
  }
}

function agent(p: Partial<Agent> & { id: string }): Agent {
  return {
    name: p.id, desc: '', color: AGENT_COLORS[2], avatar: { kind: 'text', value: '' }, provider_id: 'apv_a', model: 'claude-haiku-5-5',
    instructions: '', skills: [], mcps: [], kbs: [], triggers: [{ kind: 'manual', detail: '' }], enabled: true,
    created_at: '2026-10-29T00:00:00Z', updated_at: '2026-10-29T00:00:00Z', ...p,
  }
}

type World = { agents: Agent[]; providers: AgentProvider[]; impact?: AgentImpact }
type Call = { method: string; path: string; body?: Record<string, unknown> }

// 内存里的后端：Agent 增删改照着改；执行记录接口还没有（404），其余列表给空
function fakeBackend(w: World) {
  const calls: Call[] = []
  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(status < 300 ? { data, meta: Array.isArray(data) ? { total: data.length } : undefined } : data), { status })
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input), 'http://x')
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ method, path: u.pathname, body })
    if (u.pathname === '/api/agents' && method === 'GET') return json(w.agents)
    if (u.pathname === '/api/agents' && method === 'POST') {
      const a = agent({ ...body, id: 'ag_new' })
      w.agents.unshift(a)
      return json(a, 201)
    }
    const m = u.pathname.match(/^\/api\/agents\/([^/]+)(\/[a-z]+)?$/)
    if (m) {
      const a = w.agents.find((x) => x.id === decodeURIComponent(m[1]))
      if (!a) return json({ error: { code: 'not_found', message: 'Agent 不存在' } }, 404)
      if (m[2] === '/impact') return json(w.impact ?? { agent_id: a.id, blocks: [], items: [] })
      if (m[2] === '/grants') return json({ agent_id: a.id, grants: { read_tasks: 'auto', write_tasks: 'confirm' }, effective: { read_tasks: 'auto', write_tasks: 'confirm' } })
      if (method === 'PATCH') Object.assign(a, body)
      if (method === 'DELETE') w.agents = w.agents.filter((x) => x !== a)
      return json(a)
    }
    if (u.pathname === '/api/agent-providers') return json(w.providers)
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
  return router
}

afterEach(() => vi.unstubAllGlobals())

describe('Agent 列表（SPEC-settings-8）', () => {
  it('卡片显示模型、说明、能力标签、触发方式；搜索写命中数，搜不到和一个都没有分开说', async () => {
    fakeBackend({
      providers: [prov({ id: 'apv_a', name: 'Anthropic' })],
      agents: [
        agent({ id: 'ag_1', name: '消息分诊助手', desc: '先确认是谁', triggers: [{ kind: 'manual', detail: '' }, { kind: 'im', detail: '飞书群' }] }),
        agent({ id: 'ag_2', name: '周报', desc: '' }),
      ],
    })
    show('/settings/agents')
    const card = await screen.findByRole('button', { name: '消息分诊助手' })
    expect(within(card).getByText('Claude Haiku 5.5')).toBeInTheDocument()
    expect(within(card).getByText('手动 · 飞书群')).toBeInTheDocument()
    expect(within(card).getByText('还没运行过')).toBeInTheDocument()
    expect(await within(card).findByText('新建 / 更新任务')).toHaveClass('confirm')
    expect(within(screen.getByRole('button', { name: '周报' })).getByText('还没有说明')).toBeInTheDocument()

    await userEvent.type(screen.getByRole('textbox', { name: '搜 Agent 名称和说明' }), '分诊 确认')
    expect(screen.getByText('命中 1 个')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '周报' })).not.toBeInTheDocument()
    await userEvent.type(screen.getByRole('textbox', { name: '搜 Agent 名称和说明' }), 'xyz')
    expect(screen.getByText('没有匹配的 Agent')).toBeInTheDocument()
  })

  it('一个都没有时写「还没有 Agent」', async () => {
    fakeBackend({ providers: [], agents: [] })
    show('/settings/agents')
    expect(await screen.findByText('还没有 Agent')).toBeInTheDocument()
  })

  it('别处用 ?agent=<id> 跳过来时打开这个 Agent 的配置页', async () => {
    fakeBackend({ providers: [prov({ id: 'apv_a' })], agents: [agent({ id: 'ag_1', name: '分诊' })] })
    const router = show('/settings/agents?agent=ag_1')
    await waitFor(() => expect(router.state.location.pathname).toBe('/settings/agents/ag_1'))
    expect(router.state.location.search).toBe('')
  })

  it('卡片上的开关直接启停，不进配置页；服务商停用时模型红字不可用', async () => {
    const calls = fakeBackend({ providers: [prov({ id: 'apv_a', enabled: false })], agents: [agent({ id: 'ag_1', name: '分诊' })] })
    const router = show('/settings/agents')
    const card = await screen.findByRole('button', { name: '分诊' })
    expect(within(card).getByText('Claude Haiku 5.5 · 不可用')).toHaveClass('danger-text')
    await userEvent.click(within(card).getByRole('switch', { name: '停用 分诊' }))
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH' && c.body?.enabled === false)).toBe(true))
    expect(router.state.location.pathname).toBe('/settings/agents')
    await userEvent.click(card)
    expect(router.state.location.pathname).toBe('/settings/agents/ag_1')
  })
})

describe('Agent 配置页（SPEC-settings-9）', () => {
  it('新建：什么都没填直接返回不拦；默认第一个可用的模型，保存记 provider_id 和 model，停在新 Agent 的配置页', async () => {
    const calls = fakeBackend({
      providers: [prov({ id: 'apv_off', enabled: false }), prov({ id: 'apv_a', name: 'Anthropic', model: 'claude-sonnet-5-5' })],
      agents: [],
    })
    const router = show('/settings/agents/new')
    expect(await screen.findByRole('heading', { name: '新建 Agent' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Agent' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/settings/agents'))

    await userEvent.click(await screen.findByRole('button', { name: /新建 Agent/ }))
    // 名称为空时点创建：跳到基本信息、底栏写问题，不发请求
    await userEvent.click(screen.getByRole('tab', { name: /模型/ }))
    expect(screen.getByRole('radio', { name: /Claude Sonnet 5.5/ })).toBeChecked()
    await userEvent.click(screen.getByRole('button', { name: '创建' }))
    expect(screen.getByRole('tab', { name: /基本信息/ })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText('名称还没填')).toBeInTheDocument()
    expect(calls.some((c) => c.method === 'POST')).toBe(false)

    await userEvent.type(screen.getByRole('textbox', { name: '名称' }), '  新助手 ')
    await userEvent.click(screen.getByRole('button', { name: '创建' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/settings/agents/ag_new'))
    const post = calls.find((c) => c.method === 'POST' && c.path === '/api/agents')!
    expect(post.body).toMatchObject({ name: '新助手', provider_id: 'apv_a', model: 'claude-sonnet-5-5', triggers: [{ kind: 'manual', detail: '' }] })
    expect(await screen.findByRole('heading', { name: '新助手' })).toBeInTheDocument()
  })

  it('改了没保存时离开先在底栏确认：继续编辑留下，放弃修改离开', async () => {
    fakeBackend({ providers: [prov({ id: 'apv_a' })], agents: [agent({ id: 'ag_1', name: '分诊' })] })
    const router = show('/settings/agents/ag_1')
    const desc = await screen.findByRole('textbox', { name: '说明' })
    await userEvent.type(desc, '新的说明')
    expect(screen.getByText('有未保存的修改，切换标签不会丢')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Agent' }))
    expect(await screen.findByText('有未保存的修改，离开后会丢掉')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '继续编辑' }))
    expect(router.state.location.pathname).toBe('/settings/agents/ag_1')
    expect(screen.getByRole('textbox', { name: '说明' })).toHaveValue('新的说明')
    // 外面的跳转（切二级菜单）同样拦
    void router.navigate('/settings/providers')
    expect(await screen.findByText('有未保存的修改，离开后会丢掉')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '放弃修改' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/settings/providers'))
  })

  it('保存只传改了的字段，换模型记服务商和模型；保存后显示已保存', async () => {
    const calls = fakeBackend({
      providers: [
        prov({ id: 'apv_a', name: 'Anthropic' }), prov({ id: 'apv_o', name: 'OpenAI', kind: 'openai', model: 'gpt-5' }),
        prov({ id: 'apv_l', name: '本机', kind: 'ollama', model: '', has_api_key: false, extra: { model_ids: 'qwen3:4b, llama3:8b' } }),
      ],
      agents: [agent({ id: 'ag_1', name: '分诊' })],
    })
    show('/settings/agents/ag_1')
    await userEvent.click(await screen.findByRole('tab', { name: /模型/ }))
    // 超过 6 个：只露当前选中的一行和「换模型」
    await userEvent.click(screen.getByRole('button', { name: /换模型/ }))
    await userEvent.type(screen.getByRole('textbox', { name: '搜模型或服务商' }), 'openai mini')
    await userEvent.click(screen.getByRole('radio', { name: /GPT-5 mini/ }))
    await userEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ provider_id: 'apv_o', model: 'gpt-5-mini' }))
    expect(await screen.findByRole('button', { name: '已保存' })).toBeDisabled()
  })

  it('服务商停用后模型标签红点，顶部红条写不可用', async () => {
    fakeBackend({ providers: [prov({ id: 'apv_a', name: 'Anthropic', enabled: false })], agents: [agent({ id: 'ag_1', name: '分诊' })] })
    show('/settings/agents/ag_1')
    await userEvent.click(await screen.findByRole('tab', { name: /模型/ }))
    expect(screen.getByRole('alert')).toHaveTextContent('Claude Haiku 5.5 当前不可用，Agent 调用会失败，换一个可用的模型。')
    expect(screen.getByRole('tab', { name: /模型/ })).toHaveAttribute('title', 'Claude Haiku 5.5 当前不可用')
  })

  it('删除被拦时写原因和「知道了」；能删时列影响，删后回列表', async () => {
    const w: World = {
      providers: [prov({ id: 'apv_a' })], agents: [agent({ id: 'ag_1', name: '分诊' })],
      impact: { agent_id: 'ag_1', blocks: [{ key: 'schedules', count: 1, text: '定时任务「周报」交给它执行，先改掉或删掉这些定时任务' }], items: [] },
    }
    const calls = fakeBackend(w)
    const router = show('/settings/agents/ag_1')
    await userEvent.click(await screen.findByRole('button', { name: '删除' }))
    expect(await screen.findByText('不能删除：定时任务「周报」交给它执行，先改掉或删掉这些定时任务')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '知道了' }))

    w.impact = { agent_id: 'ag_1', blocks: [], items: [{ key: 'sessions', count: 2, text: '2 个会话和它们的产出保留，显示为已删除的 Agent', effect: 'keep' }] }
    await userEvent.click(screen.getByRole('button', { name: '删除' }))
    expect(await screen.findByText('删除后2 个会话和它们的产出保留，显示为已删除的 Agent')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '删除' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/settings/agents'))
    expect(calls.some((c) => c.method === 'DELETE' && c.path === '/api/agents/ag_1')).toBe(true)
  })

  it('打开不存在的 Agent 写「这个 Agent 不存在或已删除」', async () => {
    fakeBackend({ providers: [], agents: [] })
    show('/settings/agents/ag_gone')
    expect(await screen.findByText('这个 Agent 不存在或已删除')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '回到 Agent 列表' })).toBeInTheDocument()
  })

  it('触发方式：加一行定时，只剩一行时删除置灰；任务触发默认勾着分配给它', async () => {
    fakeBackend({ providers: [prov({ id: 'apv_a' })], agents: [agent({ id: 'ag_1', name: '分诊' })] })
    show('/settings/agents/ag_1')
    await userEvent.click(await screen.findByRole('tab', { name: /触发方式/ }))
    const rows = () => screen.getAllByRole('combobox', { name: '触发类型' })
    expect(rows()).toHaveLength(1)
    await userEvent.click(screen.getByRole('button', { name: '加一个触发方式' }))
    expect(rows()).toHaveLength(2)
    expect(rows()[1]).toHaveValue('schedule')
    expect(screen.getByRole('tab', { name: /触发方式/ })).toHaveAttribute('title', '有触发方式没填条件')
    await userEvent.selectOptions(rows()[1], 'task')
    expect(screen.getByRole('checkbox', { name: '任务分配给它' })).toBeChecked()
  })
})
