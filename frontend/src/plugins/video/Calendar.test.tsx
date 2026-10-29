import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startEventStream, type VideoPublish } from '../../core/data'
import { ymd } from './calendarModel'
import Page from './Page'

const T = '2099-03-01T08:00:00Z'
// 2099-03-12 是周四；发布定在本地 10:00
const AT = new Date(2099, 2, 12, 10, 0).toISOString()
const video = (id: string, title: string, target?: string, ch1 = 'pending') => ({
  id, title, orientations: ['landscape'], stage: 'ch1', root: '/v', chapters: 3, runners: [], target_date: target,
  checkpoints: [{ stage: 'plan', state: 'passed' }, { stage: 'ch1', state: ch1 }, { stage: 'audio', state: 'pending' }, { stage: 'distribution', state: 'pending' }],
  created_at: T, updated_at: T,
})

type Call = { method: string; path: string; body?: Record<string, unknown> }

// 内存里的视频、发布和日历：日历按 internal/plugins/video/schedule.go 的 calendarItems 的要点现算
function fakeBackend() {
  const calls: Call[] = []
  const videos = [video('vd_1', '第 1 集', '2099-03-14'), video('vd_2', '第 2 集', '2099-03-20', 'passed')]
  const pubs: VideoPublish[] = [
    { id: 'pb_1', video_id: 'vd_1', platform: 'bilibili', variant: 'landscape', title: 'B 站首发', desc: '', status: 'scheduled', scheduled_at: AT, created_at: T, updated_at: T },
  ]
  const deals = [
    { id: 'deal_1', project_id: 'obj_pj', brand: '远川', title: '试点短片', platforms: [], deliverables: '', quote: 0, currency: 'CNY', status: 'signed', deadline: '2099-03-18', video_ids: [], history: [], created_at: T, updated_at: T },
  ]
  const json = (data: unknown, status = 200, meta?: unknown) => new Response(JSON.stringify(status < 300 ? { data, meta } : data), { status })
  const calendar = (from: string, to: string) => {
    const out: Record<string, unknown>[] = []
    for (const p of pubs) {
      const at = p.status === 'published' ? p.published_at : p.scheduled_at
      if (!at) continue
      out.push({ date: ymd(new Date(at)), kind: 'publish', ref_id: p.id, label: p.title, at, status: p.status, platform: p.platform, video_id: p.video_id,
        tone: p.status === 'failed' ? 'danger' : p.status === 'published' ? 'ok' : 'muted', movable: p.status === 'planned' || p.status === 'scheduled' })
    }
    for (const v of videos) {
      if (!v.target_date) continue
      const behind = v.checkpoints[1].state !== 'passed'
      out.push({ date: v.target_date, kind: 'target', ref_id: v.id, label: v.title, video_id: v.id, tone: behind ? 'danger' : 'muted', movable: true, ...(behind ? { behind: true } : {}) })
    }
    const xs = out.filter((x) => (x.date as string) >= from && (x.date as string) <= to)
    return json(xs, 200, { total: xs.length, from, to, today: '2099-03-10', late_days: 7, behind: xs.filter((x) => x.behind).length })
  }
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input), 'http://x')
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ method, path: u.pathname + u.search, body })
    const p = u.pathname
    if (p === '/api/objects') return json([], 200, { total: 0 })
    if (['/api/video/series', '/api/video/topics', '/api/video/clips', '/api/video/accounts', '/api/video/platforms', '/api/video/artifacts', '/api/video/cover-tests'].includes(p)) {
      return json([], 200, { total: 0 })
    }
    if (p === '/api/video/videos') return json(videos, 200, { total: videos.length })
    if (p === '/api/video/deals') return json(deals, 200, { total: deals.length })
    if (p === '/api/video/publishes') return json(pubs, 200, { total: pubs.length })
    if (p === '/api/video/calendar') return calendar(u.searchParams.get('from')!, u.searchParams.get('to')!)
    let m = p.match(/^\/api\/video\/publishes\/([^/]+)$/)
    if (m && method === 'PATCH') {
      const x = pubs.find((y) => y.id === m![1])!
      Object.assign(x, body)
      return json(x)
    }
    m = p.match(/^\/api\/video\/videos\/([^/]+)$/)
    if (m) {
      const v = videos.find((y) => y.id === m![1])!
      if (method === 'PATCH') Object.assign(v, body)
      return json(v)
    }
    return json({ error: { code: 'not_found', message: '没有这个接口' } }, 404)
  }))
  return { calls, pubs, videos }
}

