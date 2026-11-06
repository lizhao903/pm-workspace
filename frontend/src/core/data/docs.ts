// 文档页的数据（DOC-01b）：分类树、标签、挂载的本地目录和目录里的文件、读文件，以及文档星标。
// 契约见 docs/api-contract.md「分类 categories」「标签 tags」「文件读取和挂载目录」。
// 文档本身是 type=doc 的对象，列表走 objects.ts 的 useAllObjects；星标改的是对象，报 { kind: 'object' }。
// 挂载、移除目录报 { kind: 'local-dir' }，刷新挂载列表、文件清单和读过的文件。
// 文件清单分页（「全部文档」）：一页页拉到 next_cursor 为空，拉一页显示一页，合起来是全量。
import { keepPreviousData, useInfiniteQuery, useMutation, useQuery } from '@tanstack/react-query'
import { useEffect, useMemo } from 'react'
import { objects, request, requestList, type WorkObject } from '../api'
import { apiBase } from '../api/client'
import { useNotifyChange } from './invalidate'
import { dataKeys } from './keys'

export type Category = {
  id: string
  type_id: string
  parent_id: string | null
  name: string
  slug: string
  /** 形如 /prd/sub/ */
  path: string
  depth: number
  color: string
  description: string
  sort_order: number
  created_at: string
  updated_at: string
  /** counts=true 时才有：直接挂在这个分类下的对象数，以及含子分类的总数（都不含归档和回收站） */
  count: number
  total_count: number
  children?: Category[]
}

export type TagInfo = { id: string; name: string; color: string; count: number; created_at: string }

export type LocalDir = { id: string; path: string; name: string; position: number; created_at: string; updated_at: string }

/** 文件种类：text 直接读正文，pdf、image 原样预览（/api/fs/raw），office 不预览、给「用本机应用打开」 */
export type LocalFileKind = 'text' | 'pdf' | 'image' | 'office'

export type LocalFileEntry = {
  /** 相对挂载目录，分隔符 / */
  rel: string
  /** 绝对路径，读内容用它 */
  path: string
  name: string
  ext: string
  /** 老后端没有这个字段，按文本处理 */
  kind?: LocalFileKind
  size: number
  modified: string
}

/** 截断原因：visited 是目录太大（走查项数到上限），depth 是有子目录太深没往下走 */
export type LocalListReason = 'visited' | 'depth' | ''

/**
 * 文件清单。接口回的是一页；useLocalDirFiles 把各页合起来：skipped 累加，truncated 任一页触到保护就为 true，
 * loading 为 true 表示后面还有页在拉。
 */
export type LocalFileList = {
  path: string
  files: LocalFileEntry[]
  skipped: number
  truncated: boolean
  reason?: LocalListReason
  next_cursor?: string
  /** 累计走查的项数（文件、目录都算） */
  visited?: number
  loading?: boolean
}

export type LocalFile = {
  path: string
  name: string
  ext: string
  size: number
  modified: string
  /** 二进制只给元信息，content 为空串 */
  binary: boolean
  /** 超过 limit 只给开头 */
  truncated: boolean
  limit: number
  content: string
}

const dirPath = (id: string) => `/api/local-dirs/${encodeURIComponent(id)}`

export const docsApi = {
  categoryTree: (type: string, signal?: AbortSignal) =>
    requestList<Category>('/api/categories', { query: new URLSearchParams({ type, tree: 'true', counts: 'true' }), signal }).then((r) => r.data),
  tags: (signal?: AbortSignal) => requestList<TagInfo>('/api/tags', { signal }).then((r) => r.data),
  localDirs: (signal?: AbortSignal) => requestList<LocalDir>('/api/local-dirs', { signal }).then((r) => r.data),
  mount: (body: { path: string; name?: string }) => request<LocalDir>('POST', '/api/local-dirs', { body }),
  unmount: (id: string) => request<null>('DELETE', dirPath(id)),
  /** 一页文件清单；cursor 是上一页的 next_cursor，不给从头列 */
  files: (id: string, cursor = '', signal?: AbortSignal, limit?: number) => {
    const query = new URLSearchParams()
    if (cursor) query.set('cursor', cursor)
    if (limit) query.set('limit', String(limit))
    return request<LocalFileList>('GET', `${dirPath(id)}/files`, { query, signal })
  },
  read: (path: string, signal?: AbortSignal) => request<LocalFile>('GET', '/api/fs/read', { query: new URLSearchParams({ path }), signal }),
  /** 用本机默认应用打开，reveal 为 true 时在访达中显示 */
  open: (body: { path: string; reveal?: boolean }) => request<{ path: string; reveal: boolean }>('POST', '/api/fs/open', { body }),
}

/** 原样读文件的地址（PDF、图片预览用，给 iframe、img 的 src），边界同 /api/fs/read */
export const localRawUrl = (path: string) => `${apiBase()}/api/fs/raw?${new URLSearchParams({ path })}`

/** 把各页清单合成一份 */
export function mergeFilePages(pages: LocalFileList[], more: boolean): LocalFileList | undefined {
  if (!pages.length) return undefined
  const last = pages[pages.length - 1]
  const truncated = pages.some((p) => p.truncated)
  // visited（目录太大）比 depth 要紧，有就报它
  const reason: LocalListReason = pages.some((p) => p.reason === 'visited') ? 'visited' : (pages.find((p) => p.reason)?.reason ?? '')
  return {
    path: pages[0].path,
    files: pages.length === 1 ? pages[0].files : pages.flatMap((p) => p.files),
    skipped: pages.reduce((n, p) => n + (p.skipped ?? 0), 0),
    truncated, reason, visited: last.visited, next_cursor: last.next_cursor, loading: more,
  }
}

