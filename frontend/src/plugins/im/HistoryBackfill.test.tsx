import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ImConversationSummary, ImHistoryBackfillResult, ImMember } from '../../core/data'
import { GroupAdminDrawer } from './GroupAdmin'

// 群组管理「补全消息」和成员「加为联系人」（TSK-0724）

const conv = (p: Partial<ImConversationSummary> & { conversation_id: string }): ImConversationSummary => ({
  channel: 'slack', kind: 'group', name: '', external_id: 'C0', participants: [], total: 3, pending: 1, unread: 0, last_at: '2026-03-01T00:00:00Z',
  project_id: null, project_ref: '', project_name: '', connector_id: 'cn_sl', sent: 0, last_sent_at: null, unresolved_users: [], name_unresolved: false,
  can_refill: true, refill_error: '', can_backfill: true, backfill_note: '', ...p,
})
const SUMMARY = [
  conv({ conversation_id: 'cv_a', name: '#product' }),
  conv({ conversation_id: 'cv_b', name: '#ops' }),
  conv({ conversation_id: 'cv_tg', name: '产品群', channel: 'telegram', can_backfill: false, backfill_note: 'Telegram 的 Bot 只能收到加入之后的新消息，拉不到历史消息' }),
]
const res = (p: Partial<ImHistoryBackfillResult>): ImHistoryBackfillResult => ({
  conversation_id: '', connector_id: 'cn_sl', range: '7d', scanned: 0, threads_checked: 0, added: 0, expired: 0, muted: 0,
  duplicates: 0, bodies_filled: 0, complete: true, limited: false, capped: false, cursor: '', ...p,
})
const member = (p: Partial<ImMember>): ImMember => ({
  external_id: 'U1', name: '', sender_name: '', identity_id: '', contact_id: '', source: 'conversation', last_at: '2026-03-01T00:00:00Z', is_bot: false, is_self: false, ...p,
})
const MEMBERS = [
  member({ external_id: 'U2', name: '周舟', contact_id: 'stk_zhou', identity_id: 'idn_2' }),
  member({ external_id: 'U1', name: 'Lin Yuan', sender_name: 'Lin Yuan' }),
  member({ external_id: 'U3', name: 'Mia', sender_name: 'Mia' }),
  member({ external_id: 'B1', name: 'Google Calendar', sender_name: 'Google Calendar', is_bot: true }),
]

type Call = { method: string; path: string; query: string; body?: unknown }

function backend(fill: (conv: string, query: URLSearchParams) => Response) {
  const calls: Call[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://x')
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ method, path: url.pathname, query: url.search, body })
    const one = (data: unknown, status = 200) => new Response(JSON.stringify({ data }), { status })
    const list = (data: unknown[]) => new Response(JSON.stringify({ data, meta: { total: data.length } }), { status: 200 })
    const m = url.pathname.match(/^\/api\/im\/conversations\/([^/]+)\/backfill$/)
    if (m && method === 'POST') return fill(m[1], url.searchParams)
    if (url.pathname === '/api/im/conversations/summary') return list(SUMMARY)
    if (url.pathname === '/api/im/conversations/cv_a/members') return list(MEMBERS)
    if (url.pathname === '/api/stakeholders' && method === 'POST') return one({ id: `stk_${body.name}`, name: body.name }, 201)
    if (url.pathname === '/api/im-identities' && method === 'POST') return one({ id: `idn_${body.external_id}`, ...body }, 201)
    return list([])
  }))
  return calls
}

function renderIt(onOpenContact = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={qc}><GroupAdminDrawer onClose={() => {}} onOpenConversation={() => {}} onSend={() => {}} onOpenContact={onOpenContact} /></QueryClientProvider>)
  return onOpenContact
}

afterEach(() => { vi.unstubAllGlobals() })

