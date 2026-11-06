// SOP 编排插件 sop（SOP-04b）：流程定义、节点类型、执行和动作。契约见 docs/api-contract.md「SOP 编排插件 sop」。
// 执行列表一次拉最近 500 条放一份缓存，执行记录、待我处理、流程库的统计、二级菜单的「最近用过」都从它算。
// 状态变化靠事件流（sop.run_status_changed、sop.step_status_changed）报 sop-run 刷新；动作的响应是改后的整条执行，先写回缓存。
import { useMutation, useQuery, useQueryClient, type QueryClient, type UseQueryOptions } from '@tanstack/react-query'
import { isApiError, request, requestList } from '../api'
import { useNotifyChange } from './invalidate'
import { dataKeys } from './keys'
import type { Schedule, ScheduleRule } from './schedules'

export type SopJson = Record<string, unknown>

export type SopFieldOption = { value: string; label: string }
export type SopField = {
  key: string
  label: string
  type: 'text' | 'textarea' | 'select'
  options?: SopFieldOption[]
  placeholder?: string
  required?: boolean
  default?: string
}
export type SopCase = { key: string; label: string }
export type SopStepDef = {
  key: string
  name: string
  kind: string
  desc?: string
  ms?: number
  after?: string[]
  branch?: { of: string; case: string }
  cases?: SopCase[]
  rule?: string
  config?: Record<string, string>
}
export type SopFlow = {
  id: string
  name: string
  desc: string
  trigger: string
  fields: SopField[]
  steps: SopStepDef[]
  layout?: Record<string, { x: number; y: number }>
  version: number
  created_at: string
  updated_at: string
  /**
   * 随流程管理的定时任务（TSK-0463），形状同 /api/schedules 的一项；没有为 null。
   * 触发方式是 schedule 而它为 null 时是「定时，未配置」（比如在定时任务页删掉了）
   */
  schedule?: Schedule | null
  /** IM 触发的过滤条件、执行顺序与拦截（TSK-0481）；后端总是带（normFlow 补齐），可选只是为了老的执行快照和测试数据 */
  im?: SopIMTrigger
}
/** 与我的关系：@我、@所有人、私聊、无关（事件里 relevance 为空串） */
export type SopIMRelevance = 'me' | 'all' | 'dm' | 'none'
export const SOP_IM_RELEVANCES: readonly SopIMRelevance[] = ['me', 'all', 'dm', 'none']
/**
 * IM 触发设置（TSK-0481，契约「IM 触发」）：conversations 是会话 id，空为全部；relevance 空为不限，relevance_mode 是只要 / 除了；
 * order 是在 IM 流程里排第几（1 起，不是 IM 触发为 0）；stop 是命中并发起后后面的 IM 流程不再接这条消息
 */
export type SopIMTrigger = {
  conversations: string[]
  relevance: SopIMRelevance[]
  relevance_mode: 'include' | 'exclude'
  order: number
  stop: boolean
}
/** 编排页里 IM 触发的草稿：order 为 null 是不改（新的、刚改成 IM 的排最后） */
export type SopIMDraft = Omit<SopIMTrigger, 'order'> & { order: number | null }
export const SOP_TRIGGER_IM = 'im'
/** 触发方式「定时」的 key；旧的 daily、weekly、cron 后端转成它（TSK-0463） */
export const SOP_TRIGGER_SCHEDULE = 'schedule'
/** 编排页里定时触发的草稿：规则和启停，保存时写进随流程管理的定时任务 */
export type SopScheduleDraft = { rule: ScheduleRule; enabled: boolean }
/** 触发方式从定时改成别的时，随流程管理的那条怎么处理：停用（改回定时时恢复）或删掉 */
export type SopScheduleOff = 'disable' | 'delete'
export type SopNodeType = {
  kind: string
  group: string
  branching: boolean
  default_cases?: SopCase[]
  required: { key: string; label: string }[]
}

export type SopStepStatus = 'pending' | 'running' | 'paused' | 'review' | 'done' | 'failed' | 'skipped' | 'bypassed'
export type SopRunStatus = 'running' | 'waiting' | 'done' | 'failed' | 'stopped'
/**
 * 界面上显示的执行状态：比 SopRunStatus 多一种「已重跑」——失败执行按最新流程重新发起过（带 relaunched_to），
 * 不算失败待处理（不进「失败」「待我处理」、不计红点），在「全部」里灰色显示并能点到新执行
 */
