import { describe, expect, it } from 'vitest'
import { calendarPollMs, isVideoEvent, type VideoCalendarItem } from './videoCalendar'

const NOW = Date.parse('2099-03-12T10:00:00Z')
const pub = (status: VideoCalendarItem['status'], at: string): VideoCalendarItem =>
  ({ date: '2099-03-12', kind: 'publish', ref_id: 'pb_1', label: 'x', tone: 'muted', movable: true, status, at })

describe('videoCalendar', () => {
  it('有已定时的发布才回查：过点多等 35 秒，已过点每 15 秒，最远 10 分钟', () => {
    expect(calendarPollMs([], NOW)).toBe(false)
    expect(calendarPollMs([pub('published', '2099-03-12T09:00:00Z'), pub('planned', '2099-03-12T11:00:00Z')], NOW)).toBe(false)
    expect(calendarPollMs([pub('scheduled', '2099-03-12T10:01:00Z')], NOW)).toBe(95_000)
    expect(calendarPollMs([pub('scheduled', '2099-03-12T09:00:00Z')], NOW)).toBe(15_000)
    expect(calendarPollMs([pub('scheduled', '2099-03-12T09:59:50Z')], NOW)).toBe(25_000)
    expect(calendarPollMs([pub('scheduled', '2099-03-13T10:00:00Z')], NOW)).toBe(600_000)
  })

  it('认得视频插件的事件和视频的通知', () => {
    expect(isVideoEvent('video.publish_updated', {})).toBe(true)
    expect(isVideoEvent('notification.created', { kind: 'video.publish_failed' })).toBe(true)
    expect(isVideoEvent('notification.created', { kind: 'x', data: { source: 'video' } })).toBe(true)
    expect(isVideoEvent('notification.created', { kind: 'task.review_requested' })).toBe(false)
    expect(isVideoEvent('object.updated', { id: 'obj_1' })).toBe(false)
  })
})
