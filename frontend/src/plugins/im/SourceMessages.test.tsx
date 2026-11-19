// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ImMessage, WorkObject } from '../../core/data'
import { digest, messagePath, messageURL, permalinkLabel, permalinkOf } from './linkModel'
import { MessageLinks } from './MessageLinks'
import SourceMessages from './SourceMessages'

// 消息链接与任务的来源消息（im 0.32.0，SPEC-messages-2.57、SPEC-tasks-4.84）

const msg = (over: Partial<ImMessage> = {}): ImMessage => ({
  id: 'msg_1', channel: 'slack', connector_id: 'cn_1', external_id: 'C1:1761700000.000100', conversation_id: 'cv_1', conversation_external_id: 'C1',
  conversation_kind: 'group', conversation: '#xaue-技术支持', sender_id: 'U1', sender_name: 'Jenna Chen', identity_id: null, stakeholder_id: null,
  contact_name: '', text: '现在 XAUE Shop 无法连接多签钱包\n没有弹出签名', relevance: 'me', status: 'pending', read: false, snooze_until: null,
  at: '2026-11-02T05:55:40Z', received_at: '2026-11-02T05:55:41Z', adapter: 'slack', task_id: 'obj_t', task_ref: 'TSK-1', replies: [], reply_error: '',
  expired_at: null, project_id: null, project_name: '', project_source: '', sessions: [], split_tasks: [], materials: [], thread: null, reply_count: 0,
  attachments: [], link: 'https://bro.vip/messages?m=msg_1', permalink: 'https://acme.slack.com/archives/C1/p1761700000000100', ...over,
})

let calls: string[] = []
function fakeBackend(rows: ImMessage[] | 'not_found') {
  calls = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const u = new URL(String(input), 'http://x')
    calls.push(u.pathname + u.search)
    if (u.pathname === '/api/im/messages' && rows !== 'not_found') {
      return new Response(JSON.stringify({ data: rows, meta: { total: rows.length, limit: 200, offset: 0 } }), { status: 200 })
    }
    return new Response(JSON.stringify({ error: { code: 'not_found', message: 'nope' } }), { status: 404 })
  }))
}

function Where() {
  const l = useLocation()
  return <div data-testid="where">{l.pathname + l.search}</div>
}

const task = { id: 'obj_t', type_id: 'task', title: '修钱包' } as unknown as WorkObject

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/tasks?t=obj_t']}>
        <Routes><Route path="*" element={<><SourceMessages object={task} /><Where /></>} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

afterEach(() => { vi.unstubAllGlobals() })

describe('linkModel', () => {
  it('深链沿用消息页的 ?m=，复制时拼上当前地址', () => {
    expect(messagePath('msg_1')).toBe('/messages?m=msg_1')
    expect(messageURL('msg_1', 'https://bro.vip/')).toBe('https://bro.vip/messages?m=msg_1')
    expect(permalinkLabel('Slack')).toBe('在 Slack 打开')
  })
  it('原平台链接只认 http(s)，没有为空', () => {
    expect(permalinkOf({ permalink: 'https://acme.slack.com/archives/C1/p1' })).toBe('https://acme.slack.com/archives/C1/p1')
    expect(permalinkOf({ permalink: '' })).toBe('')
    expect(permalinkOf({})).toBe('')
    expect(permalinkOf({ permalink: 'javascript:alert(1)' })).toBe('')
  })
  it('正文摘要合并空白、过长截断', () => {
    expect(digest('a\n\n b')).toBe('a b')
    expect(digest('一二三四五', 3)).toBe('一二三…')
  })
})

describe('任务详情「来源消息」', () => {
  it('按任务取来源消息，显示发信人、会话、摘要；点一行去消息页打开那条，另给在 Slack 打开', async () => {
    fakeBackend([msg(), msg({ id: 'msg_0', at: '2026-11-01T00:00:00Z', contact_name: '侯亮', text: '补充', permalink: '', task_id: 'obj_other',
      split_tasks: [{ id: 'obj_t', ref: 'TSK-1', title: '修钱包' }] }),
    // 0.32.0 之前的后端不认 task_id、回全部消息：和这条任务无关的不列
    msg({ id: 'msg_9', task_id: null, contact_name: '无关的人' })])
    mount()
    expect(await screen.findByRole('region', { name: '来源消息' })).toBeTruthy()
    expect(calls).toContain('/api/im/messages?task_id=obj_t&limit=200')
    const opens = [...document.querySelectorAll<HTMLButtonElement>('button.imsrc-open')]
    // 按发送时间正序：先「侯亮」再「Jenna Chen」
    expect(opens.map((b) => b.textContent)).toEqual([expect.stringContaining('侯亮'), expect.stringContaining('Jenna Chen')])
    expect(opens[1].textContent).toContain('#xaue-技术支持')
    expect(opens[1].textContent).toContain('现在 XAUE Shop 无法连接多签钱包 没有弹出签名')
    const links = screen.getAllByRole('link', { name: '在 Slack 打开' })
    expect(links).toHaveLength(1)
    expect(links[0].getAttribute('href')).toBe('https://acme.slack.com/archives/C1/p1761700000000100')
    expect(links[0].getAttribute('target')).toBe('_blank')
    await userEvent.click(opens[1])
    expect(screen.getByTestId('where').textContent).toBe('/messages?m=msg_1')
  })

  it('没有来源消息、IM 插件没装（404）时整块不显示', async () => {
    fakeBackend([])
    const a = mount()
    await waitFor(() => expect(calls.length).toBe(1))
    expect(screen.queryByRole('region', { name: '来源消息' })).toBeNull()
    a.unmount()
    fakeBackend('not_found')
    mount()
    await waitFor(() => expect(calls.length).toBe(1))
    expect(screen.queryByRole('region', { name: '来源消息' })).toBeNull()
  })
})

describe('消息抽屉的链接', () => {
  it('复制链接复制工作台深链；有原平台链接时给在 Slack 打开，没有不显示', async () => {
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const { rerender } = render(<MessageLinks msg={msg()} chLabel="Slack" />)
    await userEvent.click(screen.getByRole('button', { name: '复制链接' }))
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/messages?m=msg_1`)
    expect(await screen.findByRole('button', { name: '已复制' })).toBeTruthy()
    expect(screen.getByRole('link', { name: '在 Slack 打开' }).getAttribute('href')).toBe('https://acme.slack.com/archives/C1/p1761700000000100')
    rerender(<MessageLinks msg={msg({ permalink: '' })} chLabel="Slack" />)
    expect(screen.queryByRole('link', { name: '在 Slack 打开' })).toBeNull()
  })
})
