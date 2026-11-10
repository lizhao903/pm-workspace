// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 运行中心（P0-O1）：Agent 执行记录和任务执行统一一页看到，接 GET /api/runs/all。
// 契约见 docs/api-contract.md「运行中心」；单条的停止、重试走 agentRuns 里原来的接口，取消任务走下面的 cancelTaskRun。
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { request, requestList } from '../api'

export type RunCenterKind = 'agent' | 'task'
/** 两种执行共用的状态；等你确认、已拒绝是 Agent 才有的 */
export type RunCenterStatus = 'running' | 'waiting' | 'done' | 'failed' | 'canceled' | 'rejected'

/** 运行中心的一行：Agent 行 title=Agent 名、sub=触发说明；任务行 title=「ref 标题」、sub=执行器的中文名 */
export type RunCenterItem = {
  kind: RunCenterKind
  id: string
  status: RunCenterStatus | (string & {})
  title: string
  sub: string
  /** Agent 最后一条回复 / 失败原因；任务行是这次执行的说明 */
  summary: string
  started_at: string
  finished_at: string | null
  /** 还在等确认的调用数 */
  pending: number
  agent_id: string
  agent_name: string
  trigger: string
  /** Agent 建的会话；还没建出会话就失败了为 null */
  session_id: string | null
  object_id: string
  object_ref: string
  object_title: string
  harness: string
}

export type RunCenterFilter = { status?: string; source?: string; limit?: number; offset?: number }

/** 一页取多少：运行记录不会挂太久，一次多取一些先都看到 */
export const RUN_CENTER_LIMIT = 200
/** 有在跑的就隔一会儿再读：执行在后台跑，没有事件推过来 */
export const RUN_CENTER_POLL_MS = 5_000

const runCenterKeys = {
  all: ['run-center'] as const,
  list: (f: RunCenterFilter) => ['run-center', 'list', f] as const,
}

function filterQuery(f: RunCenterFilter): URLSearchParams {
  const q = new URLSearchParams()
  if (f.status) q.set('status', f.status)
  if (f.source) q.set('source', f.source)
  if (f.limit !== undefined) q.set('limit', String(f.limit))
  if (f.offset) q.set('offset', String(f.offset))
  return q
}

/** 一次执行从开始到结束的耗时；还没结束的按现在算。没开始时间时空串 */
export function runElapsed(item: Pick<RunCenterItem, 'started_at' | 'finished_at'>, now: Date = new Date()): string {
  const start = Date.parse(item.started_at)
  const end = item.finished_at ? Date.parse(item.finished_at) : now.getTime()
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return ''
  const sec = Math.max(0, Math.round((end - start) / 1000))
  if (sec < 60) return `${sec} 秒`
  const min = Math.floor(sec / 60)
  if (min < 60) return sec % 60 ? `${min} 分 ${sec % 60} 秒` : `${min} 分`
  return `${Math.floor(min / 60)} 小时 ${min % 60} 分`
}

export const runCenterApi = {
  /** 按状态、来源在后端筛的一页；total 不含分页 */
  all: (f: RunCenterFilter, signal?: AbortSignal) => requestList<RunCenterItem>('/api/runs/all', { query: filterQuery(f), signal }),
}

/** 取消一次任务执行（P0-O1）：只有在跑的能取消，其余 409 */
export const cancelTaskRun = (id: string) =>
  request<{ run_id: string; status: RunCenterStatus }>('POST', `/api/runs/${encodeURIComponent(id)}/cancel`, { body: {} })

/** 一页运行记录（按状态、来源在后端筛）；有在跑的就 5 秒轮询。换条件时先留着上一页，列表不闪 */
export function useRunCenter(f: RunCenterFilter) {
  const q: RunCenterFilter = { status: f.status || undefined, source: f.source || undefined, limit: f.limit ?? RUN_CENTER_LIMIT }
  return useQuery({
    queryKey: runCenterKeys.list(q),
    queryFn: ({ signal }) => runCenterApi.all(q, signal),
    placeholderData: keepPreviousData,
    refetchInterval: (q2) => (q2.state.data?.data.some((r) => r.status === 'running') ? RUN_CENTER_POLL_MS : false),
  })
}

/** 取消一次任务执行；完了刷新运行中心的列表和条数 */
export function useCancelTaskRun() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => cancelTaskRun(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: runCenterKeys.all }),
  })
}
