// 视频创作插件 video（VID-01c）：视频、系列，阶段推进和检查点；VID-01d 加了产出物和系列的写操作。契约见 docs/api-contract.md「视频创作插件 video」（VID-01a）。
// 视频和检查点一共几十集，列表不分页，一次取完由前端分组、筛选。写操作报 { kind: 'video' }，整个 video 前缀一起刷：
// 阶段、检查点一变，列表的分布条、「待我处理」的数字都跟着变。
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { request, requestList } from '../api'
import { useNotifyChange } from './invalidate'
import { videoKeys } from './videoKeys'

export type VideoOrientation = 'landscape' | 'portrait' | 'square'
export type VideoStageKey = 'topic' | 'script' | 'plan' | 'web' | 'ch1' | 'chapters' | 'audio' | 'record' | 'distribution'
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
  /** 这一集的选题（VID-09a），只能用 PUT /topic 和立项写 */
  topic_id?: string
  orientations: VideoOrientation[]
  stage: VideoStageKey
  /** 固定 4 个，按 plan、ch1、audio、distribution 排 */
  checkpoints: VideoCheckpoint[]
  root: string
  chapters: number
  /** 阶段执行器（VID-03b），按阶段先后，没配是 [] */
  runners?: VideoStageRunner[]
  /** 最近一次执行，没跑过没有 */
  last_run?: VideoLastRun
  created_at: string
  updated_at: string
}

