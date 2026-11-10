// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { VideoAccount, VideoArtifact, VideoCoverRatio, VideoCoverTest, VideoPlatformInfo, VideoPublish } from '../../core/data'
import Page from './Page'

const T = '2026-10-29T08:00:00Z'
const VIDEO = {
  id: 'vd_1', title: '第 1 集', orientations: ['portrait'], stage: 'distribution', root: '/v', chapters: 3, runners: [],
  checkpoints: ['plan', 'ch1', 'audio', 'distribution'].map((stage) => ({ stage, state: 'pending' })), created_at: T, updated_at: T,
}
const cover = (id: string, option: number): VideoArtifact => ({
  id, video_id: 'vd_1', kind: 'cover', name: `封面 ${option}`, path: `cover/9x16-${option}.png`, variant: 'portrait', ratio: '9x16', option,
  version: 1, status: 'draft', source: { type: 'manual', label: '手动' }, reviews: [], created_at: T, updated_at: T,
})
const rule = (title_max: number) => ({ title_max, desc_max: 1000, tags_max: 10, allow_link: false, cover: ['9x16', '3x4'] as VideoCoverRatio[] })
const plats = (bili: Partial<VideoPlatformInfo> = {}): VideoPlatformInfo[] => [
  { key: 'bilibili', label: 'B 站', tool: 'bilibili', caps: ['upload', 'metrics'], covers: ['16x9', '4x3'], creator_url: '', connectors: [],
    rule: { platform: 'bilibili', ...rule(80), cover: ['16x9', '4x3'] }, ...bili },
  { key: 'youtube', label: 'YouTube', tool: 'youtube', caps: [], covers: ['16x9'], creator_url: '', connectors: [], rule: { platform: 'youtube', ...rule(100), cover: ['16x9'] } },
  { key: 'douyin', label: '抖音', tool: 'douyin', caps: [], covers: ['3x4', '9x16'], creator_url: '', connectors: [], rule: { platform: 'douyin', ...rule(30) } },
  { key: 'channels', label: '视频号', caps: [], covers: ['9x16', '3x4'], creator_url: '', connectors: [], rule: { platform: 'channels', ...rule(30) } },
  { key: 'xiaohongshu', label: '小红书', caps: [], covers: ['3x4', '1x1'], creator_url: '', connectors: [], rule: { platform: 'xiaohongshu', ...rule(20) } },
]
const acc = (id: string, handle: string, role: VideoAccount['role']): VideoAccount => ({ id, platform: 'channels', handle, uid: '', role, caps: [], created_at: T, updated_at: T })

type Call = { method: string; path: string; body?: Record<string, unknown> }

