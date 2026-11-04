// 群组管理（IM 插件 0.15.0）：会话统计 GET /api/im/conversations/summary、批量设默认项目 PUT /api/im/conversation-projects。
// 统计一次列出有消息（或设了默认项目）的会话：消息总数、待处理数（不含稍后、已过期）、未读数、最近一条时间、默认项目。
// 批量设逐条校验，过了的写上、没过的列在 failed（全没过也是 200）；一次最多 200 个会话。
// 主动发消息（0.17.0）：POST /api/im/send 发到已有会话或账号所在、还没收过消息的频道，GET /api/im/conversations/{id}/sent 是发出的记录（含失败的、SOP 发的）。
// @ 候选（0.18.0）：GET /api/im/conversations/{id}/members 是会话里发过言的人 + 联系人里在这个渠道有 IM 身份的人；
// 回复、发消息的 body 带 mentions，后端按渠道换成真正的 @（Slack <@MemberID>，Telegram @用户名或 text_mention），正文仍存「@名字」。
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { isApiError, request, requestList } from '../api'
import { useNotifyChange } from './invalidate'
import type { ImConversationProject } from './im'
import { dataKeys } from './keys'

/** 批量设默认项目一次最多几个会话（同后端） */
export const IM_CONV_BATCH_MAX = 200

export type ImConversationSummary = {
  conversation_id: string
  channel: string
  kind: 'group' | 'direct' | string
  /** 会话名；私聊为空 */
  name: string
  external_id: string
  /** 最近一条消息所在的连接器（主动发消息默认用它），没有消息为空串 */
  connector_id: string
  /** 发过消息的人，最近发言的在前，最多 5 个；私聊的对方是第一个 */
  participants: string[]
  total: number
  pending: number
  unread: number
  /** 最近一条的发送时间；没有消息（只设了默认项目）为 null */
  last_at: string | null
  project_id: string | null
  project_ref: string
  project_name: string
  /** 主动发出去的（发成功的）条数和最近一次的时间（0.17.0），没发过为 0 和 null */
  sent: number
  last_sent_at: string | null
}

/** 主动发出的一条（0.17.0）：群组管理里手动发的（manual）或 SOP 节点发的（sop），失败的也有 */
export type ImOutboxItem = {
  id: string
  conversation_id: string
  channel: string
  connector_id: string
  text: string
  status: 'sent' | 'failed' | string
  error: string
  external_id: string
  source: 'manual' | 'sop' | string
  run_id: string
  created_at: string
}

/**
 * 主动发一条：已登记的会话给 conversation_id（connector_id 可省，省了用会话里最近一条消息的连接器；没收过消息时必须给）；
 * 还没收过消息的频道给 connector_id + conversation_external_id（+ conversation_name），后端先登记成群组会话再发
 */
export type ImSendInput = {
  text: string
  conversation_id?: string
  connector_id?: string
  conversation_external_id?: string
  conversation_name?: string
  /** 正文里要真正 @ 到的人（0.18.0） */
  mentions?: ImMention[]
}

/**
 * 正文里一个「@名字」要真正 @ 到的人（0.18.0）：external_id 是渠道里的编号（同消息的 sender_id），
 * 也可以给联系人的 IM 身份 identity_id；name 是正文里 @ 后面的名字（不带 @）
 */
export type ImMention = { external_id?: string; identity_id?: string; name: string }

/** @ 候选：source conversation 是会话里发过言的（最近的在前），contact 是联系人里在这个渠道有 IM 身份的 */
export type ImMember = {
  external_id: string
  /** 联系人名优先，其次渠道里的名字 */
  name: string
  sender_name: string
  identity_id: string
  contact_id: string
  source: 'conversation' | 'contact' | string
  /** 在这个会话里最近一次发言的时间，没发过言为空串 */
  last_at: string
}

/** 一次最多带几个 @（同后端） */
export const IM_MENTIONS_MAX = 50

/** 主动发消息正文上限（同后端回复上限） */
export const IM_SEND_MAX = 4000

/** 一项：project_id 是项目 id、编号或名字，null 是清除 */
export type ImConvProjectBatchInput = { conversation_id: string; project_id: string | null }[]
/** 没写成的一项，message 是给人看的原因 */
export type ImConvProjectFailure = { conversation_id: string; project_id: string | null; code: string; message: string }
export type ImConvProjectBatchResult = { updated: ImConversationProject[]; failed: ImConvProjectFailure[] }

