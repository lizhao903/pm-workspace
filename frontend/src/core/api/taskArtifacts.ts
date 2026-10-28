// 任务抽屉的产出物（DEV-08b）：列出某个对象的产出物、手工登记一条。
// 查询键挂在 artifacts 前缀下，登记后按前缀失效，删除确认里的产出物数也一起刷新。
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { artifacts } from './resources'
import type { ArtifactInput } from './types'

// 一个任务的产出物一般不多，取后端单页上限，不分页
const LIMIT = 500

export const taskArtifactKeys = {
  list: (objectId: string) => ['artifacts', 'list', { object_id: objectId }] as const,
}

// 最近登记的在前（后端排序）
export function useTaskArtifacts(objectId: string) {
  return useQuery({
    queryKey: taskArtifactKeys.list(objectId),
    queryFn: ({ signal }) => artifacts.list({ object_id: objectId, limit: LIMIT }, signal),
  })
}

// 界面登记：来源由后端按 X-Actor-Source: ui 记成 manual
export function useRecordArtifact(objectId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: Omit<ArtifactInput, 'object_id'>) => artifacts.create({ ...input, object_id: objectId }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['artifacts'] }),
  })
}
