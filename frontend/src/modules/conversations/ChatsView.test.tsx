// 空会话不堆积（B-09）：没有消息的会话只在打开时列出，从它切走时删掉；有消息的、删除会话后切走的不再删。
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSession } from '../../core/data'
import { resetLiveChats } from './chatLive'
import { ChatsView } from './ChatsView'

const now = new Date().toISOString()
const sess = (id: string, title: string, message_count: number): AgentSession => ({
  id, title, object_id: null, provider_id: 'apv_1', model: 'm', workdir: '', agent_id: null, created_at: now, updated_at: now, message_count,
})
let sessions: AgentSession[] = []
let deleted: string[] = []

beforeEach(() => {
  resetLiveChats()
  deleted = []
  sessions = [sess('ags_e', '新会话', 0), sess('ags_m', '周报怎么写', 2), sess('ags_e2', '新会话', 0)]
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input), 'http://x')
    if (init?.method === 'DELETE') {
      const id = u.pathname.split('/').pop() ?? ''
      deleted.push(id)
      sessions = sessions.filter((s) => s.id !== id)
      return new Response(null, { status: 204 })
    }
    const data = u.pathname === '/api/agent/sessions' ? sessions
      : u.pathname === '/api/agent-providers' ? [{ id: 'apv_1', name: '本机 Ollama', kind: 'ollama', model: 'm', enabled: true, is_default: true }]
        : []
    return new Response(JSON.stringify({ data, meta: { total: Array.isArray(data) ? data.length : 0 } }), { status: 200 })
  }))
})
afterEach(() => { vi.unstubAllGlobals() })

function setup(current: string | null) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const view = (c: string | null) => <QueryClientProvider client={client}><ChatsView current={c} onOpen={vi.fn()} /></QueryClientProvider>
  const r = render(view(current))
  return { rerender: (c: string | null) => r.rerender(view(c)), container: r.container }
}
const items = (c: HTMLElement) => [...c.querySelectorAll('.chat-item-title')].map((e) => e.textContent)

describe('空会话（B-09）', () => {
  it('列表不列没有消息的会话，正打开的除外', async () => {
    const { container, rerender } = setup(null)
    await screen.findByText('周报怎么写')
    expect(items(container)).toEqual(['周报怎么写'])
    rerender('ags_e')
    await waitFor(() => expect(items(container)).toEqual(['新会话', '周报怎么写']))
    expect(deleted).toEqual([])
  })

  it('从空会话切走就删掉它，从有消息的切走不删', async () => {
    const { container, rerender } = setup('ags_e')
    await waitFor(() => expect(items(container)).toContain('新会话'))
    rerender('ags_m')
    await waitFor(() => expect(deleted).toEqual(['ags_e']))
    rerender('ags_e2')
    await waitFor(() => expect(items(container)).toContain('新会话'))
    rerender('ags_m')
    await waitFor(() => expect(deleted).toEqual(['ags_e', 'ags_e2']))
    rerender(null)
    await new Promise((r) => setTimeout(r, 20))
    expect(deleted).toEqual(['ags_e', 'ags_e2'])
  })
})
