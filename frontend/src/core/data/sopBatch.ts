// SOP 批量发起和按输入字段查执行（IM 消息页的批量分诊、处理队列）。契约见 docs/api-contract.md「SOP 编排插件 sop」。
// 批量发起 POST /api/sop/flows/{id}/runs/batch：每个输入一次执行，按 skip_existing_key 跳过这条流程已经跑过的；
// 按输入字段查 GET /api/sop/runs?input_key=message_id：只列输入里带这个字段的执行，每条回 input_value。
// 键挂在 sop runs 前缀下，执行一变（sop-run）跟着刷。
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { isApiError, request, requestList } from '../api'
import { useNotifyChange } from './invalidate'
import { dataKeys } from './keys'
import { SOP_RUNS_MAX, sopApi, type SopFlow, type SopRunBrief } from './sop'

/** 一次批量发起的上限（同后端） */
export const SOP_BATCH_MAX = 200

export type SopBatchItem = { index: number; run_id?: string; key: string; error?: string }
export type SopBatchResult = { started: SopBatchItem[]; skipped: SopBatchItem[]; failed: SopBatchItem[] }

/** 按输入字段查到的执行：input_value 是那个字段的值；步骤带 queue（在排队等模型名额） */
export type SopInputRun = Omit<SopRunBrief, 'steps'> & {
  input_value: string
  steps: (SopRunBrief['steps'][number] & { queue?: { ahead: number } })[]
}

/**
 * 失败执行批量重跑的两种做法：retry 在原执行里重试失败的步骤（沿用发起时的流程快照）；
 * relaunch 用原执行的输入、流程当前定义新发起一条（原执行保留，子执行换成它的顶层执行并去重）
 */
export type SopRerunAction = 'retry' | 'relaunch'
export type SopRerunResult = {
  /** retry 带重试了的步骤 key，relaunch 带新执行 id */
  done: { run_id: string; new_run_id?: string; steps?: string[] }[]
  /**
   * 不是失败状态、不存在、重复，和同一批里的执行同属一条顶层执行（带那条新执行 id），
   * 已重跑过（reason「已重跑过」，带那条新执行 id）、另一次重跑正在新起（「正在重跑」）
   */
  skipped: { run_id: string; reason: string; new_run_id?: string }[]
  failed: { run_id: string; error: string }[]
}

const noRetry404 = (n: number, e: unknown) => !isApiError(e, 'not_found') && n < 2

export const sopBatchApi = {
  start: async (flowId: string, inputs: Record<string, string>[], skipExistingKey?: string) => {
    const r = await request<SopBatchResult>('POST', `/api/sop/flows/${encodeURIComponent(flowId)}/runs/batch`,
      { body: { inputs, ...(skipExistingKey ? { skip_existing_key: skipExistingKey } : {}) } })
    return { started: r.started ?? [], skipped: r.skipped ?? [], failed: r.failed ?? [] }
  },
  /** 失败执行批量重跑，run_ids 最多 SOP_BATCH_MAX 条 */
  rerun: async (runIds: readonly string[], action: SopRerunAction) => {
    const r = await request<SopRerunResult>('POST', '/api/sop/runs/batch-actions', { body: { run_ids: runIds, action } })
    return { done: r.done ?? [], skipped: r.skipped ?? [], failed: r.failed ?? [] }
  },
  /** 输入里带 key 的执行，最近的在前，最多 500 条 */
  byInput: async (key: string, signal?: AbortSignal) => {
    const query = new URLSearchParams({ input_key: key, limit: String(SOP_RUNS_MAX) })
    const r = await requestList<SopInputRun>('/api/sop/runs', { query, signal })
    return r.data.map((x) => ({ ...x, source: x.source ?? '', steps: x.steps ?? [], input_value: x.input_value ?? '' }))
  },
}

/** 输入里带 key 的执行；SOP 插件没在跑时接口 404，不重试 */
export function useSopRunsByInput(key: string, opts: { enabled?: boolean; refetchInterval?: number | false } = {}) {
  return useQuery({
    queryKey: [...dataKeys.sop.runs, 'input', key] as const,
    queryFn: ({ signal }) => sopBatchApi.byInput(key, signal),
    enabled: opts.enabled ?? true,
    retry: noRetry404,
    refetchInterval: opts.refetchInterval,
  })
}

