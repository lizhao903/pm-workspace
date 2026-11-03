import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KbSection } from './KbSection'

const settings = { auto_sync: false, dirs: [{ path: '/v/docs', auto_sync: true, synced_at: '2026-10-29T00:00:00Z', files: 1 }], chunk_size: 300, overlap: 50, top: 5, embed: { provider_id: '', model: '' } }
const counts = { docs: 2, indexed: 1, pending: 0, failed: 1, excluded: 0, searchable: 1, chunks: 1, last_doc_at: '2026-10-29T00:00:00Z' }
const kb = {
  id: 'kb_a', name: '产品文档库', desc: 'PRD 和纪要', sources: ['cat_prd'], settings, counts, agents: [{ id: 'ag_1', name: '写作助手' }],
  created_at: '', updated_at: '2026-10-29T00:00:00Z',
}
const other = { ...kb, id: 'kb_b', name: '客户反馈', desc: '', sources: [], agents: [], counts: { ...counts, docs: 0, indexed: 0, failed: 0, searchable: 0, chunks: 0 } }
const longText = '权限变更五分钟内生效。'.repeat(40)
const docs = [
  { id: 'kd_1', kb_id: 'kb_a', title: '权限说明.md', source: { type: 'dir', ref: '/v/docs/权限说明.md' }, text: longText, chunks: 1, status: 'indexed', excluded: false, created_at: '', updated_at: '' },
  { id: 'kd_2', kb_id: 'kb_a', title: '扫描件.pdf', source: { type: 'upload', ref: '扫描件.pdf' }, text: '', chunks: 0, status: 'failed', excluded: false, error: 'PDF 里没有可提取的文字', created_at: '', updated_at: '' },
]

type Call = { method: string; url: string; body: unknown }
let calls: Call[]
let created: unknown[]

beforeEach(() => {
  calls = []
  created = []
  vi.stubGlobal('fetch', vi.fn((url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url)
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ method, url: u, body })
    const ok = (data: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify({ data }), { status }))
    if (u.includes('/api/categories')) return ok([{ id: 'cat_prd', name: '需求文档', children: [] }])
    if (method === 'POST' && u.endsWith('/api/knowledge-bases')) {
      created = [{ ...other, id: 'kb_new', name: body.name }]
      return ok(created[0], 201)
    }
    if (method === 'POST' && u.endsWith('/search')) {
      return ok({ terms: ['权限', '变更'], scope: { searchable: 1, skipped: 1 }, hits: [
        { kb_id: 'kb_a', doc_id: 'kd_1', title: '权限说明.md', source: docs[0].source, index: 0, start: 0, end: 30, text: '## 权限变更五分钟内生效', score: 0.75, terms: ['权限', '变更'] },
      ] })
    }
    if (method === 'POST' && u.endsWith('/reindex')) return ok(docs)
    // 同步一直没回来（大目录），进度可查
    if (method === 'GET' && u.endsWith('/kb_a/sync')) return ok({ kb_id: 'kb_a', dir: '/v/docs', listed: 800, done: 120, listing: true, started_at: '2026-11-03T00:00:00Z' })
    if (method === 'PATCH') return ok({ ...kb, settings: { ...settings, ...body.settings } })
    if (u.endsWith('/api/knowledge-bases/kb_a/docs')) return ok(docs)
    if (u.includes('/docs')) return ok([])
    if (u.endsWith('/api/knowledge-bases')) return ok([...created, kb, other])
    if (u.includes('/api/agents')) return ok([{ id: 'ag_1', name: '写作助手', desc: '写周报', color: '', avatar: { kind: 'text', value: '' }, enabled: false }])
    if (u.includes('/api/agent-providers')) return ok([])
    if (u.includes('/api/objects')) return ok([])
    return new Promise<Response>(() => {})
  }))
})
afterEach(() => { vi.unstubAllGlobals() })

function renderAt(path: string) {
  const router = createMemoryRouter([{ path: '*', element: <KbSection /> }], { initialEntries: [path] })
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return router
}

describe('知识库列表', () => {
  it('卡片显示状态、篇数、来源分类和在用的 Agent；没有 Agent 写「没有 Agent 在用」', async () => {
    renderAt('/settings/kbs')
    const card = await screen.findByRole('button', { name: /产品文档库/ })
    expect(within(card).getByText('1 篇失败')).toBeInTheDocument()
    expect(await within(card).findByText('需求文档')).toBeInTheDocument()
    expect(within(card).getByRole('img', { name: '写作助手' })).toBeInTheDocument()
    expect(within(screen.getByRole('button', { name: /客户反馈/ })).getByText('没有 Agent 在用')).toBeInTheDocument()
  })

  it('搜不到时提示换关键词；点卡片进详情，地址带上 kb', async () => {
    const user = userEvent.setup()
    const router = renderAt('/settings/kbs')
    await user.type(await screen.findByPlaceholderText('搜知识库名称、说明、里面的文档标题'), '不存在的')
    expect(await screen.findByText('没有匹配的知识库')).toBeInTheDocument()
    await user.clear(screen.getByPlaceholderText('搜知识库名称、说明、里面的文档标题'))
    await user.click(screen.getByRole('button', { name: /产品文档库/ }))
    expect(router.state.location.search).toBe('?kb=kb_a')
    expect(await screen.findByRole('tab', { name: /文档/ })).toHaveAttribute('aria-selected', 'true')
  })

  it('新建：名称为空红框不提交；建好后抽屉切成编辑这一个', async () => {
    const user = userEvent.setup()
    renderAt('/settings/kbs')
    await user.click(await screen.findByRole('button', { name: '新建知识库' }))
    await user.click(screen.getByRole('button', { name: '创建' }))
    expect(screen.getByPlaceholderText('比如：竞品资料')).toHaveAttribute('aria-invalid', 'true')
    expect(calls.some((c) => c.method === 'POST')).toBe(false)
    await user.type(screen.getByPlaceholderText('比如：竞品资料'), '竞品资料')
    await user.click(await screen.findByRole('checkbox', { name: '需求文档' }))
    await user.click(screen.getByRole('button', { name: '创建' }))
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ name: '竞品资料', desc: '', sources: ['cat_prd'] })
    expect(await screen.findByRole('button', { name: '保存' })).toBeInTheDocument()
  })
})

