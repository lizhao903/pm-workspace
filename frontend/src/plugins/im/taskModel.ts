// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 消息上的关联任务只显示没到终态的（SPEC-messages-1.68，用户 2026-11-19 提）：转成的任务（task_id / task_ref）、
// 拆出来和 SOP 关联的任务（split_tasks，来自 im_message_tasks）都按任务现在的状态（后端 0.32.0 的 task_status、split_tasks[].status）
// 和任务类型的状态集（GET /api/object-types 的 statuses[].terminal）判断，不写死状态名。
// 状态不知道（旧后端没给、状态集还没取到、状态 key 不在状态集里）的当没到终态，照旧显示——宁可多显示，不能把要做的藏掉。
import { useMemo } from 'react'
import { useObjectTypes, type ImMessage, type ImSplitTask, type ObjectStatus } from '../../core/data'

export type IsTerminal = (status: string | undefined) => boolean

/** 任务类型的 id */
export const TASK_TYPE = 'task'

/** 按状态集判断终态；statuses 为空（还没取到）时一律不算 */
export function terminalOf(statuses: readonly ObjectStatus[] | undefined): IsTerminal {
  const set = new Set((statuses ?? []).filter((s) => s.terminal).map((s) => s.key))
  return (status) => !!status && set.has(status)
}

/** 任务类型状态集的终态判断（取对象类型列表，和任务模块同一份缓存） */
export function useTaskTerminal(): IsTerminal {
  const types = useObjectTypes()
  const statuses = types.data?.find((t) => t.id === TASK_TYPE)?.statuses
  // statuses 引用不变时判断函数不变，给 useMemo 依赖用
  return useMemo(() => terminalOf(statuses), [statuses])
}

/** 转成的任务还没到终态（有 task_id 才算）；到终态的消息上不显示「已转任务」 */
export const liveTask = (m: Pick<ImMessage, 'task_id' | 'task_status'>, isTerminal: IsTerminal) => !!m.task_id && !isTerminal(m.task_status)

/** 拆出来的任务分成没到终态的（显示）和到了终态的（列表上不显示，抽屉里折叠成「另有 N 条已完成」） */
export function splitByState<T extends Pick<ImSplitTask, 'status'>>(tasks: readonly T[], isTerminal: IsTerminal): { live: T[]; closed: T[] } {
  const live: T[] = []
  const closed: T[] = []
  for (const t of tasks) (isTerminal(t.status) ? closed : live).push(t)
  return { live, closed }
}
