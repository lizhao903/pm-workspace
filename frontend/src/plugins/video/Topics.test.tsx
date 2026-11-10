// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { VideoClip, VideoTopic } from '../../core/data'
import Page from './Page'

const T = '2026-10-29T08:00:00Z'
const tp = (id: string, x: Partial<VideoTopic> = {}): VideoTopic => ({
  id, title: id, angle: '', audience: '', status: 'idea', score: { demand: 3, fit: 3, effort: 3 }, tags: [], platforms: [], outline: '',
  clip_ids: [], created_at: T, updated_at: T, ...x,
})

type Call = { method: string; path: string; body?: Record<string, unknown> }

// 内存里的选题和素材后端：规则照 internal/plugins/video/topics.go、clips.go
function fakeBackend(seedTopics: VideoTopic[], seedClips: VideoClip[] = []) {
  const calls: Call[] = []
  const topics = seedTopics.map((t) => ({ ...t }))
  const clips = seedClips.map((c) => ({ ...c }))
  const videos: { id: string; title: string }[] = []
  let seq = 0
  const now = () => new Date().toISOString()
  const json = (data: unknown, status = 200, meta?: unknown) => new Response(JSON.stringify(status < 300 ? { data, meta } : data), { status })
  const err = (status: number, code: string, message: string) => json({ error: { code, message } }, status)
  const link = (t: VideoTopic, c: VideoClip) => {
    if (!t.clip_ids.includes(c.id)) t.clip_ids.push(c.id)
    if (!c.topic_ids.includes(t.id)) c.topic_ids.push(t.id)
    c.triaged = true
  }
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input), 'http://x')
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ method, path: u.pathname, body })
    const p = u.pathname
    if (p === '/api/objects') return json([], 200, { total: 0 })
    if (p === '/api/video/series') return json([], 200, { total: 0 })
    if (p === '/api/video/videos') return json(videos, 200, { total: videos.length })
    if (p === '/api/video/topics' && method === 'GET') return json(topics, 200, { total: topics.length })
    if (p === '/api/video/topics' && method === 'POST') {
      const t = tp(`tp_${++seq}`, { title: '', ...body })
      topics.push(t)
      return json(t, 201)
    }
    if (p === '/api/video/clips' && method === 'GET') return json(clips, 200, { total: clips.length, todo: clips.filter((c) => !c.triaged).length })
    if (p === '/api/video/clips' && method === 'POST') {
      const c: VideoClip = {
        id: `cl_${++seq}`, kind: body.kind, title: body.title ?? (body.url ? body.url.replace(/^https?:\/\//, '').slice(0, 60) : body.content.slice(0, 40)),
        content: body.content ?? '', url: body.url, source: body.source ?? '手动添加', heat: body.heat, tags: [], starred: false, topic_ids: [], triaged: false,
        created_at: now(), updated_at: now(),
      }
      clips.unshift(c)
      return json(c, 201)
    }
    let m = p.match(/^\/api\/video\/topics\/([^/]+)(\/make)?$/)
    if (m) {
      const t = topics.find((x) => x.id === m![1])
      if (!t) return err(404, 'not_found', '选题不存在')
      if (m[2]) {
        if (!t.title.trim()) return err(400, 'validation', '先写标题')
        const v = { id: `vd_${++seq}`, title: t.title }
        videos.push(v)
        Object.assign(t, { video_id: v.id, status: 'made' })
        return json({ topic: t, video: v }, 201)
      }
      if (method === 'PATCH') {
        if (body.clip_ids) {
          for (const c of clips) c.topic_ids = c.topic_ids.filter((x) => x !== t.id || body.clip_ids.includes(c.id))
        }
        Object.assign(t, body, { updated_at: now() })
        return json(t)
      }
      if (method === 'DELETE') { topics.splice(topics.indexOf(t), 1); return json(null) }
      return json(t)
    }
    m = p.match(/^\/api\/video\/clips\/([^/]+)(?:\/(topic|link))?$/)
    if (m) {
      const c = clips.find((x) => x.id === m![1])
      if (!c) return err(404, 'not_found', '素材不存在')
      if (m[2] === 'topic') {
        const t = tp(`tp_${++seq}`, { title: c.title, outline: c.content, score: { demand: (c.heat ?? 0) > 10000 ? 4 : 3, fit: 3, effort: 3 } })
        topics.push(t)
        link(t, c)
        return json({ topic: t, clip: c }, 201)
      }
      if (m[2] === 'link') {
        const t = topics.find((x) => x.id === body.topic_id)!
        link(t, c)
        return json({ topic: t, clip: c })
      }
      if (method === 'PATCH') { Object.assign(c, body); return json(c) }
      if (method === 'DELETE') {
        clips.splice(clips.indexOf(c), 1)
        for (const t of topics) t.clip_ids = t.clip_ids.filter((x) => x !== c.id)
        return json(null)
      }
    }
    return err(404, 'not_found', '没有这个接口')
  }))
  return { calls, topics, clips, videos }
}

