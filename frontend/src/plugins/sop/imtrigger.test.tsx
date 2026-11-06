// SOP 的 IM 触发（TSK-0481）：过滤条件的写法、编排页开始节点里配会话（能按编号搜到）、与我的关系、顺序和拦截，保存带上 im；流程库卡片显示顺序和拦截
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Conversation, SopFlow, SopNodeType } from '../../core/data'
import Page from './Page'
import { filterText, imDraftOf, imFlowsOf, toggleRel } from './imtrigger'

const CONVS: Conversation[] = [
  { id: 'cv_octok', channel: 'slack', external_id: 'C0BNCBRL5C0', kind: 'group', name: 'ai-octok-platform', members: [], created_at: '', updated_at: '' },
  { id: 'cv_rand', channel: 'slack', external_id: 'C0RANDOM', kind: 'group', name: 'random', members: [], created_at: '', updated_at: '' },
]
const IM0 = { conversations: [], relevance: [], relevance_mode: 'include' as const, order: 0, stop: false }
const base = { desc: '', version: 1, created_at: '', updated_at: '', fields: [], schedule: null }
const FLOWS: SopFlow[] = [
  { ...base, id: 'sop_triage', name: '消息分流', trigger: 'im', im: { ...IM0, order: 1 }, steps: [{ key: 'a', name: '分流', kind: 'auto', after: [] }], layout: { __start: { x: 60, y: 80 }, a: { x: 400, y: 80 } } },
  { ...base, id: 'sop_intake', name: '需求受理', trigger: 'im', im: { ...IM0, order: 2, relevance: ['me'] }, steps: [{ key: 'a', name: '受理', kind: 'auto', after: [] }] },
  { ...base, id: 'sop_manual', name: '手动的', trigger: 'manual', im: IM0, steps: [{ key: 'a', name: '甲', kind: 'auto', after: [] }] },
]

describe('IM 触发的写法', () => {
  it('过滤条件写成一句；没有过滤是全部消息；会话删了写明', () => {
    expect(filterText({ conversations: ['cv_octok'], relevance: ['me'], relevance_mode: 'exclude' }, CONVS)).toBe('#ai-octok-platform · 除了 @我')
    expect(filterText({ conversations: [], relevance: ['me', 'dm'], relevance_mode: 'include' }, CONVS)).toBe('只要 @我、私聊')
    expect(filterText({ conversations: ['cv_gone'], relevance: [], relevance_mode: 'include' }, CONVS)).toBe('已删除的会话')
    expect(filterText(IM0, CONVS)).toBe('全部消息')
  })
  it('勾选按固定顺序；草稿不带顺序；IM 流程按顺序排', () => {
    expect(toggleRel(['dm'], 'me', true)).toEqual(['me', 'dm'])
    expect(toggleRel(['me', 'dm'], 'me', false)).toEqual(['dm'])
    expect(imDraftOf(FLOWS[1])).toEqual({ conversations: [], relevance: ['me'], relevance_mode: 'include', stop: false, order: null })
    expect(imFlowsOf([FLOWS[1], FLOWS[2], FLOWS[0]]).map((f) => f.id)).toEqual(['sop_triage', 'sop_intake'])
  })
})

const TYPES: SopNodeType[] = [{ kind: 'auto', group: '基础', branching: false, required: [] }]
type Call = { method: string; path: string; body?: Record<string, unknown> }

function fakeBackend() {
  const calls: Call[] = []
  const flows = structuredClone(FLOWS)
  const json = (data: unknown, status = 200) => new Response(JSON.stringify({ data, meta: Array.isArray(data) ? { total: data.length } : undefined }), { status })
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input), 'http://x')
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ method, path: u.pathname, body })
    if (u.pathname === '/api/sop/node-types') return json(TYPES)
    if (u.pathname === '/api/conversations') return json(CONVS)
    if (u.pathname === '/api/sop/flows' && method === 'POST') return json({ ...body, id: 'sop_new', version: 1, created_at: '', updated_at: '', schedule: null, im: { ...body.im, order: body.im.order ?? 3 } }, 201)
    if (u.pathname === '/api/sop/flows') return json(flows)
    const one = u.pathname.match(/^\/api\/sop\/flows\/([^/]+)$/)
    if (one) {
      const f = flows.find((x) => x.id === one[1])!
      if (method === 'PATCH') Object.assign(f, { ...body, version: f.version + 1, im: { ...f.im, ...body.im } })
      return json(f)
    }
    return json([])
  }))
  return calls
}

