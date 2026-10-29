// 视频插件的发布记录、平台、账号、按天快照和封面 A/B（VID-05c，接口是 VID-04b、VID-05a、VID-05b）。
// 契约见 docs/api-contract.md「平台账号、发布规则和按天快照」「封面 A/B 测试」。都不分页，一次取完由前端分组、筛选。
// 缓存键都在 video 前缀下，写操作报 { kind: 'video' }：回填会重算封面测试，判出胜者会改封面的选用和归档，整个前缀一起刷
import { useMutation, useQuery } from '@tanstack/react-query'
import { request, requestEnvelope, requestList } from '../api'
import { useNotifyChange } from './invalidate'
import type { VideoArtifact, VideoCoverRatio, VideoOrientation } from './video'
import type { VideoPlatform } from './videoTopics'

export type VideoPublishStatus = 'planned' | 'scheduled' | 'published' | 'failed'

/** 播放数据：前四个各平台都有，后面的平台不给就没有；ctr、completion 是 0 到 1 */
export type VideoMetrics = {
  views: number
  likes: number
  comments: number
  shares: number
  impressions?: number
  ctr?: number
  avg_watch_sec?: number
  completion?: number
  favorites?: number
  coins?: number
  followers_gained?: number
  updated_at: string
}

export type VideoPublishCheck = { key: string; ok: boolean; text: string }

export type VideoPublish = {
  /** pb_ 前缀 */
  id: string
  video_id: string
  platform: VideoPlatform
  variant: VideoOrientation
  cover_id?: string
  title: string
  desc: string
  status: VideoPublishStatus
  scheduled_at?: string
  published_at?: string
  url?: string
  error?: string
  metrics?: VideoMetrics
  account_id?: string
  tags?: string[]
  category?: string
  collection?: string
  /** 后端按平台规则算的发布前校验 */
  checks?: VideoPublishCheck[]
  created_at: string
  updated_at: string
}

export type VideoPublishInput = {
  video_id?: string
  platform?: VideoPlatform
  variant?: VideoOrientation
  title?: string
  cover_id?: string | null
  desc?: string
  status?: VideoPublishStatus
  scheduled_at?: string | null
  published_at?: string | null
  url?: string | null
  error?: string | null
  metrics?: VideoMetrics | null
  account_id?: string | null
  tags?: string[] | null
  category?: string | null
  collection?: string | null
}

export type VideoMetricSnapshot = Omit<VideoMetrics, 'updated_at'> & {
  publish_id: string
  /** 发布后第几天，最少是 1 */
  day: number
  source: 'manual' | 'connector'
  updated_at: string
  created_at: string
}

/** 快照列表：data 是全部快照，days 是按天曲线（同一天取最后一条） */
export type VideoSnapshots = { data: VideoMetricSnapshot[]; days: VideoMetricSnapshot[] }

export type VideoPublishRule = {
  platform: VideoPlatform
  title_max: number
  desc_max: number
  tags_max: number
  allow_link: boolean
  cover: VideoCoverRatio[]
  duration_max_sec?: number
  categories?: string[]
}

export type VideoPlatformCap = 'upload' | 'schedule' | 'metrics' | 'comments'

/** GET /api/video/platforms 的一项：能力、收的封面比例、发布规则、已接入的连接器 */
export type VideoPlatformInfo = {
  key: VideoPlatform
  label: string
  /** 没有连接器的平台没有 */
  tool?: string
  caps: VideoPlatformCap[]
  covers: VideoCoverRatio[]
  creator_url: string
  rule: VideoPublishRule
  connectors: { id: string; name: string; account: string; status: string; error?: string }[]
}

export type VideoAccountRole = 'main' | 'ab' | 'client'

export type VideoAccount = {
  /** pa_ 前缀 */
  id: string
  connector_id?: string
  platform: VideoPlatform
  handle: string
  uid: string
  role: VideoAccountRole
  caps: string[]
  followers?: number
  created_at: string
  updated_at: string
}

export type VideoCoverTestMode = 'native' | 'accounts' | 'utm'
export type VideoCoverTestStatus = 'running' | 'decided' | 'inconclusive'
export type VideoCoverTestArm = { cover_id: string; publish_id?: string; impressions?: number; ctr?: number }

