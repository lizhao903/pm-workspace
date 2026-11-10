// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 会话上下文治理（P0-S2）：GET /api/agent/sessions/{id}/context 和 PATCH 会话的追加要求。
// 契约见 docs/api-contract.md「Agent 对话」：
//   { session_id, history_limit, total_messages, dropped_count, sent_chars, approx_tokens,
//     messages: [{ id, role, content, tool_name, tool_args, created_at, dropped }] }
// messages 全部按时间正序；前 dropped_count 条 dropped=true，这些不再发给模型。
// 追加要求走现有 PATCH /api/agent/sessions/{id} 的 instruction（≤2000 字，空串清空），只影响这个会话。
// 后端并行开发中，面板关着时不发请求；失败按面板内的错误处理，不影响对话本身。
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { request } from '../api'
import { useNotifyChange } from './invalidate'

/** 会话里的一条消息，dropped 是「这次不会发给模型」 */
export type AgentContextMessage = {
  id: string
  role: string
  content: string
  /** 仅 role=tool */
  tool_name?: string
  /** 仅 role=tool，JSON 原文 */
  tool_args?: string
  created_at: string
  dropped: boolean
}

/** 一次对话实际会带上的上下文：最近 history_limit 条，前面的已经裁掉 */
export type AgentSessionContext = {
  session_id: string
  /** 后端只带最近多少条，固定 40（契约值，前端照显示） */
  history_limit: number
  total_messages: number
  /** 被裁掉、不会发送的条数（最前面的那些） */
  dropped_count: number
  sent_chars: number
  /** 粗估 token 数，按字数换算 */
  approx_tokens: number
  /** 这个会话当前的追加要求（后加）：面板打开时用它初始化输入框；没有/空串就是没设过 */
  instruction?: string
  messages: AgentContextMessage[]
}

export const agentContextKeys = {
  one: (sessionId: string) => ['agent-sessions', 'context', sessionId] as const,
}

const sessionPath = (id: string) => `/api/agent/sessions/${encodeURIComponent(id)}`

/** 后端字段缺了（旧版、mock）也当空处理，面板不用到处判空 */
function normContext(raw: Partial<AgentSessionContext> | null | undefined): AgentSessionContext {
  return {
    session_id: raw?.session_id ?? '',
    history_limit: raw?.history_limit ?? 0,
    total_messages: raw?.total_messages ?? 0,
    dropped_count: raw?.dropped_count ?? 0,
    sent_chars: raw?.sent_chars ?? 0,
    approx_tokens: raw?.approx_tokens ?? 0,
    instruction: typeof raw?.instruction === 'string' ? raw.instruction : undefined,
    messages: Array.isArray(raw?.messages) ? raw.messages : [],
  }
}

export const agentContextApi = {
  get: async (id: string, signal?: AbortSignal): Promise<AgentSessionContext> =>
    normContext(await request<Partial<AgentSessionContext> | null>('GET', `${sessionPath(id)}/context`, { signal })),
  /** 保存会话追加要求：空串清空；回会话，instruction 是后端落下的值（可能做过去空白等归一） */
  saveInstruction: (id: string, instruction: string) =>
    request<{ instruction?: string }>('PATCH', sessionPath(id), { body: { instruction } }),
}

/** 会话的上下文；enabled 为 false（面板关着）时不发请求，打开面板才取一次 */
export function useAgentSessionContext(sessionId: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: agentContextKeys.one(sessionId ?? ''),
    queryFn: ({ signal }) => agentContextApi.get(sessionId ?? '', signal),
    enabled: enabled && !!sessionId,
    retry: false,
  })
}

/** 保存会话追加要求：成功后刷新这个会话的上下文和会话列表/详情（instruction 变了） */
export function useSaveSessionInstruction() {
  const qc = useQueryClient()
  const notify = useNotifyChange()
  return useMutation({
    mutationFn: ({ sessionId, instruction }: { sessionId: string; instruction: string }) =>
      agentContextApi.saveInstruction(sessionId, instruction),
    onSuccess: (_d, { sessionId }) => {
      void qc.invalidateQueries({ queryKey: agentContextKeys.one(sessionId) })
      return notify({ kind: 'agent-session' })
    },
  })
}