export type SopRunShow = SopRunStatus | 'relaunched'
/** 失败执行已按最新流程重新发起过 */
export const isSopRunRelaunched = (r: { status: SopRunStatus; relaunched_to?: string }) => r.status === 'failed' && !!r.relaunched_to
export const sopRunShow = (r: { status: SopRunStatus; relaunched_to?: string }): SopRunShow => (isSopRunRelaunched(r) ? 'relaunched' : r.status)
/** 发起来源（SOP-06）：界面上手动、Agent 的 run_sop、定时任务、IM 消息触发、子流程、别的插件；以前的执行是空串 */
export type SopRunSource = 'manual' | 'agent' | 'schedule' | 'im' | 'subflow' | 'plugin' | ''

export type SopRunStep = {
  key: string
  status: SopStepStatus
  input: SopJson | null
  output: SopJson | null
  route?: string
  route_reason?: string
  started_at?: string
  ended_at?: string
  error?: string
  edited?: 'input' | 'output' | 'route'
  attempts: number
  log: { at: string; text: string }[]
  wake_at?: string
  child_run_id?: string
  /**
   * 在排队（仍是 running）：ahead 是全插件队列里前面还有几个；slot 为空是等模型名额（SOP-07），
   * claude_code 是等 Claude Code 并发名额（AUTO-12）；不在排队时没有
   */
  queue?: SopStepQueue
  /** Claude Code 节点发起的那次执行（AUTO-01）：执行 id、关联任务（执行记录留在任务上时）、工作目录 */
  claude?: { run_id: string; task_id?: string; workdir?: string }
  /** 第几轮：被条件回退退回重做后为 2、3……，首轮没有（AUTO-02） */
  round?: number
  /** 这一轮被退回重做的原因 */
  rework_reason?: string
  /** 条件回退节点已经自动退回了几次 */
  loops?: number
  /** 超出治理上限被暂停的记录（AUTO-12）：没放行时步骤停在 paused，「继续」（confirm-input）放行这一次 */
  hold?: SopStepHold
  /** 挂起等服务商恢复（TSK-0392）：仍是 running，到 retry_at 或服务商恢复后自动重跑；不在等时没有 */
  provider_wait?: SopProviderWait
}
/** 服务商不可用时挂起的步骤：哪个服务商、最近一次失败、从什么时候开始等、下次重跑时间 */
export type SopProviderWait = { provider_id: string; provider: string; reason: string; since: string; retry_at: string }
/** 这一步正挂起等服务商恢复 */
export const isSopProviderWait = (s: { status: SopStepStatus; provider_wait?: SopProviderWait }) => s.status === 'running' && !!s.provider_wait
export type SopStepQueue = { ahead: number; slot?: 'claude_code' }
/** 超出上限暂停（AUTO-12）：kind 是 runs（次数）或 duration（时长） */
export type SopStepHold = {
  kind: 'runs' | 'duration'
  reason: string
  since: string
  released?: boolean
  released_at?: string
  attempt?: number
}
/** 这一步正停在「超出上限」上等人放行 */
export const isSopHeld = (s: { status: SopStepStatus; hold?: SopStepHold }) => s.status === 'paused' && !!s.hold && !s.hold.released
export type SopRun = {
  id: string
  flow_id: string
  flow_name: string
  flow_version: number
  flow: SopFlow
  title: string
  input: SopJson
  step_through: boolean
  stopped: boolean
  status: SopRunStatus
  parent_run_id?: string
  parent_step?: string
  /** 关联的工作对象（SOP-06）：在任务上发起、Agent 处理任务时发起的；子流程继承父执行的 */
  object_id?: string
  /** 发起来源；source_ref 是来源对象的 id（Agent、定时任务、消息、父执行、插件），source_name 是发起那一刻的名字 */
  source?: SopRunSource
  source_ref?: string
  source_name?: string
  /** 失败后按最新流程重新发起（批量重跑的 relaunch）新起的那条执行 id；有值即「已重跑」，不能再重试、重跑 */
  relaunched_to?: string
  started_at: string
  ended_at?: string
  updated_at: string
  steps: SopRunStep[]
}
/** 列表行：不带快照和每步的输入输出、日志 */
export type SopRunBrief = Omit<SopRun, 'flow' | 'input' | 'steps' | 'parent_step'> & {
  focus: number
  steps: { key: string; name: string; kind: string; status: SopStepStatus }[]
}