/** 按当前数据算的判定过程，同原型 coverTestState */
export type VideoCoverTestState = {
  days: number
  gap?: number
  reached: number
  leader?: string
  days_ok: boolean
  imp_ok: boolean
  gap_ok: boolean
  /** 每组实际用的数：小号分发从发布记录读 */
  arms: { cover_id: string; impressions?: number; ctr?: number }[]
  data_incomplete?: boolean
}

export type VideoCoverTest = {
  /** vct_ 前缀 */
  id: string
  video_id: string
  platform: VideoPlatform
  mode: VideoCoverTestMode
  arms: VideoCoverTestArm[]
  started_at: string
  ended_at?: string
  min_days: number
  min_impressions: number
  min_gap: number
  winner_id?: string
  status: VideoCoverTestStatus
  state: VideoCoverTestState
  created_at: string
  updated_at: string
}

export type VideoCoverTestInput = {
  video_id: string
  platform: VideoPlatform
  mode: VideoCoverTestMode
  arms: VideoCoverTestArm[]
  started_at?: string
  min_days?: number
  min_impressions?: number
  min_gap?: number
}

export type VideoCoverTestPatch = {
  min_days?: number
  min_impressions?: number
  min_gap?: number
  arms?: { cover_id: string; impressions?: number | null; ctr?: number | null }[]
}

export const videoPublishKeys = {
  all: ['video', 'pub'] as const,
  publishes: ['video', 'pub', 'list'] as const,
  platforms: ['video', 'pub', 'platforms'] as const,
  accounts: ['video', 'pub', 'accounts'] as const,
  /** 全部视频的封面，发布页按平台挑封面、A/B 测试列色块用 */
  covers: ['video', 'pub', 'covers'] as const,
  snapshots: (id: string) => ['video', 'pub', 'snapshots', id] as const,
  coverTests: ['video', 'pub', 'cover-tests'] as const,
}

const base = '/api/video'
const pubPath = (id: string) => `${base}/publishes/${encodeURIComponent(id)}`
const testPath = (id: string) => `${base}/cover-tests/${encodeURIComponent(id)}`

export const videoPublishApi = {
  publishes: async (signal?: AbortSignal) => (await requestList<VideoPublish>(`${base}/publishes`, { signal })).data,
  create: (body: VideoPublishInput) => request<VideoPublish>('POST', `${base}/publishes`, { body }),
  patch: (id: string, body: VideoPublishInput) => request<VideoPublish>('PATCH', pubPath(id), { body }),
  remove: (id: string) => request<null>('DELETE', pubPath(id)),
  /** 经平台连接器投稿；平台出错 502，发布记录已经置为失败 */
  submit: (id: string) => request<VideoPublish>('POST', `${pubPath(id)}/submit`, { body: {} }),
  /** 查稿件状态、拉数据，拉到数据时追加一条快照 */
  sync: (id: string) => request<VideoPublish>('POST', `${pubPath(id)}/sync`, { body: {} }),
  snapshots: async (id: string, signal?: AbortSignal): Promise<VideoSnapshots> => {
    const r = await requestEnvelope<VideoMetricSnapshot[] | null>('GET', `${pubPath(id)}/snapshots`, { signal })
    const days = (r.meta as { days?: VideoMetricSnapshot[] } | undefined)?.days
    return { data: r.data ?? [], days: days ?? [] }
  },
  platforms: async (signal?: AbortSignal) => (await requestList<VideoPlatformInfo>(`${base}/platforms`, { signal })).data,
  accounts: async (signal?: AbortSignal) => (await requestList<VideoAccount>(`${base}/accounts`, { signal })).data,
  covers: async (signal?: AbortSignal) => (await requestList<VideoArtifact>(`${base}/artifacts?kind=cover`, { signal })).data,
  coverTests: async (signal?: AbortSignal) => (await requestList<VideoCoverTest>(`${base}/cover-tests`, { signal })).data,
  createTest: (body: VideoCoverTestInput) => request<VideoCoverTest>('POST', `${base}/cover-tests`, { body }),
  patchTest: (id: string, body: VideoCoverTestPatch) => request<VideoCoverTest>('PATCH', testPath(id), { body }),
  removeTest: (id: string) => request<null>('DELETE', testPath(id)),
  evaluateTest: (id: string) => request<VideoCoverTest>('POST', `${testPath(id)}/evaluate`),
  decideTest: (id: string, winnerId?: string) => request<VideoCoverTest>('POST', `${testPath(id)}/decide`, { body: winnerId ? { winner_id: winnerId } : {} }),
}

