// SOP 编排插件 sop（SOP-04b）：流程定义、节点类型、执行和动作。契约见 docs/api-contract.md「SOP 编排插件 sop」。
// 执行列表一次拉最近 500 条放一份缓存，执行记录、待我处理、流程库的统计、二级菜单的「最近用过」都从它算。
// 状态变化靠事件流（sop.run_status_changed、sop.step_status_changed）报 sop-run 刷新；动作的响应是改后的整条执行，先写回缓存。
import { useMutation, useQuery, useQueryClient, type QueryClient, type UseQueryOptions } from '@tanstack/react-query'
import { isApiError, request, requestList } from '../api'
import { useNotifyChange } from './invalidate'
import { dataKeys } from './keys'

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
}
export type SopNodeType = {
  kind: string
  group: string
  branching: boolean
  default_cases?: SopCase[]
  required: { key: string; label: string }[]
}

export type SopStepStatus = 'pending' | 'running' | 'paused' | 'review' | 'done' | 'failed' | 'skipped' | 'bypassed'
export type SopRunStatus = 'running' | 'waiting' | 'done' | 'failed' | 'stopped'

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
}
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

export type SopStartInput = { input?: Record<string, string>; step_through?: boolean }

/** 列表一次最多 500 条（契约上限） */
export const SOP_RUNS_MAX = 500

// 后端的空数组可能是 null，这里一次补齐
const normFlow = (f: SopFlow): SopFlow => ({ ...f, desc: f.desc ?? '', trigger: f.trigger ?? '', fields: f.fields ?? [], steps: f.steps ?? [] })
const normRun = (r: SopRun): SopRun => ({
  ...r, flow: normFlow(r.flow), input: r.input ?? {},
  steps: (r.steps ?? []).map((s) => ({ ...s, log: s.log ?? [], attempts: s.attempts ?? 0, input: s.input ?? null, output: s.output ?? null })),
})
const normBrief = (r: SopRunBrief): SopRunBrief => ({ ...r, steps: r.steps ?? [] })

const flowPath = (id: string) => `/api/sop/flows/${encodeURIComponent(id)}`
const runPath = (id: string) => `/api/sop/runs/${encodeURIComponent(id)}`

export const sopApi = {
  flows: async (signal?: AbortSignal) => (await requestList<SopFlow>('/api/sop/flows', { signal })).data.map(normFlow),
  flow: async (id: string, signal?: AbortSignal) => normFlow(await request<SopFlow>('GET', flowPath(id), { signal })),
  deleteFlow: (id: string) => request<null>('DELETE', flowPath(id)),
  nodeTypes: async (signal?: AbortSignal) => (await requestList<SopNodeType>('/api/sop/node-types', { signal })).data,
  runs: async (signal?: AbortSignal) => {
    const query = new URLSearchParams({ limit: String(SOP_RUNS_MAX) })
    return (await requestList<SopRunBrief>('/api/sop/runs', { query, signal })).data.map(normBrief)
  },
  run: async (id: string, signal?: AbortSignal) => normRun(await request<SopRun>('GET', runPath(id), { signal })),
  start: async (flowId: string, body: SopStartInput) => normRun(await request<SopRun>('POST', `${flowPath(flowId)}/runs`, { body })),
  act: async (runId: string, action: SopRunAction) => normRun(await request<SopRun>('POST', `${runPath(runId)}/actions`, { body: action })),
}

/** 插件没装或停用时接口 404，不重试 */
const noRetry404 = (n: number, e: unknown) => !isApiError(e, 'not_found') && n < 2

type Poll = { refetchInterval?: number | false }

export function useSopFlows(opts: Poll = {}) {
  return useQuery({ queryKey: dataKeys.sop.flows, queryFn: ({ signal }) => sopApi.flows(signal), retry: noRetry404, refetchInterval: opts.refetchInterval })
}

/** 内置节点类型：分支节点、必填配置项；名字和颜色在前端 */
export function useSopNodeTypes() {
  return useQuery({ queryKey: dataKeys.sop.nodeTypes, queryFn: ({ signal }) => sopApi.nodeTypes(signal), retry: noRetry404, staleTime: Infinity })
}

/** 最近 500 次执行；refetchInterval 给事件流断开时轮询用 */
export function useSopRuns(opts: Poll = {}) {
  return useQuery({ queryKey: dataKeys.sop.runList, queryFn: ({ signal }) => sopApi.runs(signal), retry: noRetry404, refetchInterval: opts.refetchInterval })
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

export function useDeleteSopFlow() {
  const notify = useNotifyChange()
  return useMutation({
    mutationFn: (id: string) => sopApi.deleteFlow(id),
    onSuccess: (_d, id) => notify({ kind: 'sop-flow', id }),
  })
}
