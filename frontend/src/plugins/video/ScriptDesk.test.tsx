import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Video, VideoArtifact, VideoCheckpoint, VideoTopic } from '../../core/data'
import Page from './Page'
import { resetDeskStore } from './scriptModel'

const T = '2026-10-29T08:00:00Z'
const cps = (): VideoCheckpoint[] => (['plan', 'ch1', 'audio', 'distribution'] as const).map((stage) => ({ stage, state: 'pending' }))
const vid = (x: Partial<Video> = {}): Video => ({
  id: 'a', title: '新视频', orientations: [], stage: 'topic', checkpoints: cps(), root: '/tmp/a', chapters: 3, runners: [], created_at: T, updated_at: T, ...x,
})
const tp = (id: string, x: Partial<VideoTopic> = {}): VideoTopic => ({
  id, title: id, angle: '', audience: '', status: 'ready', score: { demand: 3, fit: 3, effort: 3 }, tags: [], platforms: [], outline: '',
  clip_ids: [], created_at: T, updated_at: T, ...x,
})
const art = (id: string, x: Partial<VideoArtifact>): VideoArtifact => ({
  id, video_id: 'a', kind: 'script', name: '口播稿', path: 'script-landscape.md', variant: 'landscape', version: 1, status: 'draft',
  source: { type: 'manual', label: '手写' }, reviews: [], created_at: T, updated_at: T, ...x,
})

type Call = { method: string; path: string; body?: Record<string, unknown> }

// 内存里的视频后端：选题一步照 internal/plugins/video/videotopic.go，正文照 content.go（旧版本留在 files 里按版本号存）
function fakeBackend(seed: { video?: Partial<Video>; topics?: VideoTopic[]; arts?: VideoArtifact[]; files?: Record<string, string> } = {}) {
  const calls: Call[] = []
  const v = vid(seed.video)
  const topics = (seed.topics ?? []).map((t) => ({ ...t }))
  const arts = (seed.arts ?? []).map((a) => ({ ...a }))
  // 正文：<产出物 id>@<版本>
  const files: Record<string, string> = { ...seed.files }
  let seq = 0
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(status < 300 ? { data, meta: Array.isArray(data) ? { total: data.length } : undefined } : data), { status })
  const err = (status: number, code: string, message: string) => json({ error: { code, message } }, status)
  const content = (a: VideoArtifact, version = a.version) => {
    const k = `${a.id}@${version}`
    return { artifact_id: a.id, version, path: a.path, content: files[k] ?? '', exists: k in files, size: 0, versions: Object.keys(files)
      .filter((x) => x.startsWith(`${a.id}@`)).map((x) => Number(x.split('@')[1])).filter((n) => n < a.version).sort() }
  }
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input), 'http://x')
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ method, path: u.pathname + u.search, body })
    const p = u.pathname
    if (p === '/api/objects' || p === '/api/video/series' || p === '/api/video/clips') return json([])
    if (p === '/api/sop/flows' || p === '/api/agents') return json([])
    if (p === '/api/video/videos') return json([v])
    if (p === '/api/video/videos/a') return json(v)
    if (p === '/api/video/topics' && method === 'GET') return json(topics)
    if (p === '/api/video/topics' && method === 'POST') {
      const t = tp(`tp_new${++seq}`, { ...body, status: 'idea' })
      topics.unshift(t)
      return json(t, 201)
    }
    if (p === '/api/video/videos/a/topic') {
      const t = topics.find((x) => x.id === body.topic_id)
      if (!t) return err(400, 'validation', '选题不存在')
      if (t.video_id) return err(409, 'conflict', '这个选题已经挂在别的视频上了')
      const prev = topics.find((x) => x.id === v.topic_id)
      if (prev) { prev.video_id = undefined; prev.status = 'ready' }
      Object.assign(t, { video_id: 'a', status: 'made' })
      v.topic_id = t.id
      if (v.title === '新视频' && t.title) v.title = t.title
      return json({ video: v, topic: t })
    }
    if (p === '/api/video/videos/a/advance') {
      if (v.stage === 'topic' && !v.topic_id) return err(400, 'validation', '先选一个选题或新建一个')
      v.stage = v.stage === 'topic' ? 'script' : 'plan'
      return json(v)
    }
    if (p === '/api/video/videos/a/runners/script/run') {
      if (!v.topic_id) return err(409, 'conflict', '「内容编写」还没配执行器，先配一个再跑')
      v.last_run = { type: 'agent', id: 'run_1', stage: 'script', status: 'running', started_at: new Date().toISOString(), ref: 'ags_1' }
      return json(v, 202)
    }
    if (p === '/api/video/artifacts' && method === 'GET') return json(arts)
    if (p === '/api/video/artifacts' && method === 'POST') {
      const a = art(`vaf_n${++seq}`, { ...body, version: 1, status: 'draft', source: { type: 'manual', label: '手动登记' } })
      arts.push(a)
      return json(a, 201)
    }
    const m = p.match(/^\/api\/video\/artifacts\/([a-z0-9_]+)(\/content)?$/)
    const a = m && arts.find((x) => x.id === m[1])
    if (!m || !a) return err(404, 'not_found', '没有这个接口')
    if (m[2] && method === 'GET') return json(content(a, Number(u.searchParams.get('version')) || a.version))
    if (m[2] && method === 'PUT') {
      if (body.from !== undefined && body.from !== a.version) return err(409, 'conflict', `已经是第 ${a.version} 版了，刷新后再操作`)
      if (body.new_version) Object.assign(a, { version: a.version + 1, status: 'draft', source: { type: 'manual', label: '手写' } })
      files[`${a.id}@${a.version}`] = body.content
      return json({ artifact: a, content: content(a) })
    }
    if (method === 'PATCH') { Object.assign(a, body); return json(a) }
    if (method === 'DELETE') { arts.splice(arts.indexOf(a), 1); return json(null) }
    return err(404, 'not_found', '没有这个接口')
  }))
  return {
    calls, v, topics, arts, files,
    // 起草跑完：同后端 finishRun，口播稿、大纲升版本成待验收，来源记成执行器
    finishDraft: (bodies: Record<string, string>) => {
      const ids: string[] = []
      for (const [kind, text] of Object.entries(bodies)) {
        let a = arts.find((x) => x.kind === kind && x.variant === 'landscape')
        const src = { type: 'skill' as const, label: '网页演示做视频', id: 'sk_video' }
        if (a) Object.assign(a, { version: a.version + 1, status: 'review', source: src })
        else { a = art(`vaf_r${++seq}`, { kind: kind as VideoArtifact['kind'], name: kind === 'script' ? '口播稿' : '大纲', path: `${kind}-landscape.md`, status: 'review', source: src }); arts.push(a) }
        files[`${a.id}@${a.version}`] = text
        ids.push(a.id)
      }
      v.last_run = { ...v.last_run!, status: 'done', ended_at: new Date().toISOString(), artifact_ids: ids }
    },
  }
}

