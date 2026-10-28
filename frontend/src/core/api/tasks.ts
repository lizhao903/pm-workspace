// 任务列表页用的查询（DEV-07a）。查询键都挂在 objects / counts / dictionaries 前缀下，
// 以后按前缀失效缓存时一起刷新。
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import type { ListResult } from './client'
import { counts, dictionaries, objects } from './resources'
import type { ObjectListParams, WorkObject } from './types'

// 后端单页上限
const MAX_PAGE = 200

// 按页拉完全部匹配的对象。分段、状态条数要在整份数据上算，只拿一页会算错。
export async function listAllObjects(params: ObjectListParams, signal?: AbortSignal): Promise<ListResult<WorkObject>> {
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

export type TaskListParams = { q?: string; overdue?: boolean }

export const taskKeys = {
  list: (p: TaskListParams) => ['objects', 'list', 'task', { q: p.q ?? '', overdue: !!p.overdue }] as const,
  counts: ['counts', 'task'] as const,
  dictItems: (dictId: string) => ['dictionaries', dictId, 'items'] as const,
  projects: ['objects', 'list', 'project'] as const,
}

// 任务列表：type=task，搜索走 q，逾期视图走 overdue=true（和 /api/counts 的 overdue 同一口径）
export function useTaskList(p: TaskListParams) {
  return useQuery({
    queryKey: taskKeys.list(p),
    queryFn: ({ signal }) => listAllObjects({ type: ['task'], q: p.q, overdue: p.overdue }, signal),
    // 改搜索词时先留着上一份结果，免得列表闪成加载中
    placeholderData: keepPreviousData,
  })
}

// 聚焦类计数器收窄到任务
export function useTaskCounts() {
  return useQuery({ queryKey: taskKeys.counts, queryFn: () => counts({ type: 'task' }) })
}

// 某本字典的条目（含已归档的，历史数据要显示得出来）
export function useDictItems(dictId: string) {
  return useQuery({ queryKey: taskKeys.dictItems(dictId), queryFn: () => dictionaries.items(dictId) })
}

// 项目筛选的选项
export function useProjectOptions() {
  return useQuery({
    queryKey: taskKeys.projects,
    queryFn: ({ signal }) => listAllObjects({ type: ['project'], sort: 'title' }, signal),
  })
}
