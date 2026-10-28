import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Connector, ImMessage } from '../../core/data'
import Page from './Page'

let seq = 0
function msg(p: Partial<ImMessage> = {}): ImMessage {
  seq += 1
  return {
    id: `msg_${seq}`, channel: 'slack', connector_id: '', external_id: `C:${seq}`, conversation_id: null, conversation_external_id: 'C01',
    conversation_kind: 'group', conversation: '#product', sender_id: 'U1', sender_name: 'Lin Yuan', identity_id: null, stakeholder_id: null,
    contact_name: '', text: '权限点清单看下', attachments: [], relevance: '', status: 'pending', read: true, snooze_until: null,
    at: new Date().toISOString(), received_at: new Date().toISOString(), adapter: 'fake', task_id: null, task_ref: '', replies: [],
    reply_error: '', ...p,
  }
}

type Call = { method: string; path: string; body?: Record<string, unknown> }

// 内存里的消息表：处理动作按契约改了再返回整条
function fakeBackend(rows: ImMessage[], opts: { connectors?: Connector[]; replyFails?: string } = {}) {
  const calls: Call[] = []
  const json = (data: unknown, status = 200, meta?: unknown) =>
    new Response(JSON.stringify(status < 300 ? { data, meta } : data), { status })
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input), 'http://x')
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ method, path: u.pathname, body })
    if (u.pathname === '/api/im/messages') return json(rows, 200, { total: rows.length, limit: 200, offset: 0 })
    const m = u.pathname.match(/^\/api\/im\/messages\/([^/]+)(?:\/([a-z]+))?$/)
    if (m) {
      const r = rows.find((x) => x.id === m[1])
      if (!r) return json({ error: { code: 'not_found', message: '消息不存在' } }, 404)
      const a = m[2]
      if (a === 'done' || a === 'ignore') Object.assign(r, { status: a === 'done' ? 'done' : 'ignored', snooze_until: null, read: true })
      if (a === 'reopen') Object.assign(r, { status: 'pending', snooze_until: null })
      if (a === 'read') r.read = true
      if (a === 'snooze') Object.assign(r, { snooze_until: body.until, read: true })
      if (a === 'reply') {
        if (opts.replyFails) {
          r.reply_error = opts.replyFails
          return json({ error: { code: 'send_failed', message: `发送失败：${opts.replyFails}` } }, 502)
        }
        r.replies = [...r.replies, { id: `rp_${seq++}`, text: body.text, status: 'sent', error: '', external_id: '', at: new Date().toISOString() }]
        if (body.done) r.status = 'done'
      }
      if (a === 'task') {
        Object.assign(r, { task_id: 'obj_t1', task_ref: 'TSK-0001' })
        if (body.done) r.status = 'done'
        return json({ message: r, task: { id: 'obj_t1', ref: 'TSK-0001', title: body.title, status: 'todo', source: 'im' } }, 201)
      }
      return json(r)
    }
    if (u.pathname === '/api/connectors') return json(opts.connectors ?? [])
    if (u.pathname === '/api/connectors/defs' || u.pathname === '/api/stakeholders' || u.pathname.startsWith('/api/dictionaries')) return json([])
    return json({ error: { code: 'not_found', message: u.pathname } }, 404)
  }))
  return calls
}

function renderPage(path = '/messages') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createMemoryRouter([
    { path: '/messages', element: <Page /> },
    { path: '/contacts', element: <div>联系人页</div> },
    { path: '/settings/*', element: <div>设置页</div> },
  ], { initialEntries: [path] })
  render(<QueryClientProvider client={qc}><RouterProvider router={router} /></QueryClientProvider>)
  return router
}

