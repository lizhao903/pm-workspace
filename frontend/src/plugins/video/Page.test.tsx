import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Video, VideoCheckpoint, VideoSeries, VideoStageKey } from '../../core/data'
import Page from './Page'
import { STAGES } from './model'

const T = '2026-10-29T08:00:00Z'
const cps = (x: Partial<Record<string, Omit<VideoCheckpoint, 'stage'>>> = {}): VideoCheckpoint[] =>
  (['plan', 'ch1', 'audio', 'distribution'] as const).map((stage) => ({ stage, state: 'pending', ...x[stage] }))
const vid = (id: string, x: Partial<Video>): Video => ({
  id, title: id, orientations: ['landscape'], stage: 'script', checkpoints: cps(), root: `videos/${id}`, chapters: 3, created_at: T, updated_at: T, ...x,
})
const SERIES: VideoSeries[] = [{ id: 'sr_a', name: 'AI 系列', desc: '', intro: '', outro: '', template: '', stale: [], created_at: T, updated_at: T }]

type Call = { method: string; path: string; body?: Record<string, unknown> }

// 内存里的视频后端：规则照 internal/plugins/video/videos.go 的 advance、decide
function fakeBackend(seed: Video[]) {
  const calls: Call[] = []
  const videos = seed.map((v) => ({ ...v, checkpoints: v.checkpoints.map((c) => ({ ...c })) }))
  const json = (data: unknown, status = 200, meta?: unknown) => new Response(JSON.stringify(status < 300 ? { data, meta } : data), { status })
  const err = (status: number, code: string, message: string) => json({ error: { code, message } }, status)
  const idx = (k: string) => STAGES.findIndex((s) => s.key === k)
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input), 'http://x')
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ method, path: u.pathname, body })
    if (u.pathname === '/api/objects') return json([], 200, { total: 0 })
    if (u.pathname === '/api/video/series') return json(SERIES, 200, { total: SERIES.length })
    if (u.pathname === '/api/video/videos' && method === 'GET') return json(videos, 200, { total: videos.length })
    if (u.pathname === '/api/video/videos' && method === 'POST') {
      const v = vid(`vd_${videos.length + 1}`, { ...body, created_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      videos.push(v)
      return json(v, 201)
    }
    const m = u.pathname.match(/^\/api\/video\/videos\/([^/]+)(?:\/(advance|checkpoints)(?:\/([^/]+))?)?$/)
    if (!m) return err(404, 'not_found', '没有这个接口')
    const v = videos.find((x) => x.id === m[1])
    if (!v) return err(404, 'not_found', '视频不存在')
    const touch = () => { v.updated_at = new Date().toISOString() }
    if (!m[2] && method === 'GET') return json(v)
    if (!m[2] && method === 'PATCH') { Object.assign(v, body); touch(); return json(v) }
    if (!m[2] && method === 'DELETE') { videos.splice(videos.indexOf(v), 1); return json(null) }
    if (m[2] === 'advance') {
      if (body.from !== v.stage) return err(409, 'conflict', '视频已经在别的阶段了，刷新后再操作')
      v.stage = STAGES[idx(v.stage) + 1].key as VideoStageKey
      touch()
      return json(v)
    }
    const stage = m[3]
    if (body.state === 'rejected' && !body.note) return err(400, 'validation', '退回要写意见')
    if (stage !== v.stage) return err(409, 'conflict', '只能处理当前阶段的检查点')
    const cp = v.checkpoints.find((c) => c.stage === stage)!
    Object.assign(cp, { state: body.state, note: body.note, at: new Date().toISOString() })
    if (body.state !== 'rejected' && idx(stage) < STAGES.length - 1) v.stage = STAGES[idx(stage) + 1].key as VideoStageKey
    touch()
    return json(v)
  }))
  return { calls, videos }
}

function show(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createMemoryRouter([{ path: '/videos/*', element: <Page /> }], { initialEntries: [path] })
  render(<QueryClientProvider client={qc}><RouterProvider router={router} /></QueryClientProvider>)
  return router
}

afterEach(() => { vi.unstubAllGlobals() })