// 内存里的发布、快照和封面测试后端：规则照 internal/plugins/video/publish.go、covertests.go 的要点
function fakeBackend(opts: { platforms?: VideoPlatformInfo[]; submitFails?: boolean } = {}) {
  const calls: Call[] = []
  const pubs: VideoPublish[] = []
  const snaps: Record<string, unknown[]> = {}
  const tests: VideoCoverTest[] = []
  const covers = [cover('vaf_1', 1), cover('vaf_2', 2), cover('vaf_3', 3)]
  const accounts = [acc('pa_m', '周七主号', 'main'), acc('pa_a', '周七 A 号', 'ab')]
  let seq = 0
  const json = (data: unknown, status = 200, meta?: unknown) => new Response(JSON.stringify(status < 300 ? { data, meta } : data), { status })
  const err = (status: number, code: string, message: string) => json({ error: { code, message } }, status)
  const state = (t: VideoCoverTest) => {
    const arms = t.arms.map((a) => {
      const m = pubs.find((p) => p.id === a.publish_id)?.metrics
      return { cover_id: a.cover_id, impressions: m?.impressions, ctr: m?.ctr }
    })
    const ranked = arms.filter((a) => a.ctr != null).sort((a, b) => b.ctr! - a.ctr!)
    const gap = ranked.length >= 2 ? ranked[0].ctr! / ranked[1].ctr! - 1 : undefined
    const reached = arms.filter((a) => (a.impressions ?? 0) >= t.min_impressions).length
    t.state = { days: 1, gap, reached, leader: ranked[0]?.cover_id, days_ok: 1 >= t.min_days, imp_ok: reached === arms.length, gap_ok: gap != null && gap >= t.min_gap,
      arms, data_incomplete: ranked.length < arms.length || undefined }
    if (t.status === 'running' && t.state.days_ok && t.state.imp_ok && !t.state.data_incomplete) {
      t.status = t.state.gap_ok ? 'decided' : 'inconclusive'
      t.winner_id = t.state.gap_ok ? t.state.leader : undefined
      t.ended_at = T
    }
    return t
  }
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input), 'http://x')
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ method, path: u.pathname, body })
    const p = u.pathname
    if (p === '/api/objects') return json([], 200, { total: 0 })
    if (p === '/api/video/series' || p === '/api/video/topics' || p === '/api/video/clips') return json([], 200, { total: 0 })
    if (p === '/api/video/videos') return json([VIDEO], 200, { total: 1 })
    if (p === '/api/video/platforms') return json(opts.platforms ?? plats(), 200, { total: 5 })
    if (p === '/api/video/accounts') return json(accounts, 200, { total: accounts.length })
    if (p === '/api/video/artifacts') return json(u.searchParams.get('kind') === 'cover' || !u.searchParams.get('video_id') ? covers : [], 200, { total: covers.length })
    if (p === '/api/video/publishes' && method === 'GET') return json(pubs, 200, { total: pubs.length })
    if (p === '/api/video/publishes' && method === 'POST') {
      const x = { id: `pb_${++seq}`, desc: '', status: 'planned', ...body, created_at: T, updated_at: T } as VideoPublish
      pubs.push(x)
      return json(x, 201)
    }
    if (p === '/api/video/cover-tests' && method === 'GET') return json(tests, 200, { total: tests.length })
    if (p === '/api/video/cover-tests' && method === 'POST') {
      const t = state({ id: `vct_${++seq}`, ...body, started_at: T, min_days: 7, min_impressions: 10000, min_gap: 0.2, status: 'running', created_at: T, updated_at: T } as VideoCoverTest)
      tests.push(t)
      return json(t, 201)
    }
    let m = p.match(/^\/api\/video\/publishes\/([^/]+)(?:\/(submit|snapshots))?$/)
    if (m) {
      const x = pubs.find((y) => y.id === m![1])
      if (!x) return err(404, 'not_found', '发布记录不存在')
      if (m[2] === 'snapshots') return json(snaps[x.id] ?? [], 200, { total: (snaps[x.id] ?? []).length, days: snaps[x.id] ?? [] })
      if (m[2] === 'submit') {
        if (opts.submitFails) { Object.assign(x, { status: 'failed', error: 'B 站：封面与内容不符' }); return err(502, 'publish_failed', 'B 站：封面与内容不符') }
        Object.assign(x, { status: 'published', url: 'https://www.bilibili.com/video/BV1xxxxxxxxx', published_at: T, error: undefined })
        return json(x)
      }
      if (method === 'PATCH') {
        for (const [k, v] of Object.entries(body)) { if (v === null) delete (x as Record<string, unknown>)[k]; else (x as Record<string, unknown>)[k] = v }
        if (body.metrics) (snaps[x.id] ??= []).push({ ...body.metrics, publish_id: x.id, day: 1, source: 'manual', created_at: T })
        tests.forEach(state)
        return json(x)
      }
      if (method === 'DELETE') { pubs.splice(pubs.indexOf(x), 1); return json(null) }
    }
    m = p.match(/^\/api\/video\/cover-tests\/([^/]+)(\/evaluate|\/decide)?$/)
    if (m) {
      const t = tests.find((y) => y.id === m![1])!
      if (method === 'PATCH') Object.assign(t, body)
      // 手动判定：门槛不动，给了 winner_id 判胜，不给判没有结论
      if (m[2] === '/decide') {
        if (t.status !== 'running') return err(409, 'conflict', '测试已经结束了，不能再判')
        Object.assign(t, { status: body?.winner_id ? 'decided' : 'inconclusive', winner_id: body?.winner_id, ended_at: T })
      }
      return json(state(t))
    }
    return err(404, 'not_found', '没有这个接口')
  }))
  return { calls, pubs, tests }
}

function show(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createMemoryRouter([{ path: '/videos/*', element: <Page /> }, { path: '*', element: <div>别的页</div> }], { initialEntries: [path] })
  render(<QueryClientProvider client={qc}><RouterProvider router={router} /></QueryClientProvider>)
  return router
}

afterEach(() => { vi.unstubAllGlobals() })

