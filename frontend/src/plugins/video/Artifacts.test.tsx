import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Video, VideoArtifact, VideoCheckpoint, VideoSeries } from '../../core/data'
import Page from './Page'

const T = '2026-10-29T08:00:00Z'
const cps = (): VideoCheckpoint[] => (['plan', 'ch1', 'audio', 'distribution'] as const).map((stage) => ({ stage, state: 'pending' }))
const vid = (id: string, x: Partial<Video>): Video => ({
  id, title: id, orientations: ['landscape'], stage: 'script', checkpoints: cps(), root: `videos/${id}`, chapters: 3, created_at: T, updated_at: T, ...x,
})
const art = (id: string, x: Partial<VideoArtifact>): VideoArtifact => ({
  id, video_id: 'ep1', kind: 'script', name: '口播稿', path: 'script-landscape.md', variant: 'landscape', version: 1, status: 'draft',
  source: { type: 'manual', label: '手动登记' }, reviews: [], created_at: T, updated_at: T, ...x,
})

type Call = { method: string; path: string; body?: Record<string, unknown> }

// 内存里的视频后端：产出物和系列的规则照 internal/plugins/video/artifacts.go、series.go
function fakeBackend(seed: { videos: Video[]; series?: VideoSeries[]; artifacts?: VideoArtifact[] }) {
  const calls: Call[] = []
  const videos = seed.videos.map((v) => ({ ...v }))
  const series = (seed.series ?? []).map((s) => ({ ...s, stale: [...s.stale] }))
  const arts = (seed.artifacts ?? []).map((a) => ({ ...a, reviews: [...a.reviews] }))
  const json = (data: unknown, status = 200, meta?: unknown) => new Response(JSON.stringify(status < 300 ? { data, meta } : data), { status })
  const err = (status: number, code: string, message: string) => json({ error: { code, message } }, status)
  let n = 0
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input), 'http://x')
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    const p = u.pathname
    calls.push({ method, path: p + u.search, body })
    if (p === '/api/objects') return json([], 200, { total: 0 })
    if (p === '/api/video/videos' && method === 'GET') return json(videos, 200, { total: videos.length })
    let m = p.match(/^\/api\/video\/videos\/([^/]+)$/)
    if (m) {
      const v = videos.find((x) => x.id === m![1])
      if (!v) return err(404, 'not_found', '视频不存在')
      if (method === 'PATCH') {
        for (const [k, x] of Object.entries(body)) (v as Record<string, unknown>)[k] = x === null ? undefined : x
        if ('series_id' in body) for (const s of series) s.stale = s.stale.filter((id) => id !== v.id)
      }
      return json(v)
    }
    if (p === '/api/video/series' && method === 'GET') return json(series, 200, { total: series.length })
    if (p === '/api/video/series' && method === 'POST') {
      const s: VideoSeries = { id: `sr_${(n += 1)}`, name: '', desc: '', intro: '', outro: '', template: '', stale: [], created_at: T, updated_at: T, ...body }
      series.push(s)
      return json(s, 201)
    }
    m = p.match(/^\/api\/video\/series\/([^/]+)$/)
    if (m) {
      const s = series.find((x) => x.id === m![1])
      if (!s) return err(404, 'not_found', '系列不存在')
      if (method === 'DELETE') {
        series.splice(series.indexOf(s), 1)
        for (const v of videos) if (v.series_id === s.id) { v.series_id = undefined; v.episode = undefined }
        return json(null)
      }
      Object.assign(s, body)
      return json(s)
    }
    if (p === '/api/video/artifacts' && method === 'GET') return json(arts.filter((a) => a.video_id === u.searchParams.get('video_id')))
    if (p === '/api/video/artifacts' && method === 'POST') {
      const a = art(`vaf_${(n += 1)}`, { variant: undefined, ...body, picked: body.kind === 'cover' ? false : undefined })
      arts.push(a)
      return json(a, 201)
    }
    m = p.match(/^\/api\/video\/artifacts\/([^/]+)(?:\/(reviews|bump))?$/)
    if (!m) return err(404, 'not_found', '没有这个接口')
    const a = arts.find((x) => x.id === m![1])
    if (!a) return err(404, 'not_found', '产出物不存在')
    if (m[2] === 'reviews') {
      if (!body.ok && !body.comment) return err(400, 'validation', '退回要写意见')
      a.reviews.push({ at: new Date().toISOString(), ok: body.ok, comment: body.comment ?? '通过', version: a.version })
      a.status = body.ok ? 'final' : 'draft'
      return json(a)
    }
    if (m[2] === 'bump') {
      if (body.from !== a.version) return err(409, 'conflict', '刷新后再操作')
      a.version += 1
      a.status = 'draft'
      return json(a)
    }
    if (method === 'DELETE') { arts.splice(arts.indexOf(a), 1); return json(null) }
    if (method === 'PATCH') {
      if (body.picked) for (const x of arts) if (x.kind === a.kind && x.variant === a.variant && (x.ratio ?? '') === (a.ratio ?? '')) x.picked = false
      Object.assign(a, body)
    }
    return json(a)
  }))
  return { calls, videos, series, arts }
}

