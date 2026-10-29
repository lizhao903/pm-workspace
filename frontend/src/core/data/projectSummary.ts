// 项目汇总（ALIGN-05）：项目插件的 /api/projects/summary，每个项目的原型总数、运行中数和绑定的会话，项目列表一次取齐。
// 待回复数不在汇总里（消息在 IM 插件），拿一次全部待处理消息（不含稍后），按会话对上项目，口径见契约「项目汇总」。
// 原型启停、会话绑定解绑时刷汇总（invalidate.ts）；待处理消息挂在 im 前缀下，消息一变跟着刷。
import { useQuery } from '@tanstack/react-query'
import { isApiError, requestList } from '../api'
import { IM_PAGE_MAX, normMessage, type ImMessage } from './im'
import { dataKeys } from './keys'

export type ProjectSummary = {
  project_id: string
  /** running 只数端口能连上的，启动中不算 */
  prototypes: { total: number; running: number }
  /** 绑定的会话；消息没认上会话时按渠道和会话编号对 */
  conversations: { id: string; channel: string; external_id: string }[]
}

/** 一个项目在列表卡片上的统计 */
export type ProjectStat = { protoTotal: number; protoRunning: number; pending: number }

export const EMPTY_STAT: ProjectStat = { protoTotal: 0, protoRunning: 0, pending: 0 }

export const projectSummaryApi = {
  list: async (signal?: AbortSignal) =>
    (await requestList<ProjectSummary>('/api/projects/summary', { signal })).data.map((s) => ({ ...s, conversations: s.conversations ?? [] })),
  /** 待处理、不在稍后里的消息，按页拉完 */
  pending: async (signal?: AbortSignal) => {
    const out: ImMessage[] = []
    for (let offset = 0; ; offset += IM_PAGE_MAX) {
      const query = new URLSearchParams({ status: 'pending', snoozed: 'false', limit: String(IM_PAGE_MAX), offset: String(offset) })
      const r = await requestList<ImMessage>('/api/im/messages', { query, signal })
      out.push(...r.data.map(normMessage))
      if (!r.data.length || out.length >= r.total) return out
    }
  },
}

/** 有原型在跑时隔几秒取一次，看得到停止和崩溃（原型状态不发事件） */
export const SUMMARY_POLL_MS = 5000

const noRetry404 = (n: number, e: unknown) => !isApiError(e, 'not_found') && n < 2

export function useProjectSummary() {
  return useQuery({
    queryKey: dataKeys.projectSummary,
    queryFn: ({ signal }) => projectSummaryApi.list(signal),
    refetchInterval: (q) => (q.state.data?.some((s) => s.prototypes.running > 0) ? SUMMARY_POLL_MS : false),
  })
}

/** 待回复的消息；enabled=false（IM 插件没在跑）时不发请求 */
export function usePendingImMessages(enabled: boolean) {
  return useQuery({
    queryKey: [...dataKeys.im.all, 'pending-list'] as const,
    queryFn: ({ signal }) => projectSummaryApi.pending(signal),
    enabled,
    retry: noRetry404,
  })
}

/** 每个项目的统计：原型数照汇总，待回复数按会话对上；一个会话绑了几个项目就算进每个项目 */
export function projectStats(summary: readonly ProjectSummary[], pending: readonly ImMessage[]): Map<string, ProjectStat> {
  const byConv = new Map<string, number>()
  const byExt = new Map<string, number>()
  const extKey = (channel: string, ext: string) => `${channel}\u0000${ext}`
  for (const m of pending) {
    if (m.status !== 'pending') continue
    if (m.conversation_id) byConv.set(m.conversation_id, (byConv.get(m.conversation_id) ?? 0) + 1)
    else if (m.conversation_external_id) {
      const k = extKey(m.channel, m.conversation_external_id)
      byExt.set(k, (byExt.get(k) ?? 0) + 1)
    }
  }
  const out = new Map<string, ProjectStat>()
  for (const s of summary) {
    let n = 0
    for (const c of s.conversations) n += (byConv.get(c.id) ?? 0) + (byExt.get(extKey(c.channel, c.external_id)) ?? 0)
    out.set(s.project_id, { protoTotal: s.prototypes.total, protoRunning: s.prototypes.running, pending: n })
  }
  return out
}
