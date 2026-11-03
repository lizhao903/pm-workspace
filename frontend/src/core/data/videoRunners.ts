// 视频阶段执行器（VID-03c，接口是 VID-03b）。契约见 docs/api-contract.md「视频创作插件 video」的「阶段执行器」。
// 配、删、跑都回整个 Video（看 runners、last_run），写进单个视频的缓存再刷整个 video 前缀。
// 跑起来以后后端异步收尾：在跑的时候轮询这一个视频，跑完再刷一次前缀，产出物、列表跟着更新。
import { useEffect, useRef } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { request } from '../api'
import { useNotifyChange } from './invalidate'
import { videoApi, type Video, type VideoLastRun, type VideoRunnerType, type VideoStageKey } from './video'
import { videoKeys } from './videoKeys'

const runnerPath = (id: string, stage: VideoStageKey) => `/api/video/videos/${encodeURIComponent(id)}/runners/${stage}`

export const videoRunnerApi = {
  /** 整条替换；prompt 不传就是清掉 */
  put: (id: string, stage: VideoStageKey, body: { type: VideoRunnerType; ref_id: string; prompt?: string }) =>
    request<Video>('PUT', runnerPath(id, stage), { body }),
  /** 没配过也回 200，执行记录留着 */
  remove: (id: string, stage: VideoStageKey) => request<Video>('DELETE', runnerPath(id, stage)),
  /** 发起成功 202、发起时就失败 200，都回 Video；前置检查不过 409 */
  run: (id: string, stage: VideoStageKey) => request<Video>('POST', `${runnerPath(id, stage)}/run`, { body: {} }),
}

function useRunnerWrite<A>(fn: (a: A) => Promise<Video>) {
  const qc = useQueryClient()
  const notify = useNotifyChange()
  return useMutation({
    mutationFn: fn,
    onSuccess: (v) => {
      qc.setQueryData(videoKeys.video(v.id), v)
      return notify({ kind: 'video' })
    },
  })
}

export function usePutRunner() {
  return useRunnerWrite(({ id, stage, type, ref_id, prompt }: { id: string; stage: VideoStageKey; type: VideoRunnerType; ref_id: string; prompt?: string }) =>
    videoRunnerApi.put(id, stage, prompt ? { type, ref_id, prompt } : { type, ref_id }))
}

export function useRemoveRunner() {
  return useRunnerWrite(({ id, stage }: { id: string; stage: VideoStageKey }) => videoRunnerApi.remove(id, stage))
}

export function useRunStage() {
  return useRunnerWrite(({ id, stage }: { id: string; stage: VideoStageKey }) => videoRunnerApi.run(id, stage))
}

/** 在跑时多久看一次 */
export const VIDEO_RUN_POLL_MS = 3000

/** 视频有执行在跑时轮询它；从在跑变成跑完、失败时刷整个 video 前缀（产出物、列表的待验收） */
export function useWatchVideoRun(v: Video, pollMs = VIDEO_RUN_POLL_MS) {
  const running = v.last_run?.status === 'running'
  useQuery({
    queryKey: videoKeys.video(v.id),
    queryFn: ({ signal }) => videoApi.video(v.id, signal),
    enabled: running,
    refetchInterval: running ? pollMs : false,
  })
  const notify = useNotifyChange()
  const prev = useRef<VideoLastRun | undefined>(v.last_run)
  useEffect(() => {
    const was = prev.current
    prev.current = v.last_run
    if (was?.status === 'running' && v.last_run?.status !== 'running') void notify({ kind: 'video' })
  }, [v.last_run, notify])
}
