// 会话旁边的浏览器（SPEC-sessions-1.36）：会话里有链接时多一行「会话里的链接」，点了在这里打开，同一地址的标签切过去
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SessionPanel from './SessionPanel'
import { getBrowserState, resetBrowserStore } from './store'

beforeEach(() => {
  resetBrowserStore()
  const json = (data: unknown) => new Response(JSON.stringify({ data, meta: { total: 0 } }), { status: 200 })
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const u = new URL(String(input), 'http://x')
    if (u.pathname === '/api/browser/allowlist') return json([{ host: '127.0.0.1', note: '', builtin: true, created_at: null }])
    if (u.pathname === '/api/browser/google') return json({ signed_in: false, configured: false, account: null, drive: null, calendar: null })
    return json([])
  }))
})
afterEach(() => { resetBrowserStore(); vi.unstubAllGlobals() })

function renderPanel(links: string[]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<MemoryRouter><QueryClientProvider client={qc}><SessionPanel sessionId="ags_1" workdir="" links={links} request={1} hidden={false} /></QueryClientProvider></MemoryRouter>)
}

describe('会话旁边的浏览器', () => {
  it('没有链接时没有那一行', async () => {
    renderPanel([])
    await screen.findByRole('tablist', { name: '浏览器标签页' })
    expect(screen.queryByRole('group', { name: '会话里的链接' })).toBeNull()
  })

  it('点链接新开标签，再点切过去不重复开', async () => {
    renderPanel(['http://127.0.0.1:5173/', 'https://docs.example.com/a'])
    const user = userEvent.setup()
    const bar = await screen.findByRole('group', { name: '会话里的链接' })
    await user.click(within(bar).getByRole('button', { name: '127.0.0.1:5173' }))
    await waitFor(() => expect(getBrowserState().tabs.tabs.map((t) => t.url)).toEqual(['about:home', 'http://127.0.0.1:5173/']))
    expect(within(bar).getByRole('button', { name: '127.0.0.1:5173' })).toHaveClass('on')
    await user.click(within(bar).getByRole('button', { name: 'docs.example.com/a' }))
    await user.click(within(bar).getByRole('button', { name: '127.0.0.1:5173' }))
    expect(getBrowserState().tabs.tabs).toHaveLength(3)
  })
})
