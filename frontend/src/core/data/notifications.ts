// 通知（CORE-07b）：GET /api/notifications、标已读。契约见 docs/api-contract.md「通知与事件流」。
// 目前前端只用到提醒（定时任务动作 remind，kind 为 schedule.remind）：外壳右下角弹出，点了打开关联的任务，看过标已读。
import { useEffect } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { request, requestList } from '../api'
import { onServerEvent, useEventsLive } from './events'

export type NotificationLevel = 'info' | 'success' | 'error'

export type AppNotification = {
  id: string
  at: string
  /** 来源事件类型；提醒是 schedule.remind */
  kind: string
  level: NotificationLevel
  title: string
  body: string
  /** 关联的对象，可以是空串 */
  object_id: string
  /** 跳转用的 id：提醒带 schedule_id、run_id，关联了对象时还有 object_id、type_id、ref */
  data: Record<string, unknown>
  read_at: string | null
}

/** 定时任务动作 remind 到点发的通知 */
export const REMINDER_KIND = 'schedule.remind'
// 一次最多弹出几条没看的提醒（更早的进通知列表）
const REMINDER_LIMIT = 50
// 事件流断开时多久重取一次没看的提醒
const REMINDER_POLL_MS = 60_000

const reminderKey = ['notifications', 'reminders'] as const

export const notificationsApi = {
  list: (q: { unread?: boolean; limit?: number }, signal?: AbortSignal) => {
    const p = new URLSearchParams()
    if (q.unread) p.set('unread', 'true')
    if (q.limit) p.set('limit', String(q.limit))
    return requestList<AppNotification>('/api/notifications', { query: p, signal }).then((r) => r.data)
  },
  read: (id: string) => request<AppNotification>('POST', `/api/notifications/${encodeURIComponent(id)}/read`),
}

export const isReminder = (n: Pick<AppNotification, 'kind'>) => n.kind === REMINDER_KIND

/** 关联的对象：只认任务（任务抽屉里「设个提醒」建的），其余类型不给跳转 */
export function reminderTask(n: Pick<AppNotification, 'object_id' | 'data'>): { id: string; ref: string } | null {
  if (!n.object_id) return null
  const type = typeof n.data?.type_id === 'string' ? n.data.type_id : 'task'
  if (type !== 'task') return null
  return { id: n.object_id, ref: typeof n.data?.ref === 'string' ? n.data.ref : '' }
}

/** 把新来的提醒排进列表：新的在前，同一条不重复 */
export function addReminder(list: readonly AppNotification[] | undefined, n: AppNotification): AppNotification[] {
  const rest = (list ?? []).filter((x) => x.id !== n.id)
  return [n, ...rest]
}

/**
 * 没看的提醒：先取一次未读里的提醒，之后靠事件流 notification.created 推进来；事件流断开时退回轮询。
 * 服务没接通知时取不到，返回空列表，不打扰。
 */
export function useUnreadReminders(): AppNotification[] {
  const qc = useQueryClient()
  const live = useEventsLive()
  const q = useQuery({
    queryKey: reminderKey,
    queryFn: ({ signal }) => notificationsApi.list({ unread: true, limit: REMINDER_LIMIT }, signal).then((xs) => xs.filter(isReminder)),
    refetchInterval: live ? false : REMINDER_POLL_MS,
    retry: false,
  })
  useEffect(() => onServerEvent('notification.created', (e) => {
    const n = e.payload as unknown as AppNotification
    if (!n || typeof n.id !== 'string' || !isReminder(n) || n.read_at) return
    qc.setQueryData<AppNotification[]>(reminderKey, (xs) => addReminder(xs, n))
  }), [qc])
  return q.data ?? []
}

/** 标一条已读：先从弹出的列表里拿掉，失败了也不再弹（下次刷新再说） */
export function useReadNotification() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => notificationsApi.read(id),
    onMutate: (id) => {
      qc.setQueryData<AppNotification[]>(reminderKey, (xs) => xs?.filter((x) => x.id !== id))
    },
  })
}
