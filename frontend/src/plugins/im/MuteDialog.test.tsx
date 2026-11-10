// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ImMute } from '../../core/data'
import { MuteButton } from './MuteDialog'
import { MutesDrawer } from './MutesPanel'

type Call = { method: string; path: string; query: string; body?: unknown }

const MUTE: ImMute = {
  id: 'imu_1', kind: 'sender', channel: 'slack', sender_id: 'B0CONF', stakeholder_id: null, contact_name: '', conversation_id: null,
  conversation: '', name: 'Confluence', ignored: 4, last_at: '2026-11-06T01:00:00.000Z', created_at: '2026-11-05T01:00:00.000Z',
}

function backend(mutes: ImMute[], pending = 3) {
  const calls: Call[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://x')
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ method, path: url.pathname, query: url.search, body })
    const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status })
    if (url.pathname === '/api/im/mutes' && method === 'GET') return json({ data: mutes, meta: { total: mutes.length } })
    if (url.pathname === '/api/im/mutes/pending') return json({ data: { pending } })
    if (url.pathname === '/api/im/mutes' && method === 'POST') {
      return json({ data: { mute: { ...MUTE, id: 'imu_new', sender_id: 'B0GCAL', name: 'Google Calendar', ignored: body.ignore_pending ? pending : 0 }, created: true, ignored: body.ignore_pending ? pending : 0 } }, 201)
    }
    if (method === 'DELETE') return json({ data: { id: 'imu_1', ignored: 4 } })
    return json({ data: [], meta: { total: 0 } })
  }))
  return calls
}

const wrap = (n: ReactNode) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}>{n}</QueryClientProvider>)
}

afterEach(() => { vi.unstubAllGlobals() })

const subject = { channel: 'slack', channelLabel: 'Slack', sender_id: 'B0GCAL', name: 'Google Calendar', conversation_id: 'cv_dm', conversation: '' }

describe('自动忽略发信人（TSK-0495）', () => {
  it('标记：默认不一并忽略；勾上后按钮写条数，请求带 ignore_pending', async () => {
    const calls = backend([])
    const done = vi.fn()
    wrap(<MuteButton subject={subject} onDone={done} />)
    await userEvent.click(await screen.findByRole('button', { name: '自动忽略 Google Calendar' }))
    const box = await screen.findByRole('checkbox', { name: /把此人已有的 3 条待处理消息/ })
    expect(box).not.toBeChecked()
    // 私聊没有「范围」，没认上联系人没有「按谁」
    expect(screen.queryByText('范围')).toBeNull()
    expect(screen.queryByText('按谁')).toBeNull()
    await userEvent.click(box)
    await userEvent.click(screen.getByRole('button', { name: '自动忽略，并忽略 3 条' }))
    await vi.waitFor(() => expect(done).toHaveBeenCalledWith('已把 Google Calendar 设为自动忽略，已有的 3 条待处理一并忽略'))
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ channel: 'slack', sender_id: 'B0GCAL', name: 'Google Calendar', ignore_pending: true })
  })

  it('群里认上联系人的：能按联系人、只在这个群', async () => {
    const calls = backend([], 0)
    wrap(<MuteButton subject={{ ...subject, sender_id: 'U04LIN', name: '林原', stakeholder_id: 'stk_lin', contact_name: '林原', conversation_id: 'cv_prod', conversation: '#product' }} />)
    await userEvent.click(await screen.findByRole('button', { name: '自动忽略 林原' }))
    await userEvent.click(screen.getByRole('radio', { name: /联系人「林原」的全部 IM 身份/ }))
    await userEvent.click(screen.getByRole('radio', { name: '只在「#product」里' }))
    expect(await screen.findByText('此人现在没有待处理消息')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '自动忽略' }))
    await vi.waitFor(() => expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ stakeholder_id: 'stk_lin', conversation_id: 'cv_prod', name: '林原', ignore_pending: false }))
  })

  it('已标过的写「已自动忽略」，点开是取消确认', async () => {
    const calls = backend([{ ...MUTE, sender_id: 'B0GCAL', name: 'Google Calendar' }])
    wrap(<MuteButton subject={subject} />)
    await userEvent.click(await screen.findByRole('button', { name: '已自动忽略 Google Calendar' }))
    expect(screen.getByText(/已被自动忽略的 4 条不会自动恢复/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '取消自动忽略' }))
    await vi.waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.path === '/api/im/mutes/imu_1')).toBe(true))
  })

  it('管理列表：谁、范围、条数；看消息带名字', async () => {
    backend([MUTE])
    const show = vi.fn()
    wrap(<MutesDrawer onClose={() => {}} onShowMessages={show} />)
    expect(await screen.findByText('Confluence')).toBeInTheDocument()
    expect(screen.getByText(/B0CONF/)).toBeInTheDocument()
    expect(screen.getByText('全部会话')).toBeInTheDocument()
    expect(screen.getByText(/已自动忽略 4 条/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '看消息' }))
    expect(show).toHaveBeenCalledWith('Confluence')
  })

  it('IM 插件没在跑（404）时不显示按钮', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { code: 'not_found', message: 'x' } }), { status: 404 })))
    const { container } = wrap(<MuteButton subject={subject} />)
    await vi.waitFor(() => expect(container.querySelector('button')).toBeNull())
  })
})
