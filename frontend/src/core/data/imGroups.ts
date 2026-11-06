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
  /** participants 里只能显示渠道编号的人（0.26.0，TSK-0494），给的是编号 */
  unresolved_users: string[]
  /** 群名为空或就是编号 */
  name_unresolved: boolean
  /** 能回渠道按编号查名字（渠道支持、有消息所在的连接器；现在只有 Slack） */
  can_refill: boolean
  /** 之前查过没查到的原因，没查过或都查到了为空串 */
  refill_error: string
  /** 能「补全消息」（0.30.0，TSK-0724）：渠道支持拉历史、有消息所在的连接器；现在只有 Slack */
  can_backfill: boolean
  /** 不能补全的原因（按钮置灰时的说明），能的为空串 */
  backfill_note: string
}

/** 补全消息的范围：最近 7 天、30 天、全部（全部一个会话累计至多翻 5000 条） */
export type ImHistoryRange = '7d' | '30d' | 'all'

/**
 * 补全一个会话的结果（0.30.0，TSK-0724）：added 新补进来的（其中 expired 条较早的落成已过期、muted 条因自动忽略落成已忽略），
 * duplicates 已经有的，bodies_filled 补上正文的；complete 为 false 时带 cursor 再调接着补，limited 是撞上渠道限流停下的，capped 是「全部」到了上限
 */
export type ImHistoryBackfillResult = {
  conversation_id: string
  connector_id: string
  range: ImHistoryRange | string
  scanned: number
  threads_checked: number
  added: number
  expired: number
  muted: number
  duplicates: number
  bodies_filled: number
  complete: boolean
  limited: boolean
  capped: boolean
  cursor: string
}

/** 查询回填补上的一个名字：kind user 是发信人，conversation 是群名；source local 是本地已有、channel 是回渠道查的 */
export type ImNameFilled = { conversation_id: string; kind: 'user' | 'conversation' | string; external_id: string; name: string; source: 'local' | 'channel' | string }
/** 没补上的一个；external_id 为空是整个会话没查（渠道没连接等），message 是给人看的原因 */
export type ImNameFailed = { conversation_id: string; kind: 'user' | 'conversation' | string; external_id: string; code: string; message: string }
/** 一次查询回填的结果：skipped 是之前查不到、这次没重查的，remaining 是限流或到了上限没来得及查的 */
export type ImNameRefillResult = { conversations: number; checked: number; filled: ImNameFilled[]; failed: ImNameFailed[]; skipped: number; remaining: number }

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
  /** 机器人、「我」（0.30.0）：「全部加为联系人」排除这两种 */
  is_bot: boolean
  is_self: boolean
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
  unresolved_users: s.unresolved_users ?? [], name_unresolved: s.name_unresolved ?? false, can_refill: s.can_refill ?? false, refill_error: s.refill_error ?? '',
  can_backfill: s.can_backfill ?? false, backfill_note: s.backfill_note ?? '',
})

const normRefill = (r: ImNameRefillResult): ImNameRefillResult => ({ ...r, filled: r.filled ?? [], failed: r.failed ?? [], skipped: r.skipped ?? 0, remaining: r.remaining ?? 0 })

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
      is_bot: m.is_bot ?? false, is_self: m.is_self ?? false,
    })),
  /** 查询回填一个会话（0.26.0）：之前查不到的也重查；渠道查不了、连接器暂停或断开 409，渠道整次调不了 502 */
  refillNames: async (conversationId: string) =>
    normRefill(await request<ImNameRefillResult>('POST', `/api/im/conversations/${encodeURIComponent(conversationId)}/refill-names`)),
  /** 批量查询回填：不给 ids 是全部有缺的会话；一次最多回渠道查 100 个，之前查不到的默认跳过 */
  refillAllNames: async (input: { conversation_ids?: string[]; retry_failed?: boolean } = {}) =>
    normRefill(await request<ImNameRefillResult>('POST', '/api/im/conversations/refill-names', { body: input })),
  /**
   * 补全一个会话的消息（0.30.0）：回渠道拉历史、补空正文，补进来的不当新消息（不触发 SOP、不计未读、不通知）。
   * cursor 是上一次结果里的，接着往旧补。渠道不支持、没有连接器、连接器暂停或断开 409；渠道整次调不了 502
   */
  backfill: (conversationId: string, range: ImHistoryRange, cursor?: string) => {
    const query = new URLSearchParams({ range })
    if (cursor) query.set('cursor', cursor)
    return request<ImHistoryBackfillResult>('POST', `/api/im/conversations/${encodeURIComponent(conversationId)}/backfill`, { query })
  },
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

/** 查询回填（单个会话或批量）：补上的名字在消息和会话统计里，消息、统计一起刷（都在 im 前缀下） */
export function useRefillImNames() {
  const notify = useNotifyChange()
  return useMutation({
    mutationFn: (x: { conversationId: string } | { all: true; retryFailed?: boolean }) =>
      'conversationId' in x ? imGroupsApi.refillNames(x.conversationId) : imGroupsApi.refillAllNames(x.retryFailed ? { retry_failed: true } : {}),
    onSettled: () => notify({ kind: 'im-message' }),
  })
}

/** 补全一个会话的消息（0.30.0，TSK-0724）；补进来的消息和会话统计跟着刷 */
export function useImBackfillConversation() {
  const notify = useNotifyChange()
  return useMutation({
    mutationFn: (x: { conversationId: string; range: ImHistoryRange; cursor?: string }) => imGroupsApi.backfill(x.conversationId, x.range, x.cursor),
    onSettled: () => notify({ kind: 'im-message' }),
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
