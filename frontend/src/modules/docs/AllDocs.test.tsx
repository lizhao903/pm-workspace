// 全部文档：文件清单分页拉全量、按种类预览（PDF 内嵌、图片、Office 给打开）、大目录的内容树只渲染可见的一段。
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Page from './Page'

const dir = { id: 'ld_1', path: '/tmp/notes', name: 'notes', position: 0, created_at: '', updated_at: '' }
const file = (rel: string, kind: string) => ({
  rel, path: `${dir.path}/${rel}`, name: rel.split('/').pop() ?? rel, ext: rel.split('.').pop() ?? '', kind, size: 2048, modified: '2026-10-01T00:00:00Z',
})

/** 三页：第一页 1200 个笔记，第二页 1200 个笔记加一份 PDF，第三页图片、Office 和最深处的一篇 */
const pages = [
  { files: Array.from({ length: 1200 }, (_, i) => file(`笔记/n${String(i).padStart(4, '0')}.md`, 'text')), skipped: 3, next_cursor: 'c1' },
  { files: [...Array.from({ length: 1200 }, (_, i) => file(`笔记/n${String(i + 1200).padStart(4, '0')}.md`, 'text')), file('报告/季报.pdf', 'pdf')], skipped: 2, next_cursor: 'c2' },
  { files: [file('图/封面.png', 'image'), file('方案.docx', 'office'), file('深/处/最后一篇.md', 'text')], skipped: 1, next_cursor: '' },
]

function fakeBackend() {
  const calls: { method: string; path: string; query: string; body?: Record<string, unknown> }[] = []
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(status < 300 ? { data } : data), { status })
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input), 'http://x')
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ method, path: u.pathname, query: u.search, body })
    if (u.pathname === '/api/local-dirs') return json([dir])
    if (u.pathname === '/api/local-dirs/ld_1/files') {
      const i = ['', 'c1', 'c2'].indexOf(u.searchParams.get('cursor') ?? '')
      return json({ path: dir.path, truncated: false, reason: '', visited: 9999, ...pages[i] })
    }
    if (u.pathname === '/api/fs/read') {
      return json({ path: u.searchParams.get('path'), name: 'x.md', ext: 'md', size: 3, modified: '2026-10-01T00:00:00Z', binary: false, truncated: false, limit: 1048576, content: '# 正文' })
    }
    if (u.pathname === '/api/fs/open') return json({ path: body?.path, reveal: !!body?.reveal })
    if (u.pathname === '/api/categories' || u.pathname === '/api/tags' || u.pathname === '/api/object-types' || u.pathname === '/api/objects') return json([])
    return json({ error: { code: 'not_found', message: u.pathname } }, 404)
  }))
  return calls
}

function mount(initial: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createMemoryRouter([{ path: '/docs', element: <Page /> }], { initialEntries: [initial] })
  render(<QueryClientProvider client={qc}><RouterProvider router={router} /></QueryClientProvider>)
  return router
}

afterEach(() => vi.unstubAllGlobals())

describe('全部文档', () => {
  it('一页页拉到底，合起来是全量；跳过数累加；搜索能搜到最后一页里的文件', async () => {
    const calls = fakeBackend()
    mount('/docs?dir=ld_1')
    // 顶栏「全部」是全量篇数
    expect(await screen.findByRole('button', { name: '全部2404' })).toBeInTheDocument()
    const lists = calls.filter((c) => c.path === '/api/local-dirs/ld_1/files').map((c) => new URLSearchParams(c.query).get('cursor') ?? '')
    expect(lists).toEqual(['', 'c1', 'c2'])
    expect(screen.getByRole('button', { name: /工作目录 · 跳过 6 个/ })).toBeInTheDocument()
    // 种类筛选
    for (const name of ['文本2401', 'PDF1', '图片1', 'Office 文档1']) expect(screen.getByRole('button', { name })).toBeInTheDocument()
    await userEvent.type(screen.getByRole('textbox', { name: '搜索' }), '最后一篇')
    const tree = screen.getByRole('navigation', { name: '内容树' })
    expect(await within(tree).findByRole('button', { name: /最后一篇\.md/ })).toBeInTheDocument()
  })

  it('宽屏下地址里指定的文件在后面的页里：等拉完再定，不被落到第一条顶掉', async () => {
    fakeBackend()
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: true, media: q, addEventListener() {}, removeEventListener() {} }))
    const router = mount('/docs?dir=ld_1&doc=' + encodeURIComponent('ld_1:方案.docx'))
    expect(await screen.findByText('这类文件不能在这里预览，用本机应用打开查看。')).toBeInTheDocument()
    expect(new URLSearchParams(router.state.location.search).get('doc')).toBe('ld_1:方案.docx')
  })

  it('大目录展开后只渲染可见的一段行', async () => {
    fakeBackend()
    mount('/docs?dir=ld_1')
    await screen.findByRole('button', { name: '全部2404' })
    const tree = screen.getByRole('navigation', { name: '内容树' })
    await userEvent.click(within(tree).getByRole('button', { name: /笔记/ }))
    const rows = tree.querySelectorAll('.tree-file')
    expect(rows.length).toBeGreaterThan(10)
    expect(rows.length).toBeLessThan(200)
  })

  it('PDF 内嵌预览、图片直接显示，都不走读正文；Office 给文件信息和用本机应用打开', async () => {
    const calls = fakeBackend()
    mount('/docs?dir=ld_1&doc=' + encodeURIComponent('ld_1:报告/季报.pdf'))
    const frame = await screen.findByTitle('预览 季报.pdf')
    expect(frame.tagName).toBe('IFRAME')
    expect(frame.getAttribute('src')).toBe('/api/fs/raw?' + new URLSearchParams({ path: '/tmp/notes/报告/季报.pdf' }))
    expect(screen.queryByRole('button', { name: '复制全文' })).toBeNull()

    await userEvent.click(screen.getByRole('button', { name: '在访达中显示' }))
    await waitFor(() => expect(calls.some((c) => c.path === '/api/fs/open' && c.body?.reveal === true)).toBe(true))

    const tree = screen.getByRole('navigation', { name: '内容树' })
    await userEvent.click(within(tree).getByRole('button', { name: /^图/ }))
    await userEvent.click(within(tree).getByRole('button', { name: /封面\.png/ }))
    expect((await screen.findByRole('img', { name: '封面.png' })).getAttribute('src')).toContain('/api/fs/raw?')

    await userEvent.click(within(tree).getByRole('button', { name: /方案\.docx/ }))
    expect(await screen.findByText('这类文件不能在这里预览，用本机应用打开查看。')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '用本机应用打开' }))
    await waitFor(() => expect(calls.some((c) => c.path === '/api/fs/open' && c.body?.path === '/tmp/notes/方案.docx' && !c.body?.reveal)).toBe(true))
    expect(calls.some((c) => c.path === '/api/fs/read')).toBe(false)
  })
})