function show(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createMemoryRouter([{ path: '/videos/*', element: <Page /> }, { path: '*', element: <div>别的页</div> }], { initialEntries: [path] })
  render(<QueryClientProvider client={qc}><RouterProvider router={router} /></QueryClientProvider>)
  return { router, qc }
}

const cellOf = (date: string) => document.querySelector(`[data-date="${date}"]`) as HTMLElement
/** 等网格画出来再取格子 */
const cellAfter = async (date: string) => { await screen.findByRole('grid'); return cellOf(date) }

afterEach(() => { vi.unstubAllGlobals() })

describe('内容日历', () => {
  it('月视图按网格首尾取数，格子里有发布、首发日和商单交付，落后的标红', async () => {
    const be = fakeBackend()
    show('/videos/calendar?d=2099-03-10')
    expect(await screen.findByRole('grid', { name: '2099 年 3 月' })).toBeInTheDocument()
    // 2099-03-01 是周日：网格从 2-23 画到 4-5
    expect(be.calls.some((c) => c.path === '/api/video/calendar?from=2099-02-23&to=2099-04-05')).toBe(true)
    expect(within(cellOf('2099-03-12')).getByRole('button', { name: /B 站首发/ })).toBeInTheDocument()
    const late = within(cellOf('2099-03-14')).getByRole('button', { name: /第 1 集/ })
    expect(late).toHaveClass('vcal-t-danger')
    expect(late).toHaveAttribute('title', expect.stringContaining('进度落后'))
    expect(within(cellOf('2099-03-20')).getByRole('button', { name: /第 2 集/ })).not.toHaveClass('vcal-t-danger')
    expect(within(cellOf('2099-03-18')).getByRole('button', { name: /远川：试点短片/ })).toBeInTheDocument()
    expect(screen.getByTitle('第 1 集')).toHaveTextContent('进度落后 1 集')
  })

  it('拖动已定时的发布改到另一天，时刻不变；刷新后还是新日期', async () => {
    const be = fakeBackend()
    show('/videos/calendar?d=2099-03-10')
    const chip = await within(await cellAfter('2099-03-12')).findByRole('button', { name: /B 站首发/ })
    const dt = { effectAllowed: '', dropEffect: '', setData: () => {} }
    fireEvent.dragStart(chip, { dataTransfer: dt })
    fireEvent.dragOver(cellOf('2099-03-16'), { dataTransfer: dt })
    fireEvent.drop(cellOf('2099-03-16'), { dataTransfer: dt })
    await waitFor(() => expect(be.calls.find((c) => c.method === 'PATCH')).toBeTruthy())
    const patch = be.calls.find((c) => c.method === 'PATCH')!
    expect(patch.path).toBe('/api/video/publishes/pb_1')
    const next = new Date(patch.body!.scheduled_at as string)
    expect([ymd(next), next.getHours(), next.getMinutes()]).toEqual(['2099-03-16', 10, 0])
    expect(await screen.findByText(/已改到 2099-03-16，到 2099-03-16 10:00 自动发布/)).toBeInTheDocument()
    await waitFor(() => expect(within(cellOf('2099-03-16')).getByRole('button', { name: /B 站首发/ })).toBeInTheDocument())
    expect(within(cellOf('2099-03-12')).queryByRole('button', { name: /B 站首发/ })).not.toBeInTheDocument()
  })

  it('在详情里改首发日；已定时的不能挪到过去；能打开发布抽屉和视频', async () => {
    const be = fakeBackend()
    const user = userEvent.setup()
    const { router } = show('/videos/calendar?d=2099-03-10')
    await user.click(await within(await cellAfter('2099-03-14')).findByRole('button', { name: /第 1 集/ }))
    const panel = screen.getByRole('region', { name: '详情' })
    expect(within(panel).getByRole('note')).toHaveTextContent('离计划首发 2099-03-14 只剩 4 天，第一章还在等验收')
    fireEvent.change(within(panel).getByLabelText('改日期'), { target: { value: '2099-03-21' } })
    await waitFor(() => expect(be.calls.some((c) => c.method === 'PATCH' && c.path === '/api/video/videos/vd_1')).toBe(true))
    expect(be.calls.find((c) => c.method === 'PATCH')!.body).toEqual({ target_date: '2099-03-21' })
    await waitFor(() => expect(within(cellOf('2099-03-21')).getByRole('button', { name: /第 1 集/ })).toBeInTheDocument())

    await user.click(within(cellOf('2099-03-12')).getByRole('button', { name: /B 站首发/ }))
    fireEvent.change(within(panel).getByLabelText('改日期'), { target: { value: '2001-01-01' } })
    expect(await within(panel).findByText(/已定时的发布不能挪到已经过去的时间/)).toBeInTheDocument()
    expect(be.calls.filter((c) => c.method === 'PATCH')).toHaveLength(1)

    await user.click(within(panel).getByRole('button', { name: '打开发布记录' }))
    expect(router.state.location.search).toContain('p=pb_1')
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    await user.click(within(panel).getByRole('button', { name: '打开视频' }))
    expect(router.state.location.pathname).toBe('/videos/v/vd_1')
  })

  it('周视图记在地址上，翻周按周取数', async () => {
    const be = fakeBackend()
    const user = userEvent.setup()
    const { router } = show('/videos/calendar?d=2099-03-10')
    await screen.findByRole('grid', { name: '2099 年 3 月' })
    await user.click(screen.getByRole('button', { name: '周' }))
    expect(router.state.location.search).toContain('m=week')
    expect(await screen.findByRole('grid', { name: '3 月 9 日 - 3 月 15 日' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '下一周' }))
    expect(await screen.findByRole('grid', { name: '3 月 16 日 - 3 月 22 日' })).toBeInTheDocument()
    expect(be.calls.some((c) => c.path === '/api/video/calendar?from=2099-03-16&to=2099-03-22')).toBe(true)
  })

  it('事件流里来了发布失败的通知，格子马上变成失败', async () => {
    const be = fakeBackend()
    const { qc } = show('/videos/calendar?d=2099-03-10')
    const chip = await within(await cellAfter('2099-03-12')).findByRole('button', { name: /B 站首发/ })
    expect(chip).not.toHaveClass('vcal-t-danger')
    const sources: FakeES[] = []
    class FakeES {
      readyState = 1
      onopen: ((ev: Event) => unknown) | null = null
      onmessage: ((ev: MessageEvent) => unknown) | null = null
      onerror: ((ev: Event) => unknown) | null = null
      constructor() { sources.push(this) }
      close() { this.readyState = 2 }
    }
    const stop = startEventStream(qc, { EventSource: FakeES })
    be.pubs[0].status = 'failed'
    be.pubs[0].error = 'B 站：封面与内容不符'
    act(() => {
      sources[0].onmessage?.(new MessageEvent('message', { data: JSON.stringify({ id: '1', type: 'notification.created', at: T,
        payload: { kind: 'video.publish_failed', data: { publish_id: 'pb_1', source: 'video' } } }) }))
    })
    await waitFor(() => expect(within(cellOf('2099-03-12')).getByRole('button', { name: /B 站首发/ })).toHaveClass('vcal-t-danger'))
    stop()
  })
})
