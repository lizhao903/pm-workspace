// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 视频的分镜和 B-roll 素材（TSK-0456）。契约见 docs/api-contract.md「分镜和 B-roll 素材（TSK-0456）」。
// 分镜的写操作都回整份分镜（序号、缺失标记由后端现算），直接换进缓存；素材目录的增删只刷素材目录。
// 缓存键都在 video 前缀下，视频那边报 { kind: 'video' } 时一起刷新。
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { request, requestEnvelope } from '../api'
import { apiBase } from '../api/client'

export type VideoBroll = {
  id: string
  shot_id: string
  /** 素材目录 id；project 是这一集的工程目录 */
  root_id: string
  /** 相对素材目录 */
  path: string
  name: string
  kind: 'image' | 'video'
  note: string
  /** 视频的入点、出点（秒），没设为 null */
  in: number | null
  out: number | null
  /** 文件找不到了：目录被移除、文件被移走或删掉 */
  missing: boolean
  created_at: string
}

export type VideoShot = {
  id: string
  video_id: string
  /** 序号，从 1 起 */
  no: number
  /** 对应的口播段落 */
  text: string
  /** 画面说明 */
  visual: string
  /** 手填的时长（秒），null 是按口播字数估 */
  duration: number | null
  /** 按口播字数估的秒数 */
  est: number
  brolls: VideoBroll[]
  created_at: string
  updated_at: string
}

export type VideoMediaRoot = {
  id: string
  name: string
  path: string
  /** 工程目录 */
  builtin: boolean
  available: boolean
  /** 不可用的原因 */
  reason?: string
  created_at?: string
}

export type VideoMediaFile = {
  name: string
  /** 相对素材目录 */
  path: string
  kind: 'image' | 'video'
  size: number
  modified_at: string
  width?: number
  height?: number
  /** 视频时长（秒） */
  duration?: number
  /** 能取缩略图 */
  thumb: boolean
}

export type VideoMediaListing = {
  root: VideoMediaRoot
  dir: string
  parent?: string
  dirs: { name: string; path: string }[]
  files: VideoMediaFile[]
  /** 搜索走的目录项太多，没搜完 */
  truncated: boolean
  /** 本机有没有 ffprobe、ffmpeg（且确认过 process:spawn） */
  tools: { probe: boolean; thumbs: boolean }
}

export type VideoMediaQuery = { root: string; videoId: string; dir: string; type: '' | 'image' | 'video'; q: string; page: number; pageSize?: number }

export type GenerateShotsResult = {
  shots: VideoShot[]
  added: number
  source: { artifact_id: string; kind: 'script' | 'outline'; variant: string; version: number }
}

export const storyboardKeys = {
  shots: (videoId: string) => ['video', 'storyboard', 'shots', videoId] as const,
  roots: (videoId: string) => ['video', 'storyboard', 'roots', videoId] as const,
  rootsAll: ['video', 'storyboard', 'roots'] as const,
  browse: (q: VideoMediaQuery) => ['video', 'storyboard', 'browse', q] as const,
}

const base = '/api/video'
const enc = encodeURIComponent

const mediaQS = (root: string, videoId: string, path: string) => new URLSearchParams({ root, ...(root === 'project' ? { video_id: videoId } : {}), path })

/** 原图、视频（支持 Range）的地址，给 img、video 的 src 用 */
export const mediaFileUrl = (root: string, videoId: string, path: string) => `${apiBase()}${base}/media/file?${mediaQS(root, videoId, path)}`
/** 缩略图地址 */
export const mediaThumbUrl = (root: string, videoId: string, path: string) => `${apiBase()}${base}/media/thumb?${mediaQS(root, videoId, path)}`

export const storyboardApi = {
  shots: (videoId: string, signal?: AbortSignal) => request<VideoShot[]>('GET', `${base}/videos/${enc(videoId)}/shots`, { signal }),
  addShot: (videoId: string, body: { text?: string; visual?: string; duration?: number | null; position?: number }) =>
    request<VideoShot[]>('POST', `${base}/videos/${enc(videoId)}/shots`, { body }),
  patchShot: (id: string, body: { text?: string; visual?: string; duration?: number | null }) =>
    request<VideoShot[]>('PATCH', `${base}/shots/${enc(id)}`, { body }),
  removeShot: (id: string) => request<VideoShot[]>('DELETE', `${base}/shots/${enc(id)}`),
  reorderShots: (videoId: string, ids: string[]) => request<VideoShot[]>('POST', `${base}/videos/${enc(videoId)}/shots/reorder`, { body: { ids } }),
  /** 已有分镜时 mode 必填，不填 409 */
  generate: (videoId: string, body: { mode?: 'append' | 'replace'; source?: 'script' | 'outline'; variant?: string }) =>
    request<GenerateShotsResult>('POST', `${base}/videos/${enc(videoId)}/shots/generate`, { body }),
  addBrolls: (shotId: string, items: { root_id: string; path: string }[], position?: number) =>
    request<VideoShot[]>('POST', `${base}/shots/${enc(shotId)}/brolls`, { body: { items, ...(position ? { position } : {}) } }),
  reorderBrolls: (shotId: string, ids: string[]) => request<VideoShot[]>('POST', `${base}/shots/${enc(shotId)}/brolls/reorder`, { body: { ids } }),
  patchBroll: (id: string, body: { note?: string; in?: number | null; out?: number | null; shot_id?: string }) =>
    request<VideoShot[]>('PATCH', `${base}/brolls/${enc(id)}`, { body }),
  removeBroll: (id: string) => request<VideoShot[]>('DELETE', `${base}/brolls/${enc(id)}`),

  roots: (videoId: string, signal?: AbortSignal) =>
    request<VideoMediaRoot[]>('GET', `${base}/media/roots`, { query: new URLSearchParams(videoId ? { video_id: videoId } : {}), signal }),
  addRoot: (body: { path: string; name?: string }) => request<VideoMediaRoot>('POST', `${base}/media/roots`, { body }),
  renameRoot: (id: string, name: string) => request<VideoMediaRoot>('PATCH', `${base}/media/roots/${enc(id)}`, { body: { name } }),
  removeRoot: (id: string) => request<null>('DELETE', `${base}/media/roots/${enc(id)}`),
  browse: async (q: VideoMediaQuery, signal?: AbortSignal) => {
    const qs = new URLSearchParams({ root: q.root, page: String(q.page), page_size: String(q.pageSize ?? 60) })
    if (q.root === 'project') qs.set('video_id', q.videoId)
    if (q.dir) qs.set('dir', q.dir)
    if (q.type) qs.set('type', q.type)
    if (q.q.trim()) qs.set('q', q.q.trim())
    const r = await requestEnvelope<VideoMediaListing>('GET', `${base}/media/browse`, { query: qs, signal })
    return { ...r.data, total: Number(r.meta?.total ?? r.data.files.length) }
  },
}

