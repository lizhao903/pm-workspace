// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// SPEC-videos-0.1：视频拆成做视频、素材收集、发布与数据三个一级模块。这里管地址、标签栏、旧地址重定向和跨模块跳转
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Video, VideoCheckpoint, VideoClip } from '../../core/data'
import Page from './Page'
import { moduleOfRoot, routeOf, tabHref, tabModule, videoHref } from './routes'

const T = '2026-11-18T08:00:00Z'
const cps = (): VideoCheckpoint[] => (['plan', 'ch1', 'audio', 'distribution'] as const).map((stage) => ({ stage, state: 'pending' }))
const VIDEO: Video = { id: 'a', title: '第一集', orientations: ['landscape'], stage: 'script', checkpoints: cps(), root: 'videos/a', chapters: 3, created_at: T, updated_at: T }

const CLIP: VideoClip = { id: 'cl_1', kind: 'note', title: '一个想法', content: '', source: '', tags: [], starred: false, topic_ids: [], triaged: false, created_at: T, updated_at: T }

// 只回列表页要的数据，其余列表都回空
function fakeBackend() {
  const json = (data: unknown, status = 200, meta?: unknown) => new Response(JSON.stringify(status < 300 ? { data, meta } : data), { status })
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const u = new URL(String(input), 'http://x')
    if (u.pathname === '/api/video/videos') return json([VIDEO], 200, { total: 1 })
    if (u.pathname === '/api/video/videos/a') return json(VIDEO)
    if (u.pathname === '/api/video/clips') return json([CLIP], 200, { total: 1 })
    return json([], 200, { total: 0 })
  }))
}

function show(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createMemoryRouter(['/videos/*', '/video_clips/*', '/video_publish/*'].map((p) => ({ path: p, element: <Page /> })), { initialEntries: [path] })
  render(<QueryClientProvider client={qc}><RouterProvider router={router} /></QueryClientProvider>)
  return router
}

const tabsOf = async (name: string) => within(await screen.findByRole('tablist', { name })).getAllByRole('tab').map((t) => t.textContent?.replace(/\d+$/, ''))
const where = (r: ReturnType<typeof show>) => r.state.location.pathname + r.state.location.search

afterEach(() => { vi.unstubAllGlobals() })

describe('视频三个模块的地址', () => {
  it('每个模块的标签和首个标签（模块根）', () => {
    expect((['all', 'review', 'series', 'clips', 'topics', 'publishes', 'calendar', 'bilibili'] as const).map((t) => [tabModule(t), tabHref(t)])).toEqual([
      ['videos', '/videos'], ['videos', '/videos/review'], ['videos', '/videos/series'],
      ['video_clips', '/video_clips'], ['video_clips', '/video_clips/topics'],
      ['video_publish', '/video_publish'], ['video_publish', '/video_publish/calendar'], ['video_publish', '/video_publish/bilibili'],
    ])
    expect(['/videos', '/video_clips', '/video_publish', '/nope'].map(moduleOfRoot)).toEqual(['videos', 'video_clips', 'video_publish', 'videos'])
  })

  it('模块里认自己的子路径，别的回模块根；做视频下原来的素材、发布子路径算旧地址', () => {
    expect(routeOf('', 'video_clips')).toEqual({ kind: 'clips' })
    expect(routeOf('topics', 'video_clips')).toEqual({ kind: 'topics' })
    expect(routeOf('calendar', 'video_clips')).toEqual({ kind: 'bad' })
    expect(routeOf('', 'video_publish')).toEqual({ kind: 'publishes' })
    expect(routeOf('calendar', 'video_publish')).toEqual({ kind: 'calendar' })
    expect(routeOf('v/a', 'video_publish')).toEqual({ kind: 'bad' })
    expect(['clips', 'topics', 'publishes', 'calendar', 'bilibili'].map((x) => routeOf(x))).toEqual([
      { kind: 'moved', to: '/video_clips' }, { kind: 'moved', to: '/video_clips/topics' },
      { kind: 'moved', to: '/video_publish' }, { kind: 'moved', to: '/video_publish/calendar' }, { kind: 'moved', to: '/video_publish/bilibili' },
    ])
    expect(routeOf('series/sr_a')).toEqual({ kind: 'list', view: { kind: 'series', id: 'sr_a' } })
  })

  it('页面内部的跳转落到对的模块：选题、发布记录换模块，某一集、系列留在做视频', () => {
    expect(videoHref('/topics?t=tp_1')).toBe('/video_clips/topics?t=tp_1')
    expect(videoHref('/publishes?video=a')).toBe('/video_publish?video=a')
    expect(videoHref('/publishes?t=vct_1')).toBe('/video_publish?t=vct_1')
    expect(videoHref('/v/a')).toBe('/videos/v/a')
    expect(videoHref('/series/sr_a')).toBe('/videos/series/sr_a')
    expect(videoHref('')).toBe('/videos')
  })
})

describe('视频三个模块的页面', () => {
  it('各模块只列自己的标签，标题上级是模块名', async () => {
    fakeBackend()
    show('/video_clips')
    expect(await tabsOf('素材收集')).toEqual(['素材收件箱', '选题'])
    expect(screen.getByRole('tab', { name: /素材收件箱/, selected: true })).toHaveTextContent('1')
    expect(document.querySelector('.tb-parent')).toHaveTextContent('素材收集')
  })

  it('做视频的标签：全部视频、待我处理、系列', async () => {
    fakeBackend()
    show('/videos')
    expect(await tabsOf('做视频')).toEqual(['全部视频', '待我处理', '系列'])
  })

  it('发布与数据的标签：发布记录、日历、B 站数据；点日历换地址', async () => {
    fakeBackend()
    const router = show('/video_publish')
    expect(await tabsOf('发布与数据')).toEqual(['发布记录', '日历', 'B 站数据'])
    await userEvent.click(screen.getByRole('tab', { name: '日历' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/video_publish/calendar'))
  })

  it('旧地址重定向到新模块，查询串照带', async () => {
    fakeBackend()
    const r1 = show('/videos/topics?t=tp_1')
    await waitFor(() => expect(where(r1)).toBe('/video_clips/topics?t=tp_1'))
  })

  it('旧地址：发布记录带抽屉参数', async () => {
    fakeBackend()
    const r = show('/videos/publishes?p=pb_1')
    await waitFor(() => expect(where(r)).toBe('/video_publish?p=pb_1'))
  })

  it('今日「视频发布失败」给的 /videos/v/<id>?p= 落到发布与数据的这条发布记录', async () => {
    fakeBackend()
    const r = show('/videos/v/a?p=pb_9')
    await waitFor(() => expect(where(r)).toBe('/video_publish?video=a&p=pb_9'))
  })

  it('某一集从发布与数据点进来，标签栏是做视频的、高亮全部视频', async () => {
    fakeBackend()
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const router = createMemoryRouter(['/videos/*', '/video_clips/*', '/video_publish/*'].map((p) => ({ path: p, element: <Page /> })),
      { initialEntries: [{ pathname: '/videos/v/a', state: { from: 'publishes' } }] })
    render(<QueryClientProvider client={qc}><RouterProvider router={router} /></QueryClientProvider>)
    expect(await tabsOf('做视频')).toEqual(['全部视频', '待我处理', '系列'])
    expect(screen.getByRole('tab', { name: '全部视频', selected: true })).toBeInTheDocument()
  })
})
