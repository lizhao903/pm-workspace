import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ImAttachment, ImMessage } from '../../core/data'
import { AttachmentInbox } from './AttachmentInbox'

let calls: { method: string; path: string; body?: Record<string, unknown> }[] = []
let props: Record<string, unknown> = {}
let materials: { id: string; kind: string; value: string; name: string; tags: string[] }[] = []

const msg = (id: string, at: string, attachments: ImAttachment[]): ImMessage => ({
  id, channel: 'slack', connector_id: '', external_id: id, conversation_id: 'cv_prod', conversation_external_id: 'C1', conversation_kind: 'group',
  conversation: '#product', sender_id: 'U1', sender_name: 'Lin Yuan', identity_id: null, stakeholder_id: null, contact_name: '林予安',
  text: `正文 ${id}`, attachments, relevance: '', status: 'pending', read: false, snooze_until: null, at, received_at: at,
  adapter: 'fake', task_id: null, task_ref: '', replies: [], reply_error: '',
})
const LINK = 'https://www.figma.com/design/roles-v4'
const LOCAL = '/d/attachments/slack/清单.xlsx'
const MSGS = [
  msg('msg_1', '2026-10-29T03:00:00Z', [{ id: 'a1', name: '清单.xlsx', kind: 'file', size: 2048, fetch: 'idle' }, { id: 'a2', name: 'Figma', kind: 'link', url: LINK }]),
  msg('msg_2', '2026-10-29T02:00:00Z', [{ id: 'a1', name: '截图.png', kind: 'image', size: 10, fetch: 'idle' }]),
  msg('msg_3', '2026-10-29T01:00:00Z', [{ id: 'b1', name: '说明.pdf', kind: 'file', size: 10, fetch: 'error', error: '获取失败：file_not_found' }]),
]

function fakeBackend() {
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(status < 300 ? { data, meta: { total: Array.isArray(data) ? data.length : 0 } } : data), { status })
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input), 'http://x')
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined
    calls.push({ method, path: decodeURIComponent(u.pathname), body })
    const p = decodeURIComponent(u.pathname)
    const obj = () => ({ id: 'obj_p', type_id: 'project', title: '项目', body: '', status: 'doing', props, workdir: '', deleted_at: null })
    if (p === '/api/objects/obj_p' && method === 'GET') return json(obj())
    if (p === '/api/objects/obj_p' && method === 'PATCH') { props = body!.props as Record<string, unknown>; return json(obj()) }
    if (p === '/api/projects/obj_p/materials' && method === 'GET') return json(materials)
    if (p === '/api/projects/obj_p/materials' && method === 'POST') {
      const m = { id: `mt${materials.length}`, kind: String(body!.kind), value: String(body!.value), name: String(body!.name), tags: body!.tags as string[] }
      materials.push(m)
      return json(m, 201)
    }
    if (p === '/api/im/messages/msg_1/attachments/a1/fetch') {
      const m = MSGS[0]
      return json({ ...m, attachments: [{ ...m.attachments[0], fetch: 'done', local: LOCAL, download_url: '/api/im/attachments/slack/x' }, m.attachments[1]] })
    }
    return json({ error: { code: 'not_found', message: 'nope' } }, 404)
  }))
}

function renderInbox(onOpen = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <AttachmentInbox projectId="obj_p" messages={MSGS} now={Date.parse('2026-10-29T04:00:00Z')} onOpenMessage={onOpen} />
    </QueryClientProvider>,
  )
  return onOpen
}

const section = () => screen.getByRole('region', { name: '消息里的附件' })

beforeEach(() => {
  calls = []
  props = { color: 'blue' }
  materials = []
  fakeBackend()
})
afterEach(() => vi.unstubAllGlobals())

describe('消息里的附件', () => {
  it('多于 3 个时折成一行，逐个决定先露 3 个，再点列出全部', async () => {
    const user = userEvent.setup()
    renderInbox()
    expect(await within(section()).findByText('4 个还没决定要不要放进支持材料')).toBeInTheDocument()
    expect(screen.queryByText('清单.xlsx')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '逐个决定' }))
    expect(screen.getByText('清单.xlsx')).toBeInTheDocument()
    expect(screen.queryByText('说明.pdf')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '还有 1 个' }))
    expect(screen.getByText('说明.pdf')).toBeInTheDocument()
    expect(screen.getByText('获取失败：file_not_found')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument()
  })

  it('已加进资料的不列出；链接直接加，文件先获取再加，value 是 local，打消息附件标签', async () => {
    const user = userEvent.setup()
    materials = [{ id: 'mt_old', kind: 'file', value: '/no/match', name: 'x', tags: [] }]
    renderInbox()
    await user.click(await screen.findByRole('button', { name: '逐个决定' }))
    const linkRow = screen.getByText('Figma').closest('.pj-att-row') as HTMLElement
    await user.click(within(linkRow).getByRole('button', { name: '加入支持材料' }))
    await waitFor(() => expect(materials.some((m) => m.value === LINK)).toBe(true))
    expect(calls.find((c) => c.method === 'POST' && c.path.endsWith('/materials'))?.body).toEqual({ kind: 'link', value: LINK, name: 'Figma', tags: ['消息附件'] })
    expect(await within(section()).findByText('3 个还没决定要不要放进支持材料')).toBeInTheDocument()

    const fileRow = screen.getByText('清单.xlsx').closest('.pj-att-row') as HTMLElement
    await user.click(within(fileRow).getByRole('button', { name: '获取并加入' }))
    await waitFor(() => expect(materials.some((m) => m.value === LOCAL)).toBe(true))
    const order = calls.filter((c) => c.method === 'POST').map((c) => c.path)
    expect(order.slice(-2)).toEqual(['/api/im/messages/msg_1/attachments/a1/fetch', '/api/projects/obj_p/materials'])
  })

  it('不加入记进项目 props，别的 key 留着；恢复后回到待决定', async () => {
    const user = userEvent.setup()
    renderInbox()
    await user.click(await screen.findByRole('button', { name: '逐个决定' }))
    const row = screen.getByText('截图.png').closest('.pj-att-row') as HTMLElement
    await user.click(within(row).getByRole('button', { name: '不加入' }))
    await waitFor(() => expect(props).toEqual({ color: 'blue', skipped_attachments: ['msg_2:a1'] }))
    expect(await within(section()).findByText('3 个还没决定要不要放进支持材料')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '看不加入的 1 个' }))
    expect(screen.getByText('林予安 · 选了不加入')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '恢复' }))
    await waitFor(() => expect(props).toEqual({ color: 'blue', skipped_attachments: [] }))
  })

  it('点发信人打开那条消息', async () => {
    const user = userEvent.setup()
    const onOpen = renderInbox()
    await user.click(await screen.findByRole('button', { name: '逐个决定' }))
    await user.click(screen.getAllByRole('button', { name: /林予安 · / })[0])
    expect(onOpen).toHaveBeenCalledWith(MSGS[0])
  })
})
