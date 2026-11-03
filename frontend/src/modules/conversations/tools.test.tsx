// 会话旁边的终端、浏览器（SPEC-sessions-1.34 到 1.38）：入口来自插件登记，没登记就没有；点了在对话右边展开，
// 再点收起；面板拿到会话的工作目录、会话里的链接和「打开」次数
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { lazy } from 'react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSession } from '../../core/data'
import { sessionToolRegistry, sessionToolStore, type SessionToolProps } from '../../core/plugin'
import { resetLiveChats } from '../../core/chat/chatLive'
import { sessionLinks } from '../../core/chat/chatModel'
import { ChatsView } from './ChatsView'
import { EMPTY_DOCK, switchTool, toggleTool } from './dockModel'

describe('会话里的链接', () => {
  const m = (role: string, content: string) => ({ role, content })
  it('只取 Agent 回复和工具结果，新的在前、去重（留新的那个写法）、去掉末尾标点', () => {
    expect(sessionLinks([
      m('user', '看看 https://user.example.com'),
      m('assistant', '文档在 https://a.example.com/doc，另见 (https://b.example.com/x)。'),
      m('tool', '{"url":"https://c.example.com/p?q=1"} 和 https://a.example.com/doc/'),
      m('assistant', '预览：http://127.0.0.1:5173/。打开https://d.example.com/中文后面'),
    ])).toEqual(['http://127.0.0.1:5173/', 'https://d.example.com/', 'https://c.example.com/p?q=1', 'https://a.example.com/doc/', 'https://b.example.com/x'])
  })
  it('最多 limit 个', () => {
    const msgs = Array.from({ length: 12 }, (_, i) => m('assistant', `https://e${i}.example.com`))
    expect(sessionLinks(msgs, 3)).toEqual(['https://e11.example.com', 'https://e10.example.com', 'https://e9.example.com'])
  })
})

describe('面板状态', () => {
  it('入口：展开、再点收起；每次展开算一次打开。头部切换不收起，打开过的不再算', () => {
    let d = toggleTool(EMPTY_DOCK, 'terminal')
    expect(d).toEqual({ open: 'terminal', mounted: ['terminal'], req: { terminal: 1 } })
    d = toggleTool(d, 'terminal')
    expect(d.open).toBeNull()
    d = toggleTool(d, 'terminal')
    expect(d.req.terminal).toBe(2)
    d = switchTool(d, 'browser')
    expect(d).toEqual({ open: 'browser', mounted: ['terminal', 'browser'], req: { terminal: 2, browser: 1 } })
    d = switchTool(d, 'terminal')
    expect(d).toEqual({ open: 'terminal', mounted: ['terminal', 'browser'], req: { terminal: 2, browser: 1 } })
  })
})

const now = new Date().toISOString()
const session: AgentSession = {
  id: 'ags_1', title: '查文档', object_id: null, provider_id: 'apv_1', model: 'm', workdir: '/w/app', agent_id: null, created_at: now, updated_at: now, message_count: 2,
}
const seen: SessionToolProps[] = []
const Fake = (p: SessionToolProps) => { seen.push(p); return <div data-testid="fake-term">{p.workdir}|{p.links.join(',')}|{p.request}</div> }

function stubBackend() {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const u = new URL(String(input), 'http://x')
    const data = u.pathname === '/api/agent/sessions' ? [session]
      : u.pathname === '/api/agent-providers' ? [{ id: 'apv_1', name: '本机 Ollama', kind: 'ollama', model: 'm', enabled: true, is_default: true }]
        : u.pathname === '/api/agent/sessions/ags_1/messages' ? [
          { id: 'm1', session_id: 'ags_1', role: 'user', content: '文档在哪', created_at: now },
          { id: 'm2', session_id: 'ags_1', role: 'assistant', content: '在 https://docs.example.com/a', created_at: now },
        ]
          : []
    return new Response(JSON.stringify({ data, meta: { total: Array.isArray(data) ? data.length : 0 } }), { status: 200 })
  }))
}

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<MemoryRouter><QueryClientProvider client={client}><ChatsView current="ags_1" onOpen={vi.fn()} /></QueryClientProvider></MemoryRouter>)
}

describe('会话头部的终端、浏览器入口', () => {
  beforeEach(() => { resetLiveChats(); seen.length = 0; stubBackend() })
  afterEach(() => { vi.unstubAllGlobals(); sessionToolStore.removeOwner('terminal'); sessionToolStore.removeOwner('browser') })

  it('插件没登记（停用）时没有入口', async () => {
    setup()
    await screen.findByRole('button', { name: '删除会话' })
    expect(screen.queryByRole('button', { name: '终端' })).toBeNull()
    expect(document.querySelector('.chat-dock')).toBeNull()
  })

  it('点「终端」在右边展开，面板拿到工作目录、链接和打开次数；再点收起，面板留着', async () => {
    sessionToolRegistry('terminal').register({ key: 'terminal', label: '终端', icon: () => null, order: 10, page: '/terminal', panel: lazy(async () => ({ default: Fake })) })
    sessionToolRegistry('browser').register({ key: 'browser', label: '浏览器', icon: () => null, order: 20, panel: lazy(async () => ({ default: () => <div>浏览器面板</div> })) })
    setup()
    const user = userEvent.setup()
    const btn = await screen.findByRole('button', { name: '终端' })
    expect(btn).toHaveAttribute('title', '在对话旁边打开终端')
    expect(screen.getByRole('button', { name: '浏览器' })).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('button', { name: '浏览器' })).toBeInTheDocument())
    await user.click(btn)
    const dock = await screen.findByRole('region', { name: '会话旁边的终端' })
    await waitFor(() => expect(within(dock).getByTestId('fake-term')).toHaveTextContent('/w/app|https://docs.example.com/a|1'))
    expect(btn).toHaveAttribute('aria-pressed', 'true')
    expect(within(dock).getByRole('button', { name: '整页打开' })).toBeInTheDocument()
    await user.click(btn)
    expect(btn).toHaveAttribute('aria-pressed', 'false')
    expect(document.querySelector('.chat-dock')).toHaveAttribute('hidden')
    expect(screen.getByTestId('fake-term')).toBeInTheDocument()
    await user.click(btn)
    await waitFor(() => expect(screen.getByTestId('fake-term')).toHaveTextContent('|2'))
    // 头部切到浏览器：终端藏起来不卸载，浏览器没有整页路径就不给「整页打开」
    await user.click(within(screen.getByRole('tablist', { name: '会话旁边的工具' })).getByRole('tab', { name: '浏览器' }))
    expect(await screen.findByText('浏览器面板')).toBeInTheDocument()
    expect(screen.getByTestId('fake-term').closest('[hidden]')).not.toBeNull()
    expect(screen.queryByRole('button', { name: '整页打开' })).toBeNull()
  })

  it('插件停用后入口和面板跟着消失', async () => {
    sessionToolRegistry('terminal').register({ key: 'terminal', label: '终端', icon: () => null, panel: lazy(async () => ({ default: Fake })) })
    setup()
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: '终端' }))
    await screen.findByTestId('fake-term')
    sessionToolStore.removeOwner('terminal')
    await waitFor(() => expect(screen.queryByRole('button', { name: '终端' })).toBeNull())
    expect(screen.queryByTestId('fake-term')).toBeNull()
  })
})
