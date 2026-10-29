// Agent 会话的读写（AG-01a）：服务商、全局会话、消息、对话的流。
// 接口见 docs/api-contract.md「Agent 供应商」「Agent 对话」；core/api 里还没有这几个资源，请求函数先放在这里。
// 写操作报 agent-session，一轮对话收尾报 agent-chat（工具可能建了对象、写了文件）。
import { useMutation, useQuery } from '@tanstack/react-query'
import { chat, request, requestList, type ChatDone, type ChatEvent, type ChatRequest, type StreamOptions } from '../api'
import { agentKeys } from './agentKeys'
import { notifyChange, useNotifyChange } from './invalidate'

// ---- 类型（形状以 internal/domain 为准） ----

export type AgentProviderKind = 'openai' | 'gemini' | 'ollama'

// api_key 永远不出现在响应里，只有脱敏后的 api_key_masked 和 has_api_key
export type AgentProvider = {
  id: string
  name: string
  kind: AgentProviderKind | string
  base_url: string
  model: string
  enabled: boolean
  is_default: boolean
  api_key_masked: string
  has_api_key: boolean
  extra: Record<string, unknown>
  created_at: string
  updated_at: string
}

export type ProviderTestResult = { ok: boolean; latency_ms: number; message: string; models?: string[] }

export type AgentSession = {
  id: string
  title: string
  // null 是全局会话；归属一经创建不能改
  object_id: string | null
  provider_id: string
  model: string
  workdir: string
  /** 挂的 Agent（AG-01b1）；null 是不挂 Agent、按服务商和模型开的会话。建的时候定下，改不了 */
  agent_id?: string | null
  /** 挂了 Agent 但 Agent 已删除：只能回看 */
  agent_deleted?: boolean
  created_at: string
  updated_at: string
  message_count: number
}

export type AgentMessageRole = 'user' | 'assistant' | 'tool'

export type AgentMessage = {
  id: string
  session_id: string
  role: AgentMessageRole | string
  // tool 消息是工具结果的摘要
  content: string
  tool_name?: string
  tool_args?: string
  created_at: string
}

// 带 agent_id 时后端用这个 Agent 的服务商和模型，provider_id、model 忽略
export type AgentSessionInput = { title?: string; provider_id?: string; model?: string; workdir?: string; agent_id?: string }
// 改不了 object_id
export type AgentSessionPatch = { title?: string; provider_id?: string; model?: string; workdir?: string }

// ---- 请求 ----

const sessionPath = (id: string) => `/api/agent/sessions/${encodeURIComponent(id)}`

export const agentApi = {
  providers: (signal?: AbortSignal) => requestList<AgentProvider>('/api/agent-providers', { signal }),
  testProvider: (id: string) => request<ProviderTestResult>('POST', `/api/agent-providers/${encodeURIComponent(id)}/test`),
  unscopedSessions: (signal?: AbortSignal) =>
    requestList<AgentSession>('/api/agent/sessions', { query: new URLSearchParams({ unscoped: 'true' }), signal }),
  createSession: (input: AgentSessionInput) => request<AgentSession>('POST', '/api/agent/sessions', { body: input }),
  patchSession: (id: string, patch: AgentSessionPatch) => request<AgentSession>('PATCH', sessionPath(id), { body: patch }),
  deleteSession: (id: string) => request<null>('DELETE', sessionPath(id)),
  messages: (id: string, signal?: AbortSignal) => requestList<AgentMessage>(sessionPath(id) + '/messages', { signal }),
}

// ---- 查询 ----

export function useAgentProviders() {
  return useQuery({
    queryKey: agentKeys.providers,
    queryFn: ({ signal }) => agentApi.providers(signal),
    select: (r) => r.data,
  })
}

/** 某个服务商能用的模型；靠「测试连接」顺带拉回，拉不到就是空数组。只在要选模型时才取 */
export function useProviderModels(providerId: string, enabled = true) {
  return useQuery({
    queryKey: agentKeys.models(providerId),
    queryFn: () => agentApi.testProvider(providerId),
    enabled: enabled && !!providerId,
    staleTime: 5 * 60_000,
    retry: false,
    select: (r) => r.models ?? [],
  })
}

/** 全局会话，最近更新的在前（后端排序） */
export function useAgentSessions() {
  return useQuery({
    queryKey: agentKeys.sessions.unscoped,
    queryFn: ({ signal }) => agentApi.unscopedSessions(signal),
    select: (r) => r.data,
  })
}

/** 一个会话的消息，按时间正序 */
export function useAgentMessages(sessionId: string | null) {
  return useQuery({
    queryKey: agentKeys.sessions.messages(sessionId ?? ''),
    queryFn: ({ signal }) => agentApi.messages(sessionId ?? '', signal),
    enabled: !!sessionId,
    select: (r) => r.data,
  })
}

// ---- 写 ----

export function useCreateAgentSession() {
  const notify = useNotifyChange()
  return useMutation({
    mutationFn: (input: AgentSessionInput) => agentApi.createSession(input),
    onSuccess: () => notify({ kind: 'agent-session' }),
  })
}

export function usePatchAgentSession() {
  const notify = useNotifyChange()
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: AgentSessionPatch }) => agentApi.patchSession(id, patch),
    onSuccess: () => notify({ kind: 'agent-session' }),
  })
}

/** 删除会话：消息级联删除，产出物保留、session_id 置空 */
export function useDeleteAgentSession() {
  const notify = useNotifyChange()
  return useMutation({
    mutationFn: (id: string) => agentApi.deleteSession(id),
    onSuccess: () => notify({ kind: 'agent-session' }),
  })
}

/**
 * 发一条消息并读流（POST /api/agent/chat）。done 收到 done 事件时 resolve，失败照样 reject；
 * 收尾（done 或失败）后按 agent-chat 刷新，settled 在有人在看的消息重新读回后 resolve（不会 reject），
 * 等它再收起流式气泡，界面不会闪一下空。
 * 作用在应用唯一的缓存上，组件外（模块级状态）也能用。
 */
export function streamChat(req: ChatRequest, opts: StreamOptions<ChatEvent> = {}): { done: Promise<ChatDone>; settled: Promise<void> } {
  const done = chat(req, opts)
  const settled = done.then(
    (d) => notifyChange({ kind: 'agent-chat', sessionId: d.session_id || req.session_id }),
    () => notifyChange({ kind: 'agent-chat', sessionId: req.session_id }),
  )
  return { done, settled }
}

// 快速新建会话（外壳的「新建会话」按钮和 Cmd/Ctrl+J）带的第一句话：外壳建好会话后记在这里，
// 会话页打开这个会话时当作 autoSend 发出去（ChatPane 只在会话还没有消息时发一次）
const firstMessages = new Map<string, string>()

export function setFirstMessage(sessionId: string, text: string) {
  if (text) firstMessages.set(sessionId, text)
}

export function firstMessageOf(sessionId: string): string | undefined {
  return firstMessages.get(sessionId)
}
