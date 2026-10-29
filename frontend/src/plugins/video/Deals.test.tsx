import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { VideoDeal } from '../../core/data'
import DealsTab from './DealsTab'

const T = '2026-10-29T08:00:00Z'
const deal = (x: Partial<VideoDeal> = {}): VideoDeal => ({
  id: 'deal_1', project_id: 'obj_pj', brand: '远川科技', title: '试点上线短片', platforms: ['bilibili'], deliverables: '1 支横版', quote: 12000,
  currency: 'CNY', status: 'delivered', video_ids: ['vd_1'], history: [{ status: 'inquiry', at: T }], created_at: T, updated_at: T, ...x,
})

type Call = { method: string; path: string; body?: Record<string, unknown> }

// 内存里的商单后端：规则照 internal/plugins/video/deals.go
function fakeBackend(seed: VideoDeal[]) {
  const calls: Call[] = []
  const deals = seed.map((d) => ({ ...d }))
  let seq = 0
  const json = (data: unknown, status = 200, meta?: unknown) => new Response(JSON.stringify(status < 300 ? { data, meta } : data), { status })
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input), 'http://x')
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ method, path: u.pathname, body })
    const p = u.pathname
    if (p === '/api/objects') return json([{ id: 'obj_pj', type_id: 'project', title: '远川权限改造', props: {} }], 200, { total: 1 })
    if (p === '/api/stakeholders') return json([{ id: 'stk_a', name: '梁晚晴', company: '远川科技', group: '客户' }])
    if (p === '/api/projects/obj_pj/stakeholders') return json([{ project_id: 'obj_pj', stakeholder_id: 'stk_a', role: 'contact' }])
    if (p === '/api/plugins') return json([{ id: 'im', running: true }, { id: 'video', running: true }])
    if (p === '/api/im/messages') {
      return json([{ id: 'msg_1', sender_name: 'wanqing', contact_name: '梁晚晴', stakeholder_id: 'stk_a', conversation: '远川项目群', text: '采购流程这边需要一份正式的报价', at: T, attachments: [], replies: [] }], 200, { total: 1 })
    }
    if (p === '/api/im/messages/msg_1') {
      return json({ id: 'msg_1', sender_name: 'wanqing', contact_name: '梁晚晴', stakeholder_id: 'stk_a', conversation: '远川项目群', text: '采购流程这边需要一份正式的报价', at: T, attachments: [], replies: [] })
    }
    if (p === '/api/video/videos') return json([{ id: 'vd_1', title: '试点上线短片', orientations: ['landscape'], stage: 'distribution', checkpoints: [] }], 200, { total: 1 })
    if (p === '/api/video/deals/quote-ref') return json({ platforms: [], avg: 30000, n: 2, cpm: 150, value: 4500 })
    if (p === '/api/video/deals' && method === 'GET') return json(deals, 200, { total: deals.length })
    if (p === '/api/video/deals' && method === 'POST') {
      const d = deal({ id: `deal_new${++seq}`, status: 'inquiry', video_ids: [], platforms: [], quote: 0, deliverables: '', ...body })
      deals.push(d)
      return json(d, 201)
    }
    const m = p.match(/^\/api\/video\/deals\/([^/]+)(\/report)?$/)
    if (m) {
      const d = deals.find((x) => x.id === m[1])!
      if (m[2]) {
        d.report_content_id = 'obj_doc1'
        return json({ deal: d, doc: { id: 'obj_doc1', ref: 'DOC-0001', title: `${d.brand} · ${d.title} 结案报告` } }, 201)
      }
      if (method === 'PATCH') { Object.assign(d, body); return json(d) }
      return json(d)
    }
    return json([], 200, { total: 0 })
  }))
  return { calls, deals }
}

function setup(url = '/projects/obj_pj/deals', projectId = 'obj_pj') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createMemoryRouter([{ path: '*', element: <DealsTab projectId={projectId} /> }], { initialEntries: [url] })
  render(<QueryClientProvider client={qc}><RouterProvider router={router} /></QueryClientProvider>)
  return router
}

afterEach(() => vi.unstubAllGlobals())

