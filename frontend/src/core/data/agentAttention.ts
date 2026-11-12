// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 等确认注意力（P0-O3）：GET /api/agent/attention?session_id=
// 后端并行开发中，契约见 docs/api-contract.md「Agent 注意力 attention」：
//   { total, pending_calls: [{ call_id, session_id, session_title, agent_id, agent_name, tool, args, summary, at }],
//     waiting_runs: [{ run_id, agent_id, agent_name, trigger, session_id, session_title, since }] }
// 用来做菜单红点、今日「Agent 待确认」组、会话列表的「等你确认」圆点，以及刷新后恢复会话里的确认卡。
// 后端没上线时接口会失败；这里 retry 关掉，页面按空处理，不影响整页。
import { useQuery } from '@tanstack/react-query'
import { request } from '../api'

/** 一条要人确认的工具调用（按会话筛时只含这个会话的） */
export type AgentPendingCall = {
  call_id: string
  session_id: string
  session_title: string
  agent_id: string
  agent_name: string
  tool: string
  args: string
  /** 这次调用要做什么的一句话说明，如「新建「开通试点账号」」 */
  summary: string
  /** 提出确认的时间（后端给的是新消息的 created_at） */
  at: string
}

/** 一次执行在等人确认（执行记录里状态是 waiting） */
export type AgentWaitingRun = {
  run_id: string
  agent_id: string
  agent_name: string
  /** 给人看的触发说明，如「任务分配给它 · TSK-0012」 */
  trigger: string
  session_id: string
  session_title: string
  since: string
}

export type AgentAttention = {
  /** 等确认的总数：pending_calls 加 waiting_runs */
  total: number
  pending_calls: AgentPendingCall[]
  waiting_runs: AgentWaitingRun[]
}

export const agentAttentionKeys = {
  all: ['agent-attention'] as const,
  one: (sessionId?: string | null) => ['agent-attention', sessionId ?? 'all'] as const,
}

/** 等确认是后台在等，没有事件推过来，隔一会儿再读 */
const ATTENTION_POLL_MS = 30_000

const EMPTY: AgentAttention = { total: 0, pending_calls: [], waiting_runs: [] }

/** 后端字段缺了（旧版、mock）也当空处理，页面不用到处判空 */
function normAttention(raw: Partial<AgentAttention> | null | undefined): AgentAttention {
  const pending = Array.isArray(raw?.pending_calls) ? raw.pending_calls : []
  const waiting = Array.isArray(raw?.waiting_runs) ? raw.waiting_runs : []
  return { total: raw?.total ?? pending.length + waiting.length, pending_calls: pending, waiting_runs: waiting }
}

export const agentAttentionApi = {
  get: async (sessionId?: string | null, signal?: AbortSignal): Promise<AgentAttention> => {
    const qs = new URLSearchParams()
    const id = sessionId?.trim()
    if (id) qs.set('session_id', id)
    const q = qs.toString()
    return normAttention(await request<Partial<AgentAttention> | null>('GET', `/api/agent/attention${q ? `?${q}` : ''}`, { signal }))
  },
}

/**
 * 等确认注意力。sessionId 给了就只读这个会话的（会话页恢复确认卡用），不给读全部（菜单红点、今日、会话列表）。
 * 轮询 30 秒；失败不重试，调用方按空处理。
 */
export function useAgentAttention(sessionId?: string | null) {
  return useQuery({
    queryKey: agentAttentionKeys.one(sessionId),
    queryFn: ({ signal }) => agentAttentionApi.get(sessionId, signal),
    placeholderData: EMPTY,
    refetchInterval: ATTENTION_POLL_MS,
    retry: false,
  })
}
