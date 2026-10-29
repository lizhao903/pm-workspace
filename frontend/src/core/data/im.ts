// IM 消息（IM-02b）：IM 消息插件 im 的消息列表和处理动作。契约见 docs/api-contract.md「IM 消息插件 im」。
// 列表按页拉完（每页 200）放一份缓存，筛选、计数、会话选项都在前端算，口径和原型 MessagesPage 一致。
// 处理动作的响应是改后的整条消息，先写回缓存再按失效规则 im-message 刷一遍；转任务还建了任务，另报 object。
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { isApiError, request, requestList } from '../api'
import { useNotifyChange } from './invalidate'
import { dataKeys } from './keys'

export type ImMsgStatus = 'pending' | 'done' | 'ignored'
/** 与我相关的原因：@我、@所有人、私聊；无关为空串 */
export type ImRelevance = 'me' | 'all' | 'dm' | ''

export type ImAttachment = {
  id: string
  name: string
  kind: 'file' | 'image' | 'link'
  size?: number
  url?: string
  fetch?: 'idle' | 'fetching' | 'done' | 'error'
  local?: string
  error?: string
}

export type ImReply = { id: string; text: string; status: 'sent' | 'failed'; error: string; external_id: string; at: string }

export type ImMessage = {
  id: string
  channel: string
  connector_id: string
  external_id: string
  conversation_id: string | null
  conversation_external_id: string
  conversation_kind: 'group' | 'direct' | string
  /** 群名；私聊为空串 */
  conversation: string
  sender_id: string
  sender_name: string
  identity_id: string | null
  stakeholder_id: string | null
  /** 认上联系人时的姓名，认不上为空串 */
  contact_name: string
  text: string
  attachments: ImAttachment[]
  relevance: ImRelevance
  status: ImMsgStatus
  read: boolean
  snooze_until: string | null
  at: string
  received_at: string
  adapter: string
  task_id: string | null
  task_ref: string
  replies: ImReply[]
  /** 最近一次发送失败的原因，再发成功后清空 */
  reply_error: string
}

export type ImAction =
  | { kind: 'done' | 'ignore' | 'reopen' | 'read' }
  | { kind: 'snooze'; until: string }
  | { kind: 'reply'; text: string; done: boolean }

/** 立即同步一个渠道的结果（IM-01b）：新落库的消息 id 和已收过的条数 */
export type ImSyncResult = { connector_id: string; adapter: string; ids: string[]; duplicates: number }

/** 批量处理完或忽略（PR-03）：按 id 列表，或按会话 + 时间点之前；只改待处理的 */
export type ImBatchInput =
  | { action: 'done' | 'ignore'; ids: string[] }
  | { action: 'done' | 'ignore'; conversation_id: string; before: string }
export type ImBatchResult = { action: 'done' | 'ignore'; ids: string[]; count: number }

export type ImTaskInput = { title?: string; body?: string; priority?: string; project_id?: string; owner_id?: string; due_at?: string; done?: boolean }
export type ImTaskResult = { message: ImMessage; task: { id: string; ref: string; title: string; status: string; source: string } }

/** 一页最多 200 条（契约上限） */
export const IM_PAGE_MAX = 200

// 后端的空数组可能是 null，这里一次补齐
export const normMessage = (m: ImMessage): ImMessage => ({
  ...m, attachments: m.attachments ?? [], replies: m.replies ?? [], conversation: m.conversation ?? '', contact_name: m.contact_name ?? '',
  reply_error: m.reply_error ?? '', task_ref: m.task_ref ?? '', relevance: m.relevance ?? '',
})

const path = (id: string) => `/api/im/messages/${encodeURIComponent(id)}`

export const imApi = {
  page: async (offset: number, signal?: AbortSignal) => {
    const query = new URLSearchParams({ limit: String(IM_PAGE_MAX), offset: String(offset) })
    const r = await requestList<ImMessage>('/api/im/messages', { query, signal })
    return { ...r, data: r.data.map(normMessage) }
  },
  /** 按页拉完，按发送时间倒序 */
  all: async (signal?: AbortSignal) => {
    const out: ImMessage[] = []
    for (let offset = 0; ; offset += IM_PAGE_MAX) {
      const r = await imApi.page(offset, signal)
      out.push(...r.data)
      if (!r.data.length || out.length >= r.total) return out
    }
  },
  get: async (id: string, signal?: AbortSignal) => normMessage(await request<ImMessage>('GET', path(id), { signal })),
  act: async (id: string, a: ImAction) => {
    const body = a.kind === 'snooze' ? { until: a.until } : a.kind === 'reply' ? { text: a.text, done: a.done } : {}
    return normMessage(await request<ImMessage>('POST', `${path(id)}/${a.kind}`, { body }))
  },
  /** 立即同步一个 IM 渠道：渠道出错回 502 sync_failed（连接器已置为异常），暂停、不能同步 409 */
  syncConnector: async (connectorId: string) => {
    const r = await request<ImSyncResult>('POST', `/api/im/connectors/${encodeURIComponent(connectorId)}/sync`, { body: {} })
    return { ...r, ids: r.ids ?? [] }
  },
  batch: async (input: ImBatchInput) => {
    const r = await request<ImBatchResult>('POST', '/api/im/messages/batch', { body: input })
    return { ...r, ids: r.ids ?? [] }
  },
  toTask: async (id: string, body: ImTaskInput) => {
    const r = await request<ImTaskResult>('POST', `${path(id)}/task`, { body })
    return { ...r, message: normMessage(r.message) }
  },
}

