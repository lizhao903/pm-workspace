// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

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
  return <DocsTab projectId="obj_p1" docsDir="" root="" onSettings={() => {}} adding={adding} onAdding={setAdding} />
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

describe('项目文档标签的文档目录（TSK-0718）', () => {
  const file = (rel: string, kind: string) => ({ rel, path: `/p/docs/${rel}`, name: rel.split('/').pop()!, ext: rel.split('.').pop()!, kind, size: 3, modified: '2026-11-06T00:00:00Z' })
  function backend(filesResp: () => Response, docs: unknown[] = []) {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const u = new URL(String(input), 'http://x')
      const json = (data: unknown, status = 200, meta?: unknown) => new Response(JSON.stringify(status < 300 ? { data, meta } : data), { status })
      if (u.pathname === '/api/objects') return json(docs, 200, { total: docs.length })
      if (u.pathname === '/api/object-types') return json([{ id: 'doc', name: '文档', statuses: [] }])
      if (u.pathname === '/api/objects/obj_p1/docs-dir/files') return filesResp()
      if (u.pathname === '/api/fs/read') return json({ path: u.searchParams.get('path'), name: 'a.md', ext: 'md', size: 8, modified: '', binary: false, truncated: false, limit: 1048576, content: '# 方案正文' })
      return json({ error: { code: 'not_found', message: u.pathname } }, 404)
    }))
  }
  const mount = (docsDir: string, onSettings = () => {}) => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const router = createMemoryRouter([{ path: '/', element: <DocsTab projectId="obj_p1" docsDir={docsDir} root="/p" onSettings={onSettings} adding={false} onAdding={() => {}} /> }])
    render(<QueryClientProvider client={qc}><RouterProvider router={router} /></QueryClientProvider>)
  }

  it('没设文档目录时提示去设置', async () => {
    backend(() => new Response('{}', { status: 500 }))
    const onSettings = vi.fn()
    mount('', onSettings)
    await userEvent.click(await screen.findByRole('button', { name: '去设置' }))
    expect(onSettings).toHaveBeenCalled()
    expect(screen.getByText(/还没设文档目录/)).toBeInTheDocument()
  })

  it('按目录树列出文件：第一层默认展开、更深收起，点名称在抽屉里预览', async () => {
    backend(() => new Response(JSON.stringify({ data: { path: '/p/docs', files: [file('a.md', 'text'), file('prd/b.pdf', 'pdf'), file('prd/2026/c.docx', 'office')], skipped: 0, truncated: false, next_cursor: '' } })))
    mount('docs')
    const tree = await screen.findByRole('tree', { name: '文档目录文件' })
    // 第一层文件夹展开：顶层文件和 prd 下的文件都看得见；二级文件夹 2026 收起
    expect(within(tree).getByText('a.md')).toBeInTheDocument()
    expect(within(tree).getByText('b.pdf')).toBeInTheDocument()
    expect(within(tree).queryByText('c.docx')).toBeNull()
    expect(within(tree).getByRole('button', { name: /prd/ })).toHaveAttribute('aria-expanded', 'true')
    // 展开二级文件夹后露出里面的文件
    await userEvent.click(within(tree).getByRole('button', { name: /2026/ }))
    expect(within(tree).getByText('c.docx')).toBeInTheDocument()
    // 再点收起，正文消失
    await userEvent.click(within(tree).getByRole('button', { name: /2026/ }))
    expect(within(tree).queryByText('c.docx')).toBeNull()
    await userEvent.click(within(tree).getByRole('button', { name: 'a.md' }))
    expect(await screen.findByRole('heading', { name: '方案正文' })).toBeInTheDocument()
  })

  it('工作台文档一张表、文档目录一棵树，各列各的', async () => {
    const doc = { id: 'obj_d1', type_id: 'doc', title: '权限 PRD', status: 'draft', category_id: 'cat_prd', category_name: '需求文档', project_id: 'obj_p1', updated_at: '2026-11-10T00:00:00Z' }
    backend(() => new Response(JSON.stringify({ data: { path: '/p/docs', files: [file('prd/b.pdf', 'pdf')], skipped: 0, truncated: false, next_cursor: '' } })), [doc])
    mount('docs')
    const table = await screen.findByRole('table', { name: '工作台文档' })
    expect(within(table).getByText('权限 PRD')).toBeInTheDocument()
    const tree = await screen.findByRole('tree', { name: '文档目录文件' })
    expect(within(tree).getByText('b.pdf')).toBeInTheDocument()
    expect(within(tree).queryByText('权限 PRD')).toBeNull()
    expect(within(table).queryByText('b.pdf')).toBeNull()
  })

  it('目录不存在、越界时说清原因', async () => {
    backend(() => new Response(JSON.stringify({ error: { code: 'not_found', message: '目录不存在：/p/nope' } }), { status: 404 }))
    mount('nope')
    expect(await screen.findByText(/文档目录「nope」不存在/)).toBeInTheDocument()
  })
  it('越界 403 时带上后端的说明', async () => {
    backend(() => new Response(JSON.stringify({ error: { code: 'forbidden', message: '/etc 不在可浏览范围内' } }), { status: 403 }))
    mount('/etc')
    expect(await screen.findByText(/文档目录「\/etc」不能读：\/etc 不在可浏览范围内/)).toBeInTheDocument()
  })
})