describe('视频列表', () => {
  const seed = () => [
    vid('ep1', { title: '第 1 集', series_id: 'sr_a', episode: 1, stage: 'distribution', checkpoints: cps({ plan: { state: 'passed' }, ch1: { state: 'passed' }, audio: { state: 'passed' }, distribution: { state: 'passed' } }) }),
    vid('ep2', { title: '第 2 集', series_id: 'sr_a', episode: 2, stage: 'ch1', checkpoints: cps({ plan: { state: 'passed' } }) }),
    vid('one', { title: '单独一集', stage: 'web', checkpoints: cps({ plan: { state: 'passed' } }) }),
  ]

  it('按系列分组，单集在最后；待我处理的数字在标签上', async () => {
    fakeBackend(seed())
    show('/videos')
    expect(await screen.findByRole('region', { name: 'AI 系列' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: '单集' })).toBeInTheDocument()
    expect(within(screen.getByRole('region', { name: 'AI 系列' })).getByText('2 集 · 已完成 1 · 1 集待处理')).toBeInTheDocument()
    const review = screen.getByRole('tab', { name: /待我处理/ })
    expect(within(review).getByText('1')).toBeInTheDocument()
    expect(review).toHaveAttribute('title', '1 集停在检查点或被退回')
  })

  it('阶段分布筛选后变成平铺表，清除后回到分组', async () => {
    const user = userEvent.setup()
    fakeBackend(seed())
    show('/videos')
    await screen.findByRole('region', { name: 'AI 系列' })
    await user.click(screen.getByRole('button', { name: /^网页开发1$/ }))
    expect(screen.queryByRole('region', { name: 'AI 系列' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /单独一集/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /第 2 集/ })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '清除' }))
    expect(screen.getByRole('region', { name: 'AI 系列' })).toBeInTheDocument()
  })

  it('待我处理只列停在检查点的；单集、系列各是一张表', async () => {
    const user = userEvent.setup()
    fakeBackend(seed())
    const router = show('/videos')
    await screen.findByRole('region', { name: 'AI 系列' })
    await user.click(screen.getByRole('tab', { name: /待我处理/ }))
    expect(router.state.location.pathname).toBe('/videos/review')
    expect(await screen.findByRole('button', { name: /第 2 集/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /单独一集/ })).not.toBeInTheDocument()
    await user.click(screen.getByRole('tab', { name: /全部视频/ }))
    await user.click(await screen.findByRole('button', { name: '单集' }))
    expect(router.state.location.pathname).toBe('/videos/single')
    expect(await screen.findByRole('button', { name: /单独一集/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /第 2 集/ })).not.toBeInTheDocument()
  })

  it('系列里新建：标题「第 N 集：」，带上系列和下一集的集数，建好打开详情', async () => {
    const user = userEvent.setup()
    const be = fakeBackend(seed())
    const router = show('/videos/series/sr_a')
    await user.click(await screen.findByRole('button', { name: '新建第 3 集' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/videos/v/vd_4'))
    expect(be.calls.find((c) => c.method === 'POST')?.body).toEqual({
      title: '第 3 集：', orientations: ['landscape'], root: 'videos/new-4', chapters: 3, series_id: 'sr_a', episode: 3,
    })
    expect(await screen.findByRole('listitem', { name: '内容编写' })).toHaveAttribute('aria-current', 'step')
  })

  it('一个视频都没有时是空状态', async () => {
    fakeBackend([])
    show('/videos')
    expect(await screen.findByText('还没有视频')).toBeInTheDocument()
  })
})

describe('视频详情的制作流程', () => {
  it('非检查点阶段点「这一步做完了」进下一阶段，带上看到的阶段', async () => {
    const user = userEvent.setup()
    const be = fakeBackend([vid('a', {})])
    show('/videos/v/a')
    await user.click(await screen.findByRole('button', { name: '这一步做完了，进入「规划检查」' }))
    expect(await screen.findByRole('listitem', { name: '规划检查' })).toHaveAttribute('aria-current', 'step')
    expect(be.calls.find((c) => c.path.endsWith('/advance'))?.body).toEqual({ from: 'script' })
  })

  it('规划检查：没选比例不能通过；通过后比例锁定', async () => {
    const user = userEvent.setup()
    fakeBackend([vid('a', { stage: 'plan', orientations: [] })])
    show('/videos/v/a')
    const pass = await screen.findByRole('button', { name: '通过' })
    expect(pass).toBeDisabled()
    expect(screen.getAllByText('先选至少一个画面比例').length).toBeGreaterThan(0)
    await user.click(screen.getByRole('button', { name: '竖屏 9:16' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '通过' })).toBeEnabled())
    expect(screen.getByText('通过后比例锁定')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '通过' }))
    expect(await screen.findByText('比例定了不能改，要换比例得新开工程')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '竖屏 9:16' })).toBeDisabled()
    expect(screen.queryByRole('button', { name: '横屏 16:9' })).not.toBeInTheDocument()
    expect(screen.getByRole('listitem', { name: '网页开发' })).toHaveAttribute('aria-current', 'step')
  })

  it('退回不写意见按钮不可点；写了意见退回后停在原地，可以改好了通过', async () => {
    const user = userEvent.setup()
    const be = fakeBackend([vid('a', { stage: 'ch1', checkpoints: cps({ plan: { state: 'passed' } }) })])
    show('/videos/v/a')
    await user.click(await screen.findByRole('button', { name: '退回' }))
    const confirm = screen.getByRole('button', { name: '确认退回' })
    expect(confirm).toBeDisabled()
    expect(screen.getByText('退回要写意见')).toBeInTheDocument()
    await user.type(screen.getByRole('textbox', { name: '退回意见' }), '   ')
    expect(confirm).toBeDisabled()
    await user.type(screen.getByRole('textbox', { name: '退回意见' }), '第 3 段太长')
    expect(confirm).toBeEnabled()
    await user.click(confirm)
    expect(await screen.findByText('退回意见：第 3 段太长')).toBeInTheDocument()
    expect(be.calls.find((c) => c.path.endsWith('/checkpoints/ch1'))?.body).toEqual({ state: 'rejected', note: '第 3 段太长' })
    expect(screen.getByRole('listitem', { name: '第一章验收' })).toHaveAttribute('aria-current', 'step')
    expect(screen.getByRole('button', { name: '再次退回' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '改好了，通过' }))
    expect(await screen.findByRole('listitem', { name: '其余章节' })).toHaveAttribute('aria-current', 'step')
  })

  it('音频合成可以跳过；分发包通过后算已完成', async () => {
    const user = userEvent.setup()
    fakeBackend([vid('a', { stage: 'audio', checkpoints: cps({ plan: { state: 'passed' }, ch1: { state: 'passed' } }) })])
    show('/videos/v/a')
    await user.click(await screen.findByRole('button', { name: '跳过（不合成音频）' }))
    expect(await screen.findByText(/已跳过，不合成音频/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '这一步做完了，进入「分发包」' }))
    await user.click(await screen.findByRole('button', { name: '通过' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: '通过' })).not.toBeInTheDocument())
    expect(screen.getByText(/· 已完成$/)).toBeInTheDocument()
  })

  it('视频不存在时说已经删除', async () => {
    fakeBackend([])
    show('/videos/v/nope')
    expect(await screen.findByText('这个视频已经删除')).toBeInTheDocument()
  })

  it('设置里删除视频，确认后回到全部视频', async () => {
    const user = userEvent.setup()
    const be = fakeBackend([vid('a', { title: '要删的' })])
    const router = show('/videos/v/a/settings')
    await user.click(await screen.findByRole('button', { name: '删除视频' }))
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '删除' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/videos'))
    expect(be.videos).toEqual([])
  })

  it('设置里改标题，停手后自动保存', async () => {
    const user = userEvent.setup()
    const be = fakeBackend([vid('a', { title: '旧标题' })])
    show('/videos/v/a/settings')
    const input = await screen.findByRole('textbox', { name: '标题' })
    await user.clear(input)
    await user.type(input, '新标题')
    await waitFor(() => expect(be.videos[0].title).toBe('新标题'), { timeout: 2000 })
    expect(be.calls.filter((c) => c.method === 'PATCH').at(-1)?.body).toEqual({ title: '新标题' })
  })
})
