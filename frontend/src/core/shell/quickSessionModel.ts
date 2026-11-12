// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 快速新建会话的挑选规则，界面在 QuickSession.tsx
import type { Agent, AgentProvider } from '../data'

/** Agent、服务商多时只露这么多个，其余在「更多」里搜 */
export const CHIPS = 7

/** 能直接开聊的服务商：启用了、有默认模型 */
export const usableProvider = (p: AgentProvider) => p.enabled && !!p.model.trim()

/** 能开会话的 Agent：只列启用的（SPEC-sessions-4.3） */
export const usableAgent = (a: Agent) => a.enabled

/** 默认选上次聊过的，没有就是默认的（服务商才有），再没有就第一个 */
export function pickDefault<T extends { id: string; is_default?: boolean }>(usable: readonly T[], lastUsed?: string): string {
  return (usable.find((p) => p.id === lastUsed) ?? usable.find((p) => p.is_default) ?? usable[0])?.id ?? ''
}

/** 露出来的那几个，当前选中的一定在里面，顺序跟原列表 */
export function chipsOf<T extends { id: string }>(usable: readonly T[], cur: string): T[] {
  if (usable.length <= CHIPS + 1) return [...usable]
  const head = usable.slice(0, CHIPS).filter((p) => p.id !== cur)
  const sel = usable.find((p) => p.id === cur)
  return [...head, ...(sel ? [sel] : [])].slice(-CHIPS).sort((a, b) => usable.indexOf(a) - usable.indexOf(b))
}

/** 最近一次会话用的 Agent、服务商：会话按 updated_at 倒序，挂了 Agent 的算 Agent，没挂的算服务商 */
export function lastUsedOf(sessions: readonly { agent_id?: string | null; agent_deleted?: boolean; provider_id: string }[]): { agent?: string; provider?: string } {
  return {
    agent: sessions.find((s) => s.agent_id && !s.agent_deleted)?.agent_id ?? undefined,
    provider: sessions.find((s) => !s.agent_id)?.provider_id,
  }
}
