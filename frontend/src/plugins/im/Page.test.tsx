import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Connector, Identity, ImMember, ImMessage, SopFlow, SopInputRun } from '../../core/data'
import Page from './Page'

let seq = 0
function msg(p: Partial<ImMessage> = {}): ImMessage {
  seq += 1
  return {
    id: `msg_${seq}`, channel: 'slack', connector_id: '', external_id: `C:${seq}`, conversation_id: null, conversation_external_id: 'C01',
    conversation_kind: 'group', conversation: '#product', sender_id: 'U1', sender_name: 'Lin Yuan', identity_id: null, stakeholder_id: null,
    contact_name: '', text: '权限点清单看下', attachments: [], relevance: '', status: 'pending', read: true, snooze_until: null,
    at: new Date().toISOString(), received_at: new Date().toISOString(), adapter: 'fake', task_id: null, task_ref: '', replies: [],
    reply_error: '', expired_at: null, project_id: null, project_name: '', project_source: '', sessions: [], split_tasks: [], materials: [], thread: null, reply_count: 0, ...p,
  }
}

function sopRun(p: Partial<SopInputRun> = {}): SopInputRun {
  seq += 1
  const at = new Date().toISOString()
  return {
    id: `spr_${seq}`, flow_id: 'sop_im', flow_name: '消息分流', flow_version: 1, title: '', step_through: false, stopped: false, status: 'running',
    source: 'manual', started_at: at, updated_at: at, focus: 0, steps: [{ key: 'read', name: '读取消息', kind: 'im_get_message', status: 'running' }],
    input_value: '', ...p,
  }
}
const flow = (p: Partial<SopFlow>): SopFlow => ({ id: 'sop_im', name: '消息分流', desc: '', trigger: 'im', fields: [], steps: [], version: 1, created_at: '', updated_at: '', ...p })

const PROJECTS = [{ id: 'obj_p1', type_id: 'project', ref: 'PRJ-0001', title: 'Acme', props: {}, deleted_at: null, workdir: '/work/acme' }]

type Call = { method: string; path: string; body?: Record<string, unknown> }

type FakeContact = { id: string; name: string; company: string; title: string; photo: string; group?: string }

function identity(p: Partial<Identity> & Pick<Identity, 'id' | 'stakeholder_id' | 'external_id'>): Identity {
  return { channel: 'slack', display_name: '', account: '', created_at: '', updated_at: '', ...p }
}

// 内存里的消息表：处理动作按契约改了再返回整条
// 给了 identities 时模拟后端读取时认人（IM-05）：按渠道和编号找身份，填联系人；unseen 是身份表里有、消息列表还没认上的（别处刚挂上）
function fakeBackend(rows: ImMessage[], opts: {
  connectors?: Connector[]; replyFails?: string; contacts?: FakeContact[]; identities?: Identity[]; unseen?: Identity[]
  /** 给了就模拟 SOP 插件在跑：流程和按 message_id 发起的执行 */
  sop?: { flows: SopFlow[]; runs: SopInputRun[]; details?: Record<string, unknown>; failBatch?: number[] }
  /** @ 候选（0.18.0），按会话 id */
  members?: Record<string, ImMember[]>
  /** 转任务时回执没发起的原因（SPEC-messages-2.50）；不给时回执照常发起 */
  replyNote?: string
} = {}) {
  const calls: Call[] = []
  let batchN = 0
  const defaults: Record<string, { conversation_id: string; project_id: string; project_ref: string; project_name: string; updated_at: string }> = {}
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
    const mem = u.pathname.match(/^\/api\/im\/conversations\/([^/]+)\/members$/)
    if (mem) return json(opts.members?.[mem[1]] ?? [], 200, { total: 0 })
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
        const reply = body.reply_on_done === false ? { enabled: false } : opts.replyNote ? { enabled: false, note: opts.replyNote } : { enabled: true, run_id: 'run_r1' }
        return json({ message: r, task: { id: 'obj_t1', ref: 'TSK-0001', title: body.title, status: 'todo', source: 'im' }, reply }, 201)
      }
      return json(r)
    }
    // 交给 Agent（0008）：一个 Agent（建任务需确认），建会话，记到消息上
    if (u.pathname === '/api/agents') return json([{ id: 'ag_1', name: '拆活助手', desc: '把消息拆成任务', color: '#228be6', avatar: { kind: 'text', value: '' },
      provider_id: 'apv_1', model: 'm', instructions: '', skills: [], mcps: [], kbs: [], triggers: [{ kind: 'manual', detail: '' }], enabled: true, created_at: '', updated_at: '' }], 200, { total: 1 })
    if (u.pathname === '/api/agents/ag_1/grants') return json({ agent_id: 'ag_1', grants: { write_tasks: 'confirm' }, effective: { write_tasks: 'confirm' } })
    if (u.pathname === '/api/agent/sessions' && method === 'POST') {
      return json({ id: 'ags_1', title: body.title, object_id: null, provider_id: 'apv_1', model: 'm', workdir: body.workdir ?? '', agent_id: body.agent_id,
        source_ref: body.source_ref, created_at: '', updated_at: '', message_count: 0 }, 201)
    }
    if (u.pathname === '/api/im/sessions' && method === 'POST') {
      const hit = rows.filter((r) => body.message_ids.includes(r.id))
      for (const r of hit) r.sessions = [{ session_id: body.session_id, intent: body.intent, at: new Date().toISOString() }, ...r.sessions]
      return json({ session_id: body.session_id, intent: body.intent, messages: hit })
    }
    // 转项目资料（0009）：项目插件建笔记，IM 插件记出处，记了的消息带上 materials
    const pm = u.pathname.match(/^\/api\/projects\/([^/]+)\/materials$/)
    if (pm && method === 'GET') return json([], 200, { total: 0 })
    if (pm && method === 'POST') {
      return json({ id: `mt_${seq++}`, project_id: pm[1], kind: body.kind, name: body.name, value: body.value, category: '', status: '', tags: body.tags ?? [],
        source: 'manual', created_at: '', updated_at: '' }, 201)
    }
    if (u.pathname === '/api/im/materials' && method === 'POST') {
      const hit = rows.filter((r) => body.message_ids.includes(r.id))
      const p = PROJECTS.find((x) => x.id === body.project_id)
      for (const r of hit) {
        r.materials = [{ material_id: body.material_id, project_id: body.project_id, project_name: p?.title ?? '', kind: body.kind ?? 'messages',
          attachment_id: body.attachment_id ?? '', title: body.title ?? '', count: hit.length, at: new Date().toISOString() }, ...r.materials]
      }
      return json({ source: {}, messages: hit }, 201)
    }
    // 群组默认归属的项目：内存里一张表，设了的消息没单独归项目时按它兜底
    if (u.pathname === '/api/objects') return json(PROJECTS, 200, { total: PROJECTS.length, limit: 200, offset: 0 })
    if (u.pathname === '/api/im/conversation-projects') return json(Object.values(defaults), 200, { total: Object.keys(defaults).length })
    const cp = u.pathname.match(/^\/api\/im\/conversation-projects\/([^/]+)$/)
    if (cp && method === 'PUT') {
      const p = PROJECTS.find((x) => x.id === body.project_id)
      if (p) defaults[cp[1]] = { conversation_id: cp[1], project_id: p.id, project_ref: p.ref, project_name: p.title, updated_at: '' }
      else delete defaults[cp[1]]
      for (const r of rows) {
        if (r.conversation_id !== cp[1] || r.project_source === 'message') continue
        Object.assign(r, p ? { project_id: p.id, project_name: p.title, project_source: 'conversation' } : { project_id: null, project_name: '', project_source: '' })
      }
      return json(defaults[cp[1]] ?? { conversation_id: cp[1], project_id: null, project_ref: '', project_name: '', updated_at: '' })
    }
    if (opts.sop) {
      const sop = opts.sop
      if (u.pathname === '/api/sop/flows') return json(sop.flows)
      if (u.pathname === '/api/sop/runs') return json(sop.runs, 200, { total: sop.runs.length })
      const b = u.pathname.match(/^\/api\/sop\/flows\/([^/]+)\/runs\/batch$/)
      if (b) {
        // failBatch：第几次批量发起整批报错（从 1 数）
        batchN += 1
        if (sop.failBatch?.includes(batchN)) return json({ error: { code: 'internal', message: '模型服务没响应' } }, 500)
        const started = [], skipped = []
        for (const [index, x] of (body.inputs as { message_id: string }[]).entries()) {
          const had = sop.runs.find((r) => r.flow_id === b[1] && r.input_value === x.message_id)
          if (had && body.skip_existing_key) { skipped.push({ index, key: x.message_id, run_id: had.id }); continue }
          const r = sopRun({ flow_id: b[1], input_value: x.message_id })
          sop.runs.unshift(r)
          started.push({ index, key: x.message_id, run_id: r.id })
        }
        return json({ started, skipped, failed: [] })
      }
      const d = u.pathname.match(/^\/api\/sop\/runs\/([^/]+)$/)
      if (d && sop.details?.[d[1]]) return json(sop.details[d[1]])
      const a = u.pathname.match(/^\/api\/sop\/runs\/([^/]+)\/actions$/)
      if (a) {
        const r = sop.runs.find((x) => x.id === a[1])!
        if (body.kind === 'stop') Object.assign(r, { status: 'stopped', stopped: true, ended_at: new Date().toISOString() })
        return json({ ...r, flow: sop.flows[0], input: {}, steps: [] })
      }
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
    { path: '/conversations', element: <div>会话页</div> },
    { path: '/projects/*', element: <div>项目页</div> },
    { path: '/settings/*', element: <div>设置页</div> },
    { path: '/sop/*', element: <div>SOP 页</div> },
  ], { initialEntries: [path] })
  render(<QueryClientProvider client={qc}><RouterProvider router={router} /></QueryClientProvider>)
  return router
}

