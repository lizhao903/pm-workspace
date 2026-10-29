import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LocalFsSection } from './LocalFsSection'

type Call = { method: string; path: string; query: string; body?: Record<string, unknown> }

function fakeBackend() {
  const calls: Call[] = []
  let extra: { path: string; added_at: string }[] = []
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(status < 300 ? { data } : data), { status })
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input), 'http://x')
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ method, path: u.pathname, query: u.search, body })
    if (u.pathname !== '/api/fs/roots') return json({ error: { code: 'not_found', message: u.pathname } }, 404)
    if (method === 'GET') return json({ defaults: ['/Users/me', '/Volumes', '/tmp'], extra })
    if (method === 'POST') {
      if (body?.path === '/etc') return json({ error: { code: 'validation', message: '/etc 在系统目录 /etc 里，不能加为可浏览目录' } }, 400)
      extra = [...extra, { path: String(body?.path), added_at: '2026-10-29T08:00:00.000Z' }]
      return json(extra[extra.length - 1], 201)
    }
    if (method === 'DELETE') {
      extra = extra.filter((r) => r.path !== u.searchParams.get('path'))
      return json(null)
    }
    return json({ error: { code: 'not_found', message: '' } }, 404)
  }))
  return { calls }
}

function renderSection() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}><LocalFsSection /></QueryClientProvider>)
}

describe('设置 / 本机目录（FS-01）', () => {
  let be: ReturnType<typeof fakeBackend>
  beforeEach(() => { be = fakeBackend() })
  afterEach(() => vi.unstubAllGlobals())

  it('列默认范围，加一个额外目录，删掉要先确认', async () => {
    renderSection()
    const defaults = await screen.findByRole('list', { name: '默认可浏览' })
    expect(within(defaults).getByText('/Volumes')).toBeInTheDocument()
    expect(screen.queryByRole('list', { name: '额外可浏览目录' })).toBeNull()

    await userEvent.type(screen.getByRole('textbox', { name: '要加的目录' }), '/opt/data{Enter}')
    const extra = await screen.findByRole('list', { name: '额外可浏览目录' })
    expect(within(extra).getByText('/opt/data')).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: '要加的目录' })).toHaveValue('')

    await userEvent.click(within(extra).getByRole('button', { name: '删除' }))
    await userEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '删除' }))
    await screen.findByText(/还没有/)
    expect(be.calls.find((c) => c.method === 'DELETE')?.query).toBe('?path=%2Fopt%2Fdata')
  })

  it('被拒时显示后端写明的原因', async () => {
    renderSection()
    await userEvent.type(await screen.findByRole('textbox', { name: '要加的目录' }), '/etc')
    await userEvent.click(screen.getByRole('button', { name: '加入' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('系统目录')
  })
})
