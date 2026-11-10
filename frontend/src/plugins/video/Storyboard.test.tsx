// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Video, VideoArtifact, VideoBroll, VideoMediaFile, VideoShot } from '../../core/data'
import { StoryboardDesk } from './StoryboardDesk'
import { clipText, fileMeta, fmtSec, fmtSize, moveId, parseSec, readDragged, totalSeconds } from './storyboardModel'

const T = '2026-11-05T08:00:00Z'
const v: Video = {
  id: 'a', title: '分镜', orientations: ['landscape'], stage: 'script', checkpoints: [], root: '/tmp/a', chapters: 3, runners: [], created_at: T, updated_at: T,
}
const script: VideoArtifact = {
  id: 'vaf_1', video_id: 'a', kind: 'script', name: '口播稿', path: 'script.md', variant: 'landscape', version: 2, status: 'draft',
  source: { type: 'manual', label: '手写' }, reviews: [], created_at: T, updated_at: T,
}
const shot = (id: string, no: number, x: Partial<VideoShot> = {}): VideoShot => ({
  id, video_id: 'a', no, text: `第 ${no} 段`, visual: '', duration: null, est: 3, brolls: [], created_at: T, updated_at: T, ...x,
})
const broll = (id: string, x: Partial<VideoBroll> = {}): VideoBroll => ({
  id, shot_id: 's1', root_id: 'vmr_1', path: `clips/${id}.mp4`, name: `${id}.mp4`, kind: 'video', note: '', in: null, out: null, missing: false, created_at: T, ...x,
})
const file = (name: string, kind: 'image' | 'video'): VideoMediaFile => ({ name, path: name, kind, size: 2048, modified_at: T, width: 320, height: 180, thumb: true })

type Call = { method: string; path: string; body?: Record<string, unknown> }

function fakeBackend(seed: VideoShot[]) {
  const calls: Call[] = []
  let shots = seed.map((s) => ({ ...s, brolls: [...s.brolls] }))
  const json = (data: unknown, status = 200, meta?: unknown) => new Response(JSON.stringify(status < 300 ? { data, meta } : data), { status })
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input), 'http://x')
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ method, path: u.pathname + u.search, body })
    const p = u.pathname
    if (p === '/api/video/videos/a/shots' && method === 'GET') return json(shots)
    if (p === '/api/video/videos/a/shots/generate') {
      if (shots.length && !body.mode) return json({ error: { code: 'conflict', message: `已经有 ${shots.length} 个分镜，选追加还是覆盖` } }, 409)
      const base = body.mode === 'append' ? shots : []
      shots = [...base, shot('g1', base.length + 1, { visual: '开场' }), shot('g2', base.length + 2)]
      return json({ shots, added: 2, source: { artifact_id: 'vaf_1', kind: 'script', variant: 'landscape', version: 2 } })
    }
    if (p.startsWith('/api/video/shots/') && method === 'PATCH') {
      const s = shots.find((x) => x.id === p.split('/').pop())!
      Object.assign(s, body)
      return json(shots)
    }
    if (p === '/api/video/shots/s1/brolls' && method === 'POST') {
      const s = shots.find((x) => x.id === 's1')!
      for (const it of body.items) s.brolls.push(broll(`b${s.brolls.length + 1}`, { root_id: it.root_id, path: it.path, name: it.path, kind: it.path.endsWith('.png') ? 'image' : 'video' }))
      return json(shots)
    }
    if (p.startsWith('/api/video/brolls/') && method === 'PATCH') {
      const b = shots.flatMap((s) => s.brolls).find((x) => x.id === p.split('/').pop())!
      Object.assign(b, body)
      return json(shots)
    }
    if (p === '/api/video/media/roots') {
      return json([{ id: 'project', name: '工程目录', path: '/tmp/a', builtin: true, available: true }, { id: 'vmr_1', name: '素材库', path: '/m', builtin: false, available: true }])
    }
    if (p === '/api/video/media/browse') {
      return json({ root: { id: u.searchParams.get('root') }, dir: '', dirs: [{ name: 'sub', path: 'sub' }], files: [file('cover.png', 'image'), file('take.mp4', 'video')],
        truncated: false, tools: { probe: true, thumbs: true } }, 200, { total: 2, page: 1, page_size: 48 })
    }
    return json({ error: { code: 'not_found', message: p } }, 404)
  }))
  return calls
}

