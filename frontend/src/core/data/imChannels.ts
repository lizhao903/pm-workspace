// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// IM 连接器可选的会话（Slack「监听频道」的列表选择）：GET /api/im/connectors/{id}/conversations。契约见 docs/api-contract.md「IM 消息插件 im」。
// 按连接器的 Token 现查渠道，慢、还受限流，所以缓存键不放在 im 前缀下（消息一变不跟着重查），只在打开抽屉或点「刷新」时取。
import { useQuery } from '@tanstack/react-query'
import { request } from '../api'

/** public 公开频道、private 私有频道、mpim 多人私信 */
export type ImConversationKind = 'public' | 'private' | 'mpim'

/** name 是渠道里的名字：频道不带 #，多人私信是 mpdm-a--b--c-1 这种 */
export type ImConversationOption = { id: string; name: string; kind: ImConversationKind; is_member: boolean; is_archived: boolean }

/** complete 为 false 时只列了一部分（翻页途中限流、会话太多），note 写原因 */
export type ImConversationList = { connector_id: string; items: ImConversationOption[]; complete: boolean; note: string }

export const imConversationsKey = (connectorId: string) => ['im-conversations', connectorId] as const

export const imChannelsApi = {
  /** 连接器不在 404；不支持、已暂停、已断开、没填 Token 409（reason：unsupported / connector_paused / connector_disconnected / no_token）；渠道出错 502 list_failed */
  list: async (connectorId: string, signal?: AbortSignal) => {
    const r = await request<ImConversationList>('GET', `/api/im/connectors/${encodeURIComponent(connectorId)}/conversations`, { signal })
    return { ...r, items: r.items ?? [], note: r.note ?? '' }
  },
}

/** 连接器可选的会话；connectorId 为空（新建还没保存）时不查。失败不自动重试，界面退回文本框并给「重试」 */
export function useImConversations(connectorId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: imConversationsKey(connectorId ?? ''),
    queryFn: ({ signal }) => imChannelsApi.list(connectorId ?? '', signal),
    enabled: enabled && !!connectorId,
    retry: false,
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  })
}
