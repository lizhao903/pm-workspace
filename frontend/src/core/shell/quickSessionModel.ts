// 快速新建会话的挑选规则，界面在 QuickSession.tsx
import type { AgentProvider } from '../data'

/** 服务商多时只露这么多个，其余在「更多」里搜 */
export const CHIPS = 7

/** 能直接开聊的：启用了、有默认模型 */
export const usableProvider = (p: AgentProvider) => p.enabled && !!p.model.trim()

/** 默认选上次聊过的服务商，没有就是默认服务商，再没有就第一个 */
export function pickDefault(usable: readonly AgentProvider[], lastUsed?: string): string {
  return (usable.find((p) => p.id === lastUsed) ?? usable.find((p) => p.is_default) ?? usable[0])?.id ?? ''
}

/** 露出来的那几个，当前选中的一定在里面，顺序跟原列表 */
export function chipsOf(usable: readonly AgentProvider[], cur: string): AgentProvider[] {
  if (usable.length <= CHIPS + 1) return [...usable]
  const head = usable.slice(0, CHIPS).filter((p) => p.id !== cur)
  const sel = usable.find((p) => p.id === cur)
  return [...head, ...(sel ? [sel] : [])].slice(-CHIPS).sort((a, b) => usable.indexOf(a) - usable.indexOf(b))
}
