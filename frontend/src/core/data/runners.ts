// 执行器状态与 DeepSeek 集成检查（TSK-0722）。分派弹窗和设置「执行器」页用同一份。
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { runners, type RunnerSmoke, type RunnerSmokeInput, type RunnerStatus } from '../api'
import { dataKeys } from './keys'

/** 三种执行器能不能用、缺什么；后端检测结果缓存一分钟，这里也一分钟内不重取 */
export function useRunners() {
  return useQuery({ queryKey: dataKeys.runs.runners, queryFn: ({ signal }) => runners.list(false, signal), staleTime: 60_000 })
}

/** 设置页「检测」：跳过后端缓存重新找可执行文件、跑 --version，结果写回缓存 */
export function useDetectRunners() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => runners.list(true),
    onSuccess: (list) => qc.setQueryData<RunnerStatus[]>(dataKeys.runs.runners, list),
  })
}

/** 最近一次集成检查；在跑时每 1.5 秒取一次，看每一项的进度 */
export function useDeepSeekSmoke() {
  return useQuery({
    queryKey: dataKeys.runs.smoke,
    queryFn: ({ signal }) => runners.smoke(signal),
    refetchInterval: (q) => (q.state.data?.status === 'running' ? 1500 : false),
  })
}

/** 发起集成检查：回 202 和「进行中」的记录，直接写进缓存开始轮询；409 是已经有一次在跑 */
export function useStartDeepSeekSmoke() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: RunnerSmokeInput) => runners.startSmoke(body),
    onSuccess: (sm) => qc.setQueryData<RunnerSmoke | null>(dataKeys.runs.smoke, sm),
  })
}
