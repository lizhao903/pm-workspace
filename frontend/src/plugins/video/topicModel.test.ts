// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { describe, expect, it } from 'vitest'
import type { VideoTopic } from '../../core/data'
import { dayGroup, directions, draftOf, filterTopics, makeBlock, parseLines, pastedClip, topicPatch, topicPriority } from './topicModel'

const T = '2026-10-29T08:00:00Z'
const tp = (id: string, x: Partial<VideoTopic> = {}): VideoTopic => ({
  id, title: id, angle: '', audience: '', status: 'idea', score: { demand: 3, fit: 3, effort: 3 }, tags: [], platforms: [], outline: '',
  clip_ids: [], created_at: T, updated_at: T, ...x,
})

describe('选题', () => {
  it('优先级和原型同一个公式', () => {
    expect(topicPriority({ demand: 3, fit: 3, effort: 3 })).toBe(6)
    expect(topicPriority({ demand: 5, fit: 5, effort: 1 })).toBe(10)
    expect(topicPriority({ demand: 4, fit: 4, effort: 2 })).toBe(8)
  })

  it('方向取标签第一项，按条数排', () => {
    const xs = [tp('a', { tags: ['跑步', '编号:1'] }), tp('b', { tags: ['AI'] }), tp('c', { tags: ['跑步'] }), tp('d')]
    expect(directions(xs)).toEqual([{ name: '跑步', count: 2 }, { name: 'AI', count: 1 }])
  })

  it('筛选：方向、没有方向、多词搜索，按优先级排', () => {
    const xs = [
      tp('a', { title: 'MCP 规范', tags: ['AI'], score: { demand: 2, fit: 2, effort: 5 } }),
      tp('b', { title: '跑鞋评测', angle: '碳板', tags: ['装备评测'] }),
      tp('c', { title: 'MCP 迁移', angle: 'server', tags: ['AI'], score: { demand: 5, fit: 5, effort: 1 } }),
      tp('d', { title: '无标签' }),
    ]
    const f = { q: '', dir: '', series: '', status: '' as const }
    expect(filterTopics(xs, { ...f, dir: 'AI' }).map((t) => t.id)).toEqual(['c', 'a'])
    expect(filterTopics(xs, { ...f, dir: '-' }).map((t) => t.id)).toEqual(['d'])
    expect(filterTopics(xs, { ...f, q: 'mcp server' }).map((t) => t.id)).toEqual(['c'])
    expect(filterTopics(xs, { ...f, q: '碳板' }).map((t) => t.id)).toEqual(['b'])
  })

  it('立项检查和后端同序', () => {
    expect(makeBlock({ title: 'x', status: 'idea', video_id: 'vd_1' })).toBe('这个选题已经立项了')
    expect(makeBlock({ title: 'x', status: 'dropped' })).toBe('已放弃的选题不能立项')
    expect(makeBlock({ title: ' ', status: 'idea' })).toBe('先写标题')
    expect(makeBlock({ title: 'x', status: 'ready' })).toBe('')
  })

  it('草稿只挑改动的字段，清空传 null，平台按固定顺序', () => {
    const t = tp('a', { series_id: 'sr_1', drop_reason: '太难' })
    expect(topicPatch(t, draftOf(t))).toEqual({})
    const d = { ...draftOf(t), title: '新', series_id: '', drop_reason: '', platforms: ['douyin', 'bilibili'] as VideoTopic['platforms'], score: { demand: 5, fit: 3, effort: 3 } }
    expect(topicPatch(t, d)).toEqual({ title: '新', series_id: null, drop_reason: null, platforms: ['bilibili', 'douyin'], score: { demand: 5, fit: 3, effort: 3 } })
    const p = topicPatch(t, { ...draftOf(t), planned: '2026-11-02' }) as { planned_at: string }
    expect(new Date(p.planned_at).getDate()).toBe(2)
  })
})

describe('素材', () => {
  it('粘贴：网址当链接，其余当笔记', () => {
    expect(pastedClip(' https://b23.tv/x ')).toEqual({ kind: 'link', url: 'https://b23.tv/x' })
    expect(pastedClip('想做一期跑鞋')).toEqual({ kind: 'note', content: '想做一期跑鞋' })
    expect(pastedClip('  ')).toBeNull()
  })

  it('手动收集：一行一条，行尾数字是热度', () => {
    expect(parseLines('能讲讲怎么选吗 326\n\nAI 编程对比 2.1万\n讲讲第 3 集\n只有文字')).toEqual([
      { text: '能讲讲怎么选吗', heat: 326 }, { text: 'AI 编程对比', heat: 21000 }, { text: '讲讲第 3 集' }, { text: '只有文字' },
    ])
    expect(parseLines('12k 赞的评论 1.5k')).toEqual([{ text: '12k 赞的评论', heat: 1500 }])
  })

  it('按日子分段', () => {
    const now = new Date(2026, 9, 29, 12)
    expect(dayGroup(new Date(2026, 9, 29, 1).toISOString(), now)).toBe('今天')
    expect(dayGroup(new Date(2026, 9, 28, 23).toISOString(), now)).toBe('昨天')
    expect(dayGroup(new Date(2026, 9, 26, 9).toISOString(), now)).toBe('本周')
    expect(dayGroup(new Date(2026, 9, 1).toISOString(), now)).toBe('更早')
  })
})
