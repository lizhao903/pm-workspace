// 视频创作插件 video（VID-01c）：视频、系列，阶段推进和检查点。契约见 docs/api-contract.md「视频创作插件 video」（VID-01a）。
// 视频和检查点一共几十集，列表不分页，一次取完由前端分组、筛选。写操作报 { kind: 'video' }，整个 video 前缀一起刷：
// 阶段、检查点一变，列表的分布条、「待我处理」的数字都跟着变。
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { request, requestList } from '../api'
import { useNotifyChange } from './invalidate'
import { videoKeys } from './videoKeys'

export type VideoOrientation = 'landscape' | 'portrait' | 'square'
export type VideoStageKey = 'script' | 'plan' | 'web' | 'ch1' | 'chapters' | 'audio' | 'record' | 'distribution'
export type VideoCheckpointStage = 'plan' | 'ch1' | 'audio' | 'distribution'
export type VideoCheckpointState = 'pending' | 'passed' | 'rejected' | 'skipped'

export type VideoCheckpoint = { stage: VideoCheckpointStage; state: VideoCheckpointState; at?: string; note?: string }

export type Video = {
  /** vd_ 前缀 */
  id: string
  title: string
  project_id?: string
  series_id?: string
  episode?: number
  orientations: VideoOrientation[]
  stage: VideoStageKey
  /** 固定 4 个，按 plan、ch1、audio、distribution 排 */
  checkpoints: VideoCheckpoint[]
  root: string
  chapters: number
  created_at: string
  updated_at: string
}

export type VideoInput = {
  title?: string
  project_id?: string | null
  series_id?: string | null
  episode?: number | null
  orientations?: VideoOrientation[]
  root?: string
  chapters?: number
}

export type VideoSeries = {
  /** sr_ 前缀 */
  id: string
  name: string
  desc: string
  intro: string
  outro: string
  template: string
  /** 改过共用部分还没同步的集（视频 id），按集数排 */
  stale: string[]
  created_at: string
  updated_at: string
}

const base = '/api/video'
const videoPath = (id: string) => `${base}/videos/${encodeURIComponent(id)}`

export const videoApi = {
  videos: async (signal?: AbortSignal) => (await requestList<Video>(`${base}/videos`, { signal })).data,
  video: (id: string, signal?: AbortSignal) => request<Video>('GET', videoPath(id), { signal }),
  create: (body: VideoInput) => request<Video>('POST', `${base}/videos`, { body }),
  patch: (id: string, body: VideoInput) => request<Video>('PATCH', videoPath(id), { body }),
  remove: (id: string) => request<null>('DELETE', videoPath(id)),
  /** 没有检查点的阶段做完了；from 是点的时候看到的阶段，被别处推进过回 409 */
  advance: (id: string, from: VideoStageKey) => request<Video>('POST', `${videoPath(id)}/advance`, { body: { from } }),
  decide: (id: string, stage: VideoCheckpointStage, state: Exclude<VideoCheckpointState, 'pending'>, note?: string) =>
    request<Video>('POST', `${videoPath(id)}/checkpoints/${stage}`, { body: note ? { state, note } : { state } }),
  series: async (signal?: AbortSignal) => (await requestList<VideoSeries>(`${base}/series`, { signal })).data,
}

/** 全部视频，按新建先后 */
export function useVideos(opts?: { enabled?: boolean }) {
  return useQuery({ queryKey: videoKeys.videos, queryFn: ({ signal }) => videoApi.videos(signal), enabled: opts?.enabled })
}

export function useVideo(id: string | null) {
  return useQuery({ queryKey: videoKeys.video(id ?? ''), queryFn: ({ signal }) => videoApi.video(id!, signal), enabled: !!id })
}

export function useVideoSeries() {
  return useQuery({ queryKey: videoKeys.series, queryFn: ({ signal }) => videoApi.series(signal) })
}

// 写成功后先把回来的视频写进单个视频的缓存，详情页不闪，再刷整个前缀
function useVideoWrite<A>(fn: (a: A) => Promise<Video>) {
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

export function useCreateVideo() {
  return useVideoWrite((body: VideoInput) => videoApi.create(body))
}

/** 只传改的字段；project_id、series_id、episode 传 null 清掉 */
export function usePatchVideo() {
  return useVideoWrite(({ id, patch }: { id: string; patch: VideoInput }) => videoApi.patch(id, patch))
}

export function useAdvanceVideo() {
  return useVideoWrite(({ id, from }: { id: string; from: VideoStageKey }) => videoApi.advance(id, from))
}

export function useDecideCheckpoint() {
  return useVideoWrite(({ id, stage, state, note }: {
    id: string; stage: VideoCheckpointStage; state: Exclude<VideoCheckpointState, 'pending'>; note?: string
  }) => videoApi.decide(id, stage, state, note))
}

/** 删除：检查点、发布记录随视频一起删 */
export function useDeleteVideo() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => videoApi.remove(id),
    // 详情页还开着：单个视频的缓存不动（动了会去重取已经删掉的视频），只刷列表和系列
    onSuccess: (_, id) => {
      qc.setQueryData<Video[]>(videoKeys.videos, (xs) => xs?.filter((v) => v.id !== id))
      return Promise.all([videoKeys.videos, videoKeys.series].map((queryKey) => qc.invalidateQueries({ queryKey }))).then(() => undefined)
    },
  })
}