/**
 * 能拿来分诊消息的流程：触发方式是 IM 的在前，再列输入字段里有 message_id 的其他流程，各按名字排
 */
export function triageFlows(flows: readonly SopFlow[]): SopFlow[] {
  const byName = (a: SopFlow, b: SopFlow) => a.name.localeCompare(b.name, 'zh-CN')
  const im = flows.filter((f) => f.trigger === 'im').sort(byName)
  const other = flows.filter((f) => f.trigger !== 'im' && f.fields.some((x) => x.key === 'message_id')).sort(byName)
  return [...im, ...other]
}

export function useStartSopBatch() {
  const notify = useNotifyChange()
  return useMutation({
    mutationFn: ({ flowId, inputs, skipExistingKey }: { flowId: string; inputs: Record<string, string>[]; skipExistingKey?: string }) =>
      sopBatchApi.start(flowId, inputs, skipExistingKey),
    onSettled: () => notify({ kind: 'sop-run' }),
  })
}

/** 已重跑过的跳过原因（同后端），带那条新执行 id */
export const SOP_RERUN_REASON_RELAUNCHED = '已重跑过'

/**
 * 重跑结果先写进缓存里的执行列表，失败行立即离开「失败」，不等重新取：
 * relaunch 新起了的、已重跑过的记上 relaunched_to；retry 重试上了的改成执行中
 */
export function applyRerun<T extends Pick<SopRunBrief, 'id' | 'status' | 'relaunched_to' | 'steps'>>(
  runs: readonly T[], action: SopRerunAction, r: SopRerunResult,
): T[] {
  const to = new Map<string, string>()
  const retried = new Set<string>()
  for (const d of r.done) {
    if (action === 'relaunch' && d.new_run_id) to.set(d.run_id, d.new_run_id)
    if (action === 'retry') retried.add(d.run_id)
  }
  for (const s of r.skipped) if (s.new_run_id && s.reason === SOP_RERUN_REASON_RELAUNCHED) to.set(s.run_id, s.new_run_id)
  if (!to.size && !retried.size) return [...runs]
  return runs.map((x) => {
    if (to.has(x.id)) return { ...x, relaunched_to: to.get(x.id) }
    if (retried.has(x.id) && x.status === 'failed') {
      return { ...x, status: 'running', steps: x.steps.map((s) => (s.status === 'failed' ? { ...s, status: 'running' } : s)) }
    }
    return x
  })
}

/** 缓存里所有执行列表（全部、按对象、按输入字段）都改；单条执行的缓存等事件刷新 */
function putRerun(qc: QueryClient, action: SopRerunAction, r: SopRerunResult) {
  qc.setQueriesData<SopRunBrief[]>({ queryKey: dataKeys.sop.runs }, (old) => (Array.isArray(old) ? applyRerun(old, action, r) : old))
}

/** 失败执行批量重跑；成功先改缓存（applyRerun），做完报 sop-run，列表和计数跟着刷 */
export function useRerunSopRuns() {
  const qc = useQueryClient()
  const notify = useNotifyChange()
  return useMutation({
    mutationFn: ({ runIds, action }: { runIds: readonly string[]; action: SopRerunAction }) => sopBatchApi.rerun(runIds, action),
    onSuccess: (r, v) => putRerun(qc, v.action, r),
    // 不等重新取完：缓存已经改好，结果提示立即出来
    onSettled: () => { void notify({ kind: 'sop-run' }) },
  })
}

/** 一批执行逐个终止（已结束的 409 算跳过）；回终止了几个、失败的原因 */
export function useStopSopRuns() {
  const notify = useNotifyChange()
  return useMutation({
    mutationFn: async (ids: readonly string[]) => {
      let stopped = 0
      const errors: string[] = []
      for (const id of ids) {
        try {
          await sopApi.act(id, { kind: 'stop' })
          stopped += 1
        } catch (e) {
          if (!isApiError(e, 'conflict')) errors.push(e instanceof Error ? e.message : String(e))
        }
      }
      return { stopped, errors }
    },
    onSettled: () => notify({ kind: 'sop-run' }),
  })
}
