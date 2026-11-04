// Agent 会话的读写（AG-01a）：服务商、全局会话、消息、对话的流。
// 接口见 docs/api-contract.md「Agent 供应商」「Agent 对话」；core/api 里还没有这几个资源，请求函数先放在这里。
// 写操作报 agent-session，一轮对话收尾报 agent-chat（工具可能建了对象、写了文件）。
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  chat, debugChat, decideToolCall, request, requestList, type ChatDone, type ChatEvent, type ChatRequest, type DebugChatRequest, type StreamOptions,
} from '../api'
import { agentKeys } from './agentKeys'
import { notifyChange, useNotifyChange } from './invalidate'
import { queryClient } from './queryClient'

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
  /** 最近一次测试连接的结论（后端 0046 落库）；没测过或改了连接配置后为 null */
  last_test?: (ProviderTestResult & { at: string }) | null
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
  /** 会话的来源（0047）：从哪条记录发起的，建的时候给、之后不改；不是从别的记录发起的没有这个键。
   * kind 说是哪种记录（im_message 是 IM 消息），label 是给人看的一句，其余由发起方定；
   * 会话里 Agent 新建的对象缺省把它记进 props.source_ref，有 project_id 时缺省挂到这个项目 */
  source_ref?: SessionSourceRef | null
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
export type AgentSessionInput = { title?: string; provider_id?: string; model?: string; workdir?: string; agent_id?: string; source_ref?: SessionSourceRef }
/** 会话来源（0047），JSON 对象，最多 16KB */
export type SessionSourceRef = { kind?: string; label?: string; project_id?: string } & Record<string, unknown>
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
  /** 停掉会话里正在跑的一轮（含确认后接着跑），已执行的工具调用不撤回 */
  stopSession: (id: string) => request<{ session_id: string; stopped: number }>('POST', sessionPath(id) + '/stop', { body: {} }),
  /** 从会话里移除几条消息（SPEC-sessions-1.43）；这一轮在跑时 409 */
  removeMessages: (id: string, ids: string[]) => request<{ session_id: string; removed: number }>('POST', sessionPath(id) + '/messages/remove', { body: { ids } }),
  /** 正在跑的会话 id */
  running: (signal?: AbortSignal) => request<{ session_ids: string[] }>('GET', '/api/agent/running', { signal }),
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

/**
 * 服务商的可选模型，不发请求：设置的模型、手填的模型 ID、本次会话测试连接拉回的列表，去重。
 * 给不能用 hook 的地方（SOP 节点的下拉选项），配合 loadProviderModels 和缓存订阅用。
 */
export function providerModelIds(p: AgentProvider): string[] {
  const manual = typeof p.extra?.model_ids === 'string' ? p.extra.model_ids.split(/[\s,，]+/).filter(Boolean) : []
  const tested = queryClient.getQueryData<ProviderTestResult>(agentKeys.models(p.id))?.models ?? []
  return [...new Set([...(p.model ? [p.model] : []), ...manual, ...tested])]
}

/** 拉一次服务商的模型列表进缓存（同 useProviderModels 的那份），已经有了或正在拉就不重复 */
export function loadProviderModels(providerId: string) {
  if (!providerId) return
  void queryClient.prefetchQuery({ queryKey: agentKeys.models(providerId), queryFn: () => agentApi.testProvider(providerId), staleTime: 5 * 60_000, retry: false })
}

/** 默认服务商，同后端：标了默认且启用的，没有取第一个启用的 */
export const defaultProvider = (list: readonly AgentProvider[]) => list.find((p) => p.is_default && p.enabled) ?? list.find((p) => p.enabled)

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

/** 正在跑的会话（停止按钮用）：有在跑的每 3 秒刷一次，没有时 15 秒 */
export function useRunningAgentSessions() {
  return useQuery({
    queryKey: ['agent-sessions', 'running'],
    queryFn: ({ signal }) => agentApi.running(signal),
    select: (r) => (Array.isArray(r?.session_ids) ? r.session_ids : []),
    refetchInterval: (q) => ((Array.isArray(q.state.data?.session_ids) && q.state.data.session_ids.length > 0) ? 3000 : 15000),
    retry: false,
  })
}

/** 停止会话里正在跑的一轮；停完刷新消息（会多一句「已手动停止」）和在跑列表 */
export function useStopAgentSession() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => agentApi.stopSession(id),
    onSettled: (_d, _e, id) => {
      void qc.invalidateQueries({ queryKey: ['agent-sessions', 'running'] })
      void qc.invalidateQueries({ queryKey: agentKeys.sessions.messages(id) })
    },
  })
}

/** 从会话里移除几条消息：移除后不再进模型的上下文；完了刷新这个会话的消息和会话列表（消息数变了） */
export function useRemoveAgentMessages() {
  const qc = useQueryClient()
  const notify = useNotifyChange()
  return useMutation({
    mutationFn: ({ sessionId, ids }: { sessionId: string; ids: string[] }) => agentApi.removeMessages(sessionId, ids),
    onSuccess: (_d, { sessionId }) => {
      void qc.invalidateQueries({ queryKey: agentKeys.sessions.messages(sessionId) })
      notify({ kind: 'agent-session' })
    },
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

/**
 * 确认或拒绝一次要人确认的调用（AG-02b），读接着跑的流；收尾同 streamChat 按 agent-chat 刷新
 * （执行记录的状态跟着重算，规则里带着）。sessionId 是调用所在的会话，调试对话里的调用不给。
 */
export function streamDecision(
  callId: string, approve: boolean, sessionId?: string, opts: StreamOptions<ChatEvent> = {},
): { done: Promise<ChatDone>; settled: Promise<void> } {
  const done = decideToolCall(callId, approve, opts)
  const settled = done.then(
    () => notifyChange({ kind: 'agent-chat', sessionId }),
    () => notifyChange({ kind: 'agent-chat', sessionId }),
  )
  return { done, settled }
}

/** 调试对话（AG-02c）：不写会话，产出照常落到数据上，收尾按 agent-chat 刷新对象、产出物 */
export function streamDebugChat(req: DebugChatRequest, opts: StreamOptions<ChatEvent> = {}): { done: Promise<ChatDone>; settled: Promise<void> } {
  const done = debugChat(req, opts)
  const settled = done.then(() => notifyChange({ kind: 'agent-chat' }), () => notifyChange({ kind: 'agent-chat' }))
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
