import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ImAttachment, ImMessage } from '../../core/data'
import { AttachmentsTab, AttachmentsTabCount } from './AttachmentsTab'

let calls: { method: string; path: string; body?: Record<string, unknown> }[] = []
let props: Record<string, unknown> = {}
let materials: { id: string; kind: string; value: string; name: string; tags: string[]; created_at: string }[] = []
let imRunning = true

const msg = (id: string, at: string, attachments: ImAttachment[], over: Partial<ImMessage> = {}): ImMessage => ({
  id, channel: 'slack', connector_id: '', external_id: id, conversation_id: 'cv_prod', conversation_external_id: 'C1', conversation_kind: 'group',
  conversation: '#product', sender_id: 'U1', sender_name: 'Lin Yuan', identity_id: null, stakeholder_id: null, contact_name: '林予安',
  text: `正文 ${id}`, attachments, relevance: '', status: 'pending', read: false, snooze_until: null, at, received_at: at,
  adapter: 'fake', task_id: null, task_ref: '', replies: [], reply_error: '', expired_at: null, project_id: null, project_name: '', project_source: '', sessions: [], split_tasks: [], materials: [], thread: null, reply_count: 0,
  ...over,
})
const LINK = 'https://www.figma.com/design/roles-v4'
const LOCAL = '/d/attachments/slack/清单.xlsx'
let MSGS: ImMessage[] = []
const baseMsgs = () => [
  msg('msg_1', '2026-10-29T03:00:00Z', [{ id: 'a1', name: '清单.xlsx', kind: 'file', size: 2048, fetch: 'idle' }, { id: 'a2', name: 'Figma', kind: 'link', url: LINK }]),
  msg('msg_2', '2026-10-29T02:00:00Z', [{ id: 'a1', name: '截图.png', kind: 'image', size: 10, fetch: 'done', local: '/d/attachments/slack/截图.png', download_url: '/api/im/attachments/slack/截图.png' } as ImAttachment]),
  // 归到项目的消息（不在绑定会话里）
  msg('msg_3', '2026-10-29T01:00:00Z', [{ id: 'b1', name: '说明.pdf', kind: 'file', size: 10, fetch: 'error', error: '获取失败：file_not_found' }],
    { conversation_id: 'cv_other', conversation: '#ops', contact_name: '', sender_name: 'Chen', project_id: 'obj_p' }),
]

function fakeBackend() {
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(status < 300 ? { data, meta: { total: Array.isArray(data) ? data.length : 0 } } : data), { status })
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input), 'http://x')
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined
    const p = decodeURIComponent(u.pathname)
    calls.push({ method, path: p, body })
    const obj = () => ({ id: 'obj_p', type_id: 'project', title: '项目', body: '', status: 'active', props, workdir: '', deleted_at: null })
    if (p === '/api/plugins') return json([{ id: 'im', running: imRunning }, { id: 'projects', running: true }])
    if (p === '/api/objects/obj_p' && method === 'GET') return json(obj())
    if (p === '/api/objects/obj_p' && method === 'PATCH') { props = body!.props as Record<string, unknown>; return json(obj()) }
    if (p === '/api/projects/obj_p/conversations') {
      return json([{ project_id: 'obj_p', conversation_id: 'cv_prod', conversation: { id: 'cv_prod', channel: 'slack', external_id: 'C1', kind: 'group', name: '#product' }, created_at: '' }])
    }
    if (p === '/api/im/messages' && imRunning) {
      const cid = u.searchParams.get('conversation_id')
      const pid = u.searchParams.get('project_id')
      return json(MSGS.filter((m) => (cid ? m.conversation_id === cid : pid ? m.project_id === pid : true)))
    }
    if (p === '/api/projects/obj_p/materials' && method === 'GET') return json(materials)
    if (p === '/api/projects/obj_p/materials' && method === 'POST') {
      const m = { id: `mt${materials.length}`, kind: String(body!.kind), value: String(body!.value), name: String(body!.name), tags: body!.tags as string[], created_at: '' }
      materials.push(m)
      return json(m, 201)
    }
    if (p === '/api/im/messages/msg_1/attachments/a1/fetch') {
      const m = MSGS[0]
      const next = { ...m, attachments: [{ ...m.attachments[0], fetch: 'done', local: LOCAL, download_url: '/api/im/attachments/slack/x' }, m.attachments[1]] }
      MSGS[0] = next as ImMessage
      return json(next)
    }
    return json({ error: { code: 'not_found', message: 'nope' } }, 404)
  }))
}