/** step 是步骤下标（从 0 起）或步骤 key */
export type SopRunAction =
  | { kind: 'confirm-input'; step: number | string; input?: SopJson }
  | { kind: 'approve'; step: number | string; output?: SopJson }
  | { kind: 'route'; step: number | string; route: string }
  | { kind: 'rework' | 'retry' | 'skip'; step: number | string }
  | { kind: 'stop' }
  | { kind: 'step-through'; on: boolean }

/** object_id：这次执行关联到哪个工作对象（SOP-06），不存在或在回收站里 400 */
/**
 * SOP 插件设置（SOP-07）：model_concurrency 同时调模型的步骤数 1..16；running、queued 是此刻在调模型、在排队的步骤数，只读。
 * 流水线治理（AUTO-12）：claude_concurrency 同时跑的 Claude Code 步骤数 1..10；task_max_claude_runs、task_max_claude_minutes
 * 是每个需求累计的次数、分钟数上限，0 是不限；token_limit_supported 恒为 false（运行记录里没有 token 用量）
 */
export type SopSettings = {
  model_concurrency: number
  running: number
  queued: number
  claude_concurrency: number
  claude_running: number
  claude_queued: number
  task_max_claude_runs: number
  task_max_claude_minutes: number
  token_limit_supported: boolean
}
export type SopSettingsPatch = Partial<Pick<SopSettings, 'model_concurrency' | 'claude_concurrency' | 'task_max_claude_runs' | 'task_max_claude_minutes'>>
export const SOP_MODEL_CONCURRENCY_MAX = 16
export const SOP_CLAUDE_CONCURRENCY_MAX = 10
export const SOP_TASK_MAX_RUNS_MAX = 1000
export const SOP_TASK_MAX_MINUTES_MAX = 100000

/** 等人的种类（AUTO-12）：人工检查、人工判断、Agent 等确认、逐步确认、超出上限暂停、失败、超时 */
export type SopWaitKind = 'review' | 'decide' | 'agent' | 'confirm' | 'hold' | 'failed' | 'timeout'
/** GET /api/sop/waiting 的一条：一个等人的步骤；task_id 是这次执行算到的需求（子执行沿父执行找） */
export type SopWaitingItem = {
  run_id: string
  run_title: string
  flow_id: string
  flow_name: string
  step_key: string
  step_name: string
  step_kind: string
  step_status: SopStepStatus
  wait: SopWaitKind
  reason: string
  since: string
  task_id?: string
  cases?: SopCase[]
  hold?: SopStepHold
  claude_run_id?: string
}
export type SopPipelineStep = {
  key: string
  name: string
  kind: string
  status: SopStepStatus
  attempts: number
  round?: number
  loops?: number
  rework_reason?: string
  route?: string
  started_at?: string
  ended_at?: string
  error?: string
  hold?: SopStepHold
  child_run_id?: string
  claude_run_id?: string
  queue?: SopStepQueue
}
export type SopPipelineRun = {
  id: string
  flow_id: string
  flow_name: string
  title: string
  status: SopRunStatus
  parent_run_id?: string
  parent_step?: string
  relaunched_to?: string
  started_at: string
  ended_at?: string
  steps: SopPipelineStep[]
}
export type SopClaudeUsage = { id: string; run_id: string; step: string; attempt: number; started_at: string; ended_at?: string; status: string }
/** 预算用量；上限 0 是不限 */
export type SopPipelineBudget = { claude_runs: number; claude_minutes: number; max_runs: number; max_minutes: number }
/** GET /api/sop/pipeline/{id}：一条需求的流水线，执行按开始时间早的在前 */
export type SopPipeline = { task_id: string; runs: SopPipelineRun[]; claude: SopClaudeUsage[]; budget: SopPipelineBudget; blockers: SopWaitingItem[] }

export type SopStartInput = { input?: Record<string, string>; step_through?: boolean; object_id?: string }

