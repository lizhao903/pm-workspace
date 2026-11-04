// 执行记录页的纯函数（AG-01b8，SPEC-sessions-2）：会话里的调用记录和要人确认的调用合成一列卡片，Agent 筛选 chip 的挑法。
import type { AgentRunCall, AgentToolCall } from '../../core/data'
import type { CallState, CallView } from '../../core/chat/chatModel'

// 后端记「要确认」的那条调用时写的前缀（internal/agent 的 requestConfirm）
const WAIT_MARK = '等待确认：'

const TC_STATE: Record<string, CallState> = { pending: 'pending', confirmed: 'confirmed', rejected: 'rejected' }

/**
 * 调用卡片按顺序排：「等待确认：…」那条换成对应的要确认调用（按工具名依次配对），状态取它的；
 * 确认后真正执行的那条照常是已执行。没配上的要确认调用（会话删了等）补在最后。
 */
export function runCallViews(calls: readonly AgentRunCall[], toolCalls: readonly AgentToolCall[]): CallView[] {
  const left = [...toolCalls]
  const out: CallView[] = []
  for (const c of calls) {
    if (c.summary.startsWith(WAIT_MARK)) {
      const i = left.findIndex((t) => t.tool === c.tool)
      if (i >= 0) {
        const t = left.splice(i, 1)[0]
        out.push({ name: t.tool, args: t.args || c.args, summary: t.result || undefined, state: TC_STATE[t.state] ?? 'pending', id: t.id })
        continue
      }
    }
    out.push({ name: c.tool || '工具', args: c.args, summary: c.summary, state: 'done' })
  }
  for (const t of left) out.push({ name: t.tool, args: t.args, summary: t.result || undefined, state: TC_STATE[t.state] ?? 'pending', id: t.id })
  return out
}

/** Agent 多于这个数时 chip 只放执行记录最多的几个，其余进可搜索的下拉（SPEC-sessions-2.3） */
export const MANY_AGENTS = 6
export const TOP_AGENTS = 4

/** 露成 chip 的 Agent：不多就全部（原顺序），多了取记录数最多的 TOP_AGENTS 个 */
export function topAgents<A extends { id: string }>(agents: readonly A[], usage: ReadonlyMap<string, number>): { chips: A[]; rest: A[] } {
  if (agents.length <= MANY_AGENTS) return { chips: [...agents], rest: [] }
  const sorted = [...agents].sort((a, b) => (usage.get(b.id) ?? 0) - (usage.get(a.id) ?? 0))
  return { chips: sorted.slice(0, TOP_AGENTS), rest: sorted.slice(TOP_AGENTS) }
}
