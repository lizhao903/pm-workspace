import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Conversation, ImMessage, WorkObject } from '../../core/data'
import { CommsTab, CommsTabDot } from './CommsTab'
import { Overview } from './Overview'
import { StakeholdersTab } from './StakeholdersTab'

let imRunning = true
let bound: string[] = []
let calls: { method: string; path: string; query: string; body?: Record<string, unknown> }[] = []

const conv = (p: Partial<Conversation>): Conversation => ({
  id: 'cv_x', channel: 'slack', external_id: 'C0', kind: 'group', name: '#x', members: [], created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z', ...p,
})
const CONVS = [
  conv({ id: 'cv_prod', external_id: 'C1', name: '#product' }),
  conv({ id: 'cv_ops', external_id: 'C2', name: '#ops' }),
  conv({ id: 'cv_dm', external_id: 'D1', kind: 'direct', name: '', members: ['idn_lin'] }),
]
const msg = (p: Partial<ImMessage>): ImMessage => ({
  id: 'msg_x', channel: 'slack', connector_id: '', external_id: 'x', conversation_id: 'cv_prod', conversation_external_id: 'C1', conversation_kind: 'group',
  conversation: '#product', sender_id: 'U1', sender_name: 'Lin Yuan', identity_id: 'idn_lin', stakeholder_id: 'stk_lin', contact_name: '林予安',
  text: '', attachments: [], relevance: '', status: 'pending', read: false, snooze_until: null, at: '2026-10-29T01:00:00Z', received_at: '2026-10-29T01:00:00Z',
  adapter: 'fake', task_id: null, task_ref: '', replies: [], reply_error: '', ...p,
})
const MSGS = [
  msg({ id: 'msg_1', text: '@我 权限点清单整理了一版', at: '2026-10-29T03:00:00Z' }),
  msg({ id: 'msg_2', text: '已处理的一条', status: 'done', at: '2026-10-29T02:00:00Z' }),
  msg({ id: 'msg_3', conversation_id: 'cv_ops', conversation: '#ops', text: '不该出现的运维群消息' }),
  msg({ id: 'msg_4', conversation_id: 'cv_dm', conversation: '', conversation_kind: 'direct', text: '私聊里问进度', at: '2026-10-29T00:30:00Z' }),
]

function fakeBackend() {
  const json = (data: unknown, status = 200, total?: number) =>
    new Response(JSON.stringify(status < 300 ? { data, meta: { total: total ?? (Array.isArray(data) ? data.length : 0) } } : data), { status })
  const notFound = () => json({ error: { code: 'not_found', message: 'nope' } }, 404)
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input), 'http://x')
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined
    calls.push({ method, path: u.pathname, query: u.search, body })
    const p = u.pathname
    if (p === '/api/plugins') return json([{ id: 'im', running: imRunning }, { id: 'projects', running: true }])
    if (p === '/api/conversations') return json(CONVS)
    if (p === '/api/im-identities') return json([{ id: 'idn_lin', stakeholder_id: 'stk_lin', channel: 'slack', external_id: 'U1' }])
    if (p === '/api/stakeholders') return json([{ id: 'stk_lin', name: '林予安', company: '星河', title: 'PM', photo: '', last_contact_at: null }])
    if (p.startsWith('/api/connectors') || p.startsWith('/api/dictionaries')) return json([])
    if (p === '/api/im/messages') {
      if (!imRunning) return notFound()
      const cid = u.searchParams.get('conversation_id')
      return json(cid ? MSGS.filter((m) => m.conversation_id === cid) : MSGS)
    }
    if (p === '/api/projects/obj_p/stakeholders') {
      return json([{ project_id: 'obj_p', stakeholder_id: 'stk_lin', role: 'contact', focus: '', sort_order: 0, created_at: '', updated_at: '' }])
    }
    const m = p.match(/^\/api\/projects\/obj_p\/conversations(?:\/([^/]+))?$/)
    if (!m) return notFound()
    const row = (id: string) => {
      const c = CONVS.find((x) => x.id === id)!
      return { project_id: 'obj_p', conversation_id: id, conversation: { id, channel: c.channel, external_id: c.external_id, kind: c.kind, name: c.name }, created_at: '' }
    }
    if (method === 'GET') return json(bound.map(row))
    if (method === 'POST') { bound.push(String(body?.conversation_id)); return json(row(String(body?.conversation_id)), 201) }
    if (method === 'DELETE') { bound = bound.filter((x) => x !== decodeURIComponent(m[1])); return json(null) }
    return json({ error: { code: 'internal', message: 'x' } }, 500)
  }))
}