/** 编排页的草稿：形状同 SopFlow 去掉版本和时间，可以没保存过、可以不合格 */
export type SopDraft = Pick<SopFlow, 'name' | 'desc' | 'trigger' | 'fields' | 'steps' | 'layout'> & { id?: string; sched?: SopScheduleDraft; im?: SopIMDraft }
/** 保存校验的一条问题；step 是步骤下标（从 0 起），整条流程的问题没有 */
export type SopIssue = { text: string; step?: number }
/** 新建、修改流程的 body；layout 为 null 时清掉手动位置 */
type SopFlowBody = Omit<SopDraft, 'id' | 'layout' | 'sched' | 'im'> & {
  layout: SopFlow['layout'] | null
  /** IM 触发设置（TSK-0481）；order 不给是不改 */
  im?: Omit<SopIMTrigger, 'order'> & { order?: number }
  /** 触发方式是定时时的规则和启停（TSK-0463） */
  schedule?: SopScheduleDraft
  schedule_off?: SopScheduleOff
}
/** AI 协助的回复；draft 是改好的整条草稿，不带 layout */
export type SopAssistReply = { text: string; draft?: SopDraft; notes?: string[] }
export type SopAssistInput = { message: string; draft?: SopDraft; selected?: number }

/** 保存被后端拒绝（validation 400）时的逐条问题；不是校验错误回空数组 */
export function sopIssuesOf(e: unknown): SopIssue[] {
  if (!isApiError(e, 'validation')) return []
  const raw = e.extra.issues
  if (!Array.isArray(raw)) return []
  return raw.filter((x): x is SopIssue => !!x && typeof x === 'object' && typeof (x as SopIssue).text === 'string')
    .map((x) => (typeof x.step === 'number' ? { text: x.text, step: x.step } : { text: x.text }))
}

/** 列表一次最多 500 条（契约上限） */
export const SOP_RUNS_MAX = 500

// 后端的空数组可能是 null，这里一次补齐
const normIM = (x?: Partial<SopIMTrigger> | null): SopIMTrigger => ({
  conversations: x?.conversations ?? [], relevance: x?.relevance ?? [], relevance_mode: x?.relevance_mode === 'exclude' ? 'exclude' : 'include',
  order: x?.order ?? 0, stop: !!x?.stop,
})
const normFlow = (f: SopFlow): SopFlow => ({ ...f, desc: f.desc ?? '', trigger: f.trigger ?? '', fields: f.fields ?? [], steps: f.steps ?? [], schedule: f.schedule ?? null, im: normIM(f.im) })
const normRun = (r: SopRun): SopRun => ({
  ...r, source: r.source ?? '', flow: normFlow(r.flow), input: r.input ?? {},
  steps: (r.steps ?? []).map((s) => ({ ...s, log: s.log ?? [], attempts: s.attempts ?? 0, input: s.input ?? null, output: s.output ?? null })),
})
const normBrief = (r: SopRunBrief): SopRunBrief => ({ ...r, source: r.source ?? '', steps: r.steps ?? [] })

const flowPath = (id: string) => `/api/sop/flows/${encodeURIComponent(id)}`
const runPath = (id: string) => `/api/sop/runs/${encodeURIComponent(id)}`

export const sopApi = {
  flows: async (signal?: AbortSignal) => (await requestList<SopFlow>('/api/sop/flows', { signal })).data.map(normFlow),
  flow: async (id: string, signal?: AbortSignal) => normFlow(await request<SopFlow>('GET', flowPath(id), { signal })),
  deleteFlow: (id: string) => request<null>('DELETE', flowPath(id)),
  createFlow: async (body: SopFlowBody) => normFlow(await request<SopFlow>('POST', '/api/sop/flows', { body })),
  /** 整条覆盖；version 和库里不一致 409 */
  patchFlow: async (id: string, body: SopFlowBody & { version?: number }) => normFlow(await request<SopFlow>('PATCH', flowPath(id), { body })),
  assist: (body: SopAssistInput, signal?: AbortSignal) => request<SopAssistReply>('POST', '/api/sop/assist', { body, signal }),
  nodeTypes: async (signal?: AbortSignal) => (await requestList<SopNodeType>('/api/sop/node-types', { signal })).data,
  runs: async (signal?: AbortSignal) => {
    const query = new URLSearchParams({ limit: String(SOP_RUNS_MAX) })
    return (await requestList<SopRunBrief>('/api/sop/runs', { query, signal })).data.map(normBrief)
  },
  /** 关联到某个工作对象的执行（SOP-06），最近的在前 */
  objectRuns: async (objectId: string, signal?: AbortSignal) => {
    const query = new URLSearchParams({ object_id: objectId, limit: String(SOP_RUNS_MAX) })
    return (await requestList<SopRunBrief>('/api/sop/runs', { query, signal })).data.map(normBrief)
  },
  run: async (id: string, signal?: AbortSignal) => normRun(await request<SopRun>('GET', runPath(id), { signal })),
  start: async (flowId: string, body: SopStartInput) => normRun(await request<SopRun>('POST', `${flowPath(flowId)}/runs`, { body })),
  act: async (runId: string, action: SopRunAction) => normRun(await request<SopRun>('POST', `${runPath(runId)}/actions`, { body: action })),
  settings: (signal?: AbortSignal) => request<SopSettings>('GET', '/api/sop/settings', { signal }),
  patchSettings: (patch: SopSettingsPatch) => request<SopSettings>('PATCH', '/api/sop/settings', { body: patch }),
  pipeline: async (taskId: string, signal?: AbortSignal) => {
    const p = await request<SopPipeline>('GET', `/api/sop/pipeline/${encodeURIComponent(taskId)}`, { signal })
    return { ...p, runs: (p.runs ?? []).map((r) => ({ ...r, steps: r.steps ?? [] })), claude: p.claude ?? [], blockers: p.blockers ?? [] }
  },
  waiting: async (signal?: AbortSignal) => (await requestList<SopWaitingItem>('/api/sop/waiting', { signal })).data,
}

