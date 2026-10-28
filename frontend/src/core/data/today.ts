// 今日（TODAY-02）：今日聚合 GET /api/today，加上「今天还会自动执行」要的定时任务列表 GET /api/schedules。
// 契约见 docs/api-contract.md「今日聚合」「定时任务 schedules」。缓存键都在 ['today'] 下，对象、执行、插件一变就整体刷新（invalidate.ts）
import { useQuery } from '@tanstack/react-query'
import { localDay, request, requestList } from '../api'
import type { WorkObject } from '../api/types'

/** 内核卡片的 key；插件卡片的 key 以 `<插件id>_` 开头 */
export const TODAY_REVIEW = 'review'
export const TODAY_OVERDUE = 'overdue'
export const TODAY_DUE = 'due_today'
export const TODAY_RUNNING = 'running'
export const KERNEL_TODAY_CARDS: readonly string[] = [TODAY_REVIEW, TODAY_OVERDUE, TODAY_DUE, TODAY_RUNNING]

/** running 卡片的一项：执行记录，不带 output */
export type TodayRun = {
  id: string
  object_id: string
  object_ref: string
  object_title: string
  object_type: string
  workdir: string
  status: string
  started_at: string
}

/** 一张卡片；total 是全量，items 最多 50 条。插件卡片的 items 形状由插件定 */
export type TodayCard<T = unknown> = { key: string; title: string; order: number; total: number; items: T[] }
export type Today = { cards: TodayCard[] }

/** 定时任务（TASK-03a）。今日页只读 name、enabled、next_run_at */
export type Schedule = {
  id: string
  name: string
  enabled: boolean
  rule: Record<string, unknown>
  action: Record<string, unknown>
  /** 按规则现算，带服务时区偏移；停用、一次性已过时为 null */
  next_run_at: string | null
  created_at: string
  updated_at: string
}

export const todayKeys = {
  all: ['today'] as const,
  /** type 和 /api/counts 同义：不传是全局（含插件卡片），传了收窄到该类型（不含插件卡片） */
  of: (type?: string) => ['today', 'cards', type ?? ''] as const,
  schedules: ['today', 'schedules'] as const,
}

export const todayApi = {
  get: (type?: string, signal?: AbortSignal) =>
    request<Today>('GET', type ? `/api/today?type=${encodeURIComponent(type)}` : '/api/today', { signal }),
  schedules: (signal?: AbortSignal) => requestList<Schedule>('/api/schedules', { signal }).then((r) => r.data),
}

export function useToday(type?: string) {
  return useQuery({ queryKey: todayKeys.of(type), queryFn: ({ signal }) => todayApi.get(type, signal) })
}

export function useSchedules() {
  return useQuery({ queryKey: todayKeys.schedules, queryFn: ({ signal }) => todayApi.schedules(signal) })
}

/** 按 key 取一张卡；没有这张卡时 undefined */
export function todayCard<T = unknown>(t: Today | undefined, key: string): TodayCard<T> | undefined {
  return t?.cards.find((c) => c.key === key) as TodayCard<T> | undefined
}

export const reviewCard = (t: Today | undefined) => todayCard<WorkObject>(t, TODAY_REVIEW)
export const overdueCard = (t: Today | undefined) => todayCard<WorkObject>(t, TODAY_OVERDUE)
export const dueTodayCard = (t: Today | undefined) => todayCard<WorkObject>(t, TODAY_DUE)
export const runningCard = (t: Today | undefined) => todayCard<TodayRun>(t, TODAY_RUNNING)

/** 插件贡献的卡片（不是内核四张），保持接口给的顺序 */
export function pluginTodayCards(t: Today | undefined): TodayCard[] {
  return (t?.cards ?? []).filter((c) => !KERNEL_TODAY_CARDS.includes(c.key))
}

/** 启用的、下次执行落在本地今天的定时任务，早的在前 */
export function schedulesToday(rows: readonly Schedule[], now: Date = new Date()): Schedule[] {
  const day = localDay(now)
  return rows
    .filter((s) => s.enabled && s.next_run_at && !Number.isNaN(Date.parse(s.next_run_at)) && localDay(new Date(s.next_run_at)) === day)
    .sort((a, b) => Date.parse(a.next_run_at!) - Date.parse(b.next_run_at!))
}
