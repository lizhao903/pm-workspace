// 知识库（AG-01b7）：契约见 docs/api-contract.md「知识库 knowledge-bases」（AG-01b3）。
// 知识库、文档、来源分类里还没收进来的篇目、检索都在 ['knowledge-bases'] 前缀下，增删改一律报 { kind: 'knowledge-base' }：
// 加文档、重新索引、同步都会改知识库上的篇数和状态，整个前缀一起刷最省事。
// 「挂了这个知识库的 Agent」要头像、说明、启停，Agent 列表也在这个前缀下取一份。
import { useMutation, useQueries, useQuery } from '@tanstack/react-query'
import { request, requestList } from '../api'
import { useNotifyChange } from './invalidate'
import { dataKeys } from './keys'

export type KbDocSource = 'library' | 'dir' | 'upload' | 'link' | 'note'
export type KbDocStatus = 'indexed' | 'pending' | 'failed'

export type KbDir = {
  path: string
  auto_sync: boolean
  synced_at?: string
  /** 从这个目录收进来的篇数 */
  files: number
}

export type KbEmbed = { provider_id: string; model: string }

export type KbSettings = {
  auto_sync: boolean
  dirs: KbDir[]
  /** 200、300、500、800、1200 */
  chunk_size: number
  /** 0、30、50、100，不超过段长一半 */
  overlap: number
  /** 检索返回几段 */
  top: number
  /** 只存不用：后端只做关键词检索 */
  embed: KbEmbed
}

export type KbCounts = {
  docs: number
  indexed: number
  pending: number
  failed: number
  excluded: number
  /** 已索引且没排除的篇数和段数 */
  searchable: number
  chunks: number
  last_doc_at: string | null
}

export type KnowledgeBase = {
  id: string
  name: string
  desc: string
  /** 文档分类 id（categories 里 type_id 为 doc 的） */
  sources: string[]
  settings: KbSettings
  counts: KbCounts
  /** 挂着它的 Agent，新建的在前 */
  agents: { id: string; name: string }[]
  created_at: string
  updated_at: string
}

export type KbDoc = {
  id: string
  kb_id: string
  title: string
  /** ref：工作台文档的对象 id、目录里的文件路径、上传的文件名、网址；笔记没有 */
  source: { type: KbDocSource; ref?: string }
  text: string
  /** 上次索引切出的段数 */
  chunks: number
  status: KbDocStatus
  excluded: boolean
  error?: string
  created_at: string
  updated_at: string
}

/** 加文档；dir 不能直接加，目录里的文件由挂目录和同步收进来 */
export type KbAddInput =
  | { type: 'library'; ref?: string; refs?: string[] }
  | { type: 'upload'; ref: string; data: string; title?: string }
  | { type: 'link'; ref: string; title?: string; text?: string }
  | { type: 'note'; title: string; text: string }

export type KbSettingsInput = Partial<Omit<KbSettings, 'dirs'>> & { dirs?: { path: string; auto_sync: boolean }[] }
export type KbInput = { name: string; desc?: string; sources?: string[]; settings?: KbSettingsInput }
export type KbPatch = { name?: string; desc?: string; sources?: string[]; settings?: KbSettingsInput }
export type KbDocPatch = { excluded?: boolean; title?: string; text?: string }

/** 来源分类里还没收进来的工作台文档 */
export type KbMissing = { id: string; ref: string; title: string; category_id: string | null }

export type KbSyncResult = {
  added: number
  updated: number
  removed: number
  unchanged: number
  failed: number
  /** 同步不了的目录 -> 原因 */
  errors: Record<string, string> | null
}

export type KbHit = {
  kb_id: string
  doc_id: string
  title: string
  source: KbDoc['source']
  /** 从 0 起 */
  index: number
  /** 正文里的字符位置（按码点） */
  start: number
  end: number
  text: string
  score: number
  /** 这段命中的词 */
  terms: string[]
}

export type KbSearchResult = { terms: string[]; hits: KbHit[]; scope: { searchable: number; skipped: number } }

/** 挂知识库的 Agent：设置标签里要头像、说明和启停 */
export type KbAgent = { id: string; name: string; desc: string; color: string; avatar: { kind: string; value: string }; enabled: boolean }

const base = '/api/knowledge-bases'
const one = (id: string) => `${base}/${encodeURIComponent(id)}`

