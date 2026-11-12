import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { LatestMessage } from './LatestMessage'

afterEach(() => vi.unstubAllGlobals())

function setup(rows: unknown[], webhook = '', failed = false) {
  const calls: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    calls.push(url)
    if (failed) return new Response(JSON.stringify({ error: { message: '同步超时' } }), { status: 502 })
    return new Response(JSON.stringify({ data: url.endsWith('/sync') ? {} : rows }))
  }))
  const connector = { id: 'cn_bot', config: { webhook_url: webhook } }
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={qc}><LatestMessage connector={connector} testedAt={1} /></QueryClientProvider>)
  return calls
}

it('同步后读取当前连接器的最新消息，展示发送人、时间和原文', async () => {
  const calls = setup([
    { id: 'm3', sender_name: '小林', sender_id: '123', text: '第一行\n第二行', at: '2026-11-11T12:30:00Z' },
    { id: 'm2', sender_name: '小王', text: '第二条', at: '2026-11-11T12:29:00Z' },
    { id: 'm1', sender_name: '小李', text: '第三条', at: '2026-11-11T12:28:00Z' },
  ])
  expect(await screen.findByText('小林')).toBeInTheDocument()
  expect(screen.getByText(/第一行/)).toHaveTextContent('第一行 第二行')
  expect(document.querySelector('time')).toHaveAttribute('datetime', '2026-11-11T12:30:00Z')
  expect(screen.getAllByRole('row')).toHaveLength(4)
  expect(screen.getAllByRole('row').slice(1).map((row) => within(row).getAllByRole('cell')[0].textContent)).toEqual(['小林', '小王', '小李'])
  expect(calls).toEqual(['/api/im/connectors/cn_bot/sync', '/api/im/messages?connector_id=cn_bot&limit=3&offset=0'])
})

it('webhook 模式只读已收消息并展示空状态', async () => {
  const calls = setup([], 'https://example.com')
  expect(await screen.findByText(/暂无消息/)).toBeInTheDocument()
  expect(calls).toHaveLength(1)
})

it('同步失败时展示原因，不把它当作暂无消息', async () => {
  const calls = setup([], '', true)
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('消息读取失败：同步超时'))
  expect(calls).toHaveLength(1)
  expect(screen.queryByText(/暂无消息/)).not.toBeInTheDocument()
})
