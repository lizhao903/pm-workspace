// 执行记录的停止（TSK-0717，SPEC-sop-4.20~4.25）：哪些行能停、确认框的说明、停完的一句话结果。
// 只停执行中、待我处理的（失败、已完成、已终止、已重跑的不停）；后端按 batch-actions 的 stop、按条件的 POST /api/sop/runs/stop 做。
import { sopRunShow, type SopRunBrief, type SopStopResult } from '../../core/data'

/** 能停：执行中、待我处理（已重跑的失败执行不算） */
export const isStoppable = (r: Pick<SopRunBrief, 'status' | 'relaunched_to'>) => {
  const s = sopRunShow(r)
  return s === 'running' || s === 'waiting'
}

/** 确认框里的说明：停了什么、不撤回什么 */
export const STOP_EFFECT = '停止后执行标为「已终止」：排队等模型的步骤立即出队，正在调模型的请求会取消，等你处理的步骤不再等。'
export const STOP_NO_UNDO = '已经建出的任务、写出的文档、发出的消息不会撤回；停止后不能接着跑，要重来得重新发起。'

/** 勾选停止、单条停止的结果 */
export function stopIdsNote(r: { stopped: number; skipped: number; errors: string[] }): { text: string; bad: boolean } {
  const parts = [`已停止 ${r.stopped} 条`]
  if (r.skipped) parts.push(`跳过 ${r.skipped} 条（已结束或已停止）`)
  if (r.errors.length) parts.push(`${r.errors.length} 条没停成：${r.errors[0]}`)
  return { text: parts.join('，') + '。已建出的任务不会撤回', bad: r.errors.length > 0 }
}

/** 按条件停止的结果 */
export function stopWhereNote(r: SopStopResult): { text: string; bad: boolean } {
  if (!r.matched) return { text: '没有运行中的执行要停', bad: false }
  const parts = [`已停止 ${r.stopped.length} 条`]
  if (r.skipped.length) parts.push(`跳过 ${r.skipped.length} 条（停的时候已结束）`)
  if (r.failed.length) parts.push(`${r.failed.length} 条没停成：${r.failed[0].error}`)
  return { text: parts.join('，') + '。已建出的任务不会撤回', bad: r.failed.length > 0 }
}