/** 某类对象的分类树，带数量 */
export function useCategoryTree(type: string) {
  return useQuery({ queryKey: dataKeys.categories.tree(type), queryFn: ({ signal }) => docsApi.categoryTree(type, signal) })
}

/** 全部标签（全局，不分类型），count 是所有对象上的引用数 */
export function useTags() {
  return useQuery({ queryKey: dataKeys.tags.list, queryFn: ({ signal }) => docsApi.tags(signal) })
}

/** 挂载的本地目录，按 position */
export function useLocalDirs() {
  return useQuery({ queryKey: dataKeys.localDirs.list, queryFn: ({ signal }) => docsApi.localDirs(signal) })
}

/**
 * 挂载目录下认得的文件（文本、PDF、图片、Office 等）全量清单；null 不查。目录被删了回 404，不重试。
 * 第一页到了就有 data，后面的页自动接着拉（data.loading 为 true 时还没拉完），合起来是全量。
 */
export function useLocalDirFiles(id: string | null) {
  const q = useInfiniteQuery({
    queryKey: dataKeys.localDirs.files(id ?? ''),
    queryFn: ({ signal, pageParam }) => docsApi.files(id ?? '', pageParam, signal),
    initialPageParam: '',
    getNextPageParam: (last: LocalFileList) => last.next_cursor || undefined,
    enabled: !!id,
    retry: false,
  })
  const { hasNextPage, isFetchingNextPage, isError, fetchNextPage } = q
  // 页数也放进依赖：一页拉完时「正在拉下一页」可能没在某次渲染里露出来，只看它会停在半路
  const loaded = q.data?.pages.length ?? 0
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage && !isError) void fetchNextPage({ cancelRefetch: false })
  }, [hasNextPage, isFetchingNextPage, isError, fetchNextPage, loaded])
  const data = useMemo(() => (q.data ? mergeFilePages(q.data.pages, !!hasNextPage) : undefined), [q.data, hasNextPage])
  return {
    data, isError: q.isError && !data, error: q.error, isFetching: q.isFetching, dataUpdatedAt: q.dataUpdatedAt,
    refetch: q.refetch,
    /** 后面的页拉失败了（前面的页还在） */
    pageError: q.isError && !!data ? q.error : null,
    retryPage: () => void fetchNextPage(),
  }
}

/**
 * 项目设置里的文档目录下的文件（TSK-0718，GET /api/objects/{id}/docs-dir/files）；dir 为空不查。
 * dir、root 只用来区分缓存（改了设置换一份），解析在后端。没设、越界、不存在回错误，不重试；分页同 useLocalDirFiles
 */
export function useProjectDocFiles(projectId: string, dir: string, root: string) {
  const q = useInfiniteQuery({
    queryKey: dataKeys.localDirs.projectDocs(projectId, dir, root),
    queryFn: ({ signal, pageParam }) => {
      const query = new URLSearchParams()
      if (pageParam) query.set('cursor', pageParam)
      return request<LocalFileList>('GET', `/api/objects/${encodeURIComponent(projectId)}/docs-dir/files`, { query, signal })
    },
    initialPageParam: '',
    getNextPageParam: (last: LocalFileList) => last.next_cursor || undefined,
    enabled: !!dir,
    retry: false,
  })
  const { hasNextPage, isFetchingNextPage, isError, fetchNextPage } = q
  const loaded = q.data?.pages.length ?? 0
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage && !isError) void fetchNextPage({ cancelRefetch: false })
  }, [hasNextPage, isFetchingNextPage, isError, fetchNextPage, loaded])
  const data = useMemo(() => (q.data ? mergeFilePages(q.data.pages, !!hasNextPage) : undefined), [q.data, hasNextPage])
  return { data, isError: q.isError && !data, error: q.error, isPending: !!dir && q.isPending, refetch: q.refetch, isFetching: q.isFetching }
}

/** 用本机应用打开、在访达中显示 */
export function useOpenLocalFile() {
  return useMutation({ mutationFn: docsApi.open })
}

/** 读一个挂载目录里的文件；null 不读。403（不在挂载目录、隐藏项）和 404 都不重试 */
export function useLocalFile(path: string | null) {
  return useQuery({
    queryKey: dataKeys.localDirs.read(path ?? ''),
    queryFn: ({ signal }) => docsApi.read(path ?? '', signal),
    enabled: !!path,
    retry: false,
    placeholderData: keepPreviousData,
  })
}

export function useMountLocalDir() {
  const notify = useNotifyChange()
  return useMutation({ mutationFn: docsApi.mount, onSuccess: () => notify({ kind: 'local-dir' }) })
}

/** 移除挂载：只删记录，不动磁盘 */
export function useUnmountLocalDir() {
  const notify = useNotifyChange()
  return useMutation({ mutationFn: docsApi.unmount, onSuccess: () => notify({ kind: 'local-dir' }) })
}

/** 文档星标存在对象的 props 里（后端没有单独的字段），值为 true */
export const PROP_STARRED = 'starred'

export const isStarred = (o: Pick<WorkObject, 'props'>) => o.props?.[PROP_STARRED] === true

/** 切换星标：先读回最新的 props 再改这一个 key，别的 key 原样留着 */
export async function setStarred(id: string, on: boolean): Promise<WorkObject> {
  const fresh = await objects.get(id)
  const props: Record<string, unknown> = { ...(fresh.props ?? {}) }
  if (on) props[PROP_STARRED] = true
  else delete props[PROP_STARRED]
  return objects.patch(id, { props })
}

export function useSetStarred() {
  const notify = useNotifyChange()
  return useMutation({
    mutationFn: ({ id, on }: { id: string; on: boolean }) => setStarred(id, on),
    onSuccess: (_, v) => notify({ kind: 'object', id: v.id }),
  })
}