/** 一集的分镜 */
export function useShots(videoId: string) {
  return useQuery({ queryKey: storyboardKeys.shots(videoId), queryFn: ({ signal }) => storyboardApi.shots(videoId, signal) })
}

/** 分镜的写操作：回来的整份分镜换进缓存 */
function useShotsWrite<A>(videoId: string, fn: (a: A) => Promise<VideoShot[]>) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSuccess: (xs) => { qc.setQueryData(storyboardKeys.shots(videoId), xs) },
  })
}

export function useAddShot(videoId: string) {
  return useShotsWrite(videoId, (b: Parameters<typeof storyboardApi.addShot>[1]) => storyboardApi.addShot(videoId, b))
}
export function usePatchShot(videoId: string) {
  return useShotsWrite(videoId, ({ id, ...b }: { id: string } & Parameters<typeof storyboardApi.patchShot>[1]) => storyboardApi.patchShot(id, b))
}
export function useRemoveShot(videoId: string) {
  return useShotsWrite(videoId, (id: string) => storyboardApi.removeShot(id))
}
export function useReorderShots(videoId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (ids: string[]) => storyboardApi.reorderShots(videoId, ids),
    // 先按新顺序换进缓存，拖完不跳回去；失败时重新读
    onMutate: (ids) => {
      const key = storyboardKeys.shots(videoId)
      const prev = qc.getQueryData<VideoShot[]>(key)
      if (prev) qc.setQueryData(key, ids.map((id, i) => ({ ...prev.find((s) => s.id === id)!, no: i + 1 })).filter((s) => s.id))
    },
    onSuccess: (xs) => { qc.setQueryData(storyboardKeys.shots(videoId), xs) },
    onError: () => qc.invalidateQueries({ queryKey: storyboardKeys.shots(videoId) }),
  })
}
export function useGenerateShots(videoId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (b: Parameters<typeof storyboardApi.generate>[1]) => storyboardApi.generate(videoId, b),
    onSuccess: (r) => { qc.setQueryData(storyboardKeys.shots(videoId), r.shots) },
  })
}
export function useAddBrolls(videoId: string) {
  return useShotsWrite(videoId, ({ shotId, items, position }: { shotId: string; items: { root_id: string; path: string }[]; position?: number }) =>
    storyboardApi.addBrolls(shotId, items, position))
}
export function useReorderBrolls(videoId: string) {
  return useShotsWrite(videoId, ({ shotId, ids }: { shotId: string; ids: string[] }) => storyboardApi.reorderBrolls(shotId, ids))
}
export function usePatchBroll(videoId: string) {
  return useShotsWrite(videoId, ({ id, ...b }: { id: string } & Parameters<typeof storyboardApi.patchBroll>[1]) => storyboardApi.patchBroll(id, b))
}
export function useRemoveBroll(videoId: string) {
  return useShotsWrite(videoId, (id: string) => storyboardApi.removeBroll(id))
}

/** 素材目录：带 video_id 时第一个是这一集的工程目录 */
export function useMediaRoots(videoId: string) {
  return useQuery({ queryKey: storyboardKeys.roots(videoId), queryFn: ({ signal }) => storyboardApi.roots(videoId, signal) })
}

/** 素材目录登记、改名、移除后刷素材目录和分镜（缺失标记跟着变） */
function useRootsWrite<A, R>(fn: (a: A) => Promise<R>) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSuccess: () => Promise.all([
      qc.invalidateQueries({ queryKey: storyboardKeys.rootsAll }),
      qc.invalidateQueries({ queryKey: ['video', 'storyboard', 'shots'] }),
    ]),
  })
}
export const useAddMediaRoot = () => useRootsWrite(storyboardApi.addRoot)
export const useRenameMediaRoot = () => useRootsWrite(({ id, name }: { id: string; name: string }) => storyboardApi.renameRoot(id, name))
export const useRemoveMediaRoot = () => useRootsWrite(storyboardApi.removeRoot)

/** 浏览一页；root 为空时不取 */
export function useMediaBrowse(q: VideoMediaQuery | null) {
  return useQuery({
    queryKey: storyboardKeys.browse(q ?? { root: '', videoId: '', dir: '', type: '', q: '', page: 1 }),
    queryFn: ({ signal }) => storyboardApi.browse(q!, signal),
    enabled: !!q?.root,
    placeholderData: keepPreviousData,
    retry: false,
  })
}
