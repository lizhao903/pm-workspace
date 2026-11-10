// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 对象的读写（CORE-03a）：列表、单个对象，以及新建、编辑、改状态、删除。
// 写操作成功后报 { kind: 'object' }，按失效规则刷新所有对象列表、计数和干系人。
import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query'
import { objects, type ListResult, type ObjectCreateInput, type ObjectListParams, type ObjectPatch, type WorkObject } from '../api'
import { useNotifyChange } from './invalidate'
import { dataKeys } from './keys'

// 后端单页上限
const MAX_PAGE = 200

export type ObjectFilter = Omit<ObjectListParams, 'limit' | 'offset'>

/** 按页拉完全部匹配的对象。分段、状态条数要在整份数据上算，只拿一页会算错 */
export async function listAllObjects(params: ObjectFilter, signal?: AbortSignal): Promise<ListResult<WorkObject>> {
  const out: WorkObject[] = []
  let total = 0
  for (;;) {
    const page = await objects.list({ ...params, limit: MAX_PAGE, offset: out.length }, signal)
    total = page.total
    out.push(...page.data)
    if (page.data.length === 0 || out.length >= total) break
  }
  return { data: out, total }
}

type ListOpts = {
  enabled?: boolean
  /** 改过滤条件时先留着上一份结果，免得列表闪成加载中 */
  keepPrevious?: boolean
}

/** 一页对象 */
export function useObjects(filter: ObjectListParams, opts: ListOpts = {}) {
  return useQuery({
    queryKey: dataKeys.objects.list(filter),
    queryFn: ({ signal }) => objects.list(filter, signal),
    enabled: opts.enabled,
    placeholderData: opts.keepPrevious ? keepPreviousData : undefined,
  })
}

/** 全部匹配的对象（按页拉完） */
export function useAllObjects(filter: ObjectFilter, opts: ListOpts = {}) {
  return useQuery({
    queryKey: dataKeys.objects.listAll(filter),
    queryFn: ({ signal }) => listAllObjects(filter, signal),
    enabled: opts.enabled,
    placeholderData: opts.keepPrevious ? keepPreviousData : undefined,
  })
}

/** 单个对象；null 不查。不重试，抽屉打开期间用它发现「已经被删了」 */
export function useObject(id: string | null) {
  return useQuery({
    queryKey: dataKeys.objects.detail(id ?? ''),
    queryFn: () => objects.get(id ?? ''),
    enabled: !!id,
    retry: false,
  })
}

/** 开发任务约定的 props key（docs/api-contract.md「props 约定」） */
export const PROP_ACCEPTANCE = 'acceptance'
export const PROP_REPO = 'repo'

/**
 * props 是整体替换：只改其中几个 key 时，把改动合并到读回来的最新 props 上，其它 key 原样留着。
 * 值为空串或 null 表示去掉这个 key。
 */
export function mergeProps(current: Record<string, unknown> | null, edit: Record<string, string | null>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(current ?? {}) }
  for (const [k, v] of Object.entries(edit)) {
    if (v) out[k] = v
    else delete out[k]
  }
  return out
}

export type ObjectSave = {
  id: string
  /** 只放改动的字段，不含 props */
  patch: ObjectPatch
  /** props 里改动的 key；有值时先读回对象再合并，合并结果整体放进 patch.props */
  props?: Record<string, string | null>
}

/** 编辑保存：props 有改动时先读回最新的再合并；什么都没改就不发请求，返回 null */
export async function saveObject({ id, patch, props }: ObjectSave): Promise<WorkObject | null> {
  const body: ObjectPatch = { ...patch }
  if (props && Object.keys(props).length) {
    const fresh = await objects.get(id)
    body.props = mergeProps(fresh.props, props)
  }
  if (!Object.keys(body).length) return null
  return objects.patch(id, body)
}

export function useCreateObject() {
  const notify = useNotifyChange()
  return useMutation({
    mutationFn: (input: ObjectCreateInput) => objects.create(input),
    onSuccess: (o) => notify({ kind: 'object', id: o.id }),
  })
}

/** 编辑保存，见 saveObject */
export function usePatchObject() {
  const notify = useNotifyChange()
  return useMutation({ mutationFn: saveObject, onSuccess: (_, v) => notify({ kind: 'object', id: v.id }) })
}

/** 只改状态（列表的完成圆圈）：PATCH 里只有 status */
export function useSetStatus() {
  const notify = useNotifyChange()
  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) => objects.patch(id, { status }),
    onSuccess: (_, v) => notify({ kind: 'object', id: v.id }),
  })
}

/** 改任务阶段（AUTO-05，props.stage）：PUT /stage，服务端只换这一个键，不冲掉别的 props */
export function useSetStage() {
  const notify = useNotifyChange()
  return useMutation({
    mutationFn: ({ id, stage }: { id: string; stage: string }) => objects.setStage(id, stage),
    onSuccess: (_, v) => notify({ kind: 'object', id: v.id }),
  })
}

/** 软删除进回收站 */
export function useDeleteObject() {
  const notify = useNotifyChange()
  return useMutation({
    mutationFn: (id: string) => objects.delete(id),
    onSuccess: (_, id) => notify({ kind: 'object', id }),
  })
}