// 阶段执行器（VID-03b 接口，VID-03c 前端）：技能只认 sk_video；SOP、Agent 是 id 或名称，后端只存不查
export type VideoRunnerType = 'skill' | 'sop' | 'agent'
export type VideoStageRunner = { stage: VideoStageKey; type: VideoRunnerType; ref_id: string; prompt?: string }
export type VideoRunStatus = 'running' | 'done' | 'failed'
export type VideoLastRun = {
  /** 技能和 Agent 都按 agent 记 */
  type: 'agent' | 'sop'
  /** 内核插件运行 id（run_），发起时就失败的为空串 */
  id: string
  stage: VideoStageKey
  status: VideoRunStatus
  started_at: string
  ended_at?: string
  error?: string
  artifact_ids?: string[]
  /** Agent 会话 id（ags_）或 SOP 执行 id（spr_） */
  ref?: string
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

export type VideoSeriesInput = { name?: string; desc?: string; intro?: string; outro?: string; template?: string; stale?: string[] }

// 产出物（VID-01b 接口，VID-01d 前端）。ratio、lang、字幕是 VID-02a 加的，老数据没有 ratio 的封面按比例的默认封面比例算
export type VideoArtifactKind = 'article' | 'script' | 'outline' | 'presentation' | 'audio' | 'video' | 'subtitle' | 'cover' | 'description' | 'chapters'
export type VideoArtifactStatus = 'draft' | 'review' | 'final' | 'published'
export type VideoCoverRatio = '16x9' | '4x3' | '9x16' | '3x4' | '1x1'
export type VideoArtifactReview = { at: string; ok: boolean; comment: string; version: number }
export type VideoArtifactSource = {
  type: 'manual' | 'sop' | 'agent' | 'skill'
  label: string
  /** Agent id、SOP 流程 id 或技能名 */
  id?: string
  session_id?: string
  run_id?: string
  artifact_id?: string
}

export type VideoArtifact = {
  /** vaf_ 前缀 */
  id: string
  video_id: string
  kind: VideoArtifactKind
  name: string
  /** 相对视频目录 */
  path: string
  variant?: VideoOrientation
  ratio?: VideoCoverRatio
  option?: number
  lang?: string
  version: number
  status: VideoArtifactStatus
  /** 秒 */
  duration?: number
  source: VideoArtifactSource
  /** 按先后 */
  reviews: VideoArtifactReview[]
  /** 只有封面有 */
  picked?: boolean
  /** 封面在 A/B 测试里输掉后归档（VID-05b），记录和文件都留着 */
  archived?: boolean
  created_at: string
  updated_at: string
}

export type VideoArtifactInput = {
  name?: string
  path?: string
  variant?: VideoOrientation | null
  ratio?: VideoCoverRatio
  option?: number | null
  lang?: string
  duration?: number | null
  status?: VideoArtifactStatus
  picked?: boolean
}

const base = '/api/video'
const videoPath = (id: string) => `${base}/videos/${encodeURIComponent(id)}`
const artifactPath = (id: string) => `${base}/artifacts/${encodeURIComponent(id)}`

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
  createSeries: (body: VideoSeriesInput) => request<VideoSeries>('POST', `${base}/series`, { body }),
  /** stale 整体替换 */
  patchSeries: (id: string, body: VideoSeriesInput) => request<VideoSeries>('PATCH', `${base}/series/${encodeURIComponent(id)}`, { body }),
  removeSeries: (id: string) => request<null>('DELETE', `${base}/series/${encodeURIComponent(id)}`),
  artifacts: async (videoId: string, signal?: AbortSignal) =>
    (await requestList<VideoArtifact>(`${base}/artifacts?video_id=${encodeURIComponent(videoId)}`, { signal })).data,
  createArtifact: (body: VideoArtifactInput & { video_id: string; kind: VideoArtifactKind }) => request<VideoArtifact>('POST', `${base}/artifacts`, { body }),
  patchArtifact: (id: string, body: VideoArtifactInput) => request<VideoArtifact>('PATCH', artifactPath(id), { body }),
  removeArtifact: (id: string) => request<null>('DELETE', artifactPath(id)),
  /** 验收：退回必须写意见 */
  reviewArtifact: (id: string, ok: boolean, comment?: string) =>
    request<VideoArtifact>('POST', `${artifactPath(id)}/reviews`, { body: comment ? { ok, comment } : { ok } }),
  /** 升版本：from 是点的时候看到的版本，别处升过回 409 */
  bumpArtifact: (id: string, from: number) => request<VideoArtifact>('POST', `${artifactPath(id)}/bump`, { body: { from } }),
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

/** 一集的产出物，按登记先后，带验收记录 */
export function useVideoArtifacts(videoId: string | null) {
  return useQuery({ queryKey: videoKeys.artifacts(videoId ?? ''), queryFn: ({ signal }) => videoApi.artifacts(videoId!, signal), enabled: !!videoId })
}

// 产出物写成功后先换掉列表里那一条，抽屉不闪；视频的更新时间跟着变，再刷整个 video 前缀
function useArtifactWrite<A>(fn: (a: A) => Promise<VideoArtifact>) {
  const qc = useQueryClient()
  const notify = useNotifyChange()
  return useMutation({
    mutationFn: fn,
    onSuccess: (a) => {
      qc.setQueryData<VideoArtifact[]>(videoKeys.artifacts(a.video_id), (xs) => (xs?.some((x) => x.id === a.id)
        ? xs.map((x) => (x.id === a.id ? a : x)) : [...(xs ?? []), a]))
      return notify({ kind: 'video' })
    },
  })
}

export function useCreateArtifact() {
  return useArtifactWrite((body: VideoArtifactInput & { video_id: string; kind: VideoArtifactKind }) => videoApi.createArtifact(body))
}

/** 只传改的字段；选用封面传 picked: true，后端把同组其余的取消 */
export function usePatchArtifact() {
  return useArtifactWrite(({ id, patch }: { id: string; patch: VideoArtifactInput }) => videoApi.patchArtifact(id, patch))
}

export function useReviewArtifact() {
  return useArtifactWrite(({ id, ok, comment }: { id: string; ok: boolean; comment?: string }) => videoApi.reviewArtifact(id, ok, comment))
}

export function useBumpArtifact() {
  return useArtifactWrite(({ id, from }: { id: string; from: number }) => videoApi.bumpArtifact(id, from))
}

/** 只删记录，文件不动 */
export function useDeleteArtifact() {
  const qc = useQueryClient()
  const notify = useNotifyChange()
  return useMutation({
    mutationFn: ({ id }: { id: string; videoId: string }) => videoApi.removeArtifact(id),
    onSuccess: (_, { id, videoId }) => {
      qc.setQueryData<VideoArtifact[]>(videoKeys.artifacts(videoId), (xs) => xs?.filter((x) => x.id !== id))
      return notify({ kind: 'video' })
    },
  })
}

function useSeriesWrite<A, R>(fn: (a: A) => Promise<R>) {
  const notify = useNotifyChange()
  return useMutation({ mutationFn: fn, onSuccess: () => notify({ kind: 'video' }) })
}

export function useCreateSeries() {
  return useSeriesWrite((body: VideoSeriesInput) => videoApi.createSeries(body))
}

/** 改系列；改共用部分时把勾上的集并进 stale 一起传 */
export function usePatchSeries() {
  return useSeriesWrite(({ id, patch }: { id: string; patch: VideoSeriesInput }) => videoApi.patchSeries(id, patch))
}

/** 删除系列：各集变回单集 */
export function useDeleteSeries() {
  return useSeriesWrite((id: string) => videoApi.removeSeries(id))
}