function Where() {
  const l = useLocation()
  return <div data-testid="where">{l.pathname}{l.search}</div>
}

function renderTab(el = <CommsTab projectId="obj_p" />) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/projects/obj_p/comms']}>
        <Routes><Route path="*" element={<>{el}<Where /></>} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const PROJECT = { id: 'obj_p', ref: 'P-1', type_id: 'project', title: '工作台', body: '', status: 'active', props: null, workdir: '' } as unknown as WorkObject

beforeEach(() => { imRunning = true; bound = []; calls = []; fakeBackend() })
afterEach(() => { vi.unstubAllGlobals() })

describe('沟通标签', () => {
  it('没绑定时是空状态，不去取消息', async () => {
    renderTab()
    expect(await screen.findByText(/还没绑定。把项目群/)).toBeInTheDocument()
    expect(screen.getByText('没有消息')).toBeInTheDocument()
    expect(calls.some((c) => c.path === '/api/im/messages')).toBe(false)
  })

  it('只显示绑定会话里的消息，按会话 id 取', async () => {
    bound = ['cv_prod', 'cv_dm']
    renderTab()
    expect(await screen.findByText('权限点清单整理了一版', { exact: false })).toBeInTheDocument()
    expect(screen.getByText('私聊里问进度')).toBeInTheDocument()
    expect(screen.queryByText('不该出现的运维群消息')).not.toBeInTheDocument()
    const qs = calls.filter((c) => c.path === '/api/im/messages').map((c) => new URLSearchParams(c.query).get('conversation_id'))
    expect(qs.sort()).toEqual(['cv_dm', 'cv_prod'])
    // 私聊按成员认出联系人
    expect(screen.getByRole('button', { name: /私聊\s*林予安/ })).toBeInTheDocument()
    // 待回复的右侧「回复」，已处理的显示状态名
    const rows = screen.getAllByRole('button', { name: /林予安/ }).filter((b) => b.classList.contains('pj-msg'))
    expect(rows).toHaveLength(3)
    expect(within(rows[0]).getByText('回复')).toBeInTheDocument()
    expect(within(rows[1]).getByText('已处理')).toBeInTheDocument()
  })

  it('点渠道只看这个渠道；点消息跳到 IM 消息页', async () => {
    bound = ['cv_prod', 'cv_dm']
    renderTab()
    await screen.findByText('私聊里问进度')
    await userEvent.click(screen.getByRole('button', { name: /私聊\s*林予安/ }))
    expect(screen.queryByText('已处理的一条')).not.toBeInTheDocument()
    await userEvent.click(screen.getByText('私聊里问进度'))
    expect(screen.getByTestId('where')).toHaveTextContent('/messages?m=msg_4')
  })

  it('绑定面板列出没绑的会话，点了绑定并收起', async () => {
    bound = ['cv_prod']
    renderTab()
    await screen.findByText('权限点清单整理了一版', { exact: false })
    await userEvent.click(screen.getByRole('button', { name: '绑定' }))
    const search = screen.getByRole('textbox', { name: '搜群名、联系人' })
    expect(search).toHaveFocus()
    const panel = search.closest('.pj-bind') as HTMLElement
    expect(within(panel).queryByText('#product')).not.toBeInTheDocument()
    await userEvent.click(within(panel).getByText('#ops'))
    await waitFor(() => expect(screen.queryByRole('textbox', { name: '搜群名、联系人' })).not.toBeInTheDocument())
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ conversation_id: 'cv_ops' })
    expect(await screen.findByText('不该出现的运维群消息')).toBeInTheDocument()
  })

  it('搜不到时提示，Esc 先清空再收起', async () => {
    renderTab()
    await screen.findByText(/还没绑定/)
    await userEvent.click(screen.getByRole('button', { name: '绑定' }))
    await userEvent.type(screen.getByRole('textbox', { name: '搜群名、联系人' }), 'zzz')
    expect(screen.getByText('没有匹配的群')).toBeInTheDocument()
    expect(screen.getByText('没有匹配的联系人')).toBeInTheDocument()
    await userEvent.keyboard('{Escape}')
    expect(screen.getByRole('textbox', { name: '搜群名、联系人' })).toHaveValue('')
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('textbox', { name: '搜群名、联系人' })).not.toBeInTheDocument()
  })

  it('解绑后消息跟着去掉，正在看的渠道回到全部', async () => {
    bound = ['cv_prod', 'cv_dm']
    renderTab()
    await screen.findByText('私聊里问进度')
    await userEvent.click(screen.getByRole('button', { name: /私聊\s*林予安/ }))
    await userEvent.click(screen.getByRole('button', { name: '解绑 林予安' }))
    await waitFor(() => expect(screen.queryByText('私聊里问进度')).not.toBeInTheDocument())
    expect(screen.getByRole('button', { name: /^全部/ })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByText('已处理的一条')).toBeInTheDocument()
  })

  it('IM 消息插件没在跑时提示去插件管理，绑定照常显示', async () => {
    imRunning = false
    bound = ['cv_prod']
    renderTab()
    expect(await screen.findByText('需要 IM 消息插件')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Slack\s*#product/ })).toBeInTheDocument()
    expect(calls.some((c) => c.path === '/api/im/messages')).toBe(false)
    await userEvent.click(screen.getByRole('button', { name: '去插件管理' }))
    expect(screen.getByTestId('where')).toHaveTextContent('/settings/plugins')
  })
})

