import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, act } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import JobsSection from './Section'

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })
it('显示任务统计并每十秒重新读取', async () => {
  vi.useFakeTimers()
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ data: [{
    plugin_id: 'im', plugin_name: 'IM 消息', name: 'pull_telegram', every_ms: 1000,
    enabled: true, running: true, total: 12, success: 10, failed: 1, canceled: 1,
    last_started_at: null, last_finished_at: null, last_duration_ms: 5, last_error: '上游超时',
  }] })))
  vi.stubGlobal('fetch', fetcher)
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const view = render(<QueryClientProvider client={qc}><JobsSection /></QueryClientProvider>)
  await act(async () => { await vi.advanceTimersByTimeAsync(100) })
  expect(screen.getByText('pull_telegram')).toBeInTheDocument()
  expect(screen.getByText('上游超时')).toBeInTheDocument()
  expect(fetcher).toHaveBeenCalledTimes(1)
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
  expect(fetcher).toHaveBeenCalledTimes(2)
  view.unmount(); qc.clear()
})
