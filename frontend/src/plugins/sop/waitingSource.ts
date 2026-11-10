// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 「待我处理」的取数（AUTO-12，TSK-0486）：等人的 SOP 步骤（GET /api/sop/waiting，后端全量查）加停在等人阶段的任务。
// 今日「需要你处理」的来源和 SOP 页二级菜单的「待我处理」数字用同一个缓存键、同一份取数、同一个计数（waitingTodayItems），两边数字一致。
// 键挂在今日前缀下：执行变化（sop-run）和任务变化都会刷
import { useQuery } from '@tanstack/react-query'
import { WAITING_STAGES, listAllObjects, sopApi, todayKeys, type SopWaitingItem, type WorkObject } from '../../core/data'

export type WaitingData = { steps: SopWaitingItem[]; tasks: WorkObject[] }

export const waitingQueryKey = [...todayKeys.all, 'sop-waiting'] as const

export async function fetchWaiting({ signal }: { signal?: AbortSignal } = {}): Promise<WaitingData> {
  const [steps, tasks] = await Promise.all([
    sopApi.waiting(signal),
    listAllObjects({ type: ['task'], stage: [...WAITING_STAGES], not_terminal: true }, signal),
  ])
  return { steps, tasks: tasks.data }
}

/** SOP 页用：和今日来源共用缓存；refetchInterval 给事件流断开时轮询用 */
export function useWaitingData(opts: { refetchInterval?: number | false } = {}) {
  return useQuery({ queryKey: waitingQueryKey, queryFn: ({ signal }) => fetchWaiting({ signal }), refetchInterval: opts.refetchInterval })
}