function renderDesk(arts: VideoArtifact[] = [script]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}><StoryboardDesk v={v} arts={arts} /></QueryClientProvider>)
}

afterEach(() => vi.unstubAllGlobals())

describe('分镜的纯函数', () => {
  it('时长、入出点、大小、排序', () => {
    expect(fmtSec(65)).toBe('1:05')
    expect(fmtSec(8.5)).toBe('0:08.5')
    expect(fmtSec(3723)).toBe('1:02:03')
    expect(parseSec('12')).toBe(12)
    expect(parseSec('1:05')).toBe(65)
    expect(parseSec('1:02:03')).toBe(3723)
    expect(parseSec('0:01.5')).toBe(1.5)
    expect(parseSec('')).toBeNull()
    expect(parseSec('1:75')).toBeUndefined()
    expect(parseSec('abc')).toBeUndefined()
    expect(totalSeconds([{ duration: 10, est: 3 }, { duration: null, est: 4 }])).toBe(14)
    expect(fmtSize(512)).toBe('512 B')
    expect(fmtSize(2048)).toBe('2.0 KB')
    expect(fileMeta({ width: 320, height: 180, duration: 2, size: 2048 })).toBe('320×180 · 0:02 · 2.0 KB')
    expect(clipText({ in: 1.5, out: 4 })).toBe('0:01.5 到 0:04')
    expect(clipText({ in: null, out: null })).toBe('')
    expect(moveId(['a', 'b', 'c'], 'c', 0)).toEqual(['c', 'a', 'b'])
    expect(moveId(['a', 'b', 'c'], 'a', 2)).toEqual(['b', 'c', 'a'])
    expect(readDragged('[{"root_id":"r","path":"x.png"},{"bad":1}]')).toEqual([{ root_id: 'r', path: 'x.png' }])
    expect(readDragged('nope')).toEqual([])
  })
})

