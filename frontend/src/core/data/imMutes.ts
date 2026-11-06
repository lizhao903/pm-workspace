// 自动忽略发信人（IM 插件 0.27.0，TSK-0495）：把某个发信人标为「自动忽略」，之后他的消息入库即已忽略、已读，
// 不发 im.message_received（不触发 SOP 的 IM 流程、Agent 的 IM 触发）。契约见 docs/api-contract.md「自动忽略发信人」。
// 键在 im 前缀下：消息一变（im-message 失效）跟着刷，标记、取消时也刷消息。
import { useMutation, useQuery } from '@tanstack/react-query'
import { isApiError, request, requestList } from '../api'
import { useNotifyChange } from './invalidate'

/**
 * 一条自动忽略。kind sender 按渠道身份（channel + sender_id），contact 按联系人（名下全部 IM 身份）。
 * stakeholder_id、contact_name：sender 时是这个身份现在认上的联系人，contact 时是标记的联系人。
 * conversation_id 为 null 是全部会话，否则只在这个会话里；conversation 是群名（私聊、会话删了为空串）。
 * name 是标记时的显示名；ignored 是被它自动忽略的消息条数，last_at 是最近一条的时间
 */
export type ImMute = {
  id: string
  kind: 'sender' | 'contact' | (string & {})
  channel: string
  sender_id: string
  stakeholder_id: string | null
  contact_name: string
  conversation_id: string | null
  conversation: string
  name: string
  ignored: number
  last_at: string | null
  created_at: string
}

/** 消息上的「因发信人 X 被设为自动忽略」；active 为 false 时那条自动忽略已经取消 */
export type ImMessageMute = { mute_id: string; name: string; active: boolean }

/** 要标记的对象：channel + sender_id 和 stakeholder_id 二选一；conversation_id 只在这个会话里 */
export type ImMuteTarget = { channel?: string; sender_id?: string; stakeholder_id?: string; conversation_id?: string }
export type ImMuteInput = ImMuteTarget & { name?: string; ignore_pending?: boolean }
/** created 为 false 时同一对象同一范围已经标过；ignored 是这次一并忽略的已有待处理条数 */
export type ImMuteResult = { mute: ImMute; created: boolean; ignored: number }

const KEY = ['im', 'mutes'] as const
const pendingKey = (t: ImMuteTarget) => ['im', 'mutes', 'pending', t] as const

const norm = (m: ImMute): ImMute => ({
  ...m, channel: m.channel ?? '', sender_id: m.sender_id ?? '', stakeholder_id: m.stakeholder_id ?? null, contact_name: m.contact_name ?? '',
  conversation_id: m.conversation_id ?? null, conversation: m.conversation ?? '', name: m.name ?? '', ignored: m.ignored ?? 0, last_at: m.last_at ?? null,
})

const targetQuery = (t: ImMuteTarget) => {
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(t)) if (v) q.set(k, v)
  return q
}

export const imMutesApi = {
  list: async (signal?: AbortSignal) => (await requestList<ImMute>('/api/im/mutes', { signal })).data.map(norm),
  /** 此人现在有几条待处理消息（含稍后、已过期） */
  pending: async (t: ImMuteTarget, signal?: AbortSignal) => (await request<{ pending: number }>('GET', '/api/im/mutes/pending', { query: targetQuery(t), signal })).pending,
  create: async (input: ImMuteInput) => {
    const r = await request<ImMuteResult>('POST', '/api/im/mutes', { body: input })
    return { ...r, mute: norm(r.mute), ignored: r.ignored ?? 0 }
  },
  remove: (id: string) => request<{ id: string; ignored: number }>('DELETE', `/api/im/mutes/${encodeURIComponent(id)}`),
}

const noRetry404 = (n: number, e: unknown) => !isApiError(e, 'not_found') && n < 2

/** 全部自动忽略；IM 插件没在跑时 404，调用方当没有 */
export function useImMutes(enabled = true) {
  return useQuery({ queryKey: KEY, queryFn: ({ signal }) => imMutesApi.list(signal), enabled, retry: noRetry404 })
}

/** 此人现在的待处理条数；target 为 null 时不查 */
export function useImMutePending(t: ImMuteTarget | null) {
  return useQuery({
    queryKey: pendingKey(t ?? {}),
    queryFn: ({ signal }) => imMutesApi.pending(t!, signal),
    enabled: !!t,
    retry: noRetry404,
  })
}

/** 标记：一并忽略会改消息，消息、统计、列表一起刷（都在 im 前缀下） */
export function useCreateImMute() {
  const notify = useNotifyChange()
  return useMutation({ mutationFn: (input: ImMuteInput) => imMutesApi.create(input), onSettled: () => notify({ kind: 'im-message' }) })
}

/** 取消：已被自动忽略的消息不恢复，消息上的 active 变 false，一起刷 */
export function useRemoveImMute() {
  const notify = useNotifyChange()
  return useMutation({ mutationFn: (id: string) => imMutesApi.remove(id), onSettled: () => notify({ kind: 'im-message' }) })
}

/** 找命中这个对象的自动忽略：按渠道身份的、按它认上的联系人的；给了会话时只在这个会话里的也算 */
export function findMute(mutes: readonly ImMute[] | undefined, x: { channel: string; sender_id: string; stakeholder_id?: string | null; conversation_id?: string | null }) {
  return (mutes ?? []).filter((m) =>
    ((m.kind === 'sender' && m.channel === x.channel && m.sender_id === x.sender_id) || (m.kind === 'contact' && !!x.stakeholder_id && m.stakeholder_id === x.stakeholder_id))
    && (!m.conversation_id || m.conversation_id === x.conversation_id))
}