function show(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createMemoryRouter([
    { path: '/videos/*', element: <Page /> },
    { path: '/conversations/*', element: <div>会话页</div> },
  ], { initialEntries: [path] })
  render(<QueryClientProvider client={qc}><RouterProvider router={router} /></QueryClientProvider>)
  return router
}

afterEach(() => { vi.unstubAllGlobals() })

describe('视频详情的产出物', () => {
  const v1 = vid('ep1', { title: '第 1 集', orientations: ['landscape', 'portrait'], stage: 'distribution' })

  it('按类型分块、按比例分栏；封面按封面比例每组 5 格，缺的格预填登记', async () => {
    const user = userEvent.setup()
    const be = fakeBackend({
      videos: [v1],
      artifacts: [
        art('s1', {}),
        art('c1', { kind: 'cover', name: '封面 1', path: 'cover/9x16-1.png', variant: 'portrait', option: 1, picked: true }),
      ],
    })
    show('/videos/v/ep1/artifacts')
    const script = await screen.findByRole('region', { name: '口播稿' })
    expect(within(script).getByRole('generic', { name: '口播稿 竖屏 9:16' })).toHaveTextContent('这个比例还没有口播稿')
    expect(within(script).getByRole('button', { name: /口播稿.*videos\/ep1\/script-landscape\.md/ })).toBeInTheDocument()
    const cover = screen.getByRole('region', { name: '封面' })
    expect(within(cover).getByRole('button', { name: '竖屏 9:16 封面 9:16 第 1 版' })).toHaveTextContent('选用')
    expect(within(cover).getAllByRole('button', { name: /^登记 竖屏 9:16 封面 3:4/ })).toHaveLength(5)

    await user.click(within(cover).getByRole('button', { name: '登记 竖屏 9:16 封面 3:4 第 2 版' }))
    const form = screen.getByRole('form', { name: '登记产出物' })
    expect(within(form).getByRole('button', { name: '3:4' })).toHaveAttribute('aria-pressed', 'true')
    expect(within(form).getByRole('textbox', { name: /路径/ })).toHaveValue('cover/3x4-2.png')
    await user.click(within(form).getByRole('button', { name: '登记' }))
    await waitFor(() => expect(screen.queryByRole('form', { name: '登记产出物' })).not.toBeInTheDocument())
    expect(be.calls.find((c) => c.method === 'POST')?.body).toEqual({
      video_id: 'ep1', kind: 'cover', name: '封面 2', path: 'cover/3x4-2.png', variant: 'portrait', option: 2, ratio: '3x4',
    })
    expect(await within(screen.getByRole('region', { name: '封面' })).findByRole('button', { name: '竖屏 9:16 封面 3:4 第 2 版' })).toBeInTheDocument()
  })

  it('一个都没有时是空状态；右上「新增产出物」按当前阶段给类型，音频填时长', async () => {
    const user = userEvent.setup()
    const be = fakeBackend({ videos: [{ ...v1, stage: 'audio' }] })
    show('/videos/v/ep1/artifacts')
    expect(await screen.findByText('还没有产出物')).toBeInTheDocument()
    await user.click(screen.getAllByRole('button', { name: '新增产出物' })[0])
    const form = screen.getByRole('form', { name: '登记产出物' })
    expect(within(form).getByRole('combobox', { name: '类型' })).toHaveValue('audio')
    await user.type(within(form).getByRole('textbox', { name: /时长/ }), '10:02')
    await user.click(within(form).getByRole('button', { name: '登记' }))
    await waitFor(() => expect(be.arts).toHaveLength(1))
    expect(be.arts[0]).toMatchObject({ kind: 'audio', path: 'audio/', duration: 602, name: '音频' })
  })

  it('抽屉：退回要写意见，通过后已定稿；升版本回到草稿；刷新后抽屉还在', async () => {
    const user = userEvent.setup()
    const be = fakeBackend({ videos: [v1], artifacts: [art('s1', { status: 'review' })] })
    const router = show('/videos/v/ep1/artifacts')
    await user.click(await screen.findByRole('button', { name: /口播稿.*script-landscape/ }))
    expect(router.state.location.search).toBe('?a=s1')
    const dr = screen.getByRole('dialog', { name: '产出物 口播稿' })
    expect(within(dr).getByRole('button', { name: '退回' })).toBeDisabled()
    expect(within(dr).getByText('还没验收过')).toBeInTheDocument()
    await user.type(within(dr).getByRole('textbox', { name: '验收意见' }), '开头太长')
    await user.click(within(dr).getByRole('button', { name: '退回' }))
    expect(await within(dr).findByText('开头太长')).toBeInTheDocument()
    expect(be.arts[0].status).toBe('draft')
    await user.click(within(dr).getByRole('button', { name: '通过' }))
    await waitFor(() => expect(be.arts[0].status).toBe('final'))
    expect(be.calls.filter((c) => c.path.endsWith('/reviews')).map((c) => c.body)).toEqual([{ ok: false, comment: '开头太长' }, { ok: true }])
    await user.click(within(dr).getByRole('button', { name: '升版本' }))
    await waitFor(() => expect(be.arts[0].version).toBe(2))
    expect(be.calls.find((c) => c.path.endsWith('/bump'))?.body).toEqual({ from: 1 })

    // 换一个新的页面实例，相当于刷新
    cleanup()
    show('/videos/v/ep1/artifacts?a=s1')
    const again = await screen.findByRole('dialog', { name: '产出物 口播稿' })
    expect(within(again).getAllByText('v2').length).toBeGreaterThan(0)
    expect(within(again).getByRole('button', { name: '草稿' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('抽屉：改名称停手后保存，改状态、选用封面、删除', async () => {
    const user = userEvent.setup()
    const be = fakeBackend({
      videos: [v1],
      artifacts: [
        art('c1', { kind: 'cover', name: '封面 1', path: 'cover/16x9-1.png', option: 1, picked: true }),
        art('c2', { kind: 'cover', name: '封面 2', path: 'cover/16x9-2.png', option: 2, picked: false }),
      ],
    })
    show('/videos/v/ep1/artifacts?a=c2')
    const dr = await screen.findByRole('dialog', { name: '产出物 封面 2' })
    expect(within(dr).getByRole('link', { name: '预览' })).toHaveAttribute('href', 'http://127.0.0.1:7801/videos/ep1/cover/16x9-2.png')
    await user.click(within(dr).getByRole('button', { name: '选用这张' }))
    await waitFor(() => expect(be.arts.map((a) => a.picked)).toEqual([false, true]))
    await user.click(within(dr).getByRole('button', { name: '已定稿' }))
    await waitFor(() => expect(be.arts[1].status).toBe('final'))
    const name = within(dr).getByRole('textbox', { name: '名称' })
    await user.clear(name)
    await user.type(name, '封面 B')
    await waitFor(() => expect(be.arts[1].name).toBe('封面 B'), { timeout: 2000 })
    await user.click(within(dr).getByRole('button', { name: '删除' }))
    expect(within(dr).getByText('只删记录，文件不动')).toBeInTheDocument()
    await user.click(within(dr).getAllByRole('button', { name: '删除' }).at(-1)!)
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /产出物/ })).not.toBeInTheDocument())
    expect(be.arts.map((a) => a.id)).toEqual(['c1'])
  })

  it('来源是 Agent 的产出物能跳到那次运行', async () => {
    const user = userEvent.setup()
    fakeBackend({ videos: [v1], artifacts: [art('s1', { source: { type: 'agent', label: '视频助手', id: 'ag_1', run_id: 'ar_9' } })] })
    const router = show('/videos/v/ep1/artifacts?a=s1')
    const dr = await screen.findByRole('dialog', { name: '产出物 口播稿' })
    expect(within(dr).getByText('Agent · 视频助手')).toBeInTheDocument()
    await user.click(within(dr).getByRole('button', { name: '查看这次运行' }))
    expect(router.state.location.pathname).toBe('/conversations/runs')
    expect(router.state.location.search).toBe('?run=ar_9')
  })
})

describe('制作流程里的产出物（VID-02b）', () => {
  it('字幕列在录屏渲染、封面带封面比例，第一章验收列演示工程；点一条打开抽屉', async () => {
    const user = userEvent.setup()
    fakeBackend({
      videos: [vid('ep1', { orientations: ['landscape', 'portrait'], stage: 'distribution' })],
      artifacts: [
        art('sub', { kind: 'subtitle', name: '字幕', path: 'subtitle/ep1-9x16.srt', variant: 'portrait', lang: 'zh' }),
        art('cv', { kind: 'cover', name: '封面 1', path: 'cover/3x4-1.png', variant: 'portrait', ratio: '3x4', option: 1 }),
        art('pr', { kind: 'presentation', name: '演示工程', path: 'presentation-landscape' }),
      ],
    })
    const router = show('/videos/v/ep1')
    const rec = await screen.findByRole('listitem', { name: '录屏渲染' })
    expect(await within(rec).findByRole('button', { name: '字幕 字幕 竖屏 9:16' })).toBeInTheDocument()
    const dist = screen.getByRole('listitem', { name: '分发包' })
    expect(within(dist).getByRole('button', { name: '封面 封面 1 竖屏 9:16 封面 3:4' })).toHaveTextContent('封面 3:4')
    expect(within(dist).getByRole('link', { name: '预览' })).toHaveAttribute('href', 'http://127.0.0.1:7801/videos/ep1/cover/3x4-1.png')
    const ch1 = screen.getByRole('listitem', { name: '第一章验收' })
    expect(within(ch1).getByRole('generic', { name: '要验收的演示工程' })).toHaveTextContent('演示工程')
    await user.click(within(rec).getByRole('button', { name: /^字幕 字幕/ }))
    expect(router.state.location.search).toBe('?a=sub')
    expect(screen.getByRole('dialog', { name: '产出物 字幕' })).toHaveTextContent('录屏渲染')
  })

  it('抖音要的 3:4 封面：在竖屏下登记，再选用，同组其余取消、9:16 那组不动', async () => {
    const user = userEvent.setup()
    const be = fakeBackend({
      videos: [vid('ep1', { orientations: ['portrait'], stage: 'distribution' })],
      artifacts: [
        art('a916', { kind: 'cover', name: '封面 1', path: 'cover/9x16-1.png', variant: 'portrait', option: 1, picked: true }),
        art('a34', { kind: 'cover', name: '封面 1', path: 'cover/3x4-1.png', variant: 'portrait', ratio: '3x4', option: 1, picked: true }),
      ],
    })
    show('/videos/v/ep1/artifacts')
    await user.click(await screen.findByRole('button', { name: '登记 竖屏 9:16 封面 3:4 第 2 版' }))
    await user.click(within(screen.getByRole('form', { name: '登记产出物' })).getByRole('button', { name: '登记' }))
    const cover = screen.getByRole('region', { name: '封面' })
    await user.click(await within(cover).findByRole('button', { name: '竖屏 9:16 封面 3:4 第 2 版' }))
    const dr = screen.getByRole('dialog', { name: '产出物 封面 2' })
    expect(dr).toHaveTextContent('封面 3:4')
    await user.click(within(dr).getByRole('button', { name: '选用这张' }))
    await waitFor(() => expect(be.arts.find((a) => a.path === 'cover/3x4-2.png')?.picked).toBe(true))
    expect(be.arts.find((a) => a.id === 'a34')?.picked).toBe(false)
    expect(be.arts.find((a) => a.id === 'a916')?.picked).toBe(true)
    expect(await within(cover).findByRole('button', { name: '竖屏 9:16 封面 3:4 第 2 版' })).toHaveTextContent('选用')
  })

  it('当前阶段还没产出物，点「登记一个」跳到产出物标签并预填', async () => {
    const user = userEvent.setup()
    fakeBackend({ videos: [vid('ep1', { stage: 'record' })] })
    const router = show('/videos/v/ep1')
    const rec = await screen.findByRole('listitem', { name: '录屏渲染' })
    await user.click(await within(rec).findByRole('button', { name: '登记一个' }))
    expect(router.state.location.pathname).toBe('/videos/v/ep1/artifacts')
    const form = await screen.findByRole('form', { name: '登记产出物' })
    expect(within(form).getByRole('combobox', { name: '类型' })).toHaveValue('video')
  })
})

describe('系列', () => {
  const S: VideoSeries = { id: 'sr_a', name: 'AI 系列', desc: '', intro: 'shared/intro.tsx', outro: '', template: '', stale: [], created_at: T, updated_at: T }
  const eps = () => [
    vid('e1', { title: '第 1 集', series_id: 'sr_a', episode: 1 }),
    vid('e2', { title: '第 2 集', series_id: 'sr_a', episode: 2 }),
    vid('one', { title: '单独一集' }),
  ]

  it('系列卡片；新建系列名称必填，建好打开详情', async () => {
    const user = userEvent.setup()
    const be = fakeBackend({ videos: eps(), series: [{ ...S, stale: ['e2'] }] })
    const router = show('/videos/series')
    const card = await screen.findByRole('button', { name: 'AI 系列' })
    expect(card).toHaveTextContent('已完成 0 / 2 集')
    expect(card).toHaveTextContent('1 集待同步')
    expect(screen.getByRole('status')).toHaveTextContent('有 1 集改过共用部分还没同步')
    expect(screen.getByRole('tab', { name: '系列' })).toHaveAttribute('aria-selected', 'true')
    await user.click(screen.getByRole('button', { name: /新建系列/ }))
    const dr = screen.getByRole('dialog', { name: '新建系列' })
    await user.click(within(dr).getByRole('button', { name: '创建' }))
    expect(within(dr).getAllByText('名称必填').length).toBeGreaterThan(0)
    await user.type(within(dr).getByRole('textbox', { name: /名称/ }), '  新系列 ')
    await user.click(within(dr).getByRole('button', { name: '创建' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/videos/series/sr_1'))
    expect(be.calls.find((c) => c.method === 'POST')?.body).toEqual({ name: '新系列', desc: '', intro: '', outro: '', template: '' })
  })

  it('系列详情：共用部分、标记已同步、加入已有视频、编排集数和移出', async () => {
    const user = userEvent.setup()
    const be = fakeBackend({ videos: eps(), series: [{ ...S, stale: ['e1', 'e2'] }] })
    show('/videos/series/sr_a')
    const top = await screen.findByRole('region', { name: '共用部分' })
    expect(top).toHaveTextContent('shared/intro.tsx')
    expect(top).toHaveTextContent('未设置')
    const stale = within(top).getByRole('generic', { name: '待同步' })
    expect(stale).toHaveTextContent('2 集待同步')
    await user.click(within(stale).getAllByRole('button', { name: '标记已同步' })[0])
    await waitFor(() => expect(be.series[0].stale).toEqual(['e2']))

    await user.click(screen.getByRole('button', { name: /加入已有视频/ }))
    await user.click(await screen.findByRole('option', { name: /单独一集/ }))
    await waitFor(() => expect(be.videos[2]).toMatchObject({ series_id: 'sr_a', episode: 3 }))

    await user.click(screen.getByRole('button', { name: '编排集数' }))
    const input = await screen.findByRole('spinbutton', { name: '第 2 集 的集数' })
    await user.clear(input)
    await user.type(input, '1{Enter}')
    await waitFor(() => expect(be.videos[1].episode).toBe(1))
    expect(await screen.findByText('有几集集数重复了，改一下')).toBeInTheDocument()
    await user.click(screen.getAllByRole('button', { name: '移出' })[0])
    await waitFor(() => expect(be.videos.filter((v) => v.series_id === 'sr_a')).toHaveLength(2))
  })

  it('系列设置：改了共用部分弹影响范围，勾上的标为待同步', async () => {
    const user = userEvent.setup()
    const be = fakeBackend({ videos: eps(), series: [S] })
    show('/videos/series/sr_a')
    await user.click(await screen.findByRole('button', { name: '系列设置' }))
    const dr = screen.getByRole('dialog', { name: '系列设置' })
    const outro = within(dr).getByRole('textbox', { name: /共用收尾/ })
    await user.type(outro, 'shared/outro.tsx')
    expect(within(dr).getByText('已改')).toBeInTheDocument()
    await user.click(within(dr).getByRole('button', { name: '保存' }))
    const dlg = await screen.findByRole('alertdialog', { name: '影响范围' })
    expect(dlg).toHaveTextContent('改了共用收尾')
    await user.click(within(dlg).getByRole('checkbox', { name: /第 1 集/ }))
    await user.click(within(dlg).getByRole('button', { name: '保存并标记 1 集' }))
    await waitFor(() => expect(be.series[0]).toMatchObject({ outro: 'shared/outro.tsx', stale: ['e2'] }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '系列设置' })).not.toBeInTheDocument())
  })

  it('系列设置里删除系列，各集变回单集，回到系列列表', async () => {
    const user = userEvent.setup()
    const be = fakeBackend({ videos: eps(), series: [S] })
    const router = show('/videos/series/sr_a')
    await user.click(await screen.findByRole('button', { name: '系列设置' }))
    await user.click(within(screen.getByRole('dialog', { name: '系列设置' })).getByRole('button', { name: '删除系列' }))
    const dlg = await screen.findByRole('alertdialog')
    expect(dlg).toHaveTextContent('2 集变回单集')
    await user.click(within(dlg).getByRole('button', { name: '删除' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/videos/series'))
    expect(be.series).toHaveLength(0)
    expect(be.videos.every((v) => !v.series_id)).toBe(true)
  })
})