describe('发布记录', () => {
  it('登记一条视频号发布：标题超长不能提交，登记后抽屉记在地址上，填链接、回填存快照', async () => {
    const be = fakeBackend()
    const user = userEvent.setup()
    const router = show('/videos/publishes')
    expect(await screen.findByText('还没有发布记录')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /新建发布/ }))
    const d = screen.getByRole('dialog', { name: '新建发布' })
    await user.click(within(d).getByRole('radio', { name: /^视频号/ }))
    expect(within(d).getByRole('radio', { name: /周七主号/ })).toHaveAttribute('aria-checked', 'true')
    expect(within(d).getByText(/视频号不开放发布接口，只能登记/)).toBeInTheDocument()
    await user.click(within(d).getByRole('radio', { name: /周七 A 号/ }))
    await user.click(within(d).getByRole('button', { name: '封面 2 · 9:16' }))
    const title = within(d).getByRole('textbox', { name: /标题/ })
    await user.clear(title)
    await user.type(title, '一'.repeat(31))
    const submit = within(d).getByRole('button', { name: '登记发布记录' })
    expect(submit).toBeDisabled()
    expect(within(d).getByRole('alert')).toHaveTextContent('标题超长：视频号最多 30 字，现在 31 字')
    await user.clear(title)
    await user.type(title, '第 1 集 A 号')
    await user.click(submit)

    const pd = await screen.findByRole('dialog', { name: '第 1 集 A 号' })
    expect(be.calls.find((c) => c.method === 'POST' && c.path === '/api/video/publishes')?.body).toMatchObject({
      video_id: 'vd_1', platform: 'channels', variant: 'portrait', cover_id: 'vaf_2', account_id: 'pa_a', status: 'planned', title: '第 1 集 A 号',
    })
    expect(router.state.location.search).toBe('?p=pb_1')
    expect(within(pd).queryByRole('button', { name: '改为立即发布' })).toBeNull()

    await user.click(within(pd).getByRole('button', { name: '填链接，标为已发布' }))
    await user.type(within(pd).getByRole('textbox', { name: '平台链接' }), 'https://channels.weixin.qq.com/x')
    await user.click(within(pd).getByRole('button', { name: '保存，标为已发布' }))
    await user.click(await within(pd).findByRole('button', { name: '回填数据' }))
    const inputs = pd.querySelectorAll<HTMLInputElement>('.vp-metric-form input')
    await user.clear(inputs[0])
    await user.type(inputs[0], 'x')
    expect(within(pd).getByText(/只能填非负整数/)).toBeInTheDocument()
    await user.clear(inputs[0])
    await user.type(inputs[0], '900')
    await user.type(inputs[5], '8')
    await user.click(within(pd).getByRole('button', { name: '保存' }))
    expect(await within(pd).findByRole('img', { name: /按天曲线/ })).toBeInTheDocument()
    const patch = be.calls.filter((c) => c.method === 'PATCH').map((c) => c.body)
    expect(patch[0]).toMatchObject({ status: 'published', url: 'https://channels.weixin.qq.com/x' })
    expect(patch[1]?.metrics).toMatchObject({ views: 900, ctr: 0.08 })
    expect(within(pd).getByText(/1 条快照，最新是第 1 天/)).toBeInTheDocument()
  })

  it('接通的平台立即发布：建好就投稿，投不成显示原因，重试再投一次', async () => {
    const be = fakeBackend({ submitFails: true, platforms: plats({ connectors: [{ id: 'cn_1', name: 'B 站主号', account: '', status: 'connected' }] }) })
    const user = userEvent.setup()
    show('/videos/publishes?p=new')
    const d = await screen.findByRole('dialog', { name: '新建发布' })
    expect(within(d).getByText(/这集还没有 16:9、4:3 的竖屏封面/)).toBeInTheDocument()
    await user.click(within(d).getByRole('button', { name: '立即发布' }))
    const pd = await screen.findByRole('dialog', { name: '第 1 集' })
    expect(await within(pd).findByText('B 站：封面与内容不符', { selector: '.vd-err' })).toBeInTheDocument()
    await waitFor(() => expect(within(pd).getAllByRole('button', { name: '重试' }).length).toBe(2))
    await user.click(within(pd).getAllByRole('button', { name: '重试' })[1])
    await waitFor(() => expect(be.calls.filter((c) => c.path.endsWith('/submit')).length).toBe(2))
  })
})

