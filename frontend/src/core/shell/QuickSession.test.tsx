// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider, useSearchParams } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { firstMessageOf } from '../data'
import type { ModuleDef } from '../plugin'
import { Shell } from './Shell'

function ConvPage() {
  const [p] = useSearchParams()
  return <p>会话页 {p.get('s')}</p>
}
const page = (text: string) => () => Promise.resolve({ default: () => <p>{text}</p> })
const modules: ModuleDef[] = [
  { id: 'today', label: '今日', path: 'today', load: page('今日页') },
  { id: 'conversations', label: '会话', path: 'conversations', load: () => Promise.resolve({ default: ConvPage }) },
  { id: 'settings', label: '设置', path: 'settings', load: page('设置页') },
]

const provider = (id: string, name: string, over: Record<string, unknown> = {}) => ({
  id, name, kind: 'openai', base_url: '', model: name.toLowerCase() + '-model', enabled: true, is_default: false,
  api_key_masked: '', has_api_key: true, extra: {}, created_at: '', updated_at: '', ...over,
})
const agent = (id: string, name: string, over: Record<string, unknown> = {}) => ({
  id, name, desc: name + '的说明', color: '#3d4fd6', avatar: { kind: 'text', value: '' }, provider_id: 'p1', model: 'alpha-model',
  instructions: '', skills: [], mcps: [], kbs: [], triggers: [], enabled: true, created_at: '', updated_at: '', ...over,
})
let agents: unknown[] = []
const json = (data: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify({ data }), { status }))

let created: unknown[] = []
function backend(url: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const u = String(url)
  if (u.includes('/api/workspaces')) return json(null, 500)
  if (u.includes('/api/agents')) return json(agents)
  if (u.includes('/api/agent-providers')) {
    return json([provider('p1', 'Alpha'), provider('p2', 'Beta', { is_default: true }), provider('p3', 'Off', { enabled: false })])
  }
  if (u.includes('/api/agent/sessions') && init?.method === 'POST') {
    created.push(JSON.parse(String(init.body)))
    return json({ id: 'ss_new', title: '新会话', object_id: null, provider_id: 'p1', model: 'alpha-model', workdir: '', created_at: '', updated_at: '', message_count: 0 })
  }
  if (u.includes('/api/agent/sessions')) {
    return json([{ id: 'ss_old', title: '旧', object_id: null, provider_id: 'p1', model: 'm', workdir: '', agent_id: 'a2', agent_deleted: false, created_at: '', updated_at: '', message_count: 1 }])
  }
  return new Promise<Response>(() => {})
}

function renderShell() {
  const router = createMemoryRouter(
    [{
      path: '/',
      element: <Shell modules={modules} />,
      children: modules.map((m) => ({ path: m.path + '/*', lazy: async () => ({ Component: (await m.load()).default }) })),
    }],
    { initialEntries: ['/today'] },
  )
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>)
}

describe('快速新建会话', () => {
  beforeEach(() => {
    created = []
    agents = [agent('a1', '分诊助手'), agent('a2', '周报助手'), agent('a3', '停用的', { enabled: false })]
    vi.stubGlobal('fetch', vi.fn(backend))
    localStorage.clear()
  })
  afterEach(() => vi.unstubAllGlobals())

  it('侧栏按钮打开，默认选上次用的 Agent，停用的不出现；回车按 Agent 建会话、跳到会话页（SPEC-sessions-4）', async () => {
    renderShell()
    await userEvent.click(await screen.findByRole('button', { name: '新建会话' }))
    const dialog = await screen.findByRole('dialog', { name: '快速新建会话' })
    expect(await screen.findByRole('radio', { name: /周报助手/ })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByText('周报助手的说明')).toBeInTheDocument()
    expect(screen.queryByRole('radio', { name: /停用的/ })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('radio', { name: /分诊助手/ }))
    const input = screen.getByRole('textbox', { name: '第一句话' })
    expect(input).toHaveFocus()
    expect(input).toHaveAttribute('placeholder', '问 分诊助手 点什么；留空就只开一个空会话')
    await userEvent.type(input, '今天谁找我了{Enter}')
    expect(await screen.findByText('会话页 ss_new')).toBeInTheDocument()
    expect(dialog).not.toBeInTheDocument()
    expect(created).toEqual([{ agent_id: 'a1', title: '新会话' }])
    expect(firstMessageOf('ss_new')).toBe('今天谁找我了')
  })

  it('所有 Agent 都停用：直接落到服务商可以聊，改回选 Agent 才提示去设置启用', async () => {
    agents = [agent('a3', '停用的', { enabled: false })]
    renderShell()
    await userEvent.click(await screen.findByRole('button', { name: '新建会话' }))
    expect(await screen.findByText(/Agent 都停用了，先直接用服务商聊/)).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: '第一句话' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '改回选 Agent' }))
    expect(await screen.findByText('所有 Agent 都停用了，先到「设置 / Agent」里启用一个')).toBeInTheDocument()
    expect(screen.getByText('没有可用的 Agent')).toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: '第一句话' })).not.toBeInTheDocument()
  })

  it('「更多」里按服务商开：默认选默认服务商，停用的不出现', async () => {
    renderShell()
    await userEvent.click(await screen.findByRole('button', { name: '新建会话' }))
    const dialog = await screen.findByRole('dialog', { name: '快速新建会话' })
    await userEvent.click(await screen.findByRole('button', { name: '更多：不选 Agent，用服务商' }))
    expect(await screen.findByRole('radio', { name: /Beta/ })).toHaveAttribute('aria-checked', 'true')
    expect(screen.queryByRole('radio', { name: /Off/ })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('radio', { name: /Alpha/ }))
    const input = screen.getByRole('textbox', { name: '第一句话' })
    expect(input).toHaveFocus()
    await userEvent.type(input, '帮我看看今天的任务{Enter}')
    expect(await screen.findByText('会话页 ss_new')).toBeInTheDocument()
    expect(dialog).not.toBeInTheDocument()
    expect(created).toEqual([{ provider_id: 'p1', model: 'alpha-model', title: '新会话' }])
    expect(firstMessageOf('ss_new')).toBe('帮我看看今天的任务')
  })

  it('Cmd/Ctrl+J 开关，Esc 关上', async () => {
    renderShell()
    await screen.findByRole('link', { name: '今日' })
    await userEvent.keyboard('{Meta>}j{/Meta}')
    expect(await screen.findByRole('dialog', { name: '快速新建会话' })).toBeInTheDocument()
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('dialog', { name: '快速新建会话' })).not.toBeInTheDocument()
    await userEvent.keyboard('{Control>}j{/Control}')
    expect(await screen.findByRole('dialog', { name: '快速新建会话' })).toBeInTheDocument()
    await userEvent.keyboard('{Control>}j{/Control}')
    expect(screen.queryByRole('dialog', { name: '快速新建会话' })).not.toBeInTheDocument()
  })
})
