// 任务列表页用的查询（DEV-07a 起），建在数据访问层上：缓存键和失效都由 core/data 管，
// 任务在抽屉里改了状态，这里的列表和逾期计数跟着刷新。
import { useAllObjects, useCounts } from '../../core/data'

export type TaskListParams = { q?: string; overdue?: boolean }

// 任务列表：type=task，搜索走 q，逾期视图走 overdue=true（和 /api/counts 的 overdue 同一口径）
export function useTaskList(p: TaskListParams) {
  return useAllObjects({ type: ['task'], q: p.q, overdue: p.overdue }, { keepPrevious: true })
}

// 聚焦类计数器收窄到任务
export const useTaskCounts = () => useCounts({ type: 'task' })

// 项目筛选的选项
export const useProjectOptions = () => useAllObjects({ type: ['project'], sort: 'title' })