describe('补全消息（TSK-0724）', () => {
  it('行上选范围补全，写结果；没补完时「继续补全」带上 cursor；Telegram 置灰并说明', async () => {
    let n = 0
    const calls = backend((_, q) => {
      n++
      if (n === 1) return new Response(JSON.stringify({ data: res({ range: q.get('range')!, added: 30, expired: 28, duplicates: 20, complete: false, limited: true, cursor: 'cur1' }) }))
      return new Response(JSON.stringify({ data: res({ range: q.get('range')!, added: 5, duplicates: 2 }) }))
    })
    renderIt()
    const row = await screen.findByRole('listitem', { name: '#product' })
    const tg = screen.getByRole('listitem', { name: '产品群' })
    const tgBtn = within(tg).getByRole('button', { name: '补全 产品群 的消息' }) as HTMLButtonElement
    expect(tgBtn.disabled).toBe(true)
    expect(tgBtn.title).toContain('Telegram')

    await userEvent.click(within(row).getByRole('button', { name: '补全 #product 的消息' }))
    await userEvent.click(within(row).getByRole('menuitem', { name: /最近 30 天/ }))
    expect(await within(row).findByText('最近 30 天：已补 30 条（28 条较早的标为已过期），跳过 20 条已有的；渠道限流停下了，剩余的稍后点「继续补全」')).toBeTruthy()
    expect(calls.find((c) => c.path === '/api/im/conversations/cv_a/backfill')?.query).toBe('?range=30d')

    await userEvent.click(within(row).getByRole('button', { name: '补全 #product 的消息' }))
    await userEvent.click(within(row).getByRole('menuitem', { name: /继续补全/ }))
    expect(await within(row).findByText('最近 30 天：已补 5 条，跳过 2 条已有的')).toBeTruthy()
    expect(calls.filter((c) => c.path.endsWith('/backfill')).map((c) => c.query)).toEqual(['?range=30d', '?range=30d&cursor=cur1'])
  })

  it('批量：勾选的逐个补，跳过不支持的，撞上限流就停', async () => {
    const calls = backend((cv) => new Response(JSON.stringify({ data: res({ conversation_id: cv, added: 4, complete: false, limited: true, cursor: 'c' }) })))
    renderIt()
    await screen.findByRole('listitem', { name: '#product' })
    await userEvent.click(screen.getByRole('checkbox', { name: /全选/ }))
    await userEvent.click(screen.getByRole('button', { name: '补全勾选会话的消息' }))
    await userEvent.click(screen.getByRole('menuitem', { name: /最近 7 天/ }))
    expect(await screen.findByText('最近 7 天补全 1 个会话：已补 4 条；1 个没补完，在行上点「继续补全」；渠道限流停下了，还有 1 个会话没补，稍后再点；1 个渠道不支持或还没消息，跳过')).toBeTruthy()
    expect(calls.filter((c) => c.path.endsWith('/backfill')).map((c) => c.path)).toEqual(['/api/im/conversations/cv_a/backfill'])
  })
})

describe('成员加为联系人（TSK-0724）', () => {
  it('已是联系人的点了去联系人页；没认上的能加；全部加为联系人排除机器人、先确认名单', async () => {
    const calls = backend(() => new Response('{}'))
    const open = renderIt()
    const row = await screen.findByRole('listitem', { name: '#product' })
    await userEvent.click(within(row).getByRole('button', { name: /成员/ }))
    const zhou = await screen.findByRole('group', { name: '周舟' })
    await userEvent.click(within(zhou).getByRole('menuitem', { name: '查看联系人 周舟' }))
    expect(open).toHaveBeenCalledWith('stk_zhou')

    await userEvent.click(within(row).getByRole('button', { name: /成员/ }))
    expect(within(await screen.findByRole('group', { name: 'Google Calendar' })).getByText('机器人')).toBeTruthy()
    await userEvent.click(screen.getByRole('menuitem', { name: /全部加为联系人/ }))
    const dialog = await screen.findByRole('alertdialog', { name: '全部加为联系人' })
    const people = within(dialog).getAllByRole('listitem').map((x) => x.getAttribute('aria-label'))
    expect(people).toEqual(['Lin Yuan', 'Mia'])
    // 去掉 Mia，改 Lin 的名字
    await userEvent.click(within(dialog).getByRole('checkbox', { name: '加 Mia' }))
    const name = within(dialog).getByRole('textbox', { name: 'Lin Yuan 的姓名' })
    await userEvent.clear(name)
    await userEvent.type(name, '林原')
    await userEvent.click(within(dialog).getByRole('button', { name: '加为联系人 1 个' }))
    expect(await screen.findByText(/已加为联系人 1 个：林原/)).toBeTruthy()
    const posts = calls.filter((c) => c.method === 'POST')
    expect(posts.map((c) => c.path)).toEqual(['/api/stakeholders', '/api/im-identities'])
    expect(posts[1].body).toMatchObject({ channel: 'slack', external_id: 'U1', stakeholder_id: 'stk_林原' })
  })
})
