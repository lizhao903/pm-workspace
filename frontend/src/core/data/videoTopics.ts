// 视频插件的选题和素材箱（VID-08c，接口是 VID-08a）。契约见 docs/api-contract.md「选题和素材箱（VID-08a）」。
// 选题、素材都不分页，一次取完由前端分组、筛选、搜索。写操作报 { kind: 'video' }：立项会生成视频，素材和选题互相记着 id，整个前缀一起刷
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { request, requestList } from '../api'
import { useNotifyChange } from './invalidate'
import type { Video } from './video'
import { videoKeys } from './videoKeys'

export type VideoTopicStatus = 'idea' | 'research' | 'ready' | 'scheduled' | 'made' | 'dropped'
export type VideoPlatform = 'bilibili' | 'youtube' | 'douyin' | 'channels' | 'xiaohongshu'
export type VideoTopicScore = { demand: number; fit: number; effort: number }

export type VideoTopic = {
  /** tp_ 前缀 */
  id: string
  title: string
  angle: string
  audience: string
  status: VideoTopicStatus
  score: VideoTopicScore
  tags: string[]
  series_id?: string
  platforms: VideoPlatform[]
  /** markdown */
  outline: string
  clip_ids: string[]
  planned_at?: string
  video_id?: string
  drop_reason?: string
  created_at: string
  updated_at: string
}

export type VideoTopicInput = {
  title?: string
  angle?: string
  audience?: string
  status?: VideoTopicStatus
  score?: Partial<VideoTopicScore>
  tags?: string[]
  series_id?: string | null
  platforms?: VideoPlatform[]
  outline?: string
  clip_ids?: string[]
  planned_at?: string | null
  drop_reason?: string | null
}

export type VideoClipKind = 'link' | 'note' | 'trend' | 'comment' | 'competitor' | 'im'

export type VideoClip = {
  /** cl_ 前缀 */
  id: string
  kind: VideoClipKind
  title: string
  content: string
  url?: string
  source: string
  heat?: number
  tags: string[]
  starred: boolean
  topic_ids: string[]
  triaged: boolean
  publish_id?: string
  message_id?: string
  created_at: string
  updated_at: string
}

export type VideoClipInput = {
  title?: string
  content?: string
  url?: string
  source?: string
  heat?: number | null
  tags?: string[]
  starred?: boolean
  triaged?: boolean
}

const base = '/api/video'
const topicPath = (id: string) => `${base}/topics/${encodeURIComponent(id)}`
const clipPath = (id: string) => `${base}/clips/${encodeURIComponent(id)}`

export const videoTopicApi = {
  topics: async (signal?: AbortSignal) => (await requestList<VideoTopic>(`${base}/topics`, { signal })).data,
  create: (body: VideoTopicInput) => request<VideoTopic>('POST', `${base}/topics`, { body }),
  patch: (id: string, body: VideoTopicInput) => request<VideoTopic>('PATCH', topicPath(id), { body }),
  remove: (id: string) => request<null>('DELETE', topicPath(id)),
  /** 立项：生成一集视频，选题变成已做成 */
  make: (id: string, projectId?: string) =>
    request<{ topic: VideoTopic; video: Video }>('POST', `${topicPath(id)}/make`, { body: projectId ? { project_id: projectId } : {} }),
  clips: async (signal?: AbortSignal) => (await requestList<VideoClip>(`${base}/clips`, { signal })).data,
  createClip: (body: VideoClipInput & { kind: VideoClipKind }) => request<VideoClip>('POST', `${base}/clips`, { body }),
  patchClip: (id: string, body: VideoClipInput) => request<VideoClip>('PATCH', clipPath(id), { body }),
  removeClip: (id: string) => request<null>('DELETE', clipPath(id)),
  /** 转为选题，body 里的字段覆盖默认值 */
  clipToTopic: (id: string, body: Omit<VideoTopicInput, 'clip_ids'> = {}) =>
    request<{ topic: VideoTopic; clip: VideoClip }>('POST', `${clipPath(id)}/topic`, { body }),
  /** 并入进行中的选题 */
  linkClip: (id: string, topicId: string) => request<{ topic: VideoTopic; clip: VideoClip }>('POST', `${clipPath(id)}/link`, { body: { topic_id: topicId } }),
}

