// 产出物的读写（DEV-08b 起，CORE-03a 迁进数据访问层）：某个对象的产出物、统计、手工登记。
// 登记后报 { kind: 'artifact' }，列表和统计（删除确认里的产出物数）一起刷新。
import { useMutation, useQuery } from '@tanstack/react-query'
import { artifacts, type ArtifactInput, type ArtifactListParams } from '../api'
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
