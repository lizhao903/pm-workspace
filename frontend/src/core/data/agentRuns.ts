// 会话页的执行记录（AG-01b8，SPEC-sessions-2）：GET /api/agent-runs 按 Agent、状态筛的一页，各状态的条数，单条详情。
// 契约见 docs/api-contract.md「Agent 执行记录 agent-runs」。执行记录由后端在触发时写，前端只读；
// 确认、拒绝调用走 /api/agent/tool-calls（AG-02b），收尾按 agent-chat 刷新，规则里带着执行记录。
import { keepPreviousData, useQueries, useQuery } from '@tanstack/react-query'
import { request, requestList } from '../api'
import { agentConfigKeys } from './agentConfigKeys'
import type { AgentRunStatus } from './agents'

export type AgentRunTriggerKind = 'task' | 'im' | 'schedule'

export type AgentRun = {
  id: string
  agent_id: string
  trigger_kind: AgentRunTriggerKind | (string & {})
  /** 给人看的触发说明，如「任务分配给它 · TSK-0012」 */
  trigger: string
  /** 任务的对象 id、IM 消息 id、定时任务 id */
  source_id: string
  event_key: string
  /** 这次执行建的会话；还没建出会话就失败了为 null */
  session_id: string | null
  status: AgentRunStatus | (string & {})
  /** Agent 最后一条回复，失败时是原因 */
  summary: string
  started_at: string
  finished_at: string | null
  /** 还在等确认的调用数 */
  pending: number
}

/** 会话里的工具调用记录，按时间正序（含「等待确认：…」那条） */
export type AgentRunCall = { tool: string; args: string; summary: string; at: string }

export type AgentToolCallState = 'pending' | 'confirmed' | 'rejected'

/** 要人确认的调用（「Agent 工具授权」的 agent_tool_calls） */
export type AgentToolCall = {
  id: string
  agent_id: string
  session_id: string | null
  run_id: string | null
  call_id: string
  tool: string
  grant_key: string
  args: string
  state: AgentToolCallState | (string & {})
  result: string
  created_at: string
  decided_at: string | null
}

export type AgentRunDetail = AgentRun & { calls: AgentRunCall[]; tool_calls: AgentToolCall[] }

export type AgentRunFilter = { agent?: string; status?: string[]; limit?: number; offset?: number }

/** 执行记录的状态，同契约 AgentRun.status；颜色照原型 RUN_STATUS，running 原型没有 */
export const AGENT_RUN_STATUS: Record<AgentRunStatus, { label: string; color: string }> = {
  running: { label: '执行中', color: 'var(--accent)' },
  waiting: { label: '等你确认', color: '#b0570b' },
  done: { label: '已完成', color: '#2f7d43' },
  rejected: { label: '已拒绝', color: '#a19d92' },
  failed: { label: '失败', color: '#c0352b' },
}

/** 要人确认的调用的状态 */
export const TOOL_CALL_STATE: Record<AgentToolCallState, string> = { pending: '等你确认', confirmed: '已确认执行', rejected: '已拒绝' }

/** 后端单页上限 */
export const AGENT_RUN_PAGE_MAX = 500
// 有在跑的就隔一会儿再读：执行在后台跑，没有事件推过来
const RUNNING_POLL_MS = 5_000

function runQuery(f: AgentRunFilter): URLSearchParams {
  const q = new URLSearchParams()
  if (f.agent) q.set('agent', f.agent)
  if (f.status?.length) q.set('status', f.status.join(','))
  if (f.limit !== undefined) q.set('limit', String(f.limit))
  if (f.offset) q.set('offset', String(f.offset))
  return q
}

const norm = <T extends AgentRun>(r: T): T => ({ ...r, summary: r.summary ?? '', pending: r.pending ?? 0 })

export const agentRunsApi = {
  /** 等确认的在前，其余按开始时间倒序；total 不含分页 */
  list: async (f: AgentRunFilter, signal?: AbortSignal) => {
    const r = await requestList<AgentRun>('/api/agent-runs', { query: runQuery(f), signal })
    return { ...r, data: r.data.map(norm) }
  },
  get: async (id: string, signal?: AbortSignal) => {
    const d = await request<AgentRunDetail>('GET', `/api/agent-runs/${encodeURIComponent(id)}`, { signal })
    return { ...norm(d), calls: d.calls ?? [], tool_calls: d.tool_calls ?? [] }
  },
}

const normFilter = (f: AgentRunFilter) => {
  const out: Record<string, unknown> = {}
  if (f.agent) out.agent = f.agent
  if (f.status?.length) out.status = [...f.status].sort()
  if (f.limit !== undefined) out.limit = f.limit
  if (f.offset) out.offset = f.offset
  return out
}

/** 一页执行记录（按 Agent、状态在后端筛）；换条件时先留着上一页，列表不闪。enabled 为假时不取（会话页找回调用 id 时按需取） */
export function useAgentRunList(f: AgentRunFilter, enabled = true) {
  return useQuery({
    queryKey: agentConfigKeys.runList(normFilter(f)),
    queryFn: ({ signal }) => agentRunsApi.list(f, signal),
    enabled,
    placeholderData: keepPreviousData,
    refetchInterval: (q) => (q.state.data?.data.some((r) => r.status === 'running') ? RUNNING_POLL_MS : false),
  })
}

/** 各状态的条数（全部执行记录里的，不受 Agent 筛选影响）：每个状态取一条，读 meta.total */
export function useAgentRunCounts(statuses: readonly string[]): Record<string, number | undefined> {
  const qs = useQueries({
    queries: statuses.map((st) => ({
      queryKey: agentConfigKeys.runCount(st),
      queryFn: ({ signal }: { signal: AbortSignal }) => agentRunsApi.list({ status: st ? [st] : undefined, limit: 1 }, signal),
    })),
  })
  const out: Record<string, number | undefined> = {}
  statuses.forEach((st, i) => { out[st] = qs[i]?.data?.total })
  return out
}

/** 一条执行记录连同调用；展开时才取。不存在是 404（不重试） */
export function useAgentRun(id: string | null, enabled = true) {
  return useQuery({
    queryKey: agentConfigKeys.run(id ?? ''),
    queryFn: ({ signal }) => agentRunsApi.get(id ?? '', signal),
    enabled: enabled && !!id,
    refetchInterval: (q) => (q.state.data?.status === 'running' ? RUNNING_POLL_MS : false),
  })
}