describe('分镜视图', () => {
  it('没有分镜时一键生成；已有分镜时先问追加还是覆盖', async () => {
    const calls = fakeBackend([])
    renderDesk()
    const user = userEvent.setup()
    expect(await screen.findByText(/还没有分镜/)).toBeTruthy()
    await user.click(screen.getByRole('button', { name: '从口播稿生成' }))
    expect(await screen.findByText('按口播稿 v2 生成了 2 个分镜')).toBeTruthy()
    expect(screen.getAllByRole('listitem', { name: /个分镜$/ })).toHaveLength(2)
    expect(calls.find((c) => c.path.endsWith('/generate'))?.body).toEqual({})

    await user.click(screen.getByRole('button', { name: '从口播稿生成' }))
    const ask = screen.getByRole('alertdialog', { name: '已有分镜' })
    expect(within(ask).getByText('已经有 2 个分镜。生成的初稿要：')).toBeTruthy()
    await user.click(within(ask).getByRole('button', { name: '追加到后面' }))
    await waitFor(() => expect(screen.getAllByRole('listitem', { name: /个分镜$/ })).toHaveLength(4))
    expect(calls.filter((c) => c.path.endsWith('/generate')).at(-1)?.body).toEqual({ mode: 'append' })
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('没有口播稿和大纲时不能生成', async () => {
    fakeBackend([])
    renderDesk([])
    const btn = await screen.findByRole('button', { name: '从口播稿生成' })
    expect((btn as HTMLButtonElement).disabled).toBe(true)
    expect(btn.title).toContain('先在「文稿」里写口播稿或大纲')
  })

  it('编辑口播、画面、时长，失焦保存；缺失的 B-roll 标出来；入出点不对不存', async () => {
    const calls = fakeBackend([shot('s1', 1, { brolls: [broll('b1'), broll('b2', { missing: true, kind: 'image', path: 'gone.png', name: 'gone.png' })] })])
    renderDesk()
    const user = userEvent.setup()
    const row = await screen.findByRole('listitem', { name: '第 1 个分镜' })
    const visual = within(row).getByRole('textbox', { name: '第 1 个分镜的画面说明' })
    await user.type(visual, '录屏')
    await user.tab()
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH' && c.path === '/api/video/shots/s1' && c.body?.visual === '录屏')).toBe(true))
    const dur = within(row).getByRole('textbox', { name: '第 1 个分镜的时长（秒）' })
    expect((dur as HTMLInputElement).placeholder).toBe('约 3 秒')
    await user.type(dur, '12')
    await user.tab()
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH' && c.body?.duration === 12)).toBe(true))

    expect(within(row).getByLabelText('B-roll gone.png（缺失）')).toBeTruthy()
    expect(within(row).getByText('缺失')).toBeTruthy()
    // 图片没有入出点
    expect(within(row).queryByRole('textbox', { name: 'gone.png 的入点' })).toBeNull()
    const inBox = within(row).getByRole('textbox', { name: 'b1.mp4 的入点' })
    const outBox = within(row).getByRole('textbox', { name: 'b1.mp4 的出点' })
    await user.type(inBox, '5')
    await user.type(outBox, '0:02')
    await user.tab()
    expect(within(row).getByText('出点要晚于入点')).toBeTruthy()
    expect(calls.some((c) => c.path === '/api/video/brolls/b1' && c.body?.out === 2)).toBe(false)
    await user.clear(outBox)
    await user.type(outBox, '0:08.5')
    await user.tab()
    await waitFor(() => expect(calls.filter((c) => c.path === '/api/video/brolls/b1').at(-1)?.body).toEqual({ in: 5, out: 8.5 }))
    expect(await within(row).findByText('0:05 到 0:08.5')).toBeTruthy()
  })

  it('从分镜行打开素材抽屉，勾选多个加进这个分镜', async () => {
    const calls = fakeBackend([shot('s1', 1), shot('s2', 2)])
    renderDesk()
    const user = userEvent.setup()
    const row = await screen.findByRole('listitem', { name: '第 1 个分镜' })
    await user.click(within(row).getByRole('button', { name: /加 B-roll/ }))
    const drawer = await screen.findByRole('dialog', { name: 'B-roll 素材' })
    // 工程目录默认在第一个
    expect(within(drawer).getByRole('tab', { name: '工程目录' }).getAttribute('aria-selected')).toBe('true')
    await user.click(within(drawer).getByRole('tab', { name: '素材库' }))
    expect(await within(drawer).findByText('take.mp4')).toBeTruthy()
    expect(within(drawer).getAllByText('320×180 · 2.0 KB')).toHaveLength(2)
    expect((within(drawer).getByRole('combobox', { name: '加到哪个分镜' }) as HTMLSelectElement).value).toBe('s1')
    await user.click(within(drawer).getByRole('checkbox', { name: '选择 cover.png' }))
    await user.click(within(drawer).getByRole('checkbox', { name: '选择 take.mp4' }))
    await user.click(within(drawer).getByRole('button', { name: '加入分镜 2 个' }))
    expect(await within(drawer).findByText('已加到第 1 个分镜：2 个')).toBeTruthy()
    expect(calls.find((c) => c.path === '/api/video/shots/s1/brolls')?.body).toEqual({
      items: [{ root_id: 'vmr_1', path: 'cover.png' }, { root_id: 'vmr_1', path: 'take.mp4' }],
    })
    expect(within(row).getByLabelText('B-roll cover.png')).toBeTruthy()
    // 类型筛选、搜索都带进请求
    await user.click(within(drawer).getByRole('button', { name: '视频' }))
    await user.type(within(drawer).getByRole('textbox', { name: '按文件名搜索' }), 'take{Enter}')
    await waitFor(() => expect(calls.some((c) => c.path.startsWith('/api/video/media/browse') && c.path.includes('type=video') && c.path.includes('q=take'))).toBe(true))
  })
})
