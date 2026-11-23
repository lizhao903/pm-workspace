// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 产出物的读写（DEV-08b 起，CORE-03a 迁进数据访问层）：某个对象的产出物、统计、手工登记。
// 登记后报 { kind: 'artifact' }，列表和统计（删除确认里的产出物数）一起刷新。
import { useMutation, useQuery } from '@tanstack/react-query'
import { artifacts, type ArtifactInput, type ArtifactListParams } from '../api'
import { apiBase } from '../api/client'
import { useNotifyChange } from './invalidate'
import { dataKeys } from './keys'

// 一个对象的产出物一般不多，取后端单页上限，不分页
const LIMIT = 500

/** 一页产出物；最近登记的在前（后端排序） */
export function useArtifacts(filter: ArtifactListParams, opts: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: dataKeys.artifacts.list(filter),
    queryFn: ({ signal }) => artifacts.list(filter, signal),
    enabled: opts.enabled,
  })
}

/** 某个对象的全部产出物 */
export const useObjectArtifacts = (objectId: string) => useArtifacts({ object_id: objectId, limit: LIMIT })

/** 产出物统计；同一套过滤参数 */
export function useArtifactStats(filter: ArtifactListParams, opts: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: dataKeys.artifacts.stats(filter),
    queryFn: () => artifacts.stats(filter),
    enabled: opts.enabled,
  })
}

/**
 * 按对象汇总的产出（TSK-0497）：任务列表每行的产出数、任务模块「产出物」视图。一次拿全，不分页；
 * 同一套过滤，kind 按 display_kind 比。登记、执行结束都报 artifact 变化，跟着 artifacts.all 一起刷新
 */
export function useArtifactsByObject(filter: ArtifactListParams, opts: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: dataKeys.artifacts.byObject(filter),
    queryFn: ({ signal }) => artifacts.byObject(filter, signal),
    enabled: opts.enabled,
  })
}

/** 删除确认里列的产出物数；null 不查 */
export function useArtifactCount(objectId: string | null) {
  const filter = { object_id: objectId ?? '' }
  return useQuery({
    queryKey: dataKeys.artifacts.stats(filter),
    queryFn: () => artifacts.stats(filter),
    enabled: !!objectId,
    select: (s) => s.total,
  })
}

// 界面登记：来源由后端按 X-Actor-Source: ui 记成 manual
export function useRecordArtifact(objectId: string) {
  const notify = useNotifyChange()
  return useMutation({
    mutationFn: (input: Omit<ArtifactInput, 'object_id'>) => artifacts.create({ ...input, object_id: objectId }),
    onSuccess: () => notify({ kind: 'artifact', objectId }),
  })
}

// --- 查看（DEV-08b 补，docs/api-contract.md「查看产出物」）：按产出物 id 读，不传路径；403、404、409 都不重试 ---

/** 读产出物登记的本机文件；null 不读 */
export function useArtifactFile(id: string | null) {
  return useQuery({
    queryKey: dataKeys.artifacts.file(id ?? ''),
    queryFn: ({ signal }) => artifacts.file(id ?? '', signal),
    enabled: !!id,
    retry: false,
  })
}

/** 提交的说明、改动文件、diff；分支产出物给 sha 看分支上的某个提交。id 为 null 不读 */
export function useArtifactCommit(id: string | null, sha?: string) {
  return useQuery({
    queryKey: dataKeys.artifacts.commit(id ?? '', sha),
    queryFn: ({ signal }) => artifacts.commit(id ?? '', sha, signal),
    enabled: !!id,
    retry: false,
  })
}

/** 分支相对主分支的提交和改动文件；null 不读 */
export function useArtifactBranch(id: string | null) {
  return useQuery({
    queryKey: dataKeys.artifacts.branch(id ?? ''),
    queryFn: ({ signal }) => artifacts.branch(id ?? '', signal),
    enabled: !!id,
    retry: false,
  })
}

/** 用本机默认应用打开产出物的文件，reveal 为 true 时在访达中显示 */
export function useOpenArtifact() {
  return useMutation({ mutationFn: ({ id, reveal }: { id: string; reveal?: boolean }) => artifacts.open(id, reveal) })
}

/** 原样读产出物文件的地址（图片、PDF、HTML 给 img、iframe 用） */
export const artifactRawUrl = (id: string) => `${apiBase()}/api/artifacts/${encodeURIComponent(id)}/raw`
