import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SopFlow } from '../../core/data'
import Page from './Page'

const FLOW: SopFlow = {
  id: 'sop_week', name: '周会纪要', desc: '', trigger: '手动', version: 1, created_at: '', updated_at: '',
  fields: [], steps: [{ key: 'end', name: '结束', kind: 'end' }],
}

afterEach(() => vi.unstubAllGlobals())

describe('流程详情带 ?start=1（项目的 SOP 标签「执行」）', () => {
  it('直接打开发起执行抽屉，关掉后去掉参数', async () => {
    const json = (data: unknown) => new Response(JSON.stringify({ data, meta: { total: 0 } }))
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const u = new URL(String(input), 'http://x')
      if (u.pathname === '/api/sop/flows') return json([FLOW])
      if (u.pathname === '/api/sop/flows/sop_week') return json(FLOW)
      if (u.pathname === '/api/sop/node-types' || u.pathname === '/api/sop/runs') return json([])
      return json([])
    }))
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const router = createMemoryRouter([{ path: '/sop/*', element: <Page /> }], { initialEntries: ['/sop/flows/sop_week?start=1'] })
    render(<QueryClientProvider client={qc}><RouterProvider router={router} /></QueryClientProvider>)
    const dlg = await screen.findByRole('dialog', { name: '执行 周会纪要' })
    expect(dlg).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '取消' }))
    await waitFor(() => expect(router.state.location.search).toBe(''))
    expect(router.state.location.pathname).toBe('/sop/flows/sop_week')
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '执行 周会纪要' })).toBeNull())
  })
})
