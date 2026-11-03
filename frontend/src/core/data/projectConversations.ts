// 项目绑定的会话（PJ-02b）：项目插件的 /api/projects/{id}/conversations（PJ-02a），按会话 id 绑，改群名不断。
// 项目里的消息按绑定的会话逐个取 /api/im/messages?conversation_id=（IM-01a），只取绑定会话的，不拉全部消息再筛。
// 绑定、解绑报 { kind: 'project-conversation' }；消息的键挂在 im 前缀下，消息一变（im-message）跟着刷。
// 归到项目的消息（消息分流）另取 /api/im/messages?project_id=，和绑定会话的消息按 id 去重合在一起。
import { useMutation, useQueries, useQuery } from '@tanstack/react-query'
import { isApiError, request, requestList } from '../api'
import { IM_PAGE_MAX, imApi, normMessage, type ImMessage } from './im'
import { useNotifyChange } from './invalidate'
import { dataKeys } from './keys'

export type ProjectConversation = {
  project_id: string
  conversation_id: string
  /** 每次从会话表现读，改名后就是新名字 */
  conversation: { id: string; channel: string; external_id: string; kind: string; name: string }
  created_at: string
}

const base = (id: string) => `/api/projects/${encodeURIComponent(id)}/conversations`

export const projectConversationsApi = {
  list: async (id: string, signal?: AbortSignal) => (await requestList<ProjectConversation>(base(id), { signal })).data,
  bind: (id: string, conversationId: string) => request<ProjectConversation>('POST', base(id), { body: { conversation_id: conversationId } }),
  unbind: (id: string, conversationId: string) => request<null>('DELETE', `${base(id)}/${encodeURIComponent(conversationId)}`),
  /** 一个会话里的消息，按页拉完，按发送时间倒序 */
  messages: (conversationId: string, signal?: AbortSignal) => allMessages({ conversation_id: conversationId }, signal),
  /** 归到这个项目的消息，按页拉完 */
  projectMessages: (projectId: string, signal?: AbortSignal) => allMessages({ project_id: projectId }, signal),
}

/** 按条件把消息按页拉完，按发送时间倒序 */
async function allMessages(filter: Record<string, string>, signal?: AbortSignal) {
  const out: ImMessage[] = []
  for (let offset = 0; ; offset += IM_PAGE_MAX) {
    const query = new URLSearchParams({ ...filter, limit: String(IM_PAGE_MAX), offset: String(offset) })
    const r = await requestList<ImMessage>('/api/im/messages', { query, signal })
    out.push(...r.data.map(normMessage))
    if (!r.data.length || out.length >= r.total) return out
  }
}

/** 项目绑定的会话，按绑定先后 */
export function useProjectConversations(projectId: string | null) {
  return useQuery({
    queryKey: dataKeys.projectConversations(projectId ?? ''),
    queryFn: ({ signal }) => projectConversationsApi.list(projectId ?? '', signal),
    enabled: !!projectId,
  })
}

export function useBindProjectConversation(projectId: string) {
  const notify = useNotifyChange()
  return useMutation({
    mutationFn: (conversationId: string) => projectConversationsApi.bind(projectId, conversationId),
    onSuccess: () => notify({ kind: 'project-conversation', projectId }),
  })
}

export function useUnbindProjectConversation(projectId: string) {
  const notify = useNotifyChange()
  return useMutation({
    mutationFn: (conversationId: string) => projectConversationsApi.unbind(projectId, conversationId),
    onSuccess: () => notify({ kind: 'project-conversation', projectId }),
  })
}

export type ConversationMessages = {
  /** 这些会话里的消息合在一起，按发送时间倒序 */
  data: ImMessage[]
  isPending: boolean
  isError: boolean
  /** 第一个出错的会话的错误 */
  error: unknown
  /** 消息接口 404：IM 消息插件没装或停用 */
  noPlugin: boolean
  refetch: () => void
}

/** 插件没装或停用时接口 404，不重试 */
const noRetry404 = (n: number, e: unknown) => !isApiError(e, 'not_found') && n < 2

/** 几个会话里的消息；给了 projectId 时再并上归到这个项目的消息。enabled=false（IM 插件没在跑）时不发请求 */
export function useConversationMessages(conversationIds: readonly string[],
  opts: { enabled?: boolean; refetchInterval?: number | false; projectId?: string } = {}): ConversationMessages {
  const enabled = opts.enabled ?? true
  const pid = opts.projectId
  return useQueries({
    queries: [
      ...conversationIds.map((id) => ({
        queryKey: dataKeys.im.conversation(id) as readonly unknown[],
        queryFn: ({ signal }: { signal: AbortSignal }) => projectConversationsApi.messages(id, signal),
        enabled,
        retry: noRetry404,
        refetchInterval: opts.refetchInterval,
      })),
      ...(pid ? [{
        queryKey: dataKeys.im.project(pid) as readonly unknown[],
        queryFn: ({ signal }: { signal: AbortSignal }) => projectConversationsApi.projectMessages(pid, signal),
        enabled,
        retry: noRetry404,
        refetchInterval: opts.refetchInterval,
      }] : []),
    ],
    combine: (rs) => {
      const seen = new Set<string>()
      const data: ImMessage[] = []
      for (const r of rs) for (const m of r.data ?? []) if (!seen.has(m.id)) { seen.add(m.id); data.push(m) }
      data.sort((a, b) => b.at.localeCompare(a.at))
      const bad = rs.find((r) => r.isError)
      return {
        data,
        isPending: enabled && rs.some((r) => r.isPending),
        isError: !!bad,
        error: bad?.error ?? null,
        noPlugin: rs.some((r) => isApiError(r.error, 'not_found')),
        refetch: () => { for (const r of rs) if (r.isError) void r.refetch() },
      }
    },
  })
}

/** 全部消息，和 IM 消息页同一份缓存；绑定面板开着时才取，用来排「最近有消息的群」 */
export function useAllImMessages(enabled: boolean) {
  return useQuery({ queryKey: dataKeys.im.list, queryFn: ({ signal }) => imApi.all(signal), enabled, retry: noRetry404 })
}