function show(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createMemoryRouter([{ path: '/videos/*', element: <Page /> }], { initialEntries: [path] })
  render(<QueryClientProvider client={qc}><RouterProvider router={router} /></QueryClientProvider>)
  return router
}

afterEach(() => { vi.unstubAllGlobals() })

describe('选题库', () => {
  it('看板按状态分列，按方向筛、搜索；表格按状态筛', async () => {
    fakeBackend([
      tp('tp_a', { title: 'MCP 去掉 session', tags: ['AI'] }),
      tp('tp_b', { title: '碳板跑鞋', tags: ['跑步'], status: 'scheduled' }),
      tp('tp_c', { title: '配速怎么练', tags: ['跑步'] }),
    ])
    const user = userEvent.setup()
    const router = show('/videos/topics')
    const idea = await screen.findByRole('region', { name: '想法' })
    expect(within(idea).getAllByRole('button').map((b) => b.textContent)).toEqual([expect.stringContaining('MCP'), expect.stringContaining('配速')])
    expect(within(screen.getByRole('region', { name: '已排期' })).getByText('碳板跑鞋')).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: '放弃' })).toBeNull()

    await user.click(screen.getByRole('button', { name: '按方向筛选' }))
    await user.click(await screen.findByRole('option', { name: /跑步/ }))
    expect(router.state.location.search).toBe('?dir=%E8%B7%91%E6%AD%A5')
    expect(screen.queryByText('MCP 去掉 session')).toBeNull()
    await user.type(screen.getByRole('searchbox', { name: '搜索选题' }), '配速')
    expect(screen.queryByText('碳板跑鞋')).toBeNull()
    expect(screen.getByText('配速怎么练')).toBeInTheDocument()

    await user.clear(screen.getByRole('searchbox', { name: '搜索选题' }))
    await user.click(screen.getByRole('button', { name: '表格' }))
    await user.click(screen.getByRole('button', { name: '按状态筛选' }))
    await user.click(await screen.findByRole('option', { name: /已排期/ }))
    expect(screen.getByText('碳板跑鞋')).toBeInTheDocument()
    expect(screen.queryByText('配速怎么练')).toBeNull()
  })

  it('抽屉改草稿保存、打分，立项后跳到视频', async () => {
    const be = fakeBackend([tp('tp_a', { title: '' })])
    const user = userEvent.setup()
    const router = show('/videos/topics?t=tp_a')
    const drawer = await screen.findByRole('dialog', { name: '未命名选题' })
    expect(within(drawer).getByRole('button', { name: '立项做成视频' })).toBeDisabled()
    await user.type(within(drawer).getByPlaceholderText('这一期讲什么'), '跑鞋怎么选')
    await user.click(within(drawer).getByRole('button', { name: '需求度 5' }))
    await user.click(within(drawer).getByRole('button', { name: '可开拍' }))
    await user.click(within(drawer).getByRole('button', { name: 'B 站' }))
    await user.click(within(drawer).getByRole('button', { name: '保存' }))
    await waitFor(() => expect(be.topics[0]).toMatchObject({ title: '跑鞋怎么选', status: 'ready', platforms: ['bilibili'], score: { demand: 5, fit: 3, effort: 3 } }))
    expect(be.calls.find((c) => c.method === 'PATCH')?.body).toEqual({ title: '跑鞋怎么选', status: 'ready', score: { demand: 5, fit: 3, effort: 3 }, platforms: ['bilibili'] })
    expect(await within(drawer).findByText('已保存')).toBeInTheDocument()

    await user.click(within(drawer).getByRole('button', { name: '立项做成视频' }))
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/videos\/v\/vd_/))
    expect(be.topics[0]).toMatchObject({ status: 'made' })
  })

  it('删除要确认，关联的素材保留', async () => {
    const be = fakeBackend([tp('tp_a', { title: '要删的', clip_ids: ['cl_x'] })], [{
      id: 'cl_x', kind: 'note', title: '一条笔记', content: '一条笔记', source: '手动添加', tags: [], starred: false, topic_ids: ['tp_a'], triaged: true, created_at: T, updated_at: T,
    }])
    const user = userEvent.setup()
    show('/videos/topics?t=tp_a')
    const drawer = await screen.findByRole('dialog', { name: '要删的' })
    expect(within(drawer).getByText('一条笔记')).toBeInTheDocument()
    await user.click(within(drawer).getByRole('button', { name: '删除' }))
    const dlg = await screen.findByRole('alertdialog')
    expect(within(dlg).getByText('1 条关联素材保留，只解除关联')).toBeInTheDocument()
    await user.click(within(dlg).getByRole('button', { name: '删除' }))
    await waitFor(() => expect(be.topics).toEqual([]))
    expect(be.clips).toHaveLength(1)
  })
})

