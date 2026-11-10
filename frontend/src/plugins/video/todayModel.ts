// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 视频今日卡片（VID-07b）的条目类型和文案，字段同后端 internal/plugins/video/today.go 的 TodayWaiting、TodayPublish
import type { VideoOrientation } from '../../core/data'
import { ORIENT } from './model'

/** 一张卡片露几条 */
export const CARD_SHOW = 5

export type TodayWaiting = {
  kind: 'checkpoint' | 'artifact'
  video_id: string
  video_title: string
  stage?: string
  stage_label?: string
  state?: string
  note?: string
  artifact_id?: string
  artifact_name?: string
  version?: number
  label: string
  at: string
  link: string
}

export type TodayPublish = {
  id: string
  video_id: string
  video_title: string
  platform: string
  platform_label?: string
  variant?: VideoOrientation | ''
  title: string
  status: string
  scheduled_at?: string | null
  error?: string
  at: string
  link: string
}

export type CardData<T> = { total: number; items: T[] } | undefined

const pad = (n: number) => String(n).padStart(2, '0')
const dayOf = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

/** 定时时刻：今天只写时分，明天写「明天」，已过点的写「已过点」；now 留给测试 */
export function scheduleText(at: string | null | undefined, now = new Date()): { text: string; late: boolean } {
  const d = at ? new Date(at) : null
  if (!d || Number.isNaN(d.getTime())) return { text: '未定时', late: false }
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  if (d.getTime() <= now.getTime()) return { text: '已过点', late: true }
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
  return { text: dayOf(d) === dayOf(now) ? hm : dayOf(d) === dayOf(tomorrow) ? `明天 ${hm}` : `${d.getMonth() + 1}/${d.getDate()} ${hm}`, late: false }
}

export const platformText = (p: TodayPublish) => [p.platform_label || p.platform, p.variant && ORIENT[p.variant]?.label].filter(Boolean).join(' · ')
