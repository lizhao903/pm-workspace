// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 失败执行批量重跑（执行记录「失败」页的多选）：两种做法、默认选哪种、结果一行提示。
// 接口 POST /api/sop/runs/batch-actions（core/data 的 useRerunSopRuns），一次最多 SOP_BATCH_MAX 条
import { SOP_RERUN_REASON_RELAUNCHED, type SopFlow, type SopRerunAction, type SopRerunResult, type SopRunBrief } from '../../core/data'

export const RERUN_OPTIONS: { key: SopRerunAction; label: string; desc: string }[] = [
  {
    key: 'retry', label: '重试失败的步骤',
    desc: '在原执行里从失败的那一步接着跑，已完成的步骤不重做；沿用发起时的流程版本，流程后来改过的地方不生效',
  },
  {
    key: 'relaunch', label: '按最新流程重新发起',
    desc: '用原来的输入、流程现在的定义新起一条执行，从头跑；原失败执行标成「已重跑」，移出「失败」，在「全部」里能点到新执行。子流程里失败的会重新发起它所在的整条顶层执行，同一条只发起一次，已重跑过的不再重复发起',

  },
]

/** 发起后流程又改过的执行：执行用的版本比流程现在的旧；流程删了的不算 */
export function staleRuns(runs: readonly Pick<SopRunBrief, 'flow_id' | 'flow_version'>[], flows: readonly Pick<SopFlow, 'id' | 'version'>[]) {
  const ver = new Map(flows.map((f) => [f.id, f.version]))
  return runs.filter((r) => {
    const v = ver.get(r.flow_id)
    return v !== undefined && v > r.flow_version
  })
}

/**
 * 默认做法：选中的有一条流程发起后改过就「按最新流程」（照旧快照重试大概率原样再失败，比如节点刚换成 Agent），
 * 都没改过就「重试」（不重做已完成的步骤，省时间和模型调用）
 */
export const defaultRerun = (staleN: number): SopRerunAction => (staleN > 0 ? 'relaunch' : 'retry')

/** 重复点击的跳过（已重跑过、正在重跑）不算出问题，后端按幂等挡掉了 */
const IDEMPOTENT = new Set([SOP_RERUN_REASON_RELAUNCHED, '正在重跑'])

/** 结果一行：重试了 N 条 / 新发起 N 条、跳过 N 条、失败 N 条，后面带排队说明和头两种原因；只因重复点击跳过的不标红 */
export function rerunNote(action: SopRerunAction, r: SopRerunResult): { text: string; bad: boolean } {
  const parts = [action === 'retry' ? `重试了 ${r.done.length} 条` : `新发起 ${r.done.length} 条`]
  if (r.skipped.length) parts.push(`跳过 ${r.skipped.length} 条`)
  if (r.failed.length) parts.push(`失败 ${r.failed.length} 条`)
  let text = parts.join('、')
  if (r.done.length) text += '。要调模型的步骤按同时调模型的上限排队，排到了自动开始'
  const why = [...new Set([...r.failed.map((x) => x.error), ...r.skipped.map((x) => x.reason)])].slice(0, 2)
  if (why.length) text += `。原因：${why.join('；')}`
  const repeatOnly = r.skipped.length > 0 && r.skipped.every((x) => IDEMPOTENT.has(x.reason))
  return { text, bad: r.failed.length > 0 || (!r.done.length && !repeatOnly) }
}