describe('沟通标签的布局（ALIGN-07）', () => {
  it('附件在右栏消息列表上面；时间和「回复」在同一行；「绑定」是描边小按钮；附件标签带种类和大小', async () => {
    bound = ['cv_prod']
    const att = { id: 'att_1', name: '权限点清单.xlsx', kind: 'file' as const, size: 2048 }
    MSGS[0].attachments = [att]
    try {
      renderTab()
      const msgs = await screen.findByLabelText('项目消息')
      expect(await within(msgs).findByRole('region', { name: '消息里的附件' })).toBeInTheDocument()
      const row = screen.getAllByRole('button', { name: /权限点清单整理了一版/ }).find((b) => b.classList.contains('pj-msg'))!
      const side = within(row).getByText('回复').parentElement!
      expect(side).toHaveClass('pj-msg-side')
      expect(within(side).getByText(/前|刚刚|-/)).toBeInTheDocument()
      expect(screen.getByRole('button', { name: '绑定' })).toHaveClass('btn-outline', 'btn-sm')
      expect(within(row).getByTitle('文件 · 2 KB')).toHaveTextContent('权限点清单.xlsx')
    } finally {
      MSGS[0].attachments = []
    }
  })
})

describe('项目消息在别处的用法', () => {
  it('标签红点：有待回复时显示，没绑定时不显示', async () => {
    bound = ['cv_prod']
    const { unmount } = renderTab(<CommsTabDot projectId="obj_p" />)
    expect(await screen.findByTitle('1 条待回复')).toBeInTheDocument()
    unmount()
    bound = []
    renderTab(<CommsTabDot projectId="obj_p" />)
    await waitFor(() => expect(calls.some((c) => c.path === '/api/projects/obj_p/conversations')).toBe(true))
    expect(screen.queryByTitle(/条待回复/)).not.toBeInTheDocument()
  })

  it('概览：待回复数、最新沟通点开消息，没绑定时去绑定', async () => {
    bound = ['cv_prod', 'cv_dm']
    const onTab = vi.fn()
    const { unmount } = renderTab(<Overview project={PROJECT} onTab={onTab} />)
    const block = await screen.findByRole('region', { name: '最新沟通' })
    expect(await within(block).findByText('私聊里问进度')).toBeInTheDocument()
    expect(within(block).queryByText('不该出现的运维群消息')).not.toBeInTheDocument()
    const stat = screen.getByRole('button', { name: /待回复消息/ })
    expect(stat).toHaveTextContent('待回复消息2')
    await userEvent.click(within(block).getByText('私聊里问进度'))
    expect(screen.getByTestId('where')).toHaveTextContent('/messages?m=msg_4')
    expect(screen.getByRole('region', { name: '项目 Agent' })).toHaveTextContent('还没设置。去设置')
    unmount()

    bound = []
    renderTab(<Overview project={PROJECT} onTab={onTab} />)
    const empty = await screen.findByRole('button', { name: '去绑定' })
    await userEvent.click(empty)
    expect(onTab).toHaveBeenCalledWith('comms')
  })

  it('干系人：最近沟通是这个人在本项目会话里最近的一条，没绑定时说还没绑定', async () => {
    bound = ['cv_prod']
    const { unmount } = renderTab(<StakeholdersTab projectId="obj_p" />)
    const last = await screen.findByRole('button', { name: /· @我 权限点清单整理了一版/ })
    expect(last).toHaveAttribute('title', '@我 权限点清单整理了一版')
    await userEvent.click(last)
    expect(screen.getByTestId('where')).toHaveTextContent('/messages?m=msg_1')
    unmount()
    bound = []
    renderTab(<StakeholdersTab projectId="obj_p" />)
    expect(await screen.findByText('还没绑定沟通渠道')).toBeInTheDocument()
  })
})

