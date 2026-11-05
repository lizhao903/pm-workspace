// 交给工作台 Agent（TSK-0460，SPEC-tasks-6.20 起）的纯函数：默认 Agent、默认服务商和模型、能不能续跑、请求体。
import type { Agent, AgentProvider, AgentScenario, RunRequest, TaskRun } from '../../core/data'

/** 场景「执行任务」的 key，同后端 agent.ScenarioTaskRun */
export const TASK_RUN_SCENARIO = 'task_run'

/** 预算默认值和上限，同后端 internal/api/runagent.go */
export const AGENT_RUN_DEFAULTS = { steps: 30, maxSteps: 100, minutes: 10, maxMinutes: 60 }

/**
 * 弹窗打开时选哪个 Agent：用户选过的（还在、还启用）优先；没选过用场景「执行任务」选的；
 * 没选或那个停了用第一个启用的；一个启用的都没有为空串
 */
export function pickAgent(agents: readonly Agent[] | undefined, scenarios: readonly AgentScenario[] | undefined, chosen: string | null): string {
  const on = (agents ?? []).filter((a) => a.enabled)
  if (chosen !== null && on.some((a) => a.id === chosen)) return chosen
  const sc = scenarios?.find((s) => s.key === TASK_RUN_SCENARIO)?.agent_id ?? ''
  if (sc && on.some((a) => a.id === sc)) return sc
  return on[0]?.id ?? ''
}

/** 服务商下拉：空值是「按 Agent 设置」，其余是启用的服务商（停用了的 Agent 服务商也列出来，标停用） */
export function providerOptions(providers: readonly AgentProvider[] | undefined, agent: Agent | undefined): { value: string; label: string }[] {
  const own = providers?.find((p) => p.id === agent?.provider_id)
  const head = { value: '', label: agent ? `按 Agent 设置（${own ? own.name : '服务商已删除'}${agent.model ? ' · ' + agent.model : ''}）` : '按 Agent 设置' }
  return [head, ...(providers ?? []).filter((p) => p.enabled).map((p) => ({ value: p.id, label: p.name }))]
}

/** 最近一次交给工作台 Agent 的执行有会话时才能续跑（同后端：最近 20 条里找） */
export function canResume(rows: readonly TaskRun[] | undefined): boolean {
  return !!rows?.some((r) => r.harness === 'agent' && !!r.harness_session?.trim())
}

/** 步数、时长输入框的值收成合法的数：空、不是整数、超范围的回默认值 */
export function clampInt(v: string, def: number, hi: number): number {
  const n = Number(v.trim())
  if (!v.trim() || !Number.isInteger(n) || n < 1 || n > hi) return def
  return n
}

export type AgentRunForm = {
  agentId: string
  providerId: string
  model: string
  presetId: string
  extra: string
  workdir: string
  resume: boolean
  steps: number
  minutes: number
}

/** 请求体（契约 POST /api/objects/{id}/run，harness=agent）：空的不带，预算是默认值时不带 */
export function agentRunRequest(f: AgentRunForm): RunRequest {
  const req: RunRequest = { harness: 'agent' }
  if (f.resume) req.resume_session = true
  else if (f.agentId) req.agent_id = f.agentId
  if (f.providerId) req.provider_id = f.providerId
  if (f.model.trim()) req.model = f.model.trim()
  if (f.presetId) req.preset_id = f.presetId
  if (f.extra.trim()) req.extra_prompt = f.extra.trim()
  if (f.workdir.trim()) req.workdir = f.workdir.trim()
  if (f.steps !== AGENT_RUN_DEFAULTS.steps) req.max_steps = f.steps
  if (f.minutes !== AGENT_RUN_DEFAULTS.minutes) req.max_minutes = f.minutes
  return req
}