const posts = (calls: Call[]) => calls.filter((c) => c.method === 'POST').map((c) => c.path.replace(/^\/api\/im\/messages\/[^/]+\//, ''))

afterEach(() => { vi.unstubAllGlobals() })
// 下面这些老用例一条一行地看；合并显示另有一组用例（文件末尾）
beforeEach(() => { localStorage.setItem('im.merge', '0') })
afterEach(() => { localStorage.clear() })

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
    const bar = screen.getByRole('toolbar', { name: '批量处理' })
    await userEvent.click(within(bar).getByRole('checkbox', { name: '全选已加载的消息' }))
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
    // 全选是常驻的，批量条还在；勾选清掉了
    expect(within(screen.getByRole('toolbar', { name: '批量处理' })).queryByText(/^已选/)).toBeNull()
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
    const all = within(bar).getByRole('checkbox', { name: '全选已加载的消息' })
    expect(all).toHaveProperty('indeterminate', true)
    await userEvent.click(all)
    expect(within(bar).getByText('已选 2 条')).toBeInTheDocument()
    expect(within(bar).getByText('/ 已加载 2 条')).toBeInTheDocument()
    expect(all).toBeChecked()
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

  it('选了渠道：按群组分标签，带待处理数；选中群能设默认归属的项目', async () => {
    const rows = [
      msg({ text: '群里一', conversation_id: 'cv_1' }), msg({ text: '群里二', conversation_id: 'cv_1', status: 'done' }),
      msg({ text: '别的群', conversation_id: 'cv_2', conversation: '#ops', conversation_external_id: 'C02' }),
      msg({ text: '私聊一句', conversation_id: 'cv_3', conversation: '', conversation_kind: 'direct', conversation_external_id: 'D01', sender_id: 'U9', sender_name: '阿明' }),
      msg({ text: 'TG 的', channel: 'telegram', conversation_id: 'cv_4', conversation: '运营群', conversation_external_id: 'T01' }),
    ]
    const calls = fakeBackend(rows)
    renderPage()
    await screen.findByText('4 条待处理')
    // 没选渠道时没有群组标签，用「只看某个会话」
    expect(screen.queryByRole('tablist', { name: '群组' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '只看某个会话' })).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /Slack/ }))
    const tabs = await screen.findByRole('tablist', { name: '群组' })
    // 全部 3、私聊合一个紧跟其后、按条数排的两个群；下拉让位给标签
    expect(within(tabs).getAllByRole('tab').map((t) => t.textContent)).toEqual(['全部3', '私聊1', '#product1', '#ops1'])
    expect(screen.queryByRole('button', { name: '只看某个会话' })).not.toBeInTheDocument()

    await userEvent.click(within(tabs).getByRole('tab', { name: /私聊/ }))
    expect(await screen.findByText('私聊一句')).toBeInTheDocument()
    expect(screen.queryByText('群里一')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '群组默认归属的项目' })).not.toBeInTheDocument()

    await userEvent.click(within(tabs).getByRole('tab', { name: /#product/ }))
    expect(await screen.findByText('群里一')).toBeInTheDocument()
    expect(screen.queryByText('别的群')).not.toBeInTheDocument()
    await userEvent.click(await screen.findByRole('button', { name: '群组默认归属的项目' }))
    await userEvent.click(await screen.findByRole('option', { name: /Acme/ }))
    await waitFor(() => expect(calls.find((c) => c.method === 'PUT')).toEqual({ method: 'PUT', path: '/api/im/conversation-projects/cv_1', body: { project_id: 'obj_p1' } }))
    await waitFor(() => expect(screen.getByRole('button', { name: '群组默认归属的项目' })).toHaveTextContent('Acme'))
    expect(rows[0].project_source).toBe('conversation')
  })

  it('批量分诊：勾选的各发起一次，已跑过的跳过；处理队列能看、能全部终止；行上标分诊状态', async () => {
    const ago = (h: number) => new Date(Date.now() - h * 3600_000).toISOString()
    const rows = [msg({ text: '第一条', at: ago(1) }), msg({ text: '第二条', at: ago(2) }), msg({ text: '第三条', at: ago(3) })]
    const sop = {
      flows: [flow({}), flow({ id: 'sop_manual', name: '消息分诊', trigger: 'manual', fields: [{ key: 'message_id', label: '消息', type: 'text' } as SopFlow['fields'][number]] }),
        flow({ id: 'sop_other', name: '无关', trigger: 'manual' })],
      runs: [sopRun({ input_value: rows[0].id, status: 'done', ended_at: new Date().toISOString() })],
    }
    const calls = fakeBackend(rows, { sop })
    renderPage()
    await screen.findByText('3 条待处理')
    expect(await screen.findByRole('button', { name: '已分诊' })).toBeInTheDocument()

    // 勾两条（其中一条已跑过）
    const boxes = screen.getAllByRole('checkbox', { name: /选中/ })
    await userEvent.click(boxes[0])
    await userEvent.click(boxes[1])
    await userEvent.click(within(screen.getByRole('toolbar', { name: '批量处理' })).getByRole('button', { name: '批量分诊' }))
    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByRole('combobox', { name: '分诊流程' })).toHaveValue('sop_im')
    expect(within(dialog).getAllByRole('option').map((o) => o.textContent)).toEqual(['消息分流（来消息自动跑）', '消息分诊'])
    expect(within(dialog).getByText('其中 1 条已经用这个流程跑过，会跳过')).toBeInTheDocument()
    await userEvent.click(within(dialog).getByRole('button', { name: '发起 1 次' }))
    await waitFor(() => expect(calls.find((c) => c.path === '/api/sop/flows/sop_im/runs/batch')).toBeTruthy())
    const sent = calls.find((c) => c.path === '/api/sop/flows/sop_im/runs/batch')!.body!
    expect(sent.skip_existing_key).toBe('message_id')
    expect((sent.inputs as { message_id: string }[]).map((x) => x.message_id).sort()).toEqual([rows[0].id, rows[1].id].sort())
    expect(await screen.findByText('分诊发起 1 条，跳过 1 条已跑过的')).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: '分诊中' })).toBeInTheDocument()

    // 处理队列：进行中 1 条，全部终止要二次确认
    await userEvent.click(screen.getByRole('button', { name: '处理队列' }))
    const q = await screen.findByRole('list', { name: '进行中' })
    expect(within(q).getByText('第二条')).toBeInTheDocument()
    expect(within(q).getByText('读取消息 · 执行中')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '全部终止' }))
    await userEvent.click(await screen.findByRole('button', { name: '终止 1 条' }))
    await waitFor(() => expect(calls.some((c) => c.path.endsWith('/actions') && c.body?.kind === 'stop')).toBe(true))
    expect(await screen.findByText('没有进行中的分诊')).toBeInTheDocument()
  })

  it('常驻全选只选已加载的：没加载的提示，加载更多后再全选包含更多；再点取消；批量标已处理不截断（TSK-0492）', async () => {
    const rows = Array.from({ length: 60 }, (_, i) => msg({ text: `第 ${i} 条`, sender_id: `U${i}`, sender_name: `人${i}`, at: new Date(Date.now() - i * 60_000).toISOString() }))
    const calls = fakeBackend(rows)
    renderPage()
    await screen.findByText('60 条待处理')
    const bar = screen.getByRole('toolbar', { name: '批量处理' })
    const all = within(bar).getByRole('checkbox', { name: '全选已加载的消息' })
    expect(within(bar).getByText('已加载 50 条')).toBeInTheDocument()
    expect(within(bar).getByText('还有未加载的，加载更多后再全选可包含更多')).toBeInTheDocument()
    await userEvent.click(all)
    expect(within(bar).getByText('已选 50 条')).toBeInTheDocument()
    expect(all).toBeChecked()
    await userEvent.click(screen.getByRole('button', { name: /加载更多/ }))
    expect(within(bar).getByText('/ 已加载 60 条')).toBeInTheDocument()
    expect(within(bar).queryByText(/还有未加载的/)).toBeNull()
    expect(all).not.toBeChecked()
    expect(all).toHaveProperty('indeterminate', true)
    await userEvent.click(all)
    expect(within(bar).getByText('已选 60 条')).toBeInTheDocument()
    await userEvent.click(all)
    expect(within(bar).queryByText(/^已选/)).toBeNull()
    await userEvent.click(all)
    await userEvent.click(within(bar).getByRole('button', { name: '标为已处理' }))
    await waitFor(() => expect(calls.filter((c) => c.path === '/api/im/messages/batch')).toHaveLength(1))
    expect((calls.find((c) => c.path === '/api/im/messages/batch')!.body!.ids as string[])).toHaveLength(60)
    expect(await screen.findByText('已把 60 条标为已处理')).toBeInTheDocument()
  })

  it('批量分诊 450 条：按 200 一批分 3 批依次发起，显示进度和汇总；某批失败不影响其余批，失败的能重试（TSK-0492）', async () => {
    const rows = Array.from({ length: 450 }, (_, i) => msg({ text: `消息 ${i}`, sender_id: `U${i}`, sender_name: `人${i}`, at: new Date(Date.now() - i * 60_000).toISOString() }))
    const sop = { flows: [flow({})], runs: [sopRun({ input_value: rows[5].id, status: 'done', ended_at: new Date().toISOString() })], failBatch: [2] }
    const calls = fakeBackend(rows, { sop })
    renderPage()
    await screen.findByText('450 条待处理')
    await userEvent.click(within(screen.getByRole('toolbar', { name: '批量处理' })).getByRole('button', { name: '批量分诊' }))
    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText(/按每批 200 条分 3 批依次发起/)).toBeInTheDocument()
    await userEvent.click(within(dialog).getByRole('button', { name: '发起 449 次，分 3 批' }))
    expect(await within(dialog).findByText('3 批都发完了')).toBeInTheDocument()
    const batches = () => calls.filter((c) => c.path === '/api/sop/flows/sop_im/runs/batch')
    expect(batches().map((c) => (c.body!.inputs as unknown[]).length)).toEqual([200, 200, 50])
    expect(batches().every((c) => c.body!.skip_existing_key === 'message_id')).toBe(true)
    // 第 2 批整批失败：第 1、3 批照常发起（第 1 批里一条已跑过的跳过）
    expect(within(dialog).getByText('已发起').querySelector('b')).toHaveTextContent('249')
    expect(within(dialog).getByText('失败').querySelector('b')).toHaveTextContent('200')
    expect(within(dialog).getByRole('progressbar', { name: '分批进度' })).toHaveAttribute('aria-valuenow', '3')
    expect(within(dialog).getByRole('list', { name: '失败原因' })).toHaveTextContent('200 条：模型服务没响应')
    await userEvent.click(within(dialog).getByRole('button', { name: '重试失败的 200 条' }))
    expect(await within(dialog).findByText('补发的 1 批都发完了')).toBeInTheDocument()
    expect(batches()).toHaveLength(4)
    expect((batches()[3].body!.inputs as { message_id: string }[]).map((x) => x.message_id)).toEqual(rows.slice(200, 400).map((m) => m.id))
    expect(within(dialog).queryByRole('list', { name: '失败原因' })).toBeNull()
    await userEvent.click(within(dialog).getByRole('button', { name: '完成' }))
    expect(await screen.findByText('分诊发起 449 条，跳过 1 条已跑过的')).toBeInTheDocument()
  })

  it('分诊建议：点「已分诊」打开抽屉看建议、能进 SOP 运行页；没分诊过的在抽屉里单独发起', async () => {
    const ago = (h: number) => new Date(Date.now() - h * 3600_000).toISOString()
    const rows = [msg({ text: '要报价', at: ago(1) }), msg({ text: '没分诊的', at: ago(2) })]
    const run = sopRun({ input_value: rows[0].id, status: 'done', flow_name: '消息分诊', ended_at: ago(0.5) })
    const steps = [
      { key: 'judge', name: '要不要我处理', kind: 'classifier', after: [], cases: [{ key: 'handle', label: '需要我处理' }, { key: 'ignore', label: '忽略' }] },
      { key: 'write', name: '写处理建议', kind: 'ai', after: ['judge'], config: { output: 'advice' } },
    ]
    const sop = {
      flows: [flow({})],
      runs: [run],
      details: {
        [run.id]: {
          ...run, flow: { ...flow({}), steps }, input: {},
          steps: [
            { key: 'judge', status: 'done', route: 'handle', route_reason: '模型判断属于「需要我处理」', attempts: 1, log: [] },
            { key: 'write', status: 'done', output: { advice: '对方要正式报价，今天回复' }, attempts: 1, log: [] },
          ],
        },
      },
    }
    const calls = fakeBackend(rows, { sop })
    const router = renderPage()
    await userEvent.click(await screen.findByRole('button', { name: '已分诊' }))
    const drawer = await screen.findByRole('dialog', { name: '消息详情' })
    const sec = within(drawer).getByRole('region', { name: '分诊建议' })
    expect(await within(sec).findByLabelText('处理建议')).toHaveTextContent('对方要正式报价，今天回复')
    expect(within(sec).getByText('要处理')).toBeInTheDocument()
    expect(router.state.location.search).toContain(`m=${rows[0].id}`)
    await userEvent.click(within(sec).getByRole('button', { name: '查看执行' }))
    await waitFor(() => expect(router.state.location.pathname).toBe(`/sop/runs/${run.id}`))
    expect((router.state.location.state as { back: string }).back).toBe(`/messages?m=${rows[0].id}`)

    // 没分诊过的：抽屉里「发起分诊」只带这一条
    await act(() => router.navigate(`/messages?m=${rows[1].id}`))
    const d2 = await screen.findByRole('dialog', { name: '消息详情' })
    await userEvent.click(within(within(d2).getByRole('region', { name: '分诊建议' })).getByRole('button', { name: '发起分诊' }))
    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText(/给这条消息各发起一次流程/)).toBeInTheDocument()
    await userEvent.click(within(dialog).getByRole('button', { name: '发起 1 次' }))
    await waitFor(() => expect(calls.find((c) => c.path === '/api/sop/flows/sop_im/runs/batch')?.body?.inputs).toEqual([{ message_id: rows[1].id }]))
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
    // 群聊回复默认 @ 对方（0.18.0）：正文开头写「@名字」，mentions 带上发信人编号
    expect(calls.find((c) => c.path.endsWith('/reply'))?.body).toEqual({ text: '@Lin Yuan 收到', done: true, mentions: [{ external_id: 'U1', name: 'Lin Yuan' }] })
    await waitFor(() => expect(screen.getByLabelText('回复内容')).toHaveValue(''))
    // 工作台里显示自己发出的仍是「@名字」
    expect(await screen.findByText('@Lin Yuan', { selector: '.im-bubble-out .im-mention' })).toBeInTheDocument()
  })

  it('回复时 @ 对方：关掉后不带，记在本机；私聊没有这个开关', async () => {
    const rows = [msg(), msg({ conversation_kind: 'direct', conversation: '', sender_id: 'U3', sender_name: '阿青', text: '私聊一句' })]
    const calls = fakeBackend(rows)
    renderPage()
    await userEvent.click(await screen.findByRole('listitem', { name: /权限点/ }))
    const sw = await screen.findByRole('checkbox', { name: '回复时 @ 对方' })
    expect(sw).toBeChecked()
    await userEvent.click(sw)
    expect(localStorage.getItem('pmw.im.replyMention')).toBe('off')
    await userEvent.type(screen.getByLabelText('回复内容'), '收到')
    await userEvent.click(screen.getByRole('button', { name: '发送' }))
    await waitFor(() => expect(calls.find((c) => c.path.endsWith('/reply'))?.body).toEqual({ text: '收到', done: true }))

    // 私聊：没有开关，不加 @
    localStorage.removeItem('pmw.im.replyMention')
    await userEvent.click(await screen.findByRole('listitem', { name: /私聊一句/ }))
    await screen.findByRole('dialog', { name: '消息详情' })
    expect(screen.queryByRole('checkbox', { name: '回复时 @ 对方' })).toBeNull()
    await userEvent.type(screen.getByLabelText('回复内容'), '好')
    await userEvent.click(screen.getByRole('button', { name: '发送' }))
    await waitFor(() => expect(calls.filter((c) => c.path.endsWith('/reply')).at(-1)?.body).toEqual({ text: '好', done: true }))
  })

  it('输入 @ 弹出候选：联系人在前、能搜、上下键选、回车选中，发送带上 mentions', async () => {
    const rows = [msg({ conversation_id: 'cv_1' })]
    const member = (p: Partial<ImMember>): ImMember => ({ external_id: '', name: '', sender_name: '', identity_id: '', contact_id: '', source: 'conversation', last_at: '', ...p })
    const calls = fakeBackend(rows, { members: { cv_1: [
      member({ external_id: 'U1', name: '林原', sender_name: 'Lin Yuan', identity_id: 'idn_1', contact_id: 'stk_1' }),
      member({ external_id: 'U5', name: '陈晨', identity_id: 'idn_5', contact_id: 'stk_5', source: 'contact' }),
      member({ external_id: 'U7', name: '陈小', sender_name: '陈小' }),
    ] } })
    renderPage()
    await userEvent.click(await screen.findByRole('listitem', { name: /权限点/ }))
    const box = await screen.findByLabelText('回复内容')
    await userEvent.type(box, '@')
    const pop = await screen.findByRole('listbox', { name: '@ 谁' })
    expect(within(pop).getAllByRole('option').map((o) => o.textContent)).toEqual(['林原Lin Yuan发过言', '陈晨联系人', '陈小发过言'])
    await userEvent.type(box, '陈')
    expect(within(pop).getAllByRole('option')).toHaveLength(2)
    await userEvent.keyboard('{ArrowDown}{Enter}')
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(box).toHaveValue('@陈小 ')
    await userEvent.type(box, '看下 @王五')
    await userEvent.click(screen.getByRole('button', { name: '发送' }))
    // 手打、没从候选里选的 @王五 不进 mentions，后端照原样发
    await waitFor(() => expect(calls.find((c) => c.path.endsWith('/reply'))?.body).toEqual({
      text: '@Lin Yuan @陈小 看下 @王五', done: true,
      mentions: [{ external_id: 'U1', name: 'Lin Yuan' }, { external_id: 'U7', name: '陈小' }],
    }))
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
      id: 'cn_1', tool: 'slack', name: 'Slack 工作区', account: 'broleez（U0EXAMPLE）', status: 'connected', error: '', auth_mode: 'token',
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
    await waitFor(() => expect(calls.find((c) => c.path.endsWith('/task'))?.body).toEqual({ title: '导出按钮 在 Safari 下没反应', done: true, reply_on_done: true }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
    await userEvent.click(within(screen.getByRole('group', { name: '状态' })).getByRole('button', { name: /^全部/ }))
    expect(await screen.findByRole('button', { name: '已转任务 TSK-0001' })).toBeInTheDocument()
    // 测试里没有任务模块登记的抽屉：说清楚打不开，不静默
    expect(screen.getByText('任务模块没有加载，打不开任务')).toBeInTheDocument()
  })

  it('转任务时「执行完成后在原消息里回复」默认勾上；取消勾选传 false；回执没发起时顶栏提示原因（SPEC-messages-2.50）', async () => {
    const calls = fakeBackend([msg({ text: '导出按钮坏了' })], { replyNote: 'SOP 编排插件没在运行，执行完成后不会自动回复' })
    renderPage()
    const row = await screen.findByRole('listitem', { name: /导出按钮坏了/ })
    await userEvent.click(within(row).getByRole('button', { name: '转任务' }))
    let dlg = await screen.findByRole('alertdialog')
    expect(within(dlg).getByRole('checkbox', { name: '执行完成后在原消息里回复' })).toBeChecked()
    await userEvent.click(within(dlg).getByRole('button', { name: '创建任务' }))
    await waitFor(() => expect(calls.find((c) => c.path.endsWith('/task'))?.body?.reply_on_done).toBe(true))
    expect(await screen.findByRole('status')).toHaveTextContent('任务建好了，但SOP 编排插件没在运行，执行完成后不会自动回复')

    const calls2 = fakeBackend([msg({ id: 'im_2', text: '另一个问题' })])
    cleanup()
    renderPage()
    const row2 = await screen.findByRole('listitem', { name: /另一个问题/ })
    await userEvent.click(within(row2).getByRole('button', { name: '转任务' }))
    dlg = await screen.findByRole('alertdialog')
    await userEvent.click(within(dlg).getByRole('checkbox', { name: '执行完成后在原消息里回复' }))
    await userEvent.click(within(dlg).getByRole('button', { name: '创建任务' }))
    await waitFor(() => expect(calls2.find((c) => c.path.endsWith('/task'))?.body?.reply_on_done).toBe(false))
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
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
    { id: 'stk_a', name: '陈澈', company: 'Acme', title: '', photo: '' },
    { id: 'stk_b', name: 'Lin Yuan', company: 'Globex', title: '产品', photo: '' },
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
    await userEvent.type(within(dlg).getByLabelText('搜索联系人'), 'acme')
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
    await userEvent.type(within(dlg).getByLabelText('公司'), 'Acme')
    await userEvent.click(within(dlg).getByRole('button', { name: '创建并关联' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
    expect(calls.find((c) => c.method === 'POST' && c.path === '/api/stakeholders')?.body).toEqual({ name: '赵六', company: 'Acme', group: '其他' })
    const made = calls.find((c) => c.method === 'POST' && c.path === '/api/im-identities')?.body
    expect(made).toMatchObject({ channel: 'slack', external_id: 'U7', display_name: '赵六' })
    expect(router.state.location.pathname).toBe('/messages')
    expect(await screen.findByRole('status')).toHaveTextContent('已新建联系人 赵六')
    expect(await screen.findByRole('button', { name: '查看联系人' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '去联系人页补全' }))
    await waitFor(() => expect(router.state.location.pathname + router.state.location.search).toBe(`/contacts?c=${made?.stakeholder_id}`))
  })

  it('合并的一组的抽屉里也能维护联系人：新建后留在这组的抽屉，按钮变成「查看联系人」', async () => {
    localStorage.removeItem('im.merge')
    const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString()
    const rows = [
      msg({ text: '私聊一', conversation: '', conversation_kind: 'direct', conversation_external_id: 'D7', sender_id: 'U7', sender_name: '赵六', relevance: 'dm', at: ago(30) }),
      msg({ text: '私聊二', conversation: '', conversation_kind: 'direct', conversation_external_id: 'D7', sender_id: 'U7', sender_name: '赵六', relevance: 'dm', at: ago(20) }),
    ]
    const calls = fakeBackend(rows, { contacts: people(), identities: [] })
    const router = renderPage()
    await userEvent.click(await screen.findByRole('listitem', { name: /赵六/ }))
    const drawer = await screen.findByRole('dialog', { name: '一组消息' })
    expect(within(drawer).getByRole('button', { name: '关联到联系人' })).toBeInTheDocument()
    await userEvent.click(within(drawer).getByRole('button', { name: '新建联系人' }))
    const dlg = await screen.findByRole('alertdialog')
    expect(within(dlg).getByLabelText(/姓名/)).toHaveValue('赵六')
    await userEvent.click(within(dlg).getByRole('button', { name: '创建并关联' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
    expect(calls.find((c) => c.method === 'POST' && c.path === '/api/im-identities')?.body).toMatchObject({ channel: 'slack', external_id: 'U7' })
    expect(router.state.location.search).toMatch(/^\?g=dm/)
    const again = await screen.findByRole('dialog', { name: '一组消息' })
    expect(within(again).getByRole('status')).toHaveTextContent('已新建联系人 赵六')
    expect(await within(again).findByRole('button', { name: '查看联系人' })).toBeInTheDocument()
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

describe('合并显示、交给 Agent（0008）', () => {
  beforeEach(() => { localStorage.removeItem('im.merge') })
  const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString()
  // 一个私聊三条、群里林原连发两条、机器人刷了三遍同一句（中间夹着别人的话）
  const fixture = () => [
    msg({ text: '私聊一', conversation: '', conversation_kind: 'direct', conversation_external_id: 'D9', sender_id: 'U9', sender_name: '周屿', relevance: 'dm', at: ago(50), project_id: 'obj_p1', project_name: 'Acme' }),
    msg({ text: '私聊二', conversation: '', conversation_kind: 'direct', conversation_external_id: 'D9', sender_id: 'U9', sender_name: '周屿', relevance: 'dm', at: ago(40), read: false }),
    msg({ text: '私聊三', conversation: '', conversation_kind: 'direct', conversation_external_id: 'D9', sender_id: 'U9', sender_name: '周屿', relevance: 'dm', at: ago(30), read: false, attachments: [{ id: 'a1', name: '合同.docx', kind: 'file' }] }),
    msg({ text: '连发一', at: ago(20) }),
    msg({ text: '连发二', at: ago(15) }),
    msg({ text: '构建失败', sender_id: 'B1', sender_name: 'CI Bot', at: ago(12) }),
    msg({ text: '有人插话', sender_id: 'U2', sender_name: '王可', at: ago(11) }),
    msg({ text: '构建失败', sender_id: 'B1', sender_name: 'CI Bot', at: ago(10) }),
    msg({ text: '构建失败', sender_id: 'B1', sender_name: 'CI Bot', at: ago(5) }),
  ]

  it('私聊一行、连发一行、重复一行；关掉合并显示一条一行', async () => {
    fakeBackend(fixture())
    renderPage()
    await screen.findByText('9 条待处理')
    const list = screen.getByRole('list', { name: '消息' })
    expect(within(list).getAllByRole('listitem')).toHaveLength(4)
    const dm = within(list).getByRole('listitem', { name: /周屿/ })
    expect(within(dm).getByText('3 条')).toBeInTheDocument()
    expect(within(dm).getByText('2 条未读')).toBeInTheDocument()
    expect(within(dm).getByText('私聊三')).toBeInTheDocument()
    const burst = within(list).getByRole('listitem', { name: /Lin Yuan/ })
    expect(within(burst).getByText('2 条')).toBeInTheDocument()
    expect(within(burst).getByText('连发一 / 连发二')).toBeInTheDocument()
    expect(within(within(list).getByRole('listitem', { name: /CI Bot/ })).getByText('重复 3 次')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: '合并显示' }))
    expect(within(list).getAllByRole('listitem')).toHaveLength(9)
    expect(localStorage.getItem('im.merge')).toBe('0')
  })

  it('勾一组 = 勾组里全部；组上的已处理按组里全部批量', async () => {
    const rows = fixture()
    const calls = fakeBackend(rows)
    renderPage()
    await screen.findByText('9 条待处理')
    await userEvent.click(within(screen.getByRole('listitem', { name: /CI Bot/ })).getByRole('checkbox'))
    expect(within(screen.getByRole('toolbar', { name: '批量处理' })).getByText('已选 3 条')).toBeInTheDocument()
    await userEvent.click(within(screen.getByRole('listitem', { name: /Lin Yuan/ })).getByRole('button', { name: '已处理' }))
    await waitFor(() => expect(calls.find((c) => c.path === '/api/im/messages/batch')?.body).toEqual({ action: 'done', ids: [rows[4].id, rows[3].id] }))
    await screen.findByText('7 条待处理')
  })

  it('点开一组看整段，能逐条处理，也能全部标为已处理；地址记 ?g=', async () => {
    const rows = fixture()
    const calls = fakeBackend(rows)
    const router = renderPage()
    await screen.findByText('9 条待处理')
    await userEvent.click(screen.getByRole('listitem', { name: /周屿/ }))
    expect(router.state.location.search).toMatch(/^\?g=dm/)
    const drawer = await screen.findByRole('dialog', { name: '一组消息' })
    const items = within(drawer).getAllByRole('listitem')
    expect(items.map((x) => x.textContent)).toEqual([expect.stringContaining('私聊一'), expect.stringContaining('私聊二'), expect.stringContaining('私聊三')])
    // 打开就把没读的标已读
    await waitFor(() => expect(posts(calls).filter((p) => p === 'read')).toHaveLength(2))
    await userEvent.click(within(items[0]).getByRole('button', { name: '忽略' }))
    await waitFor(() => expect(rows[0].status).toBe('ignored'))
    await userEvent.click(within(drawer).getByRole('button', { name: '全部标为已处理' }))
    await waitFor(() => expect(calls.find((c) => c.path === '/api/im/messages/batch')?.body).toEqual({ action: 'done', ids: [rows[1].id, rows[2].id] }))
  })

  it('拆分任务：默认挑 Agent，第一句话带原文、群、项目、附件；建会话带来源和项目目录，记到这组消息上后去会话页', async () => {
    const rows = fixture()
    const calls = fakeBackend(rows)
    const router = renderPage()
    await screen.findByText('9 条待处理')
    const dm = screen.getByRole('listitem', { name: /周屿/ })
    await userEvent.click(within(dm).getByRole('button', { name: /更多/ }))
    await userEvent.click(screen.getByRole('menuitem', { name: '拆分任务…' }))
    const dlg = await screen.findByRole('alertdialog', { name: '拆分任务' })
    await within(dlg).findByText(/拆活助手：它建任务前会先出确认卡片/)
    const prompt = within(dlg).getByRole('textbox', { name: '第一句话' }) as HTMLTextAreaElement
    for (const want of ['3 条消息', '群：私聊', '归属项目：Acme', '附件：合同.docx', '周屿：私聊一', 'create_object', '确认卡片']) expect(prompt.value).toContain(want)
    expect(within(dlg).getByRole('textbox', { name: '工作目录' })).toHaveValue('/work/acme')
    await userEvent.click(within(dlg).getByRole('button', { name: '开始拆分' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/conversations'))
    expect(router.state.location.search).toBe('?s=ags_1')
    const create = calls.find((c) => c.path === '/api/agent/sessions')!.body!
    expect(create).toMatchObject({ agent_id: 'ag_1', workdir: '/work/acme' })
    expect(create.source_ref).toMatchObject({ kind: 'im_message', message_id: rows[2].id, message_ids: [rows[0].id, rows[1].id, rows[2].id], project_id: 'obj_p1' })
    expect(calls.find((c) => c.path === '/api/im/sessions')?.body).toEqual({ session_id: 'ags_1', message_ids: [rows[0].id, rows[1].id, rows[2].id], intent: 'split' })
  })

  it('发起过会话、拆出过任务的消息行上标出来', async () => {
    const at = new Date().toISOString()
    fakeBackend([msg({ text: '单条', sessions: [{ session_id: 'ags_9', intent: 'split', at }], split_tasks: [{ id: 'obj_t1', ref: 'TSK-0001', title: 'a' }, { id: 'obj_t2', ref: 'TSK-0002', title: 'b' }] }),
      msg({ text: '另一个群', conversation: '#ops', conversation_external_id: 'C02', sender_id: 'U3', sessions: [{ session_id: 'ags_8', intent: 'chat', at }] })])
    const router = renderPage()
    await screen.findByText('2 条待处理')
    expect(screen.getByRole('button', { name: '已拆分 2 条任务' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '已发起会话' }))
    expect(router.state.location.search).toBe('?s=ags_8')
  })

  it('转项目资料（0009）：一组拼成对话记录，默认项目和标题，存成笔记、记出处；行上标「已转资料」，再转时提示，能打开已有的', async () => {
    const rows = fixture()
    const calls = fakeBackend(rows)
    const router = renderPage()
    await screen.findByText('9 条待处理')
    const dm = screen.getByRole('listitem', { name: /周屿/ })
    await userEvent.click(within(dm).getByRole('button', { name: /更多/ }))
    await userEvent.click(screen.getByRole('menuitem', { name: '转项目资料…' }))
    const dlg = await screen.findByRole('alertdialog', { name: '转项目资料' })
    expect(within(dlg).getByRole('button', { name: '存到哪个项目' })).toHaveTextContent('Acme')
    const title = within(dlg).getByRole('textbox', { name: '标题' }) as HTMLInputElement
    expect(title.value).toMatch(/^周屿 .+ 的消息$/)
    const body = within(dlg).getByRole('textbox', { name: '正文' }) as HTMLTextAreaElement
    for (const want of ['和 周屿 的私聊 · 3 条消息', '周屿：私聊一', '周屿：私聊三', '附件：合同.docx']) expect(body.value).toContain(want)
    expect(body.value.indexOf('私聊一')).toBeLessThan(body.value.indexOf('私聊三'))
    await userEvent.clear(title)
    await userEvent.type(title, '周屿的合同沟通')
    await userEvent.click(within(dlg).getByRole('button', { name: '存成资料' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog', { name: '转项目资料' })).not.toBeInTheDocument())
    const note = calls.find((c) => c.method === 'POST' && c.path === '/api/projects/obj_p1/materials')!.body!
    expect(note).toMatchObject({ kind: 'note', name: '周屿的合同沟通', tags: ['IM 消息'] })
    expect(String(note.value)).toContain('周屿：私聊二')
    expect(calls.find((c) => c.path === '/api/im/materials')?.body).toMatchObject({ project_id: 'obj_p1', message_ids: [rows[0].id, rows[1].id, rows[2].id], kind: 'messages', title: '周屿的合同沟通' })
    // 没勾附件就不动附件
    expect(calls.some((c) => c.path.includes('/attachments/'))).toBe(false)
    // 「存好后标为已处理」默认勾上：这组还没处理的批量标为已处理，从待处理里移走
    await waitFor(() => expect(calls.find((c) => c.path === '/api/im/messages/batch')?.body).toEqual({ action: 'done', ids: [rows[0].id, rows[1].id, rows[2].id] }))
    await screen.findByText('6 条待处理')
    await userEvent.click(within(screen.getByRole('group', { name: '状态' })).getByRole('button', { name: /^已处理/ }))

    const tag = await within(await screen.findByRole('listitem', { name: /周屿/ })).findByRole('button', { name: '已转资料' })
    // 再转一次：提示转过，能打开已有的
    await userEvent.click(within(screen.getByRole('listitem', { name: /周屿/ })).getByRole('button', { name: /更多/ }))
    await userEvent.click(screen.getByRole('menuitem', { name: '转项目资料…' }))
    const again = await screen.findByRole('alertdialog', { name: '转项目资料' })
    expect(within(again).getByText('这组消息已经转过资料：')).toBeInTheDocument()
    expect(within(again).getByRole('button', { name: '再转一份' })).toBeInTheDocument()
    await userEvent.click(within(again).getByRole('button', { name: '打开已有的' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/projects/obj_p1/materials'))
    expect(router.state.location.search).toMatch(/^\?mt=mt_/)
    expect(tag).toBeTruthy()
  })

  it('转项目资料：连附件一起加，没获取的先获取；正文超过 5000 字不能存', async () => {
    const rows = [msg({ text: '看下合同', project_id: 'obj_p1', project_name: 'Acme', project_source: 'conversation', attachments: [{ id: 'a1', name: '合同.docx', kind: 'file', fetch: 'idle' }] })]
    const calls = fakeBackend(rows)
    renderPage()
    await screen.findByText('1 条待处理')
    await userEvent.click(screen.getByText('看下合同'))
    const drawer = await screen.findByRole('dialog', { name: '消息详情' })
    await userEvent.click(within(drawer).getByRole('button', { name: '转项目资料' }))
    const dlg = await screen.findByRole('alertdialog', { name: '转项目资料' })
    expect((within(dlg).getByRole('textbox', { name: '标题' }) as HTMLInputElement).value).toMatch(/^#product .+ 的消息$/)
    const body = within(dlg).getByRole('textbox', { name: '正文' })
    await userEvent.click(body)
    await userEvent.paste('长'.repeat(5001))
    expect(within(dlg).getByText(/超过 5000 字/)).toBeInTheDocument()
    expect(within(dlg).getByRole('button', { name: '存成资料' })).toBeDisabled()
    await userEvent.click(within(dlg).getByRole('button', { name: '恢复默认' }))
    await userEvent.click(within(dlg).getByRole('checkbox', { name: /连附件一起加入资料/ }))
    expect(within(dlg).getByText(/还没获取，会先获取到本地/)).toBeInTheDocument()
    await userEvent.click(within(dlg).getByRole('button', { name: '存成资料' }))
    // 假后端没有获取接口：附件没加上，笔记照样存，弹窗里说清楚
    expect(await within(dlg).findByText(/附件「合同.docx」没加上/)).toBeInTheDocument()
    expect(within(dlg).getByText(/已经存进项目资料/)).toBeInTheDocument()
    expect(calls.some((c) => c.method === 'POST' && c.path === `/api/im/messages/${rows[0].id}/attachments/a1/fetch`)).toBe(true)
  })
})

describe('消息列回复（0010）', () => {
  beforeEach(() => { localStorage.removeItem('im.merge') })
  const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString()
  const fixture = () => {
    const p = msg({ text: '灰度方案看下', at: ago(60), status: 'done' })
    const th = { parent_external_id: p.external_id, parent_message_id: p.id, parent_sender_name: 'Lin Yuan', parent_text: '灰度方案看下' }
    return [
      p,
      msg({ text: '回复一', sender_id: 'U2', sender_name: '王可', at: ago(40), thread: th }),
      msg({ text: '回复二', sender_id: 'U3', sender_name: '周屿', at: ago(30), thread: th }),
      msg({ text: '回复三', sender_id: 'U2', sender_name: '王可', at: ago(20), thread: th, read: false }),
      msg({ text: '回复四', sender_id: 'U2', sender_name: '王可', at: ago(19), thread: th, read: false }),
      msg({ text: '原消息没收到的回复', sender_id: 'U3', sender_name: '周屿', at: ago(5),
        thread: { parent_external_id: 'C:old', parent_message_id: null, parent_sender_name: '张三', parent_text: '早先的话题' } }),
    ]
  }

  it('列表不列消息列回复，原消息行标「消息列 N 条未读回复」；原消息已处理时变淡；不能勾、全选也不算', async () => {
    const rows = fixture()
    fakeBackend(rows)
    renderPage()
    expect(await screen.findByText('5 条待处理')).toBeInTheDocument()
    const parent = screen.getByRole('listitem', { name: /Lin Yuan：灰度方案看下/ })
    expect(parent).toHaveClass('im-faded')
    expect(within(parent).queryByRole('checkbox')).toBeNull()
    expect(within(parent).getByRole('button', { name: '消息列 2 条未读回复' })).toBeInTheDocument()
    for (const t of ['回复一', '回复二', '回复三', '回复四']) expect(screen.queryByRole('listitem', { name: new RegExp(t) })).toBeNull()
    // 原消息没收到的：普通行，标「消息列回复」和「回复 谁：原消息」
    const orphan = screen.getByRole('listitem', { name: /原消息没收到的回复/ })
    expect(within(orphan).getByText('消息列回复')).toBeInTheDocument()
    expect(within(orphan).getByText('回复 张三：早先的话题')).toBeInTheDocument()
    expect(screen.getAllByRole('checkbox', { name: /^选中/ })).toHaveLength(1)
  })

  it('转任务时附上消息列：默认勾上，正文带整段消息列；取消勾选不带', async () => {
    const p = msg({ text: '灰度方案看下', at: ago(60) })
    const th = { parent_external_id: p.external_id, parent_message_id: p.id, parent_sender_name: 'Lin Yuan', parent_text: '灰度方案看下' }
    const rows = [p,
      msg({ text: '回复一', sender_id: 'U2', sender_name: '王可', at: ago(40), thread: th, status: 'done' }),
      msg({ text: '回复二\n第二行', sender_id: 'U3', sender_name: '周屿', at: ago(30), thread: th, status: 'done' })]
    const calls = fakeBackend(rows)
    renderPage()
    const row = await screen.findByRole('listitem', { name: /Lin Yuan：灰度方案看下/ })
    await userEvent.click(within(row).getByRole('button', { name: '转任务' }))
    const dlg = await screen.findByRole('alertdialog')
    const box = within(dlg).getByRole('checkbox', { name: /附上消息列（2 条）/ })
    expect(box).toBeChecked()
    expect(within(within(dlg).getByRole('list', { name: '附上的消息列' })).getAllByRole('listitem')).toHaveLength(2)
    await userEvent.click(within(dlg).getByRole('button', { name: '创建任务' }))
    await waitFor(() => expect(calls.find((c) => c.path.endsWith('/task'))).toBeTruthy())
    const body = String(calls.find((c) => c.path.endsWith('/task'))?.body?.body ?? '')
    expect(body).toContain('## 消息列（2 条）')
    expect(body).toMatch(/- \*\*王可\*\* .+：回复一/)
    expect(body).toContain('：回复二\n  第二行')
  })

  it('转项目资料带上消息列：默认勾上，回复并进对话记录、出处也算上；只把选中的标为已处理；取消勾选只剩这一条', async () => {
    const p = msg({ text: '灰度方案看下', at: ago(60), project_id: 'obj_p1', project_name: 'Acme' })
    const th = { parent_external_id: p.external_id, parent_message_id: p.id, parent_sender_name: 'Lin Yuan', parent_text: '灰度方案看下' }
    const rows = [p,
      msg({ text: '回复一', sender_id: 'U2', sender_name: '王可', at: ago(40), thread: th, status: 'done' }),
      msg({ text: '回复二', sender_id: 'U3', sender_name: '周屿', at: ago(30), thread: th, status: 'done' })]
    const calls = fakeBackend(rows)
    renderPage()
    const row = await screen.findByRole('listitem', { name: /Lin Yuan：灰度方案看下/ })
    await userEvent.click(within(row).getByRole('button', { name: /更多/ }))
    await userEvent.click(screen.getByRole('menuitem', { name: '转项目资料…' }))
    const dlg = await screen.findByRole('alertdialog', { name: '转项目资料' })
    const box = within(dlg).getByRole('checkbox', { name: /带上消息列（另外 2 条）/ })
    expect(box).toBeChecked()
    const body = within(dlg).getByRole('textbox', { name: '正文' }) as HTMLTextAreaElement
    for (const want of ['3 条消息', 'Lin Yuan：灰度方案看下', '王可：回复一', '周屿：回复二']) expect(body.value).toContain(want)
    await userEvent.click(box)
    expect(body.value).toContain('1 条消息')
    expect(body.value).not.toContain('回复一')
    await userEvent.click(box)
    await userEvent.click(within(dlg).getByRole('button', { name: '存成资料' }))
    await waitFor(() => expect(calls.find((c) => c.path === '/api/im/materials')?.body).toMatchObject({ message_ids: [rows[0].id, rows[1].id, rows[2].id] }))
    await waitFor(() => expect(calls.find((c) => c.path === '/api/im/messages/batch')?.body).toEqual({ action: 'done', ids: [rows[0].id] }))
  })

  it('点小标打开原消息抽屉，按时间列出整个消息列、没读的标已读，能逐条处理；消息列回复的抽屉能回到原消息', async () => {
    const rows = fixture()
    fakeBackend(rows)
    const router = renderPage()
    await screen.findByText('5 条待处理')
    await userEvent.click(screen.getByRole('button', { name: '消息列 2 条未读回复' }))
    await waitFor(() => expect(router.state.location.search).toBe(`?m=${rows[0].id}`))
    const drawer = await screen.findByRole('dialog', { name: '消息详情' })
    const list = within(drawer).getByRole('list', { name: '消息列回复' })
    await waitFor(() => expect(rows[3].read && rows[4].read).toBe(true))
    expect(await screen.findByRole('button', { name: '消息列 4 条回复' })).toBeInTheDocument()
    expect(within(list).getAllByRole('listitem').map((x) => x.textContent)).toEqual([
      expect.stringContaining('回复一'), expect.stringContaining('回复二'), expect.stringContaining('回复三'), expect.stringContaining('回复四')])
    await userEvent.click(within(within(list).getAllByRole('listitem')[1]).getByRole('button', { name: '忽略' }))
    await waitFor(() => expect(rows[2].status).toBe('ignored'))
    // 打开消息列里的一条，再回原消息
    await userEvent.click(within(list).getAllByRole('button', { name: '王可' })[0])
    await waitFor(() => expect(router.state.location.search).toBe(`?m=${rows[1].id}`))
    const d2 = await screen.findByRole('dialog', { name: '消息详情' })
    expect(within(d2).getByText('回复 Lin Yuan：灰度方案看下')).toBeInTheDocument()
    expect(within(d2).getByRole('textbox', { name: '回复内容' })).toHaveAttribute('placeholder', expect.stringContaining('发到同一个消息列'))
    await userEvent.click(within(d2).getByRole('button', { name: '打开原消息' }))
    await waitFor(() => expect(router.state.location.search).toBe(`?m=${rows[0].id}`))
  })
})

