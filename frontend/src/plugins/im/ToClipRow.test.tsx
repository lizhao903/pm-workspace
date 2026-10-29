import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ImMessage } from '../../core/data'
import { ToClipRow } from './ToClipRow'

let calls: { method: string; path: string; body?: Record<string, unknown> }[] = []
let videoRunning = true
let clips: Record<string, unknown>[] = []

const MSG: ImMessage = {
  id: 'msg_1', channel: 'slack', connector_id: '', external_id: 'x', conversation_id: 'cv_prod', conversation_external_id: 'C1', conversation_kind: 'group',
  conversation: '#product', sender_id: 'U1', sender_name: 'Lin', identity_id: null, stakeholder_id: null, contact_name: '',
  text: '周报能不能全自动生成', relevance: '', status: 'pending', read: false, snooze_until: null, at: '2026-10-29T01:00:00Z', received_at: '2026-10-29T01:00:00Z',
  adapter: 'fake', task_id: null, task_ref: '', replies: [], reply_error: '', attachments: [],
}

function fakeBackend() {
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(status < 300 ? { data, meta: { total: Array.isArray(data) ? data.length : 0 } } : data), { status })
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input), 'http://x')
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined
    calls.push({ method, path: u.pathname + u.search, body })
    if (u.pathname === '/api/plugins') return json([{ id: 'im', running: true }, { id: 'video', running: videoRunning }])
    if (u.pathname === '/api/video/clips' && method === 'GET') return json(clips)
    if (u.pathname === '/api/video/clips' && method === 'POST') {
      const c = { id: 'cl_1', topic_ids: [], ...body }
      clips.push(c)
      return json(c, 201)
    }
    return json({ error: { code: 'not_found', message: 'nope' } }, 404)
  }))
}

function renderRow(msg = MSG) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={qc}><ToClipRow msg={msg} who="Lin" source="Slack · #product" /></QueryClientProvider>)
}

beforeEach(() => {
  calls = []
  videoRunning = true
  clips = []
  fakeBackend()
})
afterEach(() => vi.unstubAllGlobals())

describe('收进素材箱', () => {
  it('收进去带上消息 id、正文和来源，收过的只显示已收', async () => {
    renderRow()
    await userEvent.click(await screen.findByRole('button', { name: '收进素材箱' }))
    await screen.findByText('已收进素材箱')
    const post = calls.find((c) => c.method === 'POST')
    expect(post?.body).toEqual({ kind: 'im', content: '周报能不能全自动生成', source: 'Slack · #product', message_id: 'msg_1' })
    expect(screen.queryByRole('button', { name: '收进素材箱' })).toBeNull()
  })

  it('没有正文时用发信人起标题', async () => {
    renderRow({ ...MSG, text: '  ' })
    await userEvent.click(await screen.findByRole('button', { name: '收进素材箱' }))
    await screen.findByText('已收进素材箱')
    expect(calls.find((c) => c.method === 'POST')?.body).toMatchObject({ title: 'Lin 的消息', content: '' })
  })

  it('已经收过、归到选题的直接显示', async () => {
    clips = [{ id: 'cl_9', kind: 'im', message_id: 'msg_2', topic_ids: [] }, { id: 'cl_0', kind: 'im', message_id: 'msg_1', topic_ids: ['tp_1'] }]
    renderRow()
    await screen.findByText('已收进素材箱，归到了 1 个选题')
  })

  it('视频插件没在跑时不显示，也不去查素材', async () => {
    videoRunning = false
    renderRow()
    await waitFor(() => expect(calls.some((c) => c.path === '/api/plugins')).toBe(true))
    expect(screen.queryByText('素材箱')).toBeNull()
    expect(calls.some((c) => c.path.startsWith('/api/video'))).toBe(false)
  })
})
