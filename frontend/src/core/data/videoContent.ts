// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 视频的选题一步和稿件正文（VID-09b，接口是 VID-09a）。契约见 docs/api-contract.md「选题一步和稿件正文（VID-09a）」。
// 挂、换、摘选题回 {video, topic}；正文按版本取，写成功回 {artifact, content}。写操作先把回来的数据换进缓存，再刷整个 video 前缀
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { request } from '../api'
import { useNotifyChange } from './invalidate'
import type { Video, VideoArtifact } from './video'
import { videoKeys } from './videoKeys'
import type { VideoTopic } from './videoTopics'

export type VideoArtifactContent = {
  artifact_id: string
  /** 读的第几版 */
  version: number
  /** 相对工程目录；旧版本是 .versions/... */
  path: string
  content: string
  /** false 是文件还没写过，content 为空串 */
  exists: boolean
  size: number
  modified_at?: string
  /** 留存的旧版本号，从小到大 */
  versions: number[]
}

const base = '/api/video'

export const videoContentApi = {
  /** 挂、换选题；传 null 摘下。换下来的选题回到可开拍 */
  putTopic: (id: string, topicId: string | null) =>
    request<{ video: Video; topic: VideoTopic | null }>('PUT', `${base}/videos/${encodeURIComponent(id)}/topic`, { body: { topic_id: topicId } }),
  /** version 不给是当前版本；旧版本没留存 404 */
  content: (id: string, version?: number, signal?: AbortSignal) =>
    request<VideoArtifactContent>('GET', `${base}/artifacts/${encodeURIComponent(id)}/content${version ? `?version=${version}` : ''}`, { signal }),
  /** new_version 存成下一版；from 是看到的版本，别处升过回 409 */
  putContent: (id: string, body: { content: string; new_version?: boolean; from?: number }) =>
    request<{ artifact: VideoArtifact; content: VideoArtifactContent }>('PUT', `${base}/artifacts/${encodeURIComponent(id)}/content`, { body }),
}

export function usePutVideoTopic() {
  const qc = useQueryClient()
  const notify = useNotifyChange()
  return useMutation({
    mutationFn: ({ id, topicId }: { id: string; topicId: string | null }) => videoContentApi.putTopic(id, topicId),
    onSuccess: (r) => {
      qc.setQueryData(videoKeys.video(r.video.id), r.video)
      return notify({ kind: 'video' })
    },
  })
}

/** 一份正文的某一版；id 为 null 或 version 为 0 时不取 */
export function useArtifactContent(id: string | null, version: number) {
  return useQuery({
    queryKey: videoKeys.content(id ?? '', version),
    queryFn: ({ signal }) => videoContentApi.content(id!, version, signal),
    enabled: !!id && version > 0,
    retry: false,
  })
}

export function usePutArtifactContent() {
  const qc = useQueryClient()
  const notify = useNotifyChange()
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string; content: string; new_version?: boolean; from?: number }) => videoContentApi.putContent(id, body),
    onSuccess: ({ artifact: a, content }) => {
      qc.setQueryData(videoKeys.content(a.id, a.version), content)
      qc.setQueryData<VideoArtifact[]>(videoKeys.artifacts(a.video_id), (xs) => (xs?.some((x) => x.id === a.id)
        ? xs.map((x) => (x.id === a.id ? a : x)) : [...(xs ?? []), a]))
      return notify({ kind: 'video' })
    },
  })
}