function show(path = '/videos/v/a') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createMemoryRouter([{ path: '/videos/*', element: <Page /> }], { initialEntries: [path] })
  render(<QueryClientProvider client={qc}><RouterProvider router={router} /></QueryClientProvider>)
  return router
}

const step = (name: string) => screen.findByRole('listitem', { name })

beforeEach(() => resetDeskStore())
afterEach(() => { vi.unstubAllGlobals() })

describe('选题一步', () => {
  it('没挂选题：确认不可点；从选题库挑一个，标题跟着换，再确认进内容编写', async () => {
    const be = fakeBackend({ topics: [tp('tp_lo', { title: '低分题', score: { demand: 1, fit: 1, effort: 5 } }), tp('tp_hi', { title: '高分题', angle: '反着讲', outline: '1. 开场\n2. 结论' }),
      tp('tp_done', { title: '已做成', status: 'made', video_id: 'x' }), tp('tp_drop', { title: '放弃的', status: 'dropped' })] })
    show()
    const user = userEvent.setup()
    const li = await step('选题')
    expect(within(li).getByText(/这一集还没挂选题/)).toBeInTheDocument()
    expect(within(li).getByRole('button', { name: '确认选题，进入「内容编写」' })).toBeDisabled()

    await user.click(within(li).getByRole('button', { name: '从选题库选一个' }))
    const names = screen.getAllByRole('option').map((o) => o.textContent)
    // 只列没立项、没放弃的，按优先级排
    expect(names).toHaveLength(2)
    expect(names[0]).toContain('高分题')
    await user.click(screen.getAllByRole('option')[0])
    await waitFor(() => expect(be.calls.some((c) => c.method === 'PUT' && c.path === '/api/video/videos/a/topic')).toBe(true))
    expect(be.calls.find((c) => c.method === 'PUT')?.body).toEqual({ topic_id: 'tp_hi' })

    const box = await within(li).findByRole('button', { name: '高分题' })
    expect(box).toBeInTheDocument()
    expect(within(li).getByText('反着讲')).toBeInTheDocument()
    expect(within(li).getByText('开场')).toBeInTheDocument()
    expect(await screen.findByRole('heading', { name: '高分题' })).toBeInTheDocument()

    await user.click(within(li).getByRole('button', { name: '确认选题，进入「内容编写」' }))
    await waitFor(() => expect(be.v.stage).toBe('script'))
    expect(be.calls.find((c) => c.path.endsWith('/advance'))?.body).toEqual({ from: 'topic' })
    expect(await screen.findByLabelText('内容编写编辑区')).toBeInTheDocument()
  })

  it('换一个：换下来的回到可开拍；没写大纲提示去补', async () => {
    const be = fakeBackend({ video: { topic_id: 'tp_a', stage: 'script' }, topics: [tp('tp_a', { title: '原来的', status: 'made', video_id: 'a' }), tp('tp_b', { title: '新的' })] })
    show()
    const user = userEvent.setup()
    const li = await step('选题')
    expect(await within(li).findByText(/还没写大纲，按大纲起草要先补上/)).toBeInTheDocument()
    await user.click(within(li).getByRole('button', { name: '换一个' }))
    await user.click(screen.getByRole('option', { name: /新的/ }))
    expect(await within(li).findByRole('button', { name: '新的' })).toBeInTheDocument()
    expect(be.topics.find((t) => t.id === 'tp_a')).toMatchObject({ status: 'ready', video_id: undefined })
  })

  it('新建选题：标题取本集标题，系列同本集，挂上后打开选题抽屉', async () => {
    const be = fakeBackend({ video: { title: '第 3 集：讲讲缓存', episode: 3 } })
    show()
    const user = userEvent.setup()
    const li = await step('选题')
    expect(within(li).getByRole('button', { name: '从选题库选一个' })).toBeDisabled()
    await user.click(within(li).getByRole('button', { name: '新建选题' }))
    expect(await screen.findByRole('dialog', { name: '讲讲缓存' })).toBeInTheDocument()
    expect(be.calls.find((c) => c.method === 'POST' && c.path === '/api/video/topics')?.body).toEqual({
      title: '讲讲缓存', series_id: null, score: { demand: 3, fit: 3, effort: 3 },
    })
    expect(be.v.topic_id).toBe('tp_new1')
  })
})