function renderPage(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createMemoryRouter([{ path: '/sop/*', element: <Page /> }], { initialEntries: [path] })
  render(<QueryClientProvider client={qc}><RouterProvider router={router} /></QueryClientProvider>)
  return router
}

const openStart = async () => fireEvent.keyDown(await screen.findByRole('button', { name: '开始节点' }), { key: 'Enter' })

afterEach(() => vi.unstubAllGlobals())

describe('编排页的 IM 触发', () => {
  it('新建：按 Slack 编号搜到会话、除了 @我、排第 1 个并拦截；保存带上 im', async () => {
    const user = userEvent.setup()
    const calls = fakeBackend()
    renderPage('/sop/new')
    await openStart()
    const panel = screen.getByRole('complementary', { name: '开始节点' })
    await user.selectOptions(within(panel).getByRole('combobox', { name: '触发方式' }), 'im')
    // 会话：搜渠道里的编号
    await user.click(within(panel).getByRole('button', { name: '会话' }))
    await user.type(screen.getByPlaceholderText('搜群名或会话编号（如 C0…）'), 'C0BNCBRL5C0')
    const opts = within(screen.getByRole('listbox')).getAllByRole('option')
    expect(opts).toHaveLength(1)
    await user.click(opts[0])
    await user.keyboard('{Escape}')
    await user.selectOptions(within(panel).getByRole('combobox', { name: '只要还是除了' }), 'exclude')
    await user.click(within(panel).getByRole('checkbox', { name: '@我' }))
    // 顺序：现在两条 IM 流程，新的默认排第 3
    const order = within(panel).getByRole('combobox', { name: '执行顺序' })
    expect(order).toHaveValue('3')
    expect(within(order).getAllByRole('option').map((o) => o.textContent)).toEqual(['第 1 个（在「消息分流」之前）', '第 2 个（在「消息分流」之后）', '第 3 个（在「需求受理」之后）'])
    await user.selectOptions(order, '1')
    await user.click(within(panel).getByRole('switch', { name: '命中后不再触发后面的 IM 流程' }))
    expect(screen.getByRole('button', { name: '开始节点' })).toHaveTextContent('#ai-octok-platform · 除了 @我 · 拦截后续')

    await user.click(screen.getByRole('button', { name: '添加节点' }))
    await user.click(within(screen.getByRole('dialog', { name: '选择节点' })).getByRole('button', { name: /自动执行/ }))
    await user.type(screen.getByRole('textbox', { name: 'SOP 名称' }), '群消息忽略')
    await user.click(screen.getByRole('button', { name: '发布' }))
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path === '/api/sop/flows')).toBe(true))
    expect(calls.find((c) => c.method === 'POST' && c.path === '/api/sop/flows')!.body).toMatchObject({
      trigger: 'im', im: { conversations: ['cv_octok'], relevance: ['me'], relevance_mode: 'exclude', order: 1, stop: true },
    })
  })

  it('编辑：没动顺序就不提交 order；排在前面的拦截流程有提示', async () => {
    const user = userEvent.setup()
    const calls = fakeBackend()
    renderPage('/sop/flows/sop_triage/edit')
    await openStart()
    const panel = screen.getByRole('complementary', { name: '开始节点' })
    expect(within(panel).getByRole('combobox', { name: '执行顺序' })).toHaveValue('1')
    await user.click(within(panel).getByRole('checkbox', { name: '私聊' }))
    await user.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true))
    const body = calls.find((c) => c.method === 'PATCH')!.body!
    expect(body.im).toEqual({ conversations: [], relevance: ['dm'], relevance_mode: 'include', stop: false })
  })

  it('流程库卡片：IM 流程显示第几个、过滤条件、拦截', async () => {
    fakeBackend()
    renderPage('/sop/library')
    const card = (await screen.findByText('需求受理')).closest('.sop-lib-cell') as HTMLElement
    expect(card).toHaveTextContent('第 2 个')
    expect(card).toHaveTextContent('只要 @我')
    expect((screen.getByText('手动的').closest('.sop-lib-cell') as HTMLElement).textContent).not.toContain('第 ')
  })
})