const norm = (s: ImConversationSummary): ImConversationSummary => ({
  ...s, name: s.name ?? '', participants: s.participants ?? [], project_ref: s.project_ref ?? '', project_name: s.project_name ?? '',
  sent: s.sent ?? 0, last_sent_at: s.last_sent_at ?? null, connector_id: s.connector_id ?? '',
})

export const imGroupsApi = {
  summary: async (channel: string, signal?: AbortSignal) => {
    const query = channel ? new URLSearchParams({ channel }) : undefined
    return (await requestList<ImConversationSummary>('/api/im/conversations/summary', { query, signal })).data.map(norm)
  },
  /** 整批不合法（空、超过 200、缺 project_id）400；逐条的问题在 failed 里 */
  setProjects: async (items: ImConvProjectBatchInput) => {
    const r = await request<ImConvProjectBatchResult>('PUT', '/api/im/conversation-projects', { body: { items } })
    return { updated: r.updated ?? [], failed: r.failed ?? [] }
  },
  /** 主动发一条（不挂在消息列里）：会话、连接器不存在 404；没收过消息又没给连接器、连接器暂停/断开/只收 409；渠道发送失败 502 send_failed（记录照样留着） */
  send: (input: ImSendInput) => request<ImOutboxItem>('POST', '/api/im/send', { body: input }),
  /** @ 候选：会话里发过言的人 + 联系人里在这个渠道有 IM 身份的人；会话不存在 404 */
  members: async (conversationId: string, signal?: AbortSignal) =>
    (await requestList<ImMember>(`/api/im/conversations/${encodeURIComponent(conversationId)}/members`, { signal })).data.map((m) => ({
      ...m, sender_name: m.sender_name ?? '', identity_id: m.identity_id ?? '', contact_id: m.contact_id ?? '', last_at: m.last_at ?? '',
    })),
  /** 这个会话发出的消息，新的在前 */
  sent: async (conversationId: string, signal?: AbortSignal) =>
    (await requestList<ImOutboxItem>(`/api/im/conversations/${encodeURIComponent(conversationId)}/sent`, { signal })).data,
}

const noRetry404 = (n: number, e: unknown) => !isApiError(e, 'not_found') && n < 2

/** 会话统计；channel 为空是全部渠道。键在 im 前缀下，收到新消息、处理消息、改默认项目时跟着刷 */
export function useImConversationSummary(channel = '', enabled = true) {
  return useQuery({
    queryKey: dataKeys.im.conversationSummary(channel),
    queryFn: ({ signal }) => imGroupsApi.summary(channel, signal),
    enabled,
    retry: noRetry404,
  })
}

/** 批量设、清除默认项目：没归项目的消息跟着变，消息、统计、默认项目一起刷（都在 im 前缀下） */
export function useSetImConversationProjects() {
  const notify = useNotifyChange()
  return useMutation({
    mutationFn: (items: ImConvProjectBatchInput) => imGroupsApi.setProjects(items),
    onSuccess: (r) => (r.updated.length ? notify({ kind: 'im-message' }) : undefined),
  })
}

/** 一个会话发出的消息 */
export function useImSent(conversationId: string) {
  return useQuery({ queryKey: dataKeys.im.sent(conversationId), queryFn: ({ signal }) => imGroupsApi.sent(conversationId, signal), retry: noRetry404 })
}

/** 一个会话的 @ 候选；conversationId 为空时不查（还没收过消息的频道、没认上会话的消息） */
export function useImMembers(conversationId: string | null | undefined) {
  return useQuery({
    queryKey: dataKeys.im.members(conversationId ?? ''),
    queryFn: ({ signal }) => imGroupsApi.members(conversationId!, signal),
    enabled: !!conversationId,
    retry: noRetry404,
    staleTime: 60_000,
  })
}

/** 主动发一条：成功、失败（502 也记了一条）都刷新记录和统计 */
export function useImSendToConversation() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: ImSendInput) => imGroupsApi.send(input),
    // 失败（502）也记了一条；新频道发出后多了会话，会话表一起刷
    onSettled: () => Promise.all([
      qc.invalidateQueries({ queryKey: ['im', 'sent'] }),
      qc.invalidateQueries({ queryKey: ['im', 'conversation-summary'] }),
      qc.invalidateQueries({ queryKey: dataKeys.conversations.all }),
    ]),
  })
}
