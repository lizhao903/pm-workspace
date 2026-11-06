// 任务列表页用的查询（DEV-07a 起），建在数据访问层上：缓存键和失效都由 core/data 管，
// 任务在抽屉里改了状态，这里的列表和逾期计数跟着刷新。
import { useMemo } from 'react'
import { useAllObjects, useArtifactsByObject, useCounts, useObjects } from '../../core/data'
import { SOURCE_VIEW, type SourceKind } from './sourceModel'

export type TaskListParams = { q?: string; overdue?: boolean; source?: string[] }

// 任务列表：type=task，搜索走 q，逾期视图走 overdue=true（和 /api/counts 的 overdue 同一口径），来源视图走 source=
export function useTaskList(p: TaskListParams) {
  return useAllObjects({ type: ['task'], q: p.q, overdue: p.overdue, source: p.source }, { keepPrevious: true })
}

// 聚焦类计数器收窄到任务
export const useTaskCounts = () => useCounts({ type: 'task' })

// 项目筛选的选项
export const useProjectOptions = () => useAllObjects({ type: ['project'], sort: 'title' })

// 来源视图的条数（二级菜单「来源」组）：和列表用同一个 source 筛选，只取 total
const useSourceTotal = (k: SourceKind) => useObjects({ type: ['task'], source: SOURCE_VIEW[k].filter, limit: 1 }).data?.total
export function useSourceCounts(): Record<SourceKind, number | undefined> {
  const manual = useSourceTotal('manual')
  const im = useSourceTotal('im')
  const webhook = useSourceTotal('webhook')
  const schedule = useSourceTotal('schedule')
  const incident = useSourceTotal('incident')
  return { manual, im, webhook, schedule, incident }
}

// 每条任务的产出汇总（TSK-0497）：一次取全部有产出的任务，列表、看板按 id 对上，不逐行请求
export const ARTIFACT_KIND_DICT = 'artifact_kind'
export function useTaskOutputs() {
  const q = useArtifactsByObject({ object_type: 'task' })
  const map = useMemo(() => (q.data ? new Map(q.data.objects.map((o) => [o.object_id, o])) : undefined), [q.data])
  return { query: q, map }
}
