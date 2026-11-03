import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ImConversationSummary } from '../../core/data'
import { GroupAdminDrawer } from './GroupAdmin'

const conv = (p: Partial<ImConversationSummary> & { conversation_id: string }): ImConversationSummary => ({
  channel: 'slack', kind: 'group', name: '', external_id: 'C0', participants: [], total: 3, pending: 1, unread: 0, last_at: '2026-03-01T00:00:00Z',
  project_id: null, project_ref: '', project_name: '', connector_id: 'cn_sl', sent: 0, last_sent_at: null, ...p,
})

const SUMMARY = [
  conv({ conversation_id: 'cv_octok', name: '#ai-octok-platform', participants: ['林原', '周舟'], total: 31, pending: 4, sent: 2, last_sent_at: '2026-03-02T00:00:00Z' }),
  conv({ conversation_id: 'cv_mix', name: '#octok-xaue-credit-card', total: 11, pending: 0 }),
  conv({ conversation_id: 'cv_ns', name: '#fde-bi-ns-support', total: 19, project_id: 'obj_ns', project_ref: 'PRJ-0010', project_name: 'NS 系统' }),
  conv({ conversation_id: 'cv_dm', kind: 'direct', participants: ['阿青'], total: 2 }),
  conv({ conversation_id: 'cv_empty', name: '#empty', total: 0, pending: 0, last_at: null, project_id: 'obj_xaue', project_name: 'XAUE' }),
]
const PROJECTS = [
  { id: 'obj_octok', type_id: 'project', ref: 'PRJ-0009', title: 'Octok' },
  { id: 'obj_xaue', type_id: 'project', ref: 'PRJ-0008', title: 'XAUE' },
  { id: 'obj_ns', type_id: 'project', ref: 'PRJ-0010', title: 'NS 系统' },
]

type Call = { method: string; path: string; body?: unknown }

function backend(put: (body: { items: { conversation_id: string; project_id: string | null }[] }) => Response) {
  const calls: Call[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://x')
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ method, path: url.pathname, body })
    const list = (data: unknown[]) => new Response(JSON.stringify({ data, meta: { total: data.length } }), { status: 200 })
    if (method === 'PUT') return put(body)
    if (url.pathname === '/api/im/conversations/summary') return list(SUMMARY)
    if (url.pathname === '/api/objects') return list(PROJECTS)
    return list([])
  }))
  return calls
}

const ok = (updated: { conversation_id: string; project_id: string | null }[], failed: unknown[] = []) =>
  new Response(JSON.stringify({ data: { updated: updated.map((u) => ({ ...u, project_ref: '', project_name: '', updated_at: '' })), failed } }), { status: 200 })

function renderIt(onOpen = vi.fn(), onSend = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={qc}><GroupAdminDrawer onClose={() => {}} onOpenConversation={onOpen} onSend={onSend} /></QueryClientProvider>)
  return onOpen
}

const puts = (calls: Call[]) => calls.filter((c) => c.method === 'PUT')

afterEach(() => { vi.unstubAllGlobals() })