/** 插件没装或停用时接口 404，不重试 */
const noRetry404 = (n: number, e: unknown) => !isApiError(e, 'not_found') && n < 2

/** 全部消息；refetchInterval 给事件流断开时轮询用 */
export function useImMessages(opts: { refetchInterval?: number | false } = {}) {
  return useQuery({
    queryKey: dataKeys.im.list,
    queryFn: ({ signal }) => imApi.all(signal),
    retry: noRetry404,
    refetchInterval: opts.refetchInterval,
  })
}

/** 待处理（不含稍后、还没到点的）的条数，侧栏红点用；只取一条，读 meta.total。在 im 前缀下，消息一变跟着刷 */
export function useImPendingCount(opts: { enabled?: boolean; refetchInterval?: number } = {}) {
  return useQuery({
    queryKey: [...dataKeys.im.all, 'pending-count'] as const,
    queryFn: async ({ signal }) => {
      const query = new URLSearchParams({ status: 'pending', snoozed: 'false', limit: '1' })
      return (await requestList<ImMessage>('/api/im/messages', { query, signal })).total
    },
    enabled: opts.enabled ?? true,
    retry: noRetry404,
    refetchInterval: opts.refetchInterval,
  })
}

/** 单条；列表里没有（太旧、别处打开）时用它 */
export function useImMessage(id: string | null) {
  return useQuery({
    queryKey: dataKeys.im.detail(id ?? ''),
    queryFn: ({ signal }) => imApi.get(id!, signal),
    enabled: !!id,
    retry: noRetry404,
  })
}

/** 响应里的最新消息先写进缓存，界面不用等重新取 */
function putMessage(qc: QueryClient, m: ImMessage) {
  qc.setQueryData<ImMessage[]>(dataKeys.im.list, (old) => old?.map((x) => (x.id === m.id ? m : x)))
  qc.setQueryData(dataKeys.im.detail(m.id), m)
}

export function useImAction() {
  const qc = useQueryClient()
  const notify = useNotifyChange()
  return useMutation({
    mutationFn: ({ id, action }: { id: string; action: ImAction }) => imApi.act(id, action),
    onSuccess: (m) => {
      putMessage(qc, m)
      return notify({ kind: 'im-message', id: m.id })
    },
    // 发送失败（502）时后端记了失败的回复和原因，读回来
    onError: (_e, v) => notify({ kind: 'im-message', id: v.id }),
  })
}

/** 批量处理：成败都整体刷一遍（失败时可能已改了一部分） */
export function useImBatch() {
  const notify = useNotifyChange()
  return useMutation({
    mutationFn: (input: ImBatchInput) => imApi.batch(input),
    onSettled: () => notify({ kind: 'im-message' }),
  })
}

export function useImToTask() {
  const qc = useQueryClient()
  const notify = useNotifyChange()
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: ImTaskInput }) => imApi.toTask(id, input),
    onSuccess: async (r) => {
      putMessage(qc, r.message)
      await Promise.all([notify({ kind: 'im-message', id: r.message.id }), notify({ kind: 'object', id: r.task.id })])
    },
    // 已经转过（409）时读回消息，拿到那条任务
    onError: (_e, v) => notify({ kind: 'im-message', id: v.id }),
  })
}

/** 立即同步一个渠道（IM-01b）：成败都会改连接器的同步时间或状态，消息和连接器都刷一遍 */
export function useImSyncConnector() {
  const notify = useNotifyChange()
  const refresh = () => Promise.all([notify({ kind: 'im-message' }), notify({ kind: 'connector' })])
  return useMutation({
    mutationFn: (connectorId: string) => imApi.syncConnector(connectorId),
    onSuccess: () => refresh(),
    onError: () => refresh(),
  })
}
