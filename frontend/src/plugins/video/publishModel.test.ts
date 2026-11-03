import { describe, expect, it } from 'vitest'
import type { VideoArtifact, VideoPlatformInfo, VideoPublishRule } from '../../core/data'
import { channelOf, checkPublish, coversFor, fillBad, fillOf, fillToMetrics, isPast, parseTags, peekOf, tomorrow10 } from './publishModel'

const rule: VideoPublishRule = { platform: 'xiaohongshu', title_max: 20, desc_max: 1000, tags_max: 2, allow_link: false, cover: ['3x4', '1x1'], duration_max_sec: 900 }
const info = (x: Partial<VideoPlatformInfo>): VideoPlatformInfo => ({
  key: 'bilibili', label: 'B 站', tool: 'bilibili', caps: ['upload', 'metrics'], covers: ['16x9'], creator_url: '', rule: { ...rule, platform: 'bilibili' }, connectors: [], ...x,
})
const cover = (id: string, x: Partial<VideoArtifact>): VideoArtifact => ({
  id, video_id: 'vd_1', kind: 'cover', name: id, path: `${id}.png`, version: 1, status: 'draft', source: { type: 'manual', label: '手动' }, reviews: [],
  created_at: '', updated_at: '', ...x,
})

describe('发布前校验', () => {
  it('按平台规则逐项算，文案同后端', () => {
    const xs = checkPublish(rule, '小红书', { title: '一'.repeat(21), desc: '看 https://x.com', tags: ['a', 'b', 'c'], cover: '16x9', duration: 1000 })
    expect(xs.map((c) => [c.key, c.ok])).toEqual([['title', false], ['desc', true], ['tags', false], ['link', false], ['cover', false], ['duration', false]])
    expect(xs[0].text).toBe('标题超长：小红书最多 20 字，现在 21 字')
    expect(xs[4].text).toBe('封面比例不对：小红书要 3:4 或 1:1')
    expect(checkPublish({ ...rule, allow_link: true }, '小红书', { title: '短', desc: '', tags: [] }).every((c) => c.ok)).toBe(true)
  })

  it('标签按逗号、顿号、空格、# 分开并去重', () => {
    expect(parseTags('效率，待办、 #效率 工具,a')).toEqual(['效率', '待办', '工具', 'a'])
  })
})

describe('平台接入情况', () => {
  it('没有连接器的平台只能登记；接通且能投稿是 ok；异常、没接入分开', () => {
    expect(channelOf(info({ tool: undefined })).state).toBe('register')
    expect(channelOf(info({})).state).toBe('none')
    expect(channelOf(info({ connectors: [{ id: 'c', name: 'B 站主号', account: '', status: 'error', error: '令牌失效' }] }))).toEqual({ state: 'error', name: 'B 站主号', error: '令牌失效' })
    expect(channelOf(info({ connectors: [{ id: 'c', name: 'B 站主号', account: '', status: 'connected' }] })).state).toBe('ok')
    expect(channelOf(info({ caps: ['metrics'], connectors: [{ id: 'c', name: '抖音', account: '', status: 'connected' }] })).state).toBe('manual')
  })
})

describe('封面和列表', () => {
  it('只列平台收的比例，推荐的排前面，同比例按版本', () => {
    const xs = [cover('a', { variant: 'portrait', ratio: '1x1', option: 1 }), cover('b', { variant: 'portrait', ratio: '3x4', option: 2 }),
      cover('c', { variant: 'portrait', ratio: '3x4', option: 1 }), cover('d', { variant: 'portrait', ratio: '9x16', option: 1 }), cover('e', { variant: 'landscape', ratio: '3x4', option: 3 })]
    expect(coversFor(xs, 'vd_1', ['3x4', '1x1'], 'portrait').map((a) => a.id)).toEqual(['c', 'b', 'a'])
    expect(coversFor(xs, 'vd_1', ['3x4']).map((a) => a.id)).toEqual(['c', 'b', 'e'])
  })

  it('每组先露 3 条，失败的排前面', () => {
    const p = (id: string, status: 'failed' | 'published') => ({ id, status }) as Parameters<typeof peekOf>[0][number]
    expect(peekOf([p('1', 'published'), p('2', 'published'), p('3', 'published'), p('4', 'failed')]).map((x) => x.id)).toEqual(['4', '1', '2'])
  })
})

describe('回填数据', () => {
  it('预填现有数字，百分比换成 0 到 100，留空的不传', () => {
    const f = fillOf({ views: 10, likes: 1, comments: 0, shares: 0, ctr: 0.0815, updated_at: '' })
    expect(f.views).toBe('10')
    expect(f.ctr).toBe('8.15')
    expect(f.impressions).toBe('')
    const m = fillToMetrics({ ...f, impressions: '12000', completion: '40', followers_gained: '-3' }, 'T')
    expect(m).toEqual({ views: 10, likes: 1, comments: 0, shares: 0, impressions: 12000, ctr: 0.0815, completion: 0.4, followers_gained: -3, updated_at: 'T' })
  })

  it('四格只能非负整数，百分比不超过 100', () => {
    const f = fillOf(undefined)
    expect(fillBad(f)).toBe(false)
    expect(fillBad({ ...f, views: '-1' })).toBe(true)
    expect(fillBad({ ...f, ctr: '101' })).toBe(true)
    expect(fillBad({ ...f, ctr: '9.5' })).toBe(false)
  })
})

describe('定时时间', () => {
  it('默认明天 10 点；不晚于现在的算过去', () => {
    expect(tomorrow10(new Date(2026, 9, 29, 15, 0))).toBe('2026-10-30T10:00')
    const now = new Date(2026, 9, 29, 15, 0).getTime()
    expect(isPast('2026-10-29T14:59', now)).toBe(true)
    expect(isPast('2026-10-30T10:00', now)).toBe(false)
    expect(isPast('不是时间', now)).toBe(false)
  })
})