describe('群组管理抽屉', () => {
  it('列出群和私聊：名字、消息数、待处理、默认归属；私聊显示对方', async () => {
    backend(() => ok([]))
    renderIt()
    const row = await screen.findByRole('listitem', { name: '#ai-octok-platform' })
    expect(within(row).getByText('31')).toBeTruthy()
    expect(within(row).getByText('4')).toBeTruthy()
    expect(within(row).getByText('林原、周舟')).toBeTruthy()
    expect(screen.getByRole('listitem', { name: '阿青' })).toBeTruthy()
    expect(within(screen.getByRole('listitem', { name: '#fde-bi-ns-support' })).getByRole('button', { name: '「#fde-bi-ns-support」默认归属的项目' }).textContent).toContain('NS 系统')
  })

  it('没设归属的筛选和搜索', async () => {
    backend(() => ok([]))
    renderIt()
    await screen.findByRole('listitem', { name: '#ai-octok-platform' })
    await userEvent.click(screen.getByRole('button', { name: /没设归属的/ }))
    expect(screen.queryByRole('listitem', { name: '#fde-bi-ns-support' })).toBeNull()
    expect(screen.getAllByRole('listitem')).toHaveLength(3)
    await userEvent.type(screen.getByRole('textbox', { name: '搜索会话' }), '阿青')
    expect(screen.getAllByRole('listitem').map((x) => x.getAttribute('aria-label'))).toEqual(['阿青'])
  })

  it('按群名建议：单个采纳；全部采纳只带只有一个候选的', async () => {
    const calls = backend((b) => ok(b.items))
    renderIt()
    const row = await screen.findByRole('listitem', { name: '#ai-octok-platform' })
    // 两个候选的那行列出两个，要人挑
    const mix = screen.getByRole('listitem', { name: '#octok-xaue-credit-card' })
    expect(within(mix).getByText('可能是')).toBeTruthy()
    expect(within(mix).getByRole('button', { name: '采纳建议：Octok' })).toBeTruthy()
    expect(within(mix).getByRole('button', { name: '采纳建议：XAUE' })).toBeTruthy()
    await userEvent.click(within(row).getByRole('button', { name: '采纳建议：Octok' }))
    expect(await screen.findByText('已设为「Octok」：1 个会话')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: '全部采纳 1 个' }))
    expect(puts(calls).map((c) => c.body)).toEqual([
      { items: [{ conversation_id: 'cv_octok', project_id: 'obj_octok' }] },
      { items: [{ conversation_id: 'cv_octok', project_id: 'obj_octok' }] },
    ])
    expect(puts(calls).every((c) => c.path === '/api/im/conversation-projects')).toBe(true)
  })

  it('勾选后批量设、批量清除；有没设成的写出原因', async () => {
    const calls = backend((b) => ok(b.items.slice(1), [{ conversation_id: b.items[0].conversation_id, project_id: b.items[0].project_id, code: 'not_found', message: '会话不存在' }]))
    renderIt()
    await screen.findByRole('listitem', { name: '#ai-octok-platform' })
    await userEvent.click(screen.getByRole('checkbox', { name: '选中 #ai-octok-platform' }))
    await userEvent.click(screen.getByRole('checkbox', { name: '选中 阿青' }))
    const bar = screen.getByRole('toolbar', { name: '批量设默认归属' })
    expect(within(bar).getByText('已选 2 个')).toBeTruthy()
    expect((within(bar).getByRole('button', { name: '清除归属' }) as HTMLButtonElement).disabled).toBe(true)
    expect((within(bar).getByRole('button', { name: '设为默认归属' }) as HTMLButtonElement).disabled).toBe(true)
    await userEvent.click(within(bar).getByRole('button', { name: '批量设为哪个项目' }))
    await userEvent.click(await screen.findByRole('option', { name: /XAUE/ }))
    await userEvent.click(within(bar).getByRole('button', { name: '设为默认归属' }))
    expect(puts(calls)[0].body).toEqual({ items: [{ conversation_id: 'cv_octok', project_id: 'obj_xaue' }, { conversation_id: 'cv_dm', project_id: 'obj_xaue' }] })
    expect((await screen.findByRole('alert')).textContent).toBe('已设为「XAUE」：1 个会话；1 个没设成：#ai-octok-platform：会话不存在')
    // 有没设成的，勾选留着，方便再来一次
    expect(screen.getByRole('toolbar', { name: '批量设默认归属' })).toBeTruthy()
  })

  it('全选当前筛出来的；整批被拒时写原因', async () => {
    const calls = backend(() => new Response(JSON.stringify({ error: { code: 'validation', message: 'at most 200 conversations at a time' } }), { status: 400 }))
    renderIt()
    await screen.findByRole('listitem', { name: '#ai-octok-platform' })
    await userEvent.click(screen.getByRole('checkbox', { name: '全选当前 5 个会话' }))
    const bar = screen.getByRole('toolbar', { name: '批量设默认归属' })
    expect(within(bar).getByText('已选 5 个')).toBeTruthy()
    await userEvent.click(within(bar).getByRole('button', { name: '清除归属' }))
    expect(puts(calls)[0].body).toEqual({ items: SUMMARY.map((s) => ({ conversation_id: s.conversation_id, project_id: null })) })
    expect((await screen.findByRole('alert')).textContent).toBe('没清除归属：at most 200 conversations at a time')
  })

  it('行上「发消息」带上会话；没收过消息的不能发；发过的写已发 N 条', async () => {
    backend(() => ok([]))
    const onSend = vi.fn()
    renderIt(vi.fn(), onSend)
    const row = await screen.findByRole('listitem', { name: '#ai-octok-platform' })
    expect(within(row).getByText('已发 2 条')).toBeTruthy()
    await userEvent.click(within(row).getByRole('button', { name: '发消息到 #ai-octok-platform' }))
    expect(onSend).toHaveBeenCalledWith('cv_octok')
    expect((within(screen.getByRole('listitem', { name: '#empty' })).getByRole('button', { name: '发消息到 #empty' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('点名字回到消息列表看这个会话', async () => {
    backend(() => ok([]))
    const onOpen = renderIt()
    await userEvent.click(await screen.findByRole('button', { name: '阿青' }))
    expect(onOpen).toHaveBeenCalledWith('slack', 'cv_dm')
  })
})
