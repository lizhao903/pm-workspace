// IM 会话（CT-02，PJ-02b 起前端用）：内核的 /api/conversations，群聊和私聊各有稳定 id。契约见 docs/api-contract.md「会话 conversations」。
// 这里只读：项目绑定会话时从这里挑。会话的增删改由 IM 插件收消息时做，界面上暂不编辑。
import { useQuery } from '@tanstack/react-query'
import { request } from '../api'
import { dataKeys } from './keys'

export type ConversationKind = 'group' | 'direct'

export type Conversation = {
  id: string
  channel: string
  external_id: string
  kind: ConversationKind | string
  /** 群名；私聊可空 */
  name: string
  /** 成员的 IM 身份 id，按加入先后 */
  members: string[]
  created_at: string
  updated_at: string
}

export const normConversation = (c: Conversation): Conversation => ({ ...c, name: c.name ?? '', members: c.members ?? [] })

export const conversationsApi = {
  list: async (signal?: AbortSignal) => ((await request<Conversation[] | null>('GET', '/api/conversations', { signal })) ?? []).map(normConversation),
}

/** 全部会话，按渠道、名字、编号排 */
export function useConversations(opts: { enabled?: boolean } = {}) {
  return useQuery({ queryKey: dataKeys.conversations.list, queryFn: ({ signal }) => conversationsApi.list(signal), enabled: opts.enabled ?? true })
}