/** 全部发布记录，按登记先后 */
export function useVideoPublishes(opts: { enabled?: boolean } = {}) {
  return useQuery({ queryKey: videoPublishKeys.publishes, queryFn: ({ signal }) => videoPublishApi.publishes(signal), enabled: opts.enabled ?? true })
}

/** 五个平台：规则、收的封面比例、能力和接入情况 */
export function useVideoPlatforms(opts: { enabled?: boolean } = {}) {
  return useQuery({ queryKey: videoPublishKeys.platforms, queryFn: ({ signal }) => videoPublishApi.platforms(signal), enabled: opts.enabled ?? true })
}

export function useVideoAccounts() {
  return useQuery({ queryKey: videoPublishKeys.accounts, queryFn: ({ signal }) => videoPublishApi.accounts(signal) })
}

/** 全部视频的封面产出物 */
export function useVideoCovers() {
  return useQuery({ queryKey: videoPublishKeys.covers, queryFn: ({ signal }) => videoPublishApi.covers(signal) })
}

export function usePublishSnapshots(id: string | null) {
  return useQuery({ queryKey: videoPublishKeys.snapshots(id ?? ''), queryFn: ({ signal }) => videoPublishApi.snapshots(id!, signal), enabled: !!id })
}

export function useVideoCoverTests() {
  return useQuery({ queryKey: videoPublishKeys.coverTests, queryFn: ({ signal }) => videoPublishApi.coverTests(signal) })
}

// 成功、失败都刷：投稿失败时后端已经把发布记录置为失败、写上原因
function usePubWrite<A, R>(fn: (a: A) => Promise<R>) {
  const notify = useNotifyChange()
  return useMutation({ mutationFn: fn, onSettled: () => notify({ kind: 'video' }) })
}

export function useCreatePublish() {
  return usePubWrite((body: VideoPublishInput) => videoPublishApi.create(body))
}

/** 只传改的字段；可选字段传 null 清掉；带 metrics 时后端记一条手动快照 */
export function usePatchPublish() {
  return usePubWrite(({ id, patch }: { id: string; patch: VideoPublishInput }) => videoPublishApi.patch(id, patch))
}

/** 只删记录，平台上已发的内容不受影响 */
export function useDeletePublish() {
  return usePubWrite((id: string) => videoPublishApi.remove(id))
}

export function useSubmitPublish() {
  return usePubWrite((id: string) => videoPublishApi.submit(id))
}

export function useSyncPublish() {
  return usePubWrite((id: string) => videoPublishApi.sync(id))
}

/** 建好立刻判一遍，数据已经够的直接判出 */
export function useCreateCoverTest() {
  return usePubWrite((body: VideoCoverTestInput) => videoPublishApi.createTest(body))
}

/** 只有进行中的能改：门槛和原生测试各组的曝光、点击率；改完立刻判一遍 */
export function usePatchCoverTest() {
  return usePubWrite(({ id, patch }: { id: string; patch: VideoCoverTestPatch }) => videoPublishApi.patchTest(id, patch))
}

export function useEvaluateCoverTest() {
  return usePubWrite((id: string) => videoPublishApi.evaluateTest(id))
}

/** 手动判定，门槛不动：给了 winnerId 按它判胜（设主封面、其余归档），不给就结束不判胜负 */
export function useDecideCoverTest() {
  return usePubWrite(({ id, winnerId }: { id: string; winnerId?: string }) => videoPublishApi.decideTest(id, winnerId))
}

/** 只删测试和分组，封面的选用、归档不回退 */
export function useDeleteCoverTest() {
  return usePubWrite((id: string) => videoPublishApi.removeTest(id))
}
