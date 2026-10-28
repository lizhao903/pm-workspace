// 任务抽屉的执行记录（DEV-08c）：某个对象的执行历史、单条详情、取消。
// 查询键挂在 runs 前缀下，执行收尾或取消后按前缀失效。
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { runs } from './resources'
import type { TaskRun } from './types'

// 后端单页上限
const LIMIT = 100
// 有记录在跑时多久刷一次。输出只在收尾时落库，轮询只为拿到最终状态
const POLL_MS = 2000

export const taskRunKeys = {
  all: ['runs'] as const,
  list: (objectId: string) => ['runs', 'list', objectId] as const,
  get: (id: string) => ['runs', 'get', id] as const,
}

export const runFinished = (r: Pick<TaskRun, 'status'>) => r.status !== 'running' && r.status !== 'pending'

// 最近的在前（后端排序）；有没收尾的记录时轮询
export function useTaskRuns(objectId: string) {
  return useQuery({
    queryKey: taskRunKeys.list(objectId),
    queryFn: () => runs.list(objectId, { limit: LIMIT }),
    refetchInterval: (q) => (q.state.data?.some((r) => !runFinished(r)) ? POLL_MS : false),
  })
}

// 单条完整输出，展开时才取；没收尾时跟着轮询
export function useTaskRun(id: string, enabled: boolean) {
  return useQuery({
    queryKey: taskRunKeys.get(id),
    queryFn: () => runs.get(id),
    enabled,
    refetchInterval: (q) => (q.state.data && !runFinished(q.state.data) ? POLL_MS : false),
  })
}

// 取消只是发出请求，后端稍后才收尾成 canceled；状态以之后读回的为准
export function useCancelRun() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => runs.cancel(id),
    onSettled: () => qc.invalidateQueries({ queryKey: taskRunKeys.all }),
  })
}
