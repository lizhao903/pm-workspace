import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SendDialog } from './SendDialog'
import { SentStrip } from './SentStrip'

const SUMMARY = [
  { conversation_id: 'cv_g', channel: 'slack', kind: 'group', name: '#product', external_id: 'C1', connector_id: 'cn_a', participants: ['林原'], total: 3, pending: 0, unread: 0,
    last_at: '2026-03-01T00:00:00Z', project_id: null, project_ref: '', project_name: '', sent: 0, last_sent_at: null, unresolved_users: [], name_unresolved: false, can_refill: true, refill_error: '' },
]
const CONNECTORS = [{ id: 'cn_a', tool: 'slack', name: '公司 Slack', status: 'connected', direction: 'both', account: '林原（U01）', config: { identity: 'user' }, secret_hints: {} }]
const DEFS = [{ tool: 'slack', label: 'Slack', category: 'im', color: '#611f69', fields: [] }]
const CHANNELS = { connector_id: 'cn_a', items: [{ id: 'C9', name: 'ops', kind: 'public', is_member: true, is_archived: false }], complete: true, note: '' }

type Call = { method: string; path: string; body?: unknown }

function backend(send: () => Response, sent: unknown[] = []) {
  const calls: Call[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://x')
    const method = init?.method ?? 'GET'
    calls.push({ method, path: url.pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    const list = (data: unknown[]) => new Response(JSON.stringify({ data, meta: { total: data.length } }), { status: 200 })
    if (method === 'POST' && url.pathname === '/api/im/send') return send()
    if (url.pathname === '/api/im/conversations/summary') return list(SUMMARY)
    if (url.pathname === '/api/connectors') return list(CONNECTORS)
    if (url.pathname === '/api/connectors/defs') return list(DEFS)
    if (url.pathname === '/api/im/connectors/cn_a/conversations') return new Response(JSON.stringify({ data: CHANNELS }), { status: 200 })
    if (url.pathname.endsWith('/sent')) return list(sent)
    if (url.pathname === '/api/im/conversations/cv_g/members') {
      return list([{ external_id: 'U1', name: '林原', sender_name: 'lin', identity_id: 'idn_1', contact_id: 'stk_1', source: 'conversation', last_at: '' },
        { external_id: 'U5', name: '陈晨', sender_name: '', identity_id: 'idn_5', contact_id: 'stk_5', source: 'contact', last_at: '' }])
    }
    return list([])
  }))
  return calls
}

const item = (p: Record<string, unknown> = {}) => ({ id: 'ob_1', conversation_id: 'cv_g', channel: 'slack', connector_id: 'cn_a', text: '周五发版', status: 'sent', error: '',
  external_id: 'C1:1', source: 'manual', run_id: '', created_at: '2026-03-01T00:00:00Z', ...p })

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>)
}

const posts = (calls: Call[]) => calls.filter((c) => c.method === 'POST').map((c) => c.body)

afterEach(() => { vi.unstubAllGlobals() })

describe('发消息弹窗', () => {
  it('选会话（含没收过消息的频道），写明身份，发出去', async () => {
    const calls = backend(() => new Response(JSON.stringify({ data: item({ conversation_id: 'cv_new' }) }), { status: 200 }))
    const onSent = vi.fn()
    wrap(<SendDialog onCancel={() => {}} onSent={onSent} />)
    await userEvent.click(await screen.findByRole('button', { name: '发到哪个会话' }))
    await userEvent.click(await screen.findByRole('option', { name: /#ops/ }))
    await userEvent.type(screen.getByRole('textbox', { name: '内容' }), '上线了')
    expect(screen.getByText(/身份发送|以 Bot/)).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: '发送' }))
    expect(posts(calls)).toEqual([{ connector_id: 'cn_a', conversation_external_id: 'C9', conversation_name: 'ops', text: '上线了' }])
    await vi.waitFor(() => expect(onSent).toHaveBeenCalled())
    expect(onSent.mock.calls[0][1]).toBe('#ops')
  })

  it('从群组管理带上会话：只写内容；没写内容不发；发送失败写原因', async () => {
    const calls = backend(() => new Response(JSON.stringify({ error: { code: 'send_failed', message: '发送失败：channel_not_found' } }), { status: 502 }))
    wrap(<SendDialog conversationId="cv_g" onCancel={() => {}} onSent={() => {}} />)
    expect(await screen.findByText('#product')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: '发送' }))
    expect(screen.getByRole('alert').textContent).toBe('内容还没写')
    await userEvent.type(screen.getByRole('textbox', { name: '内容' }), '周五发版')
    await userEvent.click(screen.getByRole('button', { name: '发送' }))
    expect(posts(calls)).toEqual([{ conversation_id: 'cv_g', connector_id: 'cn_a', text: '周五发版' }])
    expect((await screen.findByRole('alert')).textContent).toContain('channel_not_found')
    expect(screen.getByRole('alert').textContent).toContain('能在发出的记录里重发')
  })

  it('内容框同回复框一样能 @（0.18.0）：候选是所选会话的人，发送带上 mentions；不默认 @ 谁', async () => {
    const calls = backend(() => new Response(JSON.stringify({ data: item({ text: '@陈晨 周五发版' }) }), { status: 200 }))
    wrap(<SendDialog conversationId="cv_g" onCancel={() => {}} onSent={() => {}} />)
    expect(await screen.findByText('#product')).toBeTruthy()
    expect(screen.queryByRole('checkbox', { name: '回复时 @ 对方' })).toBeNull()
    const box = screen.getByRole('textbox', { name: '内容' })
    await userEvent.type(box, '@陈')
    const pop = await screen.findByRole('listbox', { name: '@ 谁' })
    expect(within(pop).getAllByRole('option').map((o) => o.textContent)).toEqual(['陈晨联系人'])
    await userEvent.keyboard('{Enter}')
    await userEvent.type(box, '周五发版')
    await userEvent.click(screen.getByRole('button', { name: '发送' }))
    expect(posts(calls)).toEqual([{ conversation_id: 'cv_g', connector_id: 'cn_a', text: '@陈晨 周五发版', mentions: [{ external_id: 'U5', name: '陈晨' }] }])
  })
})

describe('我发出的', () => {
  it('列出发出的，失败的能重发', async () => {
    const calls = backend(() => new Response(JSON.stringify({ data: item() }), { status: 200 }),
      [item({ id: 'ob_2', status: 'failed', error: 'channel_not_found', text: '重来' }), item({ source: 'sop' })])
    const onSend = vi.fn()
    wrap(<SentStrip conversationId="cv_g" onSend={onSend} />)
    await userEvent.click(await screen.findByRole('button', { name: /我发出的 2 条/ }))
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
    expect(screen.getByText('SOP')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: '重发' }))
    expect(posts(calls)).toEqual([{ conversation_id: 'cv_g', connector_id: 'cn_a', text: '重来' }])
    await userEvent.click(screen.getByRole('button', { name: '发消息' }))
    expect(onSend).toHaveBeenCalled()
  })
})