describe('商单标签', () => {
  it('从一条 IM 询价建商单：询价人、品牌按消息带出，商单记下来源', async () => {
    const be = fakeBackend([])
    const router = setup()
    expect(await screen.findByText('这个项目还没有商单')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '新建商单' }))
    const drawer = await screen.findByRole('dialog', { name: '新建商单' })
    await userEvent.click(await within(drawer).findByRole('button', { name: /来源消息|选一条 IM 消息/ }))
    await userEvent.click(await screen.findByRole('option', { name: /采购流程这边需要一份正式的报价/ }))
    expect(await within(drawer).findByText('采购流程这边需要一份正式的报价')).toBeInTheDocument()
    expect(within(drawer).getByDisplayValue('远川科技')).toBeInTheDocument()
    await userEvent.type(within(drawer).getByPlaceholderText('比如：新品上线短片'), '正式报价短片')
    await userEvent.click(within(drawer).getByRole('button', { name: '创建' }))
    await waitFor(() => expect(be.calls.some((c) => c.method === 'POST' && c.path === '/api/video/deals')).toBe(true))
    const post = be.calls.find((c) => c.method === 'POST' && c.path === '/api/video/deals')!
    expect(post.body).toMatchObject({ project_id: 'obj_pj', brand: '远川科技', title: '正式报价短片', contact_id: 'stk_a', source_message_id: 'msg_1' })
    await waitFor(() => expect(router.state.location.search).toBe('?deal=deal_new1'))
    expect(await screen.findByRole('dialog', { name: '正式报价短片' })).toBeInTheDocument()
  })

  it('从 IM 消息转过来（?new=1&message=）：询价人、品牌按消息预填；挂到别的项目时跳过去', async () => {
    const be = fakeBackend([])
    const router = setup('/projects/obj_pj/deals?new=1&message=msg_1')
    const drawer = await screen.findByRole('dialog', { name: '新建商单' })
    expect(await within(drawer).findByText('采购流程这边需要一份正式的报价')).toBeInTheDocument()
    expect(within(drawer).getByDisplayValue('远川科技')).toBeInTheDocument()
    expect(within(drawer).getByRole('button', { name: '询价人' })).toHaveTextContent('梁晚晴')
    await userEvent.type(within(drawer).getByPlaceholderText('比如：新品上线短片'), '正式报价短片')
    await userEvent.click(within(drawer).getByRole('button', { name: '创建' }))
    await waitFor(() => expect(router.state.location.search).toBe('?deal=deal_new1'))
    expect(be.calls.find((c) => c.method === 'POST')?.body).toMatchObject({ contact_id: 'stk_a', brand: '远川科技', source_message_id: 'msg_1' })
  })

  it('新建的单挂到别的项目时跳到那个项目的商单标签', async () => {
    fakeBackend([])
    const router = setup('/projects/obj_other/deals?new=1', 'obj_other')
    const drawer = await screen.findByRole('dialog', { name: '新建商单' })
    await userEvent.type(within(drawer).getByPlaceholderText('比如：远川科技'), '远川科技')
    await userEvent.type(within(drawer).getByPlaceholderText('比如：新品上线短片'), '短片')
    await userEvent.click(within(drawer).getByRole('button', { name: '项目' }))
    await userEvent.click(await screen.findByRole('option', { name: /远川权限改造/ }))
    await userEvent.click(within(drawer).getByRole('button', { name: '创建' }))
    await waitFor(() => expect(router.state.location.pathname + router.state.location.search).toBe('/projects/obj_pj/deals?deal=deal_new1'))
  })

  it('账期快到的单有提示；发布满 7 天能出结案报告，出过以后能打开', async () => {
    const day = (n: number) => { const d = new Date(); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }
    const be = fakeBackend([deal({ pay_due: day(3), report_state: { ready: true, left: 0, first_published_at: T } })])
    setup('/projects/obj_pj/deals?deal=deal_1')
    expect(await screen.findByText('1 单账期快到了')).toBeInTheDocument()
    const drawer = await screen.findByRole('dialog', { name: '试点上线短片' })
    expect(await within(drawer).findByText('3 天后到账期：已交付还没收款，记得跟对方确认付款')).toBeInTheDocument()
    await userEvent.click(within(drawer).getByRole('button', { name: '出结案报告' }))
    await waitFor(() => expect(be.calls.some((c) => c.method === 'POST' && c.path === '/api/video/deals/deal_1/report')).toBe(true))
    expect(await within(drawer).findByRole('button', { name: '打开结案报告' })).toBeInTheDocument()
    expect(within(drawer).getByText(/已生成 DOC-0001/)).toBeInTheDocument()
  })

  it('丢单要写原因才能保存', async () => {
    const be = fakeBackend([deal({ status: 'quoted', video_ids: [] })])
    setup('/projects/obj_pj/deals?deal=deal_1')
    const drawer = await screen.findByRole('dialog', { name: '试点上线短片' })
    await userEvent.click(within(drawer).getByRole('button', { name: '丢单' }))
    await userEvent.click(within(drawer).getByRole('button', { name: '保存' }))
    expect(within(drawer).getByRole('alert')).toHaveTextContent('写一下丢单原因')
    await userEvent.type(within(drawer).getByPlaceholderText('比如：预算没批下来'), '预算没批')
    await userEvent.click(within(drawer).getByRole('button', { name: '保存' }))
    await waitFor(() => expect(be.calls.find((c) => c.method === 'PATCH')?.body).toEqual({ status: 'lost', lost_reason: '预算没批' }))
  })
})
