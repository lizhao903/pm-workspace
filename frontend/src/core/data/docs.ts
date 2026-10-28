// 文档页的数据（DOC-01b）：分类树、标签、挂载的本地目录和目录里的文件、读文件，以及文档星标。
// 契约见 docs/api-contract.md「分类 categories」「标签 tags」「文件读取和挂载目录」。
// 文档本身是 type=doc 的对象，列表走 objects.ts 的 useAllObjects；星标改的是对象，报 { kind: 'object' }。
// 挂载、移除目录报 { kind: 'local-dir' }，刷新挂载列表、文件清单和读过的文件。
import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query'
import { objects, request, requestList, type WorkObject } from '../api'
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

export type LocalFileEntry = {
  /** 相对挂载目录，分隔符 / */
  rel: string
  /** 绝对路径，读内容用它 */
  path: string
  name: string
  ext: string
  size: number
  modified: string
}

export type LocalFileList = { path: string; files: LocalFileEntry[]; skipped: number; truncated: boolean }

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
  files: (id: string, signal?: AbortSignal) => request<LocalFileList>('GET', `${dirPath(id)}/files`, { signal }),
  read: (path: string, signal?: AbortSignal) => request<LocalFile>('GET', '/api/fs/read', { query: new URLSearchParams({ path }), signal }),
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

/** 挂载目录下的文本文件清单；null 不查。目录被删了回 404，不重试 */
export function useLocalDirFiles(id: string | null) {
  return useQuery({
    queryKey: dataKeys.localDirs.files(id ?? ''),
    queryFn: ({ signal }) => docsApi.files(id ?? '', signal),
    enabled: !!id,
    retry: false,
  })
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
