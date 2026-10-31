import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Connector, Identity, ImMessage } from '../../core/data'
import Page from './Page'

let seq = 0
function msg(p: Partial<ImMessage> = {}): ImMessage {
  seq += 1
  return {
    id: `msg_${seq}`, channel: 'slack', connector_id: '', external_id: `C:${seq}`, conversation_id: null, conversation_external_id: 'C01',
    conversation_kind: 'group', conversation: '#product', sender_id: 'U1', sender_name: 'Lin Yuan', identity_id: null, stakeholder_id: null,
    contact_name: '', text: '权限点清单看下', attachments: [], relevance: '', status: 'pending', read: true, snooze_until: null,
    at: new Date().toISOString(), received_at: new Date().toISOString(), adapter: 'fake', task_id: null, task_ref: '', replies: [],
    reply_error: '', expired_at: null, ...p,
  }
}

type Call = { method: string; path: string; body?: Record<string, unknown> }

type FakeContact = { id: string; name: string; company: string; title: string; photo: string; group?: string }

function identity(p: Partial<Identity> & Pick<Identity, 'id' | 'stakeholder_id' | 'external_id'>): Identity {
  return { channel: 'slack', display_name: '', account: '', created_at: '', updated_at: '', ...p }
}

// 内存里的消息表：处理动作按契约改了再返回整条
// 给了 identities 时模拟后端读取时认人（IM-05）：按渠道和编号找身份，填联系人；unseen 是身份表里有、消息列表还没认上的（别处刚挂上）
function fakeBackend(rows: ImMessage[], opts: {
  connectors?: Connector[]; replyFails?: string; contacts?: FakeContact[]; identities?: Identity[]; unseen?: Identity[]
} = {}) {
  const calls: Call[] = []
  const json = (data: unknown, status = 200, meta?: unknown) =>
    new Response(JSON.stringify(status < 300 ? { data, meta } : data), { status })
  const contacts = opts.contacts ?? []
  const ids = opts.identities
  const resolve = () => {
    if (!ids) return
    for (const r of rows) {
      const i = ids.find((x) => x.channel === r.channel && x.external_id === r.sender_id)
      const c = i && contacts.find((x) => x.id === i.stakeholder_id)
      Object.assign(r, { identity_id: i?.id ?? null, stakeholder_id: c?.id ?? null, contact_name: c?.name ?? '' })
    }
  }
  const conflict = (message: string) => json({ error: { code: 'conflict', message } }, 409)
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input), 'http://x')
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ method, path: u.pathname, body })
    if (u.pathname === '/api/im/messages') { resolve(); return json(rows, 200, { total: rows.length, limit: 200, offset: 0 }) }
    if (u.pathname === '/api/stakeholders' && method === 'POST') {
      if (contacts.some((c) => c.name === body.name)) return conflict(`已经有叫「${body.name}」的联系人了`)
      const c = { id: `stk_new${seq++}`, title: '', photo: '', ...body }
      contacts.push(c)
      return json(c, 201)
    }
    if (u.pathname === '/api/stakeholders') return json(contacts)
    if (u.pathname === '/api/im-identities' && ids) {
      const all = [...ids, ...(opts.unseen ?? [])]
      if (method === 'GET') return json(all)
      const dup = all.find((x) => x.channel === body.channel && x.external_id === body.external_id)
      if (dup) return conflict(`这个编号已经是 ${contacts.find((c) => c.id === dup.stakeholder_id)?.name} 的`)
      const i = identity({ id: `idn_${seq++}`, ...body })
      ids.push(i)
      return json(i, 201)
    }
    const im = u.pathname.match(/^\/api\/im-identities\/([^/]+)$/)
    if (im && ids) {
      const k = ids.findIndex((x) => x.id === im[1])
      if (k < 0) return json({ error: { code: 'not_found', message: '身份不存在' } }, 404)
      if (method === 'DELETE') { ids.splice(k, 1); return json(null) }
      Object.assign(ids[k], body)
      return json(ids[k])
    }
    if (u.pathname === '/api/im/messages/batch') {
      const st = body.action === 'done' ? 'done' : 'ignored'
      // 按 id 时已过期的也改（IM-07）
      const hit = rows.filter((r) => (r.status === 'pending' || (body.ids && r.status === 'expired'))
        && (body.ids ? body.ids.includes(r.id) : r.conversation_id === body.conversation_id && r.at <= body.before))
      for (const r of hit) Object.assign(r, { status: st, snooze_until: null, read: true, expired_at: null })
      return json({ action: body.action, ids: hit.map((r) => r.id), count: hit.length })
    }
    const m = u.pathname.match(/^\/api\/im\/messages\/([^/]+)(?:\/([a-z]+))?$/)
    if (m) {
      const r = rows.find((x) => x.id === m[1])
      if (!r) return json({ error: { code: 'not_found', message: '消息不存在' } }, 404)
      const a = m[2]
      if (a === 'done' || a === 'ignore') Object.assign(r, { status: a === 'done' ? 'done' : 'ignored', snooze_until: null, read: true, expired_at: null })
      if (a === 'reopen') Object.assign(r, { status: 'pending', snooze_until: null, expired_at: null })
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
    if (u.pathname === '/api/connectors/defs' || u.pathname.startsWith('/api/dictionaries')) return json([])
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

  it('已过期（IM-07）：单独一个状态，不算待处理；行内能标已处理、重新打开，排在已忽略后面', async () => {
    const at = new Date(Date.now() - 8 * 86400_000).toISOString()
    const rows = [msg({ text: '新的' }), msg({ text: '放久了', status: 'expired', expired_at: new Date().toISOString(), at }), msg({ text: '也放久了', status: 'expired', expired_at: at, at })]
    const calls = fakeBackend(rows)
    renderPage()
    expect(await screen.findByText('1 条待处理')).toBeInTheDocument()
    expect(screen.queryByRole('listitem', { name: /放久了/ })).not.toBeInTheDocument()
    const seg = screen.getByRole('group', { name: '状态' })
    expect(within(seg).getAllByRole('button').map((b) => b.textContent)).toEqual(['待处理1', '稍后0', '已处理0', '已忽略0', '已过期2', '全部3'])
    await userEvent.click(within(seg).getByRole('button', { name: /^已过期/ }))
    const row = screen.getByRole('listitem', { name: /：放久了/ })
    expect(within(row).getByText('已过期')).toBeInTheDocument()
    expect(within(row).queryByRole('button', { name: /稍后/ })).not.toBeInTheDocument()
    await userEvent.click(within(row).getByRole('button', { name: '重新打开' }))
    await waitFor(() => expect(screen.getByText('2 条待处理')).toBeInTheDocument())
    await userEvent.click(within(screen.getByRole('listitem', { name: /也放久了/ })).getByRole('button', { name: '已处理' }))
    await waitFor(() => expect(posts(calls)).toEqual(['reopen', 'done']))
    expect(await screen.findByText('这里没有消息')).toBeInTheDocument()
  })

  it('已过期的能勾选，底栏批量忽略（IM-07）', async () => {
    const rows = [msg({ text: '过期一', status: 'expired' }), msg({ text: '过期二', status: 'expired' })]
    const calls = fakeBackend(rows)
    renderPage()
    await screen.findByText('0 条待处理')
    await userEvent.click(within(screen.getByRole('group', { name: '状态' })).getByRole('button', { name: /^已过期/ }))
    await userEvent.click(within(screen.getByRole('listitem', { name: /过期一/ })).getByRole('checkbox'))
    const bar = screen.getByRole('toolbar', { name: '批量处理' })
    await userEvent.click(within(bar).getByRole('button', { name: '全选 2 条' }))
    await userEvent.click(within(bar).getByRole('button', { name: '忽略' }))
    await waitFor(() => expect(calls.find((c) => c.path === '/api/im/messages/batch')?.body).toEqual({ action: 'ignore', ids: [rows[0].id, rows[1].id] }))
    expect(await screen.findByText('已把 2 条标为已忽略')).toBeInTheDocument()
  })

  it('已过期的抽屉：写明何时标的，给标为已处理、重新打开、忽略，没有稍后（IM-07）', async () => {
    const rows = [msg({ text: '放久了', status: 'expired', expired_at: '2026-10-20T01:00:00.000Z' })]
    const calls = fakeBackend(rows)
    renderPage(`/messages?m=${rows[0].id}`)
    const drawer = await screen.findByRole('dialog', { name: '消息详情' })
    expect(within(drawer).getByText('已过期')).toBeInTheDocument()
    expect(within(drawer).getByText(/超期没处理/)).toBeInTheDocument()
    expect(within(drawer).queryByRole('button', { name: /^稍后$/ })).not.toBeInTheDocument()
    expect(within(drawer).getByRole('button', { name: '重新打开' })).toBeInTheDocument()
    expect(within(drawer).getByRole('button', { name: '忽略' })).toBeInTheDocument()
    await userEvent.click(within(drawer).getByRole('button', { name: '标为已处理' }))
    await waitFor(() => expect(posts(calls)).toEqual(['done']))
    expect(await within(drawer).findByText('已处理')).toBeInTheDocument()
    expect(within(drawer).queryByRole('button', { name: '忽略' })).not.toBeInTheDocument()
  })

  it('勾选多条，底栏一次标为已处理（PR-03）', async () => {
    const rows = [msg({ text: '第一条' }), msg({ text: '第二条' }), msg({ text: '第三条' })]
    const calls = fakeBackend(rows)
    renderPage()
    await screen.findByText('3 条待处理')
    await userEvent.click(within(screen.getByRole('listitem', { name: /第一条/ })).getByRole('checkbox'))
    await userEvent.click(within(screen.getByRole('listitem', { name: /第二条/ })).getByRole('checkbox'))
    const bar = screen.getByRole('toolbar', { name: '批量处理' })
    expect(within(bar).getByText('已选 2 条')).toBeInTheDocument()
    await userEvent.click(within(bar).getByRole('button', { name: '标为已处理' }))
    await waitFor(() => expect(screen.getByText('1 条待处理')).toBeInTheDocument())
    expect(calls.find((c) => c.path === '/api/im/messages/batch')?.body).toEqual({ action: 'done', ids: [rows[0].id, rows[1].id] })
    expect(screen.queryByRole('toolbar', { name: '批量处理' })).not.toBeInTheDocument()
    expect(screen.getByText('已把 2 条标为已处理')).toBeInTheDocument()
  })

  it('全选后忽略；勾选不打开抽屉', async () => {
    const rows = [msg({ text: '甲' }), msg({ text: '乙' }), msg({ text: '丙', status: 'done' })]
    const calls = fakeBackend(rows)
    const router = renderPage()
    await screen.findByText('2 条待处理')
    await userEvent.click(within(screen.getByRole('listitem', { name: /甲/ })).getByRole('checkbox'))
    expect(router.state.location.search).toBe('')
    const bar = screen.getByRole('toolbar', { name: '批量处理' })
    await userEvent.click(within(bar).getByRole('button', { name: '全选 2 条' }))
    expect(within(bar).getByText('已选 2 条')).toBeInTheDocument()
    await userEvent.click(within(bar).getByRole('button', { name: '忽略' }))
    expect(await screen.findByText('待处理的消息都清完了')).toBeInTheDocument()
    expect(calls.find((c) => c.path === '/api/im/messages/batch')?.body).toEqual({ action: 'ignore', ids: [rows[0].id, rows[1].id] })
  })

  it('选了会话：这个会话全部标为已处理（PR-03）', async () => {
    const old = new Date(Date.now() - 3600_000).toISOString()
    const rows = [
      msg({ text: '群里一', conversation_id: 'cv_1', at: old }), msg({ text: '群里二', conversation_id: 'cv_1' }),
      msg({ text: '别的群', conversation_id: 'cv_2', conversation: '#ops', conversation_external_id: 'C02' }),
    ]
    const calls = fakeBackend(rows)
    renderPage()
    await screen.findByText('3 条待处理')
    expect(screen.queryByRole('button', { name: '这个会话全部标为已处理' })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '只看某个会话' }))
    await userEvent.click(await screen.findByRole('option', { name: /#product/ }))
    expect(await screen.findByText('「#product」还有 2 条待处理')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '这个会话全部标为已处理' }))
    await waitFor(() => expect(calls.find((c) => c.path === '/api/im/messages/batch')?.body)
      .toEqual({ action: 'done', conversation_id: 'cv_1', before: rows[1].at }))
    await waitFor(() => expect(screen.queryByRole('button', { name: '这个会话全部标为已处理' })).not.toBeInTheDocument())
    expect(rows[2].status).toBe('pending')
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

  it('Slack 回复框写明以谁的身份发送（IM-06）', async () => {
    const c: Connector = {
      id: 'cn_1', tool: 'slack', name: 'Slack 工作区', account: 'broleez（U07ME）', status: 'connected', error: '', auth_mode: 'token',
      config: { identity: '我本人（用户 Token）' }, secret_hints: {}, direction: 'both', interval: 5, tools: [], tools_at: null, last_tested_at: null,
      last_sync_at: null, available: true, created_at: '', updated_at: '',
    }
    fakeBackend([msg({ connector_id: 'cn_1' })], { connectors: [c] })
    renderPage()
    await userEvent.click(await screen.findByRole('listitem', { name: /权限点/ }))
    expect(await screen.findByText('以 broleez 身份发送')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '发送' })).toHaveAttribute('title', '以 broleez 身份发送')
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

  it('渠道配置在本页打开 IM 渠道的抽屉，记在地址里（IM-01b）', async () => {
    fakeBackend([msg()])
    const router = renderPage()
    await userEvent.click(await screen.findByRole('button', { name: '渠道配置' }))
    expect(await screen.findByText('还没接入 IM 渠道')).toBeInTheDocument()
    expect(router.state.location.search).toBe('?channels=1')
    await userEvent.click(screen.getByRole('button', { name: '在设置里管理全部连接器' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/settings/connectors'))
  })

  it('地址里的消息不存在时说明并只给关闭', async () => {
    fakeBackend([msg()])
    renderPage('/messages?m=msg_gone')
    expect(await screen.findByText('这条消息已不存在')).toBeInTheDocument()
  })
})

describe('认人：关联到联系人、就地新建、改挂（IM-05）', () => {
  const people = (): FakeContact[] => [
    { id: 'stk_a', name: '陈澈', company: 'Octok', title: '', photo: '' },
    { id: 'stk_b', name: 'Lin Yuan', company: 'XAUE', title: '产品', photo: '' },
    { id: 'stk_c', name: '王五', company: '', title: '', photo: '' },
  ]
  const slack: Connector = {
    id: 'cn_1', tool: 'slack', name: 'Slack 工作区', account: 'pmw-bot (U0BOT)', status: 'connected', error: '', auth_mode: 'token', config: {}, secret_hints: {},
    direction: 'both', interval: 5, tools: [], tools_at: null, last_tested_at: null, last_sync_at: null, available: true, created_at: '', updated_at: '',
  }

  it('从行上「未存联系人」关联已有联系人：名字相近的排前，同一发信人的消息都显示联系人名', async () => {
    const rows = [msg({ text: '第一条', connector_id: 'cn_1' }), msg({ text: '第二条', connector_id: 'cn_1' }), msg({ text: '别人', sender_id: 'U9', sender_name: 'Bob' })]
    const calls = fakeBackend(rows, { contacts: people(), identities: [], connectors: [slack] })
    const router = renderPage()
    const row = await screen.findByRole('listitem', { name: /第一条/ })
    await userEvent.click(within(row).getByRole('button', { name: '未存联系人' }))
    const dlg = await screen.findByRole('alertdialog')
    const opts = await within(dlg).findAllByRole('option')
    expect(opts[0]).toHaveTextContent('Lin Yuan')
    // 搜公司
    await userEvent.type(within(dlg).getByLabelText('搜索联系人'), 'octok')
    expect(within(dlg).getAllByRole('option')).toHaveLength(1)
    await userEvent.clear(within(dlg).getByLabelText('搜索联系人'))
    await userEvent.click(within(dlg).getByRole('option', { name: /Lin Yuan/ }))
    await userEvent.click(within(dlg).getByRole('button', { name: '关联' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
    expect(calls.find((c) => c.method === 'POST' && c.path === '/api/im-identities')?.body)
      .toEqual({ channel: 'slack', external_id: 'U1', display_name: 'Lin Yuan', account: 'pmw-bot (U0BOT)', stakeholder_id: 'stk_b' })
    // 做完打开这条消息的抽屉说结果；两条都认上，别人的不动
    expect(router.state.location.search).toBe(`?m=${rows[0].id}`)
    expect(await screen.findByRole('status')).toHaveTextContent('已关联到 Lin Yuan，他在Slack的消息都会显示为 Lin Yuan')
    await waitFor(() => expect(screen.getAllByRole('button', { name: '未存联系人' })).toHaveLength(1))
    expect(screen.getByRole('button', { name: '查看联系人' })).toBeInTheDocument()
  })

  it('抽屉里就地新建联系人并挂上身份，不离开 IM 页', async () => {
    const rows = [msg({ sender_id: 'U7', sender_name: '赵六' })]
    const calls = fakeBackend(rows, { contacts: people(), identities: [] })
    const router = renderPage(`/messages?m=${rows[0].id}`)
    await userEvent.click(await screen.findByRole('button', { name: '新建联系人' }))
    const dlg = await screen.findByRole('alertdialog')
    expect(within(dlg).getByLabelText(/姓名/)).toHaveValue('赵六')
    expect(within(dlg).getByLabelText('分组')).toHaveValue('其他')
    await userEvent.type(within(dlg).getByLabelText('公司'), 'Octok')
    await userEvent.click(within(dlg).getByRole('button', { name: '创建并关联' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
    expect(calls.find((c) => c.method === 'POST' && c.path === '/api/stakeholders')?.body).toEqual({ name: '赵六', company: 'Octok', group: '其他' })
    const made = calls.find((c) => c.method === 'POST' && c.path === '/api/im-identities')?.body
    expect(made).toMatchObject({ channel: 'slack', external_id: 'U7', display_name: '赵六' })
    expect(router.state.location.pathname).toBe('/messages')
    expect(await screen.findByRole('status')).toHaveTextContent('已新建联系人 赵六')
    expect(await screen.findByRole('button', { name: '查看联系人' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '去联系人页补全' }))
    await waitFor(() => expect(router.state.location.pathname + router.state.location.search).toBe(`/contacts?c=${made?.stakeholder_id}`))
  })

  it('编号已挂在别人身上（409）：原样显示后端原因，给「去看这个人」', async () => {
    const rows = [msg()]
    // 列表里还没认上（比如别处刚挂上），身份表里已经有了
    fakeBackend(rows, { contacts: people(), identities: [], unseen: [identity({ id: 'idn_x', stakeholder_id: 'stk_a', external_id: 'U1' })] })
    renderPage(`/messages?m=${rows[0].id}`)
    await userEvent.click(await screen.findByRole('button', { name: '关联到联系人' }))
    const dlg = await screen.findByRole('alertdialog')
    await userEvent.click(within(dlg).getByRole('option', { name: /王五/ }))
    await userEvent.click(within(dlg).getByRole('button', { name: '关联' }))
    expect(await within(dlg).findByText('没改成：这个编号已经是 陈澈 的')).toBeInTheDocument()
    expect(screen.getByRole('alertdialog')).toBeInTheDocument()
    await userEvent.click(await within(dlg).findByRole('button', { name: '去看这个人' }))
    await waitFor(() => expect(screen.getByText('联系人页')).toBeInTheDocument())
  })

  it('新建时撞名：联系人没建成，说后端原因', async () => {
    const rows = [msg({ sender_name: '陈澈', sender_id: 'U3' })]
    fakeBackend(rows, { contacts: people(), identities: [] })
    renderPage(`/messages?m=${rows[0].id}`)
    await userEvent.click(await screen.findByRole('button', { name: '新建联系人' }))
    const dlg = await screen.findByRole('alertdialog')
    await userEvent.click(within(dlg).getByRole('button', { name: '创建并关联' }))
    expect(await within(dlg).findByText('没改成：已经有叫「陈澈」的联系人了')).toBeInTheDocument()
    await userEvent.click(within(dlg).getByRole('button', { name: /关联到已有联系人/ }))
    expect(within(dlg).getAllByRole('option')[0]).toHaveTextContent('陈澈')
  })

  it('认错人：改挂到别人', async () => {
    const rows = [msg()]
    const ids = [identity({ id: 'idn_1', stakeholder_id: 'stk_a', external_id: 'U1' })]
    const calls = fakeBackend(rows, { contacts: people(), identities: ids })
    renderPage(`/messages?m=${rows[0].id}`)
    await userEvent.click(await screen.findByRole('button', { name: '不是这个人' }))
    const dlg = await screen.findByRole('alertdialog')
    expect(within(dlg).getByText('不是 陈澈？')).toBeInTheDocument()
    // 现在挂着的人不在候选里
    expect(within(dlg).queryByRole('option', { name: /陈澈/ })).not.toBeInTheDocument()
    await userEvent.click(within(dlg).getByRole('option', { name: /Lin Yuan/ }))
    await userEvent.click(within(dlg).getByRole('button', { name: '改挂' }))
    await waitFor(() => expect(calls.find((c) => c.method === 'PATCH')).toEqual({ method: 'PATCH', path: '/api/im-identities/idn_1', body: { stakeholder_id: 'stk_b' } }))
    expect(await screen.findByRole('status')).toHaveTextContent('已改挂到 Lin Yuan')
    await waitFor(() => expect(screen.getAllByText('Lin Yuan').length).toBeGreaterThan(0))
  })

  it('认错人：解除关联要先确认，只删身份', async () => {
    const rows = [msg()]
    const ids = [identity({ id: 'idn_1', stakeholder_id: 'stk_a', external_id: 'U1' })]
    const calls = fakeBackend(rows, { contacts: people(), identities: ids })
    renderPage(`/messages?m=${rows[0].id}`)
    await userEvent.click(await screen.findByRole('button', { name: '不是这个人' }))
    await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: '谁都不是，解除关联' }))
    const dlg = screen.getByRole('alertdialog')
    expect(within(dlg).getByText('解除关联？')).toBeInTheDocument()
    expect(within(dlg).getByText('陈澈 的联系人资料不动')).toBeInTheDocument()
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
    await userEvent.click(within(dlg).getByRole('button', { name: '解除关联' }))
    await waitFor(() => expect(calls.find((c) => c.method === 'DELETE')?.path).toBe('/api/im-identities/idn_1'))
    expect(calls.some((c) => c.path.startsWith('/api/stakeholders/'))).toBe(false)
    expect(await screen.findByRole('button', { name: '关联到联系人' })).toBeInTheDocument()
  })
})
