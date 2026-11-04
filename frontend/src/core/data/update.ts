// 设置「版本更新」（SYS-UPD）：GET/POST /api/admin/update。更新中、重启中每 1.5 秒轮询一次；
// 重启那几秒请求会失败，照样接着轮询，等新进程起来
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { request } from '../api'

export type UpdateCommit = { sha: string; subject: string; at: string }
export type UpdateStep = { key: string; label: string; state: 'pending' | 'running' | 'done' | 'failed' | 'skipped'; note?: string }
export type UpdateJob = {
  state: 'running' | 'failed' | 'restarting'
  steps: UpdateStep[]
  error?: string
  log: string
  started_at: string
  ended_at?: string
}
export type UpdateStatus = {
  running: { version: string; commit: string; modified: boolean; commit_at: string; binary: string }
  source: {
    repo: string
    branch: string
    head: UpdateCommit | null
    dirty: number
    ahead: UpdateCommit[] | null
    ahead_total: number
    diverged: boolean
  } | null
  available: boolean
  blocked?: string
  job: UpdateJob | null
}

export const updateApi = {
  status: (signal?: AbortSignal) => request<UpdateStatus>('GET', '/api/admin/update', { signal }),
  start: () => request<UpdateStatus>('POST', '/api/admin/update', { body: {} }),
}

const UPDATE_KEY = ['admin', 'update'] as const
/** 更新中、重启中的轮询间隔 */
export const UPDATE_POLL_MS = 1500

/** follow 为真（刚点了更新、在等重启）时一直轮询；否则只在后端说正在更新时轮询 */
export function useUpdateStatus(follow: boolean) {
  return useQuery({
    queryKey: UPDATE_KEY,
    queryFn: ({ signal }) => updateApi.status(signal),
    retry: false,
    refetchInterval: (q) => (follow || q.state.data?.job?.state === 'running' || q.state.data?.job?.state === 'restarting' ? UPDATE_POLL_MS : false),
    refetchIntervalInBackground: true,
  })
}

/** 开始更新：回来的状态（带这次的进度）直接写进缓存，页面不会拿旧数据误判 */
export function useStartUpdate() {
  const qc = useQueryClient()
  return useMutation({ mutationFn: updateApi.start, onSuccess: (r) => qc.setQueryData(UPDATE_KEY, r) })
}
