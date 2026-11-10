// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 视频插件的内容日历（VID-06d，接口是 VID-06c 的 GET /api/video/calendar）。契约见 docs/api-contract.md「定时发布和内容日历」。
// 日历只读：改日期走发布记录的 PATCH scheduled_at、视频的 PATCH target_date，写完报 { kind: 'video' }，日历在 video 前缀下一起刷。
// 到点发布成功后端不发事件，失败发 notification.created（kind 是 video.publish_failed），所以这里两路都接：
// 事件流里视频的事件立刻刷，另外按最近一条已定时发布的时刻定时回查
import { useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { requestEnvelope } from '../api'
import { onServerEvent } from './events'
import { videoPublishKeys, type VideoPublishStatus } from './videoPublish'
import type { VideoPlatform } from './videoTopics'

export type VideoCalendarKind = 'publish' | 'target'
export type VideoCalendarTone = 'ok' | 'muted' | 'danger'

/** 日历上的一条：发布记录（ref_id 是 pb_）或计划首发日（ref_id 是视频 id） */
export type VideoCalendarItem = {
  /** YYYY-MM-DD，服务所在时区的本地日期 */
  date: string
  kind: VideoCalendarKind
  ref_id: string
  label: string
  tone: VideoCalendarTone
  /** 发布的时刻：已发布取 published_at，其余取 scheduled_at */
  at?: string
  status?: VideoPublishStatus
  platform?: VideoPlatform
  video_id?: string
  /** 计划中、已定时的发布和没完成的首发日能改日期 */
  movable: boolean
  /** 离首发日不到 late_days 天、第一章验收还没过 */
  behind?: boolean
}

export type VideoCalendar = {
  items: VideoCalendarItem[]
  from: string
  to: string
  today: string
  late_days: number
  /** 落后的集数 */
  behind: number
}

/** 起止日都含，最多 93 天 */
export type VideoCalendarRange = { from: string; to: string }

export const videoCalendarKeys = {
  all: ['video', 'calendar'] as const,
  range: (r: VideoCalendarRange) => ['video', 'calendar', r.from, r.to] as const,
}

type CalendarMeta = { from?: string; to?: string; today?: string; late_days?: number; behind?: number }

export const videoCalendarApi = {
  get: async (r: VideoCalendarRange, signal?: AbortSignal): Promise<VideoCalendar> => {
    const q = new URLSearchParams({ from: r.from, to: r.to })
    const res = await requestEnvelope<VideoCalendarItem[] | null>('GET', `/api/video/calendar?${q}`, { signal })
    const m = (res.meta ?? {}) as CalendarMeta
    return { items: res.data ?? [], from: m.from ?? r.from, to: m.to ?? r.to, today: m.today ?? '', late_days: m.late_days ?? 7, behind: m.behind ?? 0 }
  },
}

/** 后端每 30 秒看一轮到点的发布，过点后多等这么久再回查 */
const DUE_GRACE_MS = 35_000
/** 已过点还没发出去的，每隔这么久回查一次 */
const OVERDUE_POLL_MS = 15_000
/** 最长隔这么久回查一次（定时器不排太远） */
const MAX_WAIT_MS = 10 * 60_000

/** 下次回查要等多久：有已定时的发布才回查，没有返回 false */
export function calendarPollMs(items: readonly VideoCalendarItem[], now = Date.now()): number | false {
  const due = items
    .filter((x) => x.kind === 'publish' && x.status === 'scheduled' && x.at)
    .map((x) => new Date(x.at!).getTime())
    .filter((t) => !Number.isNaN(t))
  if (!due.length) return false
  const next = Math.min(...due)
  if (next + DUE_GRACE_MS <= now) return OVERDUE_POLL_MS
  return Math.min(MAX_WAIT_MS, Math.max(OVERDUE_POLL_MS, next + DUE_GRACE_MS - now))
}

/** 视频的事件：插件发的 video.* 和视频插件发的通知（发布失败） */
export function isVideoEvent(type: string, payload: Record<string, unknown> | undefined): boolean {
  if (type.startsWith('video.')) return true
  if (type !== 'notification.created') return false
  const kind = payload?.kind
  const source = (payload?.data as { source?: unknown } | undefined)?.source
  return (typeof kind === 'string' && kind.startsWith('video.')) || source === 'video'
}

export function useVideoCalendar(r: VideoCalendarRange) {
  const qc = useQueryClient()
  // 事件流里视频的事件：日历和发布记录一起刷
  useEffect(() => onServerEvent('*', (e) => {
    if (!isVideoEvent(e.type, e.payload)) return
    void qc.invalidateQueries({ queryKey: videoCalendarKeys.all })
    void qc.invalidateQueries({ queryKey: videoPublishKeys.all })
  }), [qc])
  return useQuery({
    queryKey: videoCalendarKeys.range(r),
    queryFn: ({ signal }) => videoCalendarApi.get(r, signal),
    refetchInterval: (q) => (q.state.data ? calendarPollMs(q.state.data.items) : false),
  })
}
