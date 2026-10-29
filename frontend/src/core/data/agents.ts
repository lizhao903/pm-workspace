// Agent 配置（AG-01b5）：列表、单个、新建、修改、删除和删除前的影响检查，列表卡片要的工具授权。
// 契约见 docs/api-contract.md「Agent 配置 agents」「Agent 工具授权 agent-grants」。写完报 { kind: 'agent' }。
import { useMutation, useQueries, useQuery } from '@tanstack/react-query'
import { request, requestList } from '../api'
import { agentConfigKeys } from './agentConfigKeys'
import { useNotifyChange } from './invalidate'

export type AgentAvatar = { kind: 'text' | 'icon' | 'image'; value: string }
export type AgentTriggerKind = 'manual' | 'im' | 'schedule' | 'task'

/**
 * 触发条件的结构化部分（AG-01b4），detail 仍是给人看的说明；后端按 kind 只留自己的字段，没有时按默认条件。
 * task：assigned 是分配给它（没有 match 时就是这一条），tags 是标签命中任一，两者至少一样；
 * im：connector_id、channel、conversation_id 空串不限，only_me 只看与我相关的。schedule 由定时任务的 agent 动作指过来。
 */
export type AgentTriggerMatch = {
  assigned: boolean
  tags: string[]
  connector_id: string
  channel: string
  conversation_id: string
  only_me: boolean
}

export type AgentTrigger = { kind: AgentTriggerKind | (string & {}); detail: string; match?: AgentTriggerMatch }

export type Agent = {
  id: string
  name: string
  desc: string
  /** #rrggbb，头像底色 */
  color: string
  avatar: AgentAvatar
  provider_id: string
  model: string
  instructions: string
  skills: string[]
  mcps: string[]
  kbs: string[]
  triggers: AgentTrigger[]
  enabled: boolean
  created_at: string
  updated_at: string
}

/** 新建：除 name、provider_id 外都可省；PATCH 只传改了的 */
export type AgentInput = Omit<Agent, 'id' | 'created_at' | 'updated_at'>
export type AgentPatch = Partial<AgentInput>

export type AgentImpactItem = { key: string; count: number; text: string; effect?: string }
/** blocks 有内容时不能删；text 前端原样显示 */
export type AgentImpact = { agent_id: string; blocks: AgentImpactItem[]; items: AgentImpactItem[] }

export type AgentGrantMode = 'off' | 'confirm' | 'auto'
/** grants 是 Agent 自己的授权，effective 是和连接器上限取小之后的实际档位 */
export type AgentGrants = { agent_id: string; grants: Record<string, AgentGrantMode>; effective: Record<string, AgentGrantMode> }

export type AgentRunStatus = 'running' | 'done' | 'waiting' | 'rejected' | 'failed'
/** 执行记录（AG-01b4）里列表卡片要的几项：等确认数、最近一次运行 */
export type AgentRunBrief = { id: string; agent_id: string; status: AgentRunStatus | (string & {}); started_at: string; pending?: number }

const normAgent = (a: Agent): Agent => ({
  ...a,
  desc: a.desc ?? '',
  instructions: a.instructions ?? '',
  avatar: a.avatar ?? { kind: 'text', value: '' },
  skills: a.skills ?? [],
  mcps: a.mcps ?? [],
  kbs: a.kbs ?? [],
  triggers: a.triggers ?? [],
})
const path = (id: string) => `/api/agents/${encodeURIComponent(id)}`

export const agentsApi = {
  list: async (signal?: AbortSignal) => (await requestList<Agent>('/api/agents', { signal })).data.map(normAgent),
  get: async (id: string, signal?: AbortSignal) => normAgent(await request<Agent>('GET', path(id), { signal })),
  create: async (input: Partial<AgentInput> & Pick<AgentInput, 'name' | 'provider_id'>) =>
    normAgent(await request<Agent>('POST', '/api/agents', { body: input })),
  patch: async (id: string, patch: AgentPatch) => normAgent(await request<Agent>('PATCH', path(id), { body: patch })),
  /** 有拦截原因时 409，message 为「不能删除：<原因>」 */
  remove: async (id: string) => normAgent(await request<Agent>('DELETE', path(id))),
  impact: (id: string, signal?: AbortSignal) => request<AgentImpact>('GET', `${path(id)}/impact`, { signal }),
  grants: (id: string, signal?: AbortSignal) => request<AgentGrants>('GET', `${path(id)}/grants`, { signal }),
  /** 执行记录，等确认的在前、其余按开始时间倒序 */
  runs: (limit: number, signal?: AbortSignal) =>
    requestList<AgentRunBrief>('/api/agent-runs', { query: new URLSearchParams({ limit: String(limit) }), signal }),
}

/** 全部 Agent，新建的在前（后端排序） */
export function useAgents() {
  return useQuery({ queryKey: agentConfigKeys.list, queryFn: ({ signal }) => agentsApi.list(signal) })
}

/** 一个 Agent；不存在是 404（不重试） */
export function useAgent(id: string | null) {
  return useQuery({
    queryKey: agentConfigKeys.detail(id ?? ''),
    queryFn: ({ signal }) => agentsApi.get(id ?? '', signal),
    enabled: !!id,
  })
}

/** 删除前的影响检查，点「删除」时才取，每次都重新查 */
export function useAgentImpact(id: string | null, enabled: boolean) {
  return useQuery({
    queryKey: agentConfigKeys.impact(id ?? ''),
    queryFn: ({ signal }) => agentsApi.impact(id ?? '', signal),
    enabled: enabled && !!id,
    staleTime: 0,
  })
}

/** 一组 Agent 的工具授权，按 id 对上；还没取回的不在结果里 */
export function useAgentGrants(ids: readonly string[]): Record<string, AgentGrants | undefined> {
  const qs = useQueries({
    queries: ids.map((id) => ({ queryKey: agentConfigKeys.grants(id), queryFn: ({ signal }: { signal: AbortSignal }) => agentsApi.grants(id, signal) })),
  })
  const out: Record<string, AgentGrants | undefined> = {}
  ids.forEach((id, i) => { out[id] = qs[i]?.data })
  return out
}

/** 列表卡片用的执行记录：取一页（等确认的在前），取不到（服务还没有执行记录接口）按没有处理，不重试 */
export const AGENT_RUNS_LIMIT = 200
export function useAgentRuns() {
  return useQuery({
    queryKey: agentConfigKeys.runs,
    queryFn: ({ signal }) => agentsApi.runs(AGENT_RUNS_LIMIT, signal),
    select: (r) => r.data,
    retry: false,
  })
}

export function useCreateAgent() {
  const notify = useNotifyChange()
  return useMutation({
    mutationFn: (input: Partial<AgentInput> & Pick<AgentInput, 'name' | 'provider_id'>) => agentsApi.create(input),
    onSuccess: (a) => notify({ kind: 'agent', id: a.id }),
  })
}

export function usePatchAgent() {
  const notify = useNotifyChange()
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: AgentPatch }) => agentsApi.patch(id, patch),
    onSuccess: (_, { id }) => notify({ kind: 'agent', id }),
  })
}

export function useDeleteAgent() {
  const notify = useNotifyChange()
  return useMutation({ mutationFn: (id: string) => agentsApi.remove(id), onSuccess: (_, id) => notify({ kind: 'agent', id }) })
}
