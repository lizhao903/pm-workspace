import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { createMemoryRouter, RouterProvider, useLocation } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DocsTab } from './DocsTab'

const cats = [
  { id: 'cat_tech', type_id: 'doc', parent_id: null, name: '技术方案', slug: 'tech', path: '/tech/', depth: 0, color: '', description: '', sort_order: 20, created_at: '', updated_at: '', count: 0, total_count: 0 },
  { id: 'cat_prd', type_id: 'doc', parent_id: null, name: '需求文档', slug: 'prd', path: '/prd/', depth: 0, color: '', description: '', sort_order: 10, created_at: '', updated_at: '', count: 0, total_count: 0 },
]

function fakeBackend() {
  const calls: { method: string; path: string; body?: Record<string, unknown> }[] = []
  const json = (data: unknown, status = 200, meta?: unknown) => new Response(JSON.stringify(status < 300 ? { data, meta } : data), { status })
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input), 'http://x')
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ method, path: u.pathname, body })
    if (u.pathname === '/api/objects' && method === 'GET') return json([], 200, { total: 0 })
    if (u.pathname === '/api/objects' && method === 'POST') return json({ id: 'obj_new', type_id: 'doc', title: body.title, project_id: body.project_id }, 201)
    if (u.pathname === '/api/object-types') return json([{ id: 'doc', name: '文档', statuses: [] }])
    if (u.pathname === '/api/categories') return json(cats)
    return json({ error: { code: 'not_found', message: u.pathname } }, 404)
  }))
  return calls
}

function Where() {
  const loc = useLocation()
  return <div>{`到了 ${loc.pathname}${loc.search}`}</div>
}

function Harness() {
  const [adding, setAdding] = useState(true)
  return <DocsTab projectId="obj_p1" adding={adding} onAdding={setAdding} />
}

afterEach(() => vi.unstubAllGlobals())

describe('项目文档标签的新建一篇', () => {
  it('建一篇归到本项目，然后去「文档」打开编辑区', async () => {
    const calls = fakeBackend()
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const router = createMemoryRouter([{ path: '/projects/x', element: <Harness /> }, { path: '/docs', element: <Where /> }], { initialEntries: ['/projects/x'] })
    render(<QueryClientProvider client={qc}><RouterProvider router={router} /></QueryClientProvider>)

    await userEvent.click(await screen.findByRole('button', { name: '新建一篇' }))
    const submit = screen.getByRole('button', { name: '新建并去写' })
    expect(submit).toBeDisabled()
    // 分类默认取排在最前的
    await waitFor(() => expect(screen.getByRole('combobox', { name: '新文档的分类' })).toHaveValue('cat_prd'))
    await userEvent.type(screen.getByRole('textbox', { name: '新文档的标题' }), '  对接方案 ')
    await userEvent.selectOptions(screen.getByRole('combobox', { name: '新文档的分类' }), 'cat_tech')
    await userEvent.click(submit)

    expect(await screen.findByText('到了 /docs?doc=obj_new&edit=1')).toBeInTheDocument()
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
      type_id: 'doc', title: '对接方案', category_id: 'cat_tech', project_id: 'obj_p1', source: 'manual',
    })
  })

  it('切回「从「文档」里挑」还是原来的挑选表单', async () => {
    fakeBackend()
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const router = createMemoryRouter([{ path: '/', element: <Harness /> }])
    render(<QueryClientProvider client={qc}><RouterProvider router={router} /></QueryClientProvider>)
    const group = await screen.findByRole('group', { name: '加文档的方式' })
    await userEvent.click(within(group).getByRole('button', { name: '新建一篇' }))
    await userEvent.click(within(group).getByRole('button', { name: '从「文档」里挑' }))
    expect(screen.getByRole('button', { name: '加上' })).toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: '新文档的标题' })).toBeNull()
  })
})
