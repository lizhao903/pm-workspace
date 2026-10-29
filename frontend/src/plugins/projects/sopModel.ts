// SOP 标签（SPEC-projects-9）的纯函数：关联的流程、候选、最近执行、执行状态的显示名。
// 执行状态的显示名和颜色同 SOP 插件的 RUN_STATUS（插件之间不互相 import，这里抄一份）
import type { SopFlow, SopRunBrief, SopRunStatus } from '../../core/data'

/** 最近执行露几条（SPEC-projects-9.6） */
export const SOP_RUN_PEEK = 8

export const RUN_LOOK: Record<SopRunStatus, { label: string; color: string }> = {
  running: { label: '执行中', color: 'var(--accent)' },
  waiting: { label: '待我处理', color: 'var(--warn)' },
  done: { label: '已完成', color: 'var(--ok)' },
  failed: { label: '失败', color: 'var(--danger)' },
  stopped: { label: '已终止', color: 'var(--faint)' },
}
export const runLook = (s: string) => RUN_LOOK[s as SopRunStatus] ?? { label: s, color: 'var(--faint)' }

/** 关联的流程，按 sop_ids 的顺序；流程库里找不到的（已删）跳过（SPEC-projects-9.9） */
export function linkedFlows(ids: readonly string[], flows: readonly SopFlow[]): SopFlow[] {
  const byId = new Map(flows.map((f) => [f.id, f]))
  return ids.map((id) => byId.get(id)).filter((f): f is SopFlow => !!f)
}

/** 下拉候选：还没关联的流程，保持流程库的顺序 */
export const availFlows = (ids: readonly string[], flows: readonly SopFlow[]) => flows.filter((f) => !ids.includes(f.id))

/** 关联流程的执行，按开始时间倒序取前 SOP_RUN_PEEK 条；只算还在流程库里的流程 */
export function recentRuns(linked: readonly SopFlow[], runs: readonly SopRunBrief[]): SopRunBrief[] {
  const ids = new Set(linked.map((f) => f.id))
  return runs.filter((r) => ids.has(r.flow_id))
    .sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at))
    .slice(0, SOP_RUN_PEEK)
}

/** 加到末尾，已有的不重复加 */
export const addSop = (ids: readonly string[], id: string) => (ids.includes(id) ? [...ids] : [...ids, id])
/** 取消关联：只从 sop_ids 拿掉，流程和执行记录不动（SPEC-projects-9.5） */
export const removeSop = (ids: readonly string[], id: string) => ids.filter((x) => x !== id)