describe('内容编写', () => {
  it('写横屏口播稿：草稿留在本机，保存先登记 v1 再写正文，交给验收标待验收', async () => {
    const be = fakeBackend({ video: { stage: 'script', orientations: ['landscape', 'portrait'] } })
    show()
    const user = userEvent.setup()
    const desk = await screen.findByLabelText('内容编写编辑区')
    // 两个比例两栏口播稿，加一栏大纲（栏头能切比例）
    expect(within(desk).getByRole('textbox', { name: '口播稿（横屏）' })).toBeInTheDocument()
    expect(within(desk).getByRole('textbox', { name: '口播稿（竖屏）' })).toBeInTheDocument()
    expect(within(desk).getByRole('group', { name: '大纲的比例' })).toBeInTheDocument()
    // 没挂选题不能起草
    expect(within(desk).getByRole('button', { name: '按选题大纲起草' })).toBeDisabled()

    const pane = within(desk).getByLabelText('口播稿（横屏）编辑器')
    expect(within(pane).getByRole('button', { name: '交给验收' })).toBeDisabled()
    expect(within(pane).getByText('稿子是空的，写了才能交验收')).toBeInTheDocument()
    await user.type(within(pane).getByRole('textbox'), '## 开场\n大家好')
    expect(within(pane).getByText(/草稿已自动保存/)).toBeInTheDocument()
    expect(within(pane).getByText(/5 字 · 约 1 秒/)).toBeInTheDocument()
    expect(window.localStorage.getItem('pmw.video.script-desk')).toContain('大家好')

    await user.click(within(pane).getByRole('button', { name: '保存为 v1' }))
    await waitFor(() => expect(be.arts).toHaveLength(1))
    expect(be.calls.find((c) => c.method === 'POST' && c.path === '/api/video/artifacts')?.body).toEqual({
      video_id: 'a', kind: 'script', name: '口播稿', path: 'script-landscape.md', variant: 'landscape',
    })
    expect(be.calls.find((c) => c.method === 'PUT')?.body).toEqual({ content: '## 开场\n大家好', from: 1 })
    expect(await within(pane).findByRole('button', { name: '打开口播稿（横屏） v1' })).toBeInTheDocument()
    expect(within(pane).queryByText(/草稿已自动保存/)).toBeNull()

    await user.click(within(pane).getByRole('button', { name: '交给验收' }))
    await waitFor(() => expect(be.arts[0].status).toBe('review'))
    expect(await within(pane).findByRole('button', { name: '已在待验收' })).toBeDisabled()
  })

  it('已有版本：改了存成下一版，保存并交验收一步做完；改回原样草稿就删掉', async () => {
    const be = fakeBackend({ video: { stage: 'script', orientations: ['landscape'] }, arts: [art('vaf_s', { version: 2 })], files: { 'vaf_s@2': '原来的稿子' } })
    show()
    const user = userEvent.setup()
    const pane = await screen.findByLabelText('口播稿（横屏）编辑器')
    const box = within(pane).getByRole('textbox')
    await waitFor(() => expect(box).toHaveValue('原来的稿子'))
    await user.type(box, '！')
    expect(within(pane).getByRole('button', { name: '保存并交验收' })).toBeEnabled()
    await user.type(box, '{Backspace}')
    expect(within(pane).queryByText(/草稿已自动保存/)).toBeNull()
    expect(within(pane).getByRole('button', { name: '交给验收' })).toBeEnabled()

    await user.type(box, '，改一句')
    await user.click(within(pane).getByRole('button', { name: '保存并交验收' }))
    await waitFor(() => expect(be.arts[0]).toMatchObject({ version: 3, status: 'review' }))
    expect(be.calls.find((c) => c.method === 'PUT')?.body).toEqual({ content: '原来的稿子，改一句', new_version: true, from: 2 })
    expect(be.files['vaf_s@2']).toBe('原来的稿子')
  })

  it('按选题大纲起草：跑完对比起草前的版本，丢弃退回旧正文存成下一版，采用就留着', async () => {
    const be = fakeBackend({
      video: { stage: 'script', orientations: ['landscape'], topic_id: 'tp_a' },
      topics: [tp('tp_a', { title: '缓存', status: 'made', video_id: 'a', outline: '1. 为什么' })],
      arts: [art('vaf_s', { version: 1 })], files: { 'vaf_s@1': '手写的旧稿' },
    })
    show()
    const user = userEvent.setup()
    const desk = await screen.findByLabelText('内容编写编辑区')
    expect(within(desk).getByText(/可以照选题「缓存」的角度和大纲起草/)).toBeInTheDocument()
    await user.click(within(desk).getByRole('button', { name: '按选题大纲起草' }))
    expect(await within(desk).findByRole('button', { name: '起草中…' })).toBeDisabled()
    expect(within(desk).getByText(/正在起草，开始于/)).toBeInTheDocument()
    expect(be.calls.find((c) => c.path.endsWith('/runners/script/run'))?.method).toBe('POST')

    be.finishDraft({ script: '起草的口播稿', outline: '# 起草的大纲' })
    const cmp = await within(desk).findByLabelText('初稿对比', undefined, { timeout: 6000 })
    expect(within(cmp).getByText('初稿 2 份')).toBeInTheDocument()
    const row = within(cmp).getByLabelText('横屏口播稿初稿')
    expect(within(row).getByText('起草前（v1）')).toBeInTheDocument()
    expect(await within(row).findByText('手写的旧稿')).toBeInTheDocument()
    expect(within(row).getByText('起草的口播稿')).toBeInTheDocument()
    expect(within(desk).getByRole('button', { name: '重新起草' })).toBeEnabled()

    await user.click(within(row).getByRole('button', { name: '丢弃' }))
    await waitFor(() => expect(be.arts.find((a) => a.id === 'vaf_s')).toMatchObject({ version: 3, source: { type: 'manual' } }))
    expect(be.files['vaf_s@3']).toBe('手写的旧稿')
    // 大纲是起草新登记的第一版：采用就留着
    const outline = await within(cmp).findByLabelText('大纲初稿')
    await user.click(within(outline).getByRole('button', { name: '采用' }))
    await waitFor(() => expect(within(desk).queryByLabelText('初稿对比')).toBeNull())
    expect(be.arts.find((a) => a.kind === 'outline')).toMatchObject({ version: 1, status: 'review' })
  }, 15000)

  it('过了内容编写的集：点开编辑区，能收起；规划检查列要对齐的文稿和提醒', async () => {
    fakeBackend({ video: { stage: 'plan', orientations: ['landscape', 'portrait'] }, arts: [art('vaf_s', { version: 2 })], files: { 'vaf_s@2': '稿' } })
    show()
    const user = userEvent.setup()
    const plan = await step('规划检查')
    const docs = await within(plan).findByLabelText('要对齐的文稿')
    expect(within(docs).getByText('竖屏还没有口播稿')).toBeInTheDocument()
    expect(within(docs).getByText('横屏口播稿 v2 还是草稿，没交验收')).toBeInTheDocument()

    const script = await step('内容编写')
    expect(within(script).queryByLabelText('内容编写编辑区')).toBeNull()
    await user.click(within(script).getByRole('button', { name: '打开编辑区改文稿' }))
    const desk = within(script).getByLabelText('内容编写编辑区')
    // 不在内容编写不能起草
    expect(within(desk).getByRole('button', { name: '按选题大纲起草' })).toBeDisabled()
    await user.click(within(desk).getByRole('button', { name: '收起' }))
    expect(within(script).queryByLabelText('内容编写编辑区')).toBeNull()
  })
})