describe('知识库详情', () => {
  it('文档表：失败的写原因，段数写 -；状态筛选带数量', async () => {
    renderAt('/settings/kbs?kb=kb_a')
    expect(await screen.findByText('PDF 里没有可提取的文字')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /失败1/ })).toBeInTheDocument()
    const row = screen.getByText('扫描件.pdf').closest('[role="row"]') as HTMLElement
    expect(within(row).getByText('-')).toBeInTheDocument()
    expect(screen.getByText('参与检索 1 篇 · 1 段')).toBeInTheDocument()
  })

  it('加文档：链接说明不联网抓取，网址不对拦下', async () => {
    const user = userEvent.setup()
    renderAt('/settings/kbs?kb=kb_a')
    await user.click(await screen.findByRole('button', { name: '加文档' }))
    await user.click(screen.getByRole('button', { name: '网页链接' }))
    expect(screen.getByText(/不会联网抓取/)).toBeInTheDocument()
    await user.type(screen.getByRole('textbox', { name: '网址' }), 'example')
    await user.click(screen.getByRole('button', { name: '加进知识库' }))
    expect(screen.getByText('填一个 http 或 https 开头的网址')).toBeInTheDocument()
    expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/docs'))).toBe(false)
  })

  it('检索测试：高亮命中词，点标题回文档标签并定位到那一段', async () => {
    const user = userEvent.setup()
    const router = renderAt('/settings/kbs?kb=kb_a&tab=search')
    expect(await screen.findByText(/在 1 篇已索引的文档里找，待索引、失败、已排除的 1 篇不参与/)).toBeInTheDocument()
    await user.type(screen.getByRole('textbox', { name: '问题' }), '权限变更多久生效{Enter}')
    const link = await screen.findByRole('button', { name: '权限说明.md · 第 1 段' })
    expect(document.querySelectorAll('.kbx-mark')).toHaveLength(2)
    expect(calls.find((c) => c.url.endsWith('/search'))?.body).toEqual({ q: '权限变更多久生效' })
    await user.click(link)
    expect(router.state.location.search).toBe('?kb=kb_a')
    expect(await screen.findByRole('button', { name: '返回文档列表' })).toBeInTheDocument()
    expect(document.querySelector('.kbx-chunk.focus')).toHaveAttribute('data-chunk', '0')
  })

  it('设置：改段长连带压重叠；段数变了给「重新索引这 N 篇」；Agent 停用标出来', async () => {
    const user = userEvent.setup()
    renderAt('/settings/kbs?kb=kb_a&tab=settings')
    expect(await screen.findByText('已停用')).toBeInTheDocument()
    expect(screen.getByText('写周报')).toBeInTheDocument()
    expect(screen.getByText(/1 个文件/)).toBeInTheDocument()
    // 400 字的正文按 300 字切是 2 段，上次索引是 1 段
    expect(await screen.findByRole('button', { name: '重新索引这 1 篇' })).toBeInTheDocument()
    await user.selectOptions(screen.getByRole('combobox', { name: '每段多少字' }), '200')
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ settings: { chunk_size: 200, overlap: 50 } })
    await user.click(screen.getByRole('button', { name: '重新索引这 1 篇' }))
    expect(calls.find((c) => c.url.endsWith('/reindex'))?.body).toEqual({ doc_ids: ['kd_1'] })
  })

  it('同步大目录：请求没回来时按秒查进度，显示在那个目录下', async () => {
    const user = userEvent.setup()
    renderAt('/settings/kbs?kb=kb_a&tab=settings')
    await user.click(await screen.findByRole('button', { name: '立即同步' }))
    expect(calls.find((c) => c.method === 'POST' && c.url.endsWith('/sync'))?.body).toEqual({ path: '/v/docs' })
    expect(await screen.findByText('正在同步：已处理 120 / 800+ 个文件')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '同步中…' })).toBeDisabled()
  })

  it('挂目录：相对路径、挂过的就地报错，不发请求', async () => {
    const user = userEvent.setup()
    renderAt('/settings/kbs?kb=kb_a&tab=settings')
    const input = await screen.findByRole('textbox', { name: '本地目录' })
    await user.type(input, 'docs{Enter}')
    expect(screen.getByText('填绝对路径，以 / 开头')).toBeInTheDocument()
    await user.clear(input)
    await user.type(input, '/v/docs/{Enter}')
    expect(screen.getByText('这个目录已经挂上了')).toBeInTheDocument()
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false)
  })
})