/** 全部选题，按新建先后 */
export function useVideoTopics() {
  return useQuery({ queryKey: videoKeys.topics, queryFn: ({ signal }) => videoTopicApi.topics(signal) })
}

/** 全部素材，按收进来的时间倒序 */
export function useVideoClips() {
  return useQuery({ queryKey: videoKeys.clips, queryFn: ({ signal }) => videoTopicApi.clips(signal) })
}

// 写成功后先把回来的选题、素材换进列表，抽屉和卡片不闪，再刷整个 video 前缀
type Written = { topic?: VideoTopic; clip?: VideoClip }
function useTopicWrite<A, R>(fn: (a: A) => Promise<R>, written: (r: R) => Written) {
  const qc = useQueryClient()
  const notify = useNotifyChange()
  return useMutation({
    mutationFn: fn,
    onSuccess: (r) => {
      const { topic, clip } = written(r)
      if (topic) qc.setQueryData<VideoTopic[]>(videoKeys.topics, (xs) => upsert(xs, topic))
      if (clip) qc.setQueryData<VideoClip[]>(videoKeys.clips, (xs) => upsert(xs, clip, true))
      return notify({ kind: 'video' })
    },
  })
}
const asTopic = (topic: VideoTopic): Written => ({ topic })
const asClip = (clip: VideoClip): Written => ({ clip })
const both = (r: Written) => r

function upsert<T extends { id: string }>(xs: T[] | undefined, x: T, front?: boolean): T[] | undefined {
  if (!xs) return xs
  if (xs.some((y) => y.id === x.id)) return xs.map((y) => (y.id === x.id ? x : y))
  return front ? [x, ...xs] : [...xs, x]
}

export function useCreateTopic() {
  return useTopicWrite((body: VideoTopicInput) => videoTopicApi.create(body), asTopic)
}

/** 只传改的字段；clip_ids 整体替换，series_id、planned_at、drop_reason 传 null 清掉 */
export function usePatchTopic() {
  return useTopicWrite(({ id, patch }: { id: string; patch: VideoTopicInput }) => videoTopicApi.patch(id, patch), asTopic)
}

/** 立项，回来的视频写进单个视频的缓存，跳过去不闪 */
export function useMakeTopic() {
  const qc = useQueryClient()
  return useTopicWrite(async ({ id, projectId }: { id: string; projectId?: string }) => {
    const r = await videoTopicApi.make(id, projectId)
    qc.setQueryData(videoKeys.video(r.video.id), r.video)
    return r
  }, both)
}

export function useCreateClip() {
  return useTopicWrite((body: VideoClipInput & { kind: VideoClipKind }) => videoTopicApi.createClip(body), asClip)
}

export function usePatchClip() {
  return useTopicWrite(({ id, patch }: { id: string; patch: VideoClipInput }) => videoTopicApi.patchClip(id, patch), asClip)
}

export function useClipToTopic() {
  return useTopicWrite(({ id, topic }: { id: string; topic?: Omit<VideoTopicInput, 'clip_ids'> }) => videoTopicApi.clipToTopic(id, topic), both)
}

export function useLinkClip() {
  return useTopicWrite(({ id, topicId }: { id: string; topicId: string }) => videoTopicApi.linkClip(id, topicId), both)
}

/** 删除选题：和素材的关联一起删，素材和立项生成的视频留着 */
export function useDeleteTopic() {
  const qc = useQueryClient()
  const notify = useNotifyChange()
  return useMutation({
    mutationFn: (id: string) => videoTopicApi.remove(id),
    onSuccess: (_, id) => {
      qc.setQueryData<VideoTopic[]>(videoKeys.topics, (xs) => xs?.filter((t) => t.id !== id))
      return notify({ kind: 'video' })
    },
  })
}

/** 删除素材：和选题的关联一起删，选题留着 */
export function useDeleteClip() {
  const qc = useQueryClient()
  const notify = useNotifyChange()
  return useMutation({
    mutationFn: (id: string) => videoTopicApi.removeClip(id),
    onSuccess: (_, id) => {
      qc.setQueryData<VideoClip[]>(videoKeys.clips, (xs) => xs?.filter((c) => c.id !== id))
      return notify({ kind: 'video' })
    },
  })
}
