// 执行记录的读写（DEV-08c 起，CORE-03a 迁进数据访问层）：某个对象的执行历史、单条详情、取消，以及发起执行的流。
// 执行开始报 run-started，收尾报 run-settled（执行过程中可能改了对象、登记了产出物），取消报 run-canceled。
import { useMutation, useQuery } from '@tanstack/react-query'
import { runObject, runs, type RunDone, type RunEvent, type RunRequest, type StreamOptions, type TaskRun } from '../api'
import { notifyChange, useNotifyChange } from './invalidate'
import { dataKeys } from './keys'

// 后端单页上限
const LIMIT = 100
// 有记录在跑时多久刷一次。输出只在收尾时落库，轮询只为拿到最终状态
const POLL_MS = 2000

export const runFinished = (r: Pick<TaskRun, 'status'>) => r.status !== 'running' && r.status !== 'pending'

// 最近的在前（后端排序）；有没收尾的记录时轮询
export function useTaskRuns(objectId: string) {
  return useQuery({
    queryKey: dataKeys.runs.list(objectId),
    queryFn: () => runs.list(objectId, { limit: LIMIT }),
    refetchInterval: (q) => (q.state.data?.some((r) => !runFinished(r)) ? POLL_MS : false),
  })
}

// 单条完整输出，展开时才取；没收尾时跟着轮询
export function useTaskRun(id: string, enabled: boolean) {
  return useQuery({
    queryKey: dataKeys.runs.detail(id),
    queryFn: () => runs.get(id),
    enabled,
    refetchInterval: (q) => (q.state.data && !runFinished(q.state.data) ? POLL_MS : false),
  })
}

// 取消只是发出请求，后端稍后才收尾成 canceled；状态以之后读回的为准
export function useCancelRun() {
  const notify = useNotifyChange()
  return useMutation({
    mutationFn: (id: string) => runs.cancel(id),
    onSettled: () => notify({ kind: 'run-canceled' }),
  })
}

/**
 * 发起一次执行并读流（POST /api/objects/{id}/run）。拿到 start 事件时执行列表就有这一条了，
 * 收尾（done 或失败）后按 run-settled 刷新。事件照样交给 onEvent，失败照样抛出。
 * 作用在应用唯一的缓存上，组件外（模块级状态）也能用。
 */
export function streamRun(objectId: string, req: RunRequest = {}, opts: StreamOptions<RunEvent> = {}): Promise<RunDone> {
  return runObject(objectId, req, {
    ...opts,
    onEvent: (e) => {
      opts.onEvent?.(e)
      if (e.type === 'start') void notifyChange({ kind: 'run-started', objectId })
    },
  }).finally(() => void notifyChange({ kind: 'run-settled', objectId }))
}