describe('封面 A/B', () => {
  it('小号分发每张都要有发布；建好后按现在的数据提前采用，判出胜者', async () => {
    const be = fakeBackend()
    be.pubs.push(
      { id: 'pb_m', video_id: 'vd_1', platform: 'channels', variant: 'portrait', cover_id: 'vaf_1', account_id: 'pa_m', title: '主号', desc: '', status: 'published',
        metrics: { views: 1, likes: 0, comments: 0, shares: 0, impressions: 12000, ctr: 0.08, updated_at: T }, created_at: T, updated_at: T },
      { id: 'pb_a', video_id: 'vd_1', platform: 'channels', variant: 'portrait', cover_id: 'vaf_2', account_id: 'pa_a', title: 'A 号', desc: '', status: 'published',
        metrics: { views: 1, likes: 0, comments: 0, shares: 0, impressions: 11000, ctr: 0.05, updated_at: T }, created_at: T, updated_at: T },
    )
    const user = userEvent.setup()
    const router = show('/videos/publishes')
    await user.click(await screen.findByRole('button', { name: '新建测试' }))
    const d = screen.getByRole('dialog', { name: '新建封面测试' })
    expect(within(d).getByRole('radio', { name: '平台原生测试' })).toBeDisabled()
    for (const n of [1, 2, 3]) await user.click(within(d).getByRole('button', { name: `封面 ${n} · 9:16` }))
    await user.click(within(d).getByRole('button', { name: '开始测试' }))
    expect(within(d).getByRole('alert')).toHaveTextContent('标「还没发」的封面先去新建发布')
    await user.click(within(d).getByRole('button', { name: '封面 3 · 9:16' }))
    await user.click(within(d).getByRole('button', { name: '开始测试' }))

    const t = await screen.findByRole('dialog', { name: '封面 A/B 测试' })
    expect(be.calls.find((c) => c.method === 'POST' && c.path === '/api/video/cover-tests')?.body).toEqual({
      video_id: 'vd_1', platform: 'channels', mode: 'accounts', arms: [{ cover_id: 'vaf_1', publish_id: 'pb_m' }, { cover_id: 'vaf_2', publish_id: 'pb_a' }],
    })
    expect(router.state.location.search).toBe('?t=vct_1')
    expect(within(t).getByText(/条件还没全满足/)).toBeInTheDocument()
    await user.click(within(t).getByRole('button', { name: '提前采用领先的' }))
    await user.click(within(t).getByRole('button', { name: '仍然采用' }))
    expect(await within(t).findByText(/胜出，已设为主封面/)).toBeInTheDocument()
    expect(be.calls.find((c) => c.path === '/api/video/cover-tests/vct_1/decide')?.body).toEqual({ winner_id: 'vaf_1' })
    expect(be.calls.some((c) => c.method === 'PATCH' && c.path === '/api/video/cover-tests/vct_1')).toBe(false)
    expect(be.tests[0]).toMatchObject({ min_days: 7, min_impressions: 10000, min_gap: 0.2 })
    expect(within(screen.getByRole('region', { name: '封面 A/B' })).getByText(/封面 1 胜出/)).toBeInTheDocument()
  })

  it('点击率差 10 倍以上、有封面没数据也能结束不判胜负，门槛不变', async () => {
    const be = fakeBackend()
    be.pubs.push(
      { id: 'pb_m', video_id: 'vd_1', platform: 'channels', variant: 'portrait', cover_id: 'vaf_1', account_id: 'pa_m', title: '主号', desc: '', status: 'published',
        metrics: { views: 1, likes: 0, comments: 0, shares: 0, impressions: 12000, ctr: 0.08, updated_at: T }, created_at: T, updated_at: T },
      { id: 'pb_a', video_id: 'vd_1', platform: 'channels', variant: 'portrait', cover_id: 'vaf_2', account_id: 'pa_a', title: 'A 号', desc: '', status: 'published',
        metrics: { views: 1, likes: 0, comments: 0, shares: 0, impressions: 11000, ctr: 0.005, updated_at: T }, created_at: T, updated_at: T },
      { id: 'pb_b', video_id: 'vd_1', platform: 'channels', variant: 'portrait', cover_id: 'vaf_3', account_id: 'pa_a', title: 'A 号二', desc: '', status: 'planned',
        created_at: T, updated_at: T },
    )
    be.tests.push({ id: 'vct_9', video_id: 'vd_1', platform: 'channels', mode: 'accounts', started_at: T, min_days: 7, min_impressions: 10000, min_gap: 0.2,
      status: 'running', created_at: T, updated_at: T,
      arms: [{ cover_id: 'vaf_1', publish_id: 'pb_m' }, { cover_id: 'vaf_2', publish_id: 'pb_a' }, { cover_id: 'vaf_3', publish_id: 'pb_b' }],
      state: { days: 1, reached: 0, days_ok: false, imp_ok: false, gap_ok: false, arms: [] } })
    const user = userEvent.setup()
    show('/videos/publishes?t=vct_9')
    const t = await screen.findByRole('dialog', { name: '封面 A/B 测试' })
    await user.click(within(t).getByRole('button', { name: '结束，不判胜负' }))
    expect(within(t).getByText('结束测试，不判胜负，主封面不变？')).toBeInTheDocument()
    await user.click(within(t).getByRole('button', { name: '结束' }))
    expect(await within(t).findByText(/没有判胜负就结束了/)).toBeInTheDocument()
    expect(be.calls.find((c) => c.path === '/api/video/cover-tests/vct_9/decide')?.body).toEqual({})
    expect(be.calls.some((c) => c.method === 'PATCH' && c.path.startsWith('/api/video/cover-tests/'))).toBe(false)
    expect(be.tests[0]).toMatchObject({ status: 'inconclusive', min_days: 7, min_impressions: 10000, min_gap: 0.2 })
    expect(be.tests[0].winner_id).toBeUndefined()
  })
})
