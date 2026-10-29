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
const json = (data: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify({ data }), { status }))

let created: unknown[] = []
function backend(url: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const u = String(url)
  if (u.includes('/api/workspaces')) return json(null, 500)
  if (u.includes('/api/agent-providers')) {
    return json([provider('p1', 'Alpha'), provider('p2', 'Beta', { is_default: true }), provider('p3', 'Off', { enabled: false })])
  }
  if (u.includes('/api/agent/sessions') && init?.method === 'POST') {
    created.push(JSON.parse(String(init.body)))
    return json({ id: 'ss_new', title: '新会话', object_id: null, provider_id: 'p1', model: 'alpha-model', workdir: '', created_at: '', updated_at: '', message_count: 0 })
  }
  if (u.includes('/api/agent/sessions')) return json([])
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
    vi.stubGlobal('fetch', vi.fn(backend))
    localStorage.clear()
  })
  afterEach(() => vi.unstubAllGlobals())

  it('侧栏按钮打开，默认选默认服务商，停用的不出现；回车建会话、跳到会话页，第一句话留给会话页发', async () => {
    renderShell()
    await userEvent.click(await screen.findByRole('button', { name: '新建会话' }))
    const dialog = await screen.findByRole('dialog', { name: '快速新建会话' })
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