function Where() {
  const l = useLocation()
  return <div data-testid="where">{l.pathname}{l.search}</div>
}

function renderTab(el = <AttachmentsTab projectId="obj_p" />) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/projects/obj_p/attachments']}>
        <Routes><Route path="*" element={<>{el}<Where /></>} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const table = () => screen.getByRole('table', { name: '项目附件' })
const row = (name: string) => screen.getByRole('row', { name })
const seg = (label: RegExp) => within(screen.getByRole('group', { name: '去向' })).getByRole('button', { name: label })

beforeEach(() => {
  calls = []
  props = { color: 'blue' }
  materials = [{ id: 'mt_shot', kind: 'file', value: '/d/attachments/slack/截图.png', name: '截图.png', tags: ['消息附件'], created_at: '' }]
  imRunning = true
  MSGS = baseMsgs()
  fakeBackend()
})
afterEach(() => vi.unstubAllGlobals())

describe('附件标签', () => {
  it('默认看待决定；分段带数字，全部里列出去向，已加入的点了去支持材料里那一条', async () => {
    const user = userEvent.setup()
    renderTab()
    await screen.findByRole('table', { name: '项目附件' })
    expect(seg(/^待决定/)).toHaveTextContent('待决定3')
    expect(seg(/^已加入资料/)).toHaveTextContent('1')
    expect(within(table()).queryByText('截图.png')).not.toBeInTheDocument()
    // 归到项目的消息里的附件也算
    expect(within(row('说明.pdf')).getByText('获取失败')).toBeInTheDocument()
    await user.click(seg(/^全部/))
    const shot = row('截图.png')
    expect(within(shot).getByRole('checkbox')).toBeDisabled()
    await user.click(within(shot).getByRole('button', { name: '已加入资料' }))
    expect(screen.getByTestId('where')).toHaveTextContent('/projects/obj_p/materials?mt=mt_shot')
  })

  it('按种类筛、搜发信人', async () => {
    const user = userEvent.setup()
    renderTab()
    await screen.findByRole('table', { name: '项目附件' })
    await user.selectOptions(screen.getByRole('combobox', { name: '种类' }), 'link')
    expect(within(table()).getAllByRole('row')).toHaveLength(2)
    expect(row('Figma')).toBeInTheDocument()
    await user.selectOptions(screen.getByRole('combobox', { name: '种类' }), '')
    await user.type(screen.getByRole('searchbox', { name: '搜索附件' }), 'chen')
    expect(within(table()).getAllByRole('row').map((r) => r.getAttribute('aria-label'))).toEqual([null, '说明.pdf'])
  })

  it('批量不加入一次写进项目 props；在不加入里撤销', async () => {
    const user = userEvent.setup()
    renderTab()
    await screen.findByRole('table', { name: '项目附件' })
    await user.click(within(row('清单.xlsx')).getByRole('checkbox'))
    await user.click(within(row('Figma')).getByRole('checkbox'))
    const bulk = screen.getByRole('group', { name: '批量操作' })
    expect(bulk).toHaveTextContent('已选 2 个')
    await user.click(within(bulk).getByRole('button', { name: '不加入' }))
    await waitFor(() => expect(props).toEqual({ color: 'blue', skipped_attachments: ['msg_1:a1', 'msg_1:a2'] }))
    expect(calls.filter((c) => c.method === 'PATCH')).toHaveLength(1)
    await waitFor(() => expect(seg(/^待决定/)).toHaveTextContent('1'))
    expect(screen.queryByRole('group', { name: '批量操作' })).not.toBeInTheDocument()

    await user.click(seg(/^不加入/))
    await user.click(within(row('Figma')).getByRole('button', { name: '撤销不加入' }))
    await waitFor(() => expect(props).toEqual({ color: 'blue', skipped_attachments: ['msg_1:a1'] }))
  })

  it('批量加入资料：链接直接加，没获取的文件先获取再加；加完到已加入资料', async () => {
    const user = userEvent.setup()
    renderTab()
    await screen.findByRole('table', { name: '项目附件' })
    await user.click(screen.getByRole('checkbox', { name: '全选这一页能操作的' }))
    expect(screen.getByRole('group', { name: '批量操作' })).toHaveTextContent('已选 3 个')
    // 先把说明.pdf 取消掉，它获取会失败
    await user.click(within(row('说明.pdf')).getByRole('checkbox'))
    await user.click(within(screen.getByRole('group', { name: '批量操作' })).getByRole('button', { name: '加入资料' }))
    await waitFor(() => expect(materials.map((m) => m.value)).toEqual(expect.arrayContaining([LINK, LOCAL])))
    const posts = calls.filter((c) => c.method === 'POST').map((c) => c.path)
    expect(posts).toContain('/api/im/messages/msg_1/attachments/a1/fetch')
    expect(posts.indexOf('/api/im/messages/msg_1/attachments/a1/fetch')).toBeLessThan(posts.lastIndexOf('/api/projects/obj_p/materials'))
    await waitFor(() => expect(seg(/^已加入资料/)).toHaveTextContent('3'))
    expect(seg(/^待决定/)).toHaveTextContent('1')
  })

  it('批量加入时选中不加入的也行，加上后不加入记录清掉', async () => {
    props = { color: 'blue', skipped_attachments: ['msg_1:a2'] }
    const user = userEvent.setup()
    renderTab()
    await screen.findByRole('table', { name: '项目附件' })
    await user.click(seg(/^不加入/))
    await user.click(within(row('Figma')).getByRole('checkbox'))
    const bulk = screen.getByRole('group', { name: '批量操作' })
    // 选中的都不是待决定的，批量「不加入」不能点
    expect(within(bulk).getByRole('button', { name: '不加入' })).toBeDisabled()
    await user.click(within(bulk).getByRole('button', { name: '加入资料' }))
    await waitFor(() => expect(props).toEqual({ color: 'blue', skipped_attachments: [] }))
    expect(materials.some((m) => m.value === LINK)).toBe(true)
  })

  it('预览打开弹窗，能下载；点来自打开来源消息', async () => {
    const user = userEvent.setup()
    renderTab()
    await screen.findByRole('table', { name: '项目附件' })
    await user.click(seg(/^全部/))
    await user.click(within(row('截图.png')).getByRole('button', { name: '预览' }))
    const dlg = screen.getByRole('dialog', { name: '预览 截图.png' })
    expect(within(dlg).getByRole('link', { name: '下载' })).toHaveAttribute('href', expect.stringContaining('/api/im/attachments/slack/'))
    expect(within(row('截图.png')).getByRole('link', { name: '下载' })).toBeInTheDocument()
    await user.click(within(dlg).getByRole('button', { name: '关闭预览' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await user.click(within(row('截图.png')).getByTitle(/^打开来源消息/))
    expect(screen.getByTestId('where')).toHaveTextContent('/messages?m=msg_2')
  })

  it('标签上的数字是待决定的个数', async () => {
    renderTab(<AttachmentsTabCount projectId="obj_p" />)
    expect(await screen.findByTitle('3 个附件待决定')).toHaveTextContent('3')
  })

  it('IM 插件没在跑时提示去插件管理', async () => {
    imRunning = false
    renderTab()
    expect(await screen.findByText('需要 IM 消息插件')).toBeInTheDocument()
  })
})