describe('素材收件箱', () => {
  it('收集评论后转为选题，打开新选题的抽屉', async () => {
    const be = fakeBackend([])
    const user = userEvent.setup()
    const router = show('/videos/clips')
    expect(await screen.findByText('待整理的都处理完了')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '收集评论' }))
    const form = screen.getByRole('region', { name: '收集评论' })
    await user.type(within(form).getByRole('textbox', { name: '评论' }), '能讲讲 Cursor 和 Claude Code 怎么选吗 326')
    await user.type(within(form).getByRole('textbox', { name: '来源' }), 'B 站评论 · 第 3 集')
    await user.click(within(form).getByRole('button', { name: '收进 1 条' }))
    expect(await screen.findByText('收进 1 条评论')).toBeInTheDocument()
    expect(be.calls.find((c) => c.method === 'POST')?.body).toEqual({ kind: 'comment', content: '能讲讲 Cursor 和 Claude Code 怎么选吗', source: 'B 站评论 · 第 3 集', heat: 326 })
    const card = await screen.findByRole('article', { name: '能讲讲 Cursor 和 Claude Code 怎么选吗' })
    expect(within(card).getByText('评论')).toBeInTheDocument()
    expect(within(card).getByText('326')).toBeInTheDocument()
    expect(within(screen.getByRole('tablist', { name: '视频' })).getByRole('tab', { name: /素材收件箱/ })).toHaveTextContent('1')

    await user.click(within(card).getByRole('button', { name: '转为选题' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/videos/topics'))
    const drawer = await screen.findByRole('dialog', { name: '能讲讲 Cursor 和 Claude Code 怎么选吗' })
    expect(within(drawer).getByText('B 站评论 · 第 3 集')).toBeInTheDocument()
    expect(be.clips[0]).toMatchObject({ triaged: true, topic_ids: [be.topics[0].id] })
  })

  it('粘贴链接收进来，归到选题、收藏、看过了、删除', async () => {
    const be = fakeBackend([tp('tp_a', { title: '进行中的题' }), tp('tp_b', { title: '做完了', status: 'made', video_id: 'vd_1' })])
    const user = userEvent.setup()
    show('/videos/clips')
    const input = await screen.findByRole('textbox', { name: '收进来' })
    await user.type(input, 'https://www.bilibili.com/video/BV1demo{Enter}')
    const card = await screen.findByRole('article', { name: 'www.bilibili.com/video/BV1demo' })
    expect(within(card).getByRole('link')).toHaveAttribute('href', 'https://www.bilibili.com/video/BV1demo')

    await user.click(within(card).getByRole('button', { name: /归到选题/ }))
    expect(screen.queryByRole('option', { name: /做完了/ })).toBeNull()
    await user.click(await screen.findByRole('option', { name: /进行中的题/ }))
    await waitFor(() => expect(be.topics[0].clip_ids).toEqual([be.clips[0].id]))
    // 记为已整理，从待整理里消失；切到全部能看到挂上的选题
    await waitFor(() => expect(screen.queryByRole('article')).toBeNull())
    await user.click(within(screen.getByRole('group', { name: '收件箱' })).getByRole('button', { name: /全部/ }))
    const again = await screen.findByRole('article')
    expect(within(again).getByRole('button', { name: '选题：进行中的题' })).toBeInTheDocument()
    await user.click(within(again).getByRole('button', { name: '收藏' }))
    await waitFor(() => expect(be.clips[0].starred).toBe(true))

    await user.click(within(again).getByRole('button', { name: '删除' }))
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: '删除' }))
    await waitFor(() => expect(be.clips).toEqual([]))
    expect(be.topics[0].clip_ids).toEqual([])
  })

  it('看过了：从待整理移走', async () => {
    const be = fakeBackend([], [{
      id: 'cl_x', kind: 'trend', title: '热词', content: '', source: 'B 站热搜', heat: 21000, tags: [], starred: false, topic_ids: [], triaged: false, created_at: T, updated_at: T,
    }])
    const user = userEvent.setup()
    show('/videos/clips')
    const card = await screen.findByRole('article', { name: '热词' })
    expect(within(card).getByText('21,000')).toBeInTheDocument()
    await user.click(within(card).getByRole('button', { name: '看过了' }))
    await waitFor(() => expect(be.clips[0].triaged).toBe(true))
    expect(await screen.findByText('待整理的都处理完了')).toBeInTheDocument()
  })
})
