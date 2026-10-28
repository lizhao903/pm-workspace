// 任务抽屉用的请求和查询（DEV-07b）：单个任务、干系人候选、工作目录校验和选目录，以及新建、编辑、删除、改状态。
// 写操作成功后按 objects / counts 前缀失效缓存，列表和计数一起刷新。
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { request } from './client'
import { artifacts, fs, objects, stakeholders } from './resources'
import type { ObjectCreateInput, ObjectPatch, WorkObject } from './types'

// POST /api/agent/workdir/check 的结果；不可用也是 200，看字段，message 说明原因
export type WorkdirCheck = { path: string; exists: boolean; is_dir: boolean; writable: boolean; message: string }

export const agentWorkdir = {
  check: (path: string, signal?: AbortSignal) =>
    request<WorkdirCheck>('POST', '/api/agent/workdir/check', { body: { path }, signal }),
}

/** 目录能不能用作工作目录：存在、是目录、可写 */
export const workdirUsable = (c: WorkdirCheck) => c.exists && c.is_dir && c.writable

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

export const taskEditKeys = {
  object: (id: string) => ['objects', 'get', id] as const,
  stakeholders: ['stakeholders', 'list'] as const,
  workdir: (path: string) => ['agent', 'workdir', path] as const,
  browse: (path: string) => ['fs', 'browse', path] as const,
  shortcuts: ['fs', 'shortcuts'] as const,
  artifactStats: (id: string) => ['artifacts', 'stats', id] as const,
}

// 单个对象，抽屉打开期间用来发现「已经被删了」
export function useObject(id: string | null) {
  return useQuery({
    queryKey: taskEditKeys.object(id ?? ''),
    queryFn: () => objects.get(id ?? ''),
    enabled: !!id,
    retry: false,
  })
}

// 负责人、参与人的候选：干系人名册里在岗的
export function useStakeholders() {
  return useQuery({ queryKey: taskEditKeys.stakeholders, queryFn: () => stakeholders.list() })
}

// 工作目录即时校验；空路径不查
export function useWorkdirCheck(path: string) {
  const p = path.trim()
  return useQuery({
    queryKey: taskEditKeys.workdir(p),
    queryFn: ({ signal }) => agentWorkdir.check(p, signal),
    enabled: !!p,
    staleTime: 5_000,
  })
}

// 选目录：空路径是后端的默认起点
export function useFsBrowse(path: string, enabled: boolean) {
  return useQuery({
    queryKey: taskEditKeys.browse(path),
    queryFn: () => fs.browse(path || undefined),
    enabled,
    placeholderData: keepPreviousData,
    retry: false,
  })
}

export function useFsShortcuts(enabled: boolean) {
  return useQuery({ queryKey: taskEditKeys.shortcuts, queryFn: fs.shortcuts, enabled })
}

// 删除确认里列的产出物数
export function useArtifactCount(id: string | null) {
  return useQuery({
    queryKey: taskEditKeys.artifactStats(id ?? ''),
    queryFn: () => artifacts.stats({ object_id: id ?? '' }),
    enabled: !!id,
    select: (s) => s.total,
  })
}

function useInvalidate() {
  const qc = useQueryClient()
  return () => Promise.all([
    qc.invalidateQueries({ queryKey: ['objects'] }),
    qc.invalidateQueries({ queryKey: ['counts'] }),
    qc.invalidateQueries({ queryKey: ['stakeholders'] }),
  ])
}

export function useCreateObject() {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: (input: ObjectCreateInput) => objects.create(input),
    onSuccess: () => invalidate(),
  })
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

export function useSaveObject() {
  const invalidate = useInvalidate()
  return useMutation({ mutationFn: saveObject, onSuccess: () => invalidate() })
}

// 软删除进回收站
export function useDeleteObject() {
  const invalidate = useInvalidate()
  return useMutation({ mutationFn: (id: string) => objects.delete(id), onSuccess: () => invalidate() })
}

// 只改状态（列表的完成圆圈）：PATCH 里只有 status
export function useSetStatus() {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) => objects.patch(id, { status }),
    onSuccess: () => invalidate(),
  })
}

// 验收通过：记一条进展并同一事务把状态改为 done（SPEC-tasks-5.22、5.27）
export function useApprove() {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: ({ id, status, comment }: { id: string; status: string; comment?: string }) =>
      objects.appendProgress(id, { kind: 'note', text: comment?.trim() ? `验收通过：${comment.trim()}` : '验收通过', status }),
    onSuccess: () => invalidate(),
  })
}