const posts = (calls: Call[]) => calls.filter((c) => c.method === 'POST').map((c) => c.path.replace(/^\/api\/im\/messages\/[^/]+\//, ''))

afterEach(() => { vi.unstubAllGlobals() })

describe('IM 消息页', () => {
  it('待处理数、行内已处理、切到已处理后重新打开', async () => {
    const rows = [msg({ text: '第一条' }), msg({ text: '第二条', relevance: 'me' })]
    const calls = fakeBackend(rows)
    renderPage()
    expect(await screen.findByText('2 条待处理')).toBeInTheDocument()
    const row = screen.getByRole('listitem', { name: /第一条/ })
    await userEvent.click(within(row).getByRole('button', { name: '已处理' }))
    await waitFor(() => expect(screen.getByText('1 条待处理')).toBeInTheDocument())
    expect(posts(calls)).toEqual(['done'])
    await userEvent.click(within(screen.getByRole('group', { name: '状态' })).getByRole('button', { name: /^已处理/ }))
    await userEvent.click(within(screen.getByRole('listitem', { name: /第一条/ })).getByRole('button', { name: '重新打开' }))
    await waitFor(() => expect(posts(calls)).toEqual(['done', 'reopen']))
  })

  it('只看 @我', async () => {
    fakeBackend([msg({ text: '普通' }), msg({ text: '@我 看下', relevance: 'me' })])
    renderPage()
    await screen.findByText('2 条待处理')
    await userEvent.selectOptions(screen.getByLabelText('与我相关'), 'at')
    expect(screen.getAllByRole('listitem')).toHaveLength(1)
    expect(screen.getByText('1 条待处理')).toBeInTheDocument()
  })

  it('打开抽屉标已读，回复框发送并标为已处理', async () => {
    const rows = [msg({ read: false })]
    const calls = fakeBackend(rows)
    const router = renderPage()
    await userEvent.click(await screen.findByRole('listitem', { name: /权限点/ }))
    expect(router.state.location.search).toBe(`?m=${rows[0].id}`)
    await waitFor(() => expect(posts(calls)).toEqual(['read']))
    await userEvent.type(screen.getByLabelText('回复内容'), '收到')
    await userEvent.click(screen.getByRole('button', { name: '发送' }))
    await waitFor(() => expect(posts(calls)).toEqual(['read', 'reply']))
    expect(calls.find((c) => c.path.endsWith('/reply'))?.body).toEqual({ text: '收到', done: true })
    await waitFor(() => expect(screen.getByLabelText('回复内容')).toHaveValue(''))
  })

  it('回复发送失败：保留回复框内容，红字说原因', async () => {
    fakeBackend([msg()], { replyFails: 'rate limited' })
    renderPage()
    await userEvent.click(await screen.findByRole('listitem', { name: /权限点/ }))
    await userEvent.type(screen.getByLabelText('回复内容'), '收到')
    await userEvent.click(screen.getByRole('button', { name: '发送' }))
    expect(await screen.findByText('没发出去：发送失败：rate limited')).toBeInTheDocument()
    expect(screen.getByLabelText('回复内容')).toHaveValue('收到')
  })

  it('连接器暂停时回复置灰并写出原因', async () => {
    const c: Connector = {
      id: 'cn_1', tool: 'slack', name: 'Slack 工作区', account: '', status: 'paused', error: '', auth_mode: 'token', config: {}, secret_hints: {},
      direction: 'both', interval: 5, tools: [], tools_at: null, last_tested_at: null, last_sync_at: null, available: true, created_at: '', updated_at: '',
    }
    fakeBackend([msg({ connector_id: 'cn_1' })], { connectors: [c] })
    renderPage()
    const row = await screen.findByRole('listitem', { name: /权限点/ })
    await waitFor(() => expect(within(row).getByRole('button', { name: /回复/ })).toBeDisabled())
    expect(within(row).getByRole('button', { name: /回复/ })).toHaveAttribute('title', '连接器「Slack 工作区」已暂停')
    await userEvent.click(row)
    expect(await screen.findByText('连接器「Slack 工作区」已暂停')).toBeInTheDocument()
    expect(screen.getByLabelText('回复内容')).toBeDisabled()
  })

  it('转任务：标题预填正文，确认后调后端并顺带标为已处理', async () => {
    const rows = [msg({ text: '  导出按钮\n在 Safari 下没反应 ' })]
    const calls = fakeBackend(rows)
    renderPage()
    const row = await screen.findByRole('listitem', { name: /导出按钮/ })
    await userEvent.click(within(row).getByRole('button', { name: '转任务' }))
    const dlg = await screen.findByRole('alertdialog')
    expect(within(dlg).getByRole('textbox')).toHaveValue('导出按钮 在 Safari 下没反应')
    await userEvent.click(within(dlg).getByRole('button', { name: '创建任务' }))
    await waitFor(() => expect(calls.find((c) => c.path.endsWith('/task'))?.body).toEqual({ title: '导出按钮 在 Safari 下没反应', done: true }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
    await userEvent.click(within(screen.getByRole('group', { name: '状态' })).getByRole('button', { name: /^全部/ }))
    expect(await screen.findByRole('button', { name: '已转任务 TSK-0001' })).toBeInTheDocument()
    // 测试里没有任务模块登记的抽屉：说清楚打不开，不静默
    expect(screen.getByText('任务模块没有加载，打不开任务')).toBeInTheDocument()
  })

  it('打开联系人去 /contacts?c=', async () => {
    fakeBackend([msg({ stakeholder_id: 'stk_1', contact_name: '林原' })])
    const router = renderPage()
    await userEvent.click(await screen.findByRole('listitem', { name: /林原/ }))
    await userEvent.click(screen.getByRole('button', { name: '查看联系人' }))
    await waitFor(() => expect(router.state.location.pathname + router.state.location.search).toBe('/contacts?c=stk_1'))
  })

  it('地址里的消息不存在时说明并只给关闭', async () => {
    fakeBackend([msg()])
    renderPage('/messages?m=msg_gone')
    expect(await screen.findByText('这条消息已不存在')).toBeInTheDocument()
  })
})