export const knowledgeBasesApi = {
  list: async (signal?: AbortSignal) => (await requestList<KnowledgeBase>(base, { signal })).data,
  create: (body: KbInput) => request<KnowledgeBase>('POST', base, { body }),
  patch: (id: string, body: KbPatch) => request<KnowledgeBase>('PATCH', one(id), { body }),
  remove: (id: string) => request<KnowledgeBase>('DELETE', one(id)),
  docs: async (id: string, signal?: AbortSignal) => (await requestList<KbDoc>(`${one(id)}/docs`, { signal })).data,
  addDocs: (id: string, body: KbAddInput) => request<KbDoc[]>('POST', `${one(id)}/docs`, { body }),
  patchDoc: (id: string, docId: string, body: KbDocPatch) => request<KbDoc>('PATCH', `${one(id)}/docs/${encodeURIComponent(docId)}`, { body }),
  removeDoc: (id: string, docId: string) => request<KbDoc>('DELETE', `${one(id)}/docs/${encodeURIComponent(docId)}`),
  missing: async (id: string, signal?: AbortSignal) => (await requestList<KbMissing>(`${one(id)}/missing`, { signal })).data,
  reindex: (id: string, docIds?: string[]) => request<KbDoc[]>('POST', `${one(id)}/reindex`, { body: docIds ? { doc_ids: docIds } : {} }),
  sync: (id: string, path?: string) =>
    request<{ result: KbSyncResult; knowledge_base: KnowledgeBase }>('POST', `${one(id)}/sync`, { body: path ? { path } : {} }),
  search: (id: string, q: string, signal?: AbortSignal) => request<KbSearchResult>('POST', `${one(id)}/search`, { body: { q }, signal }),
  agents: async (signal?: AbortSignal) => (await requestList<KbAgent>('/api/agents', { signal })).data,
}

/** 全部知识库，新建的在前 */
export function useKnowledgeBases() {
  return useQuery({ queryKey: dataKeys.knowledgeBases.list, queryFn: ({ signal }) => knowledgeBasesApi.list(signal) })
}

/** 一个知识库里的文档，新加的在前，带正文 */
export function useKbDocs(id: string | undefined) {
  return useQuery({
    queryKey: dataKeys.knowledgeBases.docs(id ?? ''),
    queryFn: ({ signal }) => knowledgeBasesApi.docs(id!, signal),
    enabled: !!id,
  })
}

/** 几个知识库的文档一起取（列表页按文档标题搜时才取）；返回 知识库 id -> 文档 */
export function useKbDocsOf(ids: readonly string[], enabled: boolean): Record<string, KbDoc[] | undefined> {
  const qs = useQueries({
    queries: ids.map((id) => ({
      queryKey: dataKeys.knowledgeBases.docs(id),
      queryFn: ({ signal }: { signal: AbortSignal }) => knowledgeBasesApi.docs(id, signal),
      enabled,
    })),
  })
  return Object.fromEntries(ids.map((id, i) => [id, qs[i]?.data]))
}

/** 来源分类里还没收进来的篇目；自动同步关着时不取 */
export function useKbMissing(id: string, enabled: boolean) {
  return useQuery({ queryKey: dataKeys.knowledgeBases.missing(id), queryFn: ({ signal }) => knowledgeBasesApi.missing(id, signal), enabled })
}

/** 检索测试：q 为空不发 */
export function useKbSearch(id: string, q: string) {
  return useQuery({
    queryKey: dataKeys.knowledgeBases.search(id, q),
    queryFn: ({ signal }) => knowledgeBasesApi.search(id, q, signal),
    enabled: !!q.trim(),
    retry: false,
  })
}

/** Agent 列表（头像、说明、启停） */
export function useKbAgents() {
  return useQuery({ queryKey: dataKeys.knowledgeBases.agents, queryFn: ({ signal }) => knowledgeBasesApi.agents(signal) })
}

function useKbMutation<V, R>(fn: (v: V) => Promise<R>) {
  const notify = useNotifyChange()
  return useMutation({ mutationFn: fn, onSettled: () => notify({ kind: 'knowledge-base' }) })
}

export const useCreateKb = () => useKbMutation((body: KbInput) => knowledgeBasesApi.create(body))
export const usePatchKb = () => useKbMutation(({ id, patch }: { id: string; patch: KbPatch }) => knowledgeBasesApi.patch(id, patch))
export const useDeleteKb = () => useKbMutation((id: string) => knowledgeBasesApi.remove(id))
export const useAddKbDocs = () => useKbMutation(({ id, input }: { id: string; input: KbAddInput }) => knowledgeBasesApi.addDocs(id, input))
export const usePatchKbDoc = () =>
  useKbMutation(({ id, docId, patch }: { id: string; docId: string; patch: KbDocPatch }) => knowledgeBasesApi.patchDoc(id, docId, patch))
export const useRemoveKbDoc = () => useKbMutation(({ id, docId }: { id: string; docId: string }) => knowledgeBasesApi.removeDoc(id, docId))
export const useReindexKb = () => useKbMutation(({ id, docIds }: { id: string; docIds?: string[] }) => knowledgeBasesApi.reindex(id, docIds))
export const useSyncKb = () => useKbMutation(({ id, path }: { id: string; path?: string }) => knowledgeBasesApi.sync(id, path))
