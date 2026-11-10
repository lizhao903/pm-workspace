// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ImMessage } from '../../core/data'
import { ToDealRow } from './ToDealRow'

let videoRunning = true
let deals: Record<string, unknown>[] = []
let bound: Record<string, string[]> = {}
let pluginReads = 0

const MSG: ImMessage = {
  id: 'msg_1', channel: 'slack', connector_id: '', external_id: 'x', conversation_id: 'cv_yc', conversation_external_id: 'C1', conversation_kind: 'group',
  conversation: '远川项目群', sender_id: 'U1', sender_name: 'wanqing', identity_id: null, stakeholder_id: 'stk_a', contact_name: '梁晚晴',
  text: '采购流程这边需要一份正式的报价', relevance: '', status: 'pending', read: false, snooze_until: null, at: '2026-10-29T01:00:00Z', received_at: '2026-10-29T01:00:00Z',
  adapter: 'fake', task_id: null, task_ref: '', replies: [], reply_error: '', expired_at: null, project_id: null, project_name: '', project_source: '', sessions: [], split_tasks: [], materials: [], thread: null, reply_count: 0, attachments: [],
}

function fakeBackend() {
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(status < 300 ? { data, meta: { total: Array.isArray(data) ? data.length : 0 } } : data), { status })
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const u = new URL(String(input), 'http://x')
    const p = u.pathname
    if (p === '/api/plugins') pluginReads++
    if (p === '/api/plugins') return json([{ id: 'im', running: true }, { id: 'video', running: videoRunning }, { id: 'projects', running: true }])
    if (p === '/api/objects') {
      return json([{ id: 'obj_a', type_id: 'project', title: '北岸物流', props: {} }, { id: 'obj_yc', type_id: 'project', title: '远川权限改造', props: {} }])
    }
    const m = p.match(/^\/api\/projects\/([^/]+)\/conversations$/)
    if (m) return json((bound[m[1]] ?? []).map((id) => ({ project_id: m[1], conversation_id: id, conversation: { id, channel: 'slack', external_id: id, kind: 'group', name: id } })))
    if (p === '/api/video/deals') return json(deals)
    return json({ error: { code: 'not_found', message: 'nope' } }, 404)
  }))
}

function renderRow(msg = MSG) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createMemoryRouter([{ path: '*', element: <ToDealRow msg={msg} /> }], { initialEntries: ['/messages?m=msg_1'] })
  render(<QueryClientProvider client={qc}><RouterProvider router={router} /></QueryClientProvider>)
  return router
}

const at = (r: ReturnType<typeof renderRow>) => r.state.location.pathname + r.state.location.search

beforeEach(() => {
  videoRunning = true
  deals = []
  bound = {}
  pluginReads = 0
  fakeBackend()
})
afterEach(() => vi.unstubAllGlobals())

describe('转为商单', () => {
  it('没转过：跳到绑了这个会话的项目新建，带上消息 id', async () => {
    bound = { obj_yc: ['cv_yc'] }
    const r = renderRow()
    await userEvent.click(await screen.findByRole('button', { name: '转为商单' }))
    await waitFor(() => expect(at(r)).toBe('/projects/obj_yc/deals?new=1&message=msg_1'))
  })

  it('会话没绑项目时取第一个项目', async () => {
    const r = renderRow()
    await userEvent.click(await screen.findByRole('button', { name: '转为商单' }))
    await waitFor(() => expect(at(r)).toBe('/projects/obj_a/deals?new=1&message=msg_1'))
  })

  it('转过的写商单名，点了打开那个商单', async () => {
    deals = [{ id: 'deal_1', project_id: 'obj_yc', brand: '远川科技', title: '正式报价短片', source_message_id: 'msg_1', video_ids: [], history: [] }]
    const r = renderRow()
    expect(await screen.findByText('已转为商单 远川科技 · 正式报价短片')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '打开商单' }))
    expect(at(r)).toBe('/projects/obj_yc/deals?deal=deal_1')
  })

  it('视频插件没在跑时整节不显示', async () => {
    videoRunning = false
    renderRow()
    await waitFor(() => expect(pluginReads).toBeGreaterThan(0))
    await new Promise((res) => setTimeout(res, 20))
    expect(screen.queryByText('商单')).toBeNull()
  })
})