/** 插件没装或停用时接口 404，不重试 */
const noRetry404 = (n: number, e: unknown) => !isApiError(e, 'not_found') && n < 2

type Poll = { refetchInterval?: number | false }

/** enabled 为 false 时不取（定时任务页只在有随流程管理的定时任务时取流程名） */
export function useSopFlows(opts: Poll & { enabled?: boolean } = {}) {
  return useQuery({ queryKey: dataKeys.sop.flows, queryFn: ({ signal }) => sopApi.flows(signal), retry: noRetry404, refetchInterval: opts.refetchInterval, enabled: opts.enabled ?? true })
}

/** 内置节点类型：分支节点、必填配置项；名字和颜色在前端 */
export function useSopNodeTypes() {
  return useQuery({ queryKey: dataKeys.sop.nodeTypes, queryFn: ({ signal }) => sopApi.nodeTypes(signal), retry: noRetry404, staleTime: Infinity })
}

/** 最近 500 次执行；refetchInterval 给事件流断开时轮询用 */
export function useSopRuns(opts: Poll = {}) {
  return useQuery({ queryKey: dataKeys.sop.runList, queryFn: ({ signal }) => sopApi.runs(signal), retry: noRetry404, refetchInterval: opts.refetchInterval })
}

/** 关联到某个工作对象的执行（SOP-06）：在 runs 前缀下，事件一来跟着刷；objectId 为 null 时不取 */
export function useSopObjectRuns(objectId: string | null, opts: { refetchInterval?: UseQueryOptions<SopRunBrief[]>['refetchInterval'] } = {}) {
  return useQuery({
    queryKey: dataKeys.sop.objectRuns(objectId ?? ''),
    queryFn: ({ signal }) => sopApi.objectRuns(objectId!, signal),
    enabled: !!objectId,
    retry: noRetry404,
    refetchInterval: opts.refetchInterval,
  })
}

/** refetchInterval 可以按读回的执行算（结束了就不再轮询） */
export function useSopRun(id: string | null, opts: { refetchInterval?: UseQueryOptions<SopRun>['refetchInterval'] } = {}) {
  return useQuery({
    queryKey: dataKeys.sop.run(id ?? ''),
    queryFn: ({ signal }) => sopApi.run(id!, signal),
    enabled: !!id,
    retry: noRetry404,
    refetchInterval: opts.refetchInterval,
  })
}

/** 响应里的最新执行先写进缓存，界面不用等重新取 */
function putRun(qc: QueryClient, r: SopRun) {
  qc.setQueryData(dataKeys.sop.run(r.id), r)
}

export function useStartSopRun() {
  const qc = useQueryClient()
  const notify = useNotifyChange()
  return useMutation({
    mutationFn: ({ flowId, body }: { flowId: string; body: SopStartInput }) => sopApi.start(flowId, body),
    onSuccess: (r) => {
      putRun(qc, r)
      void notify({ kind: 'sop-run', id: r.id })
    },
  })
}

