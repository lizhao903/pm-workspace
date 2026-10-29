import { describe, expect, it } from 'vitest'
import { invalidationsFor, todayKeys, videoKeys, type Video, type VideoCheckpoint, type VideoSeries } from '../../core/data'
import {
  filterVideos, groupBySeries, isFinished, needsMe, newRoot, nextEpisode, openCheckpoint, orientLocked, peek, sortVideos, stepState, timeAgo,
  videoState,
} from './model'
import { routeOf, viewPath } from './routes'

const cps = (x: Partial<Record<string, Omit<VideoCheckpoint, 'stage'>>> = {}): VideoCheckpoint[] =>
  (['plan', 'ch1', 'audio', 'distribution'] as const).map((stage) => ({ stage, state: 'pending', ...x[stage] }))
const vid = (id: string, x: Partial<Video> = {}): Video => ({
  id, title: id, orientations: [], stage: 'script', checkpoints: cps(), root: `videos/${id}`, chapters: 3, created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-01T00:00:00Z', ...x,
})
const sr = (id: string, name: string): VideoSeries => ({ id, name, desc: '', intro: '', outro: '', template: '', stale: [], created_at: '', updated_at: '' })

describe('视频状态', () => {
  it('检查点待确认、退回是等我处理；非检查点阶段是阶段名；分发包通过算已完成', () => {
    expect(videoState(vid('a'))).toEqual({ label: '内容编写', tone: 'info' })
    expect(videoState(vid('a', { stage: 'ch1' }))).toEqual({ label: '待第一章验收', tone: 'warn' })
    expect(videoState(vid('a', { stage: 'ch1', checkpoints: cps({ ch1: { state: 'rejected', note: 'x' } }) }))).toEqual({ label: '退回修改', tone: 'warn' })
    const done = vid('a', { stage: 'distribution', checkpoints: cps({ distribution: { state: 'passed' } }) })
    expect(videoState(done)).toEqual({ label: '已完成', tone: 'ok' })
    expect(isFinished(done)).toBe(true)
    expect(needsMe(done)).toBe(false)
    expect(openCheckpoint(done)).toBeNull()
    expect(openCheckpoint(vid('a', { stage: 'audio' }))).toBe('audio')
    expect(openCheckpoint(vid('a', { stage: 'web' }))).toBeNull()
  })

  it('进度：当前之前做完，已完成时全部做完', () => {
    const v = vid('a', { stage: 'web' })
    // 第一步是选题（VID-09b）
    expect([0, 1, 2, 3, 4].map((i) => stepState(v, i))).toEqual(['done', 'done', 'done', 'current', 'todo'])
    const done = vid('a', { stage: 'distribution', checkpoints: cps({ distribution: { state: 'passed' } }) })
    expect(stepState(done, 8)).toBe('done')
  })

  it('规划检查通过后比例锁定', () => {
    expect(orientLocked(vid('a'))).toBe(false)
    expect(orientLocked(vid('a', { checkpoints: cps({ plan: { state: 'passed' } }) }))).toBe(true)
  })
})

describe('列表', () => {
  const xs = [
    vid('a', { title: 'Alpha', series_id: 'sr_1', episode: 2, project_id: 'p1', updated_at: '2026-10-03T00:00:00Z' }),
    vid('b', { title: 'Beta', series_id: 'sr_1', episode: 1, stage: 'plan', updated_at: '2026-10-02T00:00:00Z' }),
    vid('c', { title: 'Gamma', series_id: 'sr_gone', updated_at: '2026-10-04T00:00:00Z' }),
  ]

  it('按阶段、项目、关键词筛', () => {
    expect(filterVideos(xs, { stage: 'plan', project: '', q: '' }).map((v) => v.id)).toEqual(['b'])
    expect(filterVideos(xs, { stage: '', project: 'p1', q: '' }).map((v) => v.id)).toEqual(['a'])
    expect(filterVideos(xs, { stage: '', project: '-', q: '' }).map((v) => v.id)).toEqual(['b', 'c'])
    expect(filterVideos(xs, { stage: '', project: '', q: 'videos/c' }).map((v) => v.id)).toEqual(['c'])
    expect(filterVideos(xs, { stage: '', project: '', q: '2' }).map((v) => v.id)).toEqual(['a'])
  })

  it('排序：按集数（没有集数的在后）或按更新倒序', () => {
    expect(sortVideos(xs, 'episode').map((v) => v.id)).toEqual(['b', 'a', 'c'])
    expect(sortVideos(xs, 'updated').map((v) => v.id)).toEqual(['c', 'a', 'b'])
  })

  it('分组：系列按顺序，系列已删的集算单集；每组先露等我处理的', () => {
    const g = groupBySeries(xs, [sr('sr_1', '一'), sr('sr_2', '空')])
    expect(g.map((x) => [x.name, x.videos.map((v) => v.id)])).toEqual([['一', ['a', 'b']], ['单集', ['c']]])
    expect(peek(g[0].videos).map((v) => v.id)).toEqual(['b', 'a'])
  })

  it('下一集、新目录', () => {
    expect(nextEpisode(xs, 'sr_1')).toBe(3)
    expect(nextEpisode(xs, 'sr_x')).toBe(1)
    expect(newRoot([vid('x', { root: 'videos/new-2' })])).toBe('videos/new-3')
  })

  it('相对时间', () => {
    const now = Date.parse('2026-10-29T12:00:00Z')
    expect(timeAgo('2026-10-29T11:59:50Z', now)).toBe('刚刚')
    expect(timeAgo('2026-10-29T11:00:00Z', now)).toBe('1 小时前')
    expect(timeAgo('2026-10-28T08:00:00Z', now)).toBe('昨天')
    expect(timeAgo('2026-10-20T12:00:00Z', now)).toBe('9 天前')
  })
})

describe('路由', () => {
  it('子路径和视图互转，认不出的回 bad', () => {
    expect(routeOf('')).toEqual({ kind: 'list', view: { kind: 'all' } })
    expect(routeOf('review')).toEqual({ kind: 'list', view: { kind: 'review' } })
    expect(routeOf('series/sr_1')).toEqual({ kind: 'list', view: { kind: 'series', id: 'sr_1' } })
    expect(routeOf('v/vd_1')).toEqual({ kind: 'video', id: 'vd_1', tab: 'flow' })
    expect(routeOf('v/vd_1/settings')).toEqual({ kind: 'video', id: 'vd_1', tab: 'settings' })
    expect(routeOf('v/vd_1/x')).toEqual({ kind: 'bad' })
    expect(viewPath({ kind: 'series', id: 'a b' })).toBe('/series/a%20b')
    expect(viewPath({ kind: 'all' })).toBe('')
  })

  it('写视频报 video，整个前缀一起刷，今日聚合也刷（视频卡片和菜单红点）', () => {
    expect(invalidationsFor({ kind: 'video' })).toEqual([videoKeys.all, todayKeys.all])
  })
})