export function useSopRunAction() {
  const qc = useQueryClient()
  const notify = useNotifyChange()
  return useMutation({
    mutationFn: ({ runId, action }: { runId: string; action: SopRunAction }) => sopApi.act(runId, action),
    onSuccess: (r) => {
      putRun(qc, r)
      void notify({ kind: 'sop-run', id: r.id })
    },
    // 别处已经处理过（409）等：按最新状态读回
    onError: (_e, v) => notify({ kind: 'sop-run', id: v.runId }),
  })
}

/**
 * 新建（没有 id）或整条覆盖保存；成功后把流程写进缓存再报 sop-flow（定时任务列表跟着刷）。
 * 触发方式是定时时带上规则和启停；scheduleOff 是从定时改成别的时那条定时任务停用还是删掉（TSK-0463）
 */
export function useSaveSopFlow() {
  const qc = useQueryClient()
  const notify = useNotifyChange()
  return useMutation({
    mutationFn: ({ id, draft, version, scheduleOff }: { id?: string; draft: SopDraft; version?: number; scheduleOff?: SopScheduleOff }) => {
      const body: SopFlowBody = { name: draft.name, desc: draft.desc, trigger: draft.trigger, fields: draft.fields, steps: draft.steps, layout: draft.layout ?? null }
      if (draft.trigger === SOP_TRIGGER_SCHEDULE && draft.sched) body.schedule = draft.sched
      if (scheduleOff) body.schedule_off = scheduleOff
      if (draft.im) {
        const { order, ...rest } = draft.im
        body.im = order != null && draft.trigger === SOP_TRIGGER_IM ? { ...rest, order } : rest
      }
      return id ? sopApi.patchFlow(id, { ...body, version }) : sopApi.createFlow(body)
    },
    onSuccess: (f) => {
      // IM 流程的顺序是大家一起排的（TSK-0481）：这一条插进去、改成或改掉 IM，别的流程的 order 跟着变，整份列表重取
      void qc.invalidateQueries({ queryKey: dataKeys.sop.flows, exact: true })
      // 列表先换上新的，回流程详情时不用等重新取（新建的不然会先显示「已经删除」）
      qc.setQueryData(dataKeys.sop.flow(f.id), f)
      qc.setQueryData<SopFlow[]>(dataKeys.sop.flows, (list) => list && (list.some((x) => x.id === f.id) ? list.map((x) => (x.id === f.id ? f : x)) : [...list, f]))
      void notify({ kind: 'sop-flow', id: f.id })
    },
  })
}

/** 一条流程（编排页用）；不存在 404 不重试 */
export function useSopFlow(id: string | null) {
  return useQuery({
    queryKey: dataKeys.sop.flow(id ?? ''),
    queryFn: ({ signal }) => sopApi.flow(id!, signal),
    enabled: !!id,
    retry: noRetry404,
  })
}

/** SOP 插件设置（SOP-07）：键在 runs 前缀下，执行一变跟着刷在调、排队的个数 */
export function useSopSettings() {
  return useQuery({ queryKey: dataKeys.sop.settings, queryFn: ({ signal }) => sopApi.settings(signal), retry: noRetry404 })
}

/** 改设置：响应是改后的整份设置，直接写回缓存 */
export function usePatchSopSettings() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (patch: SopSettingsPatch) => sopApi.patchSettings(patch),
    onSuccess: (s) => qc.setQueryData(dataKeys.sop.settings, s),
  })
}

/** AI 协助：不保存，草稿要前端应用后照常保存 */
export function useSopAssist() {
  return useMutation({ mutationFn: (body: SopAssistInput) => sopApi.assist(body) })
}

export function useDeleteSopFlow() {
  const notify = useNotifyChange()
  return useMutation({
    mutationFn: (id: string) => sopApi.deleteFlow(id),
    onSuccess: (_d, id) => notify({ kind: 'sop-flow', id }),
  })
}

/** 一条需求的流水线（AUTO-12）：在 runs 前缀下，执行一变跟着刷；taskId 为 null 时不取 */
export function useSopPipeline(taskId: string | null, opts: { refetchInterval?: UseQueryOptions<SopPipeline>['refetchInterval'] } = {}) {
  return useQuery({
    queryKey: dataKeys.sop.pipeline(taskId ?? ''),
    queryFn: ({ signal }) => sopApi.pipeline(taskId!, signal),
    enabled: !!taskId,
    retry: noRetry404,
    refetchInterval: opts.refetchInterval,
  })
}
