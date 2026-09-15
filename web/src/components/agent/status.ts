// Agent 运行状态的极简外部 store：AgentDock 写，StatusBar 读。
// 不塞进 WorkspaceProvider 是因为 hooks/ 不归本组件改；用 useSyncExternalStore
// 能让分处 main 与 footer 的两个组件共享状态，而不动全局 Provider 结构。

export type AgentPhase = 'idle' | 'unconfigured' | 'streaming' | 'error'

export interface AgentStatus {
  phase: AgentPhase
  /** 当前选中的模型名，空串表示还没选出来 */
  model: string
}

let snapshot: AgentStatus = { phase: 'idle', model: '' }
const subs = new Set<() => void>()

/** 返回值必须是稳定引用，未变化时不重建对象，否则 useSyncExternalStore 会死循环 */
export function getAgentStatus(): AgentStatus {
  return snapshot
}

export function setAgentStatus(next: Partial<AgentStatus>): void {
  const merged: AgentStatus = { ...snapshot, ...next }
  if (merged.phase === snapshot.phase && merged.model === snapshot.model) return
  snapshot = merged
  subs.forEach((fn) => fn())
}

export function subscribeAgentStatus(fn: () => void): () => void {
  subs.add(fn)
  return () => { subs.delete(fn) }
}

export function agentStatusLabel(s: AgentStatus): string {
  const tail = s.model ? ` · ${s.model}` : ''
  switch (s.phase) {
    case 'unconfigured': return 'Agent：未配置模型'
    case 'streaming': return `Agent：生成中${tail}`
    case 'error': return `Agent：出错${tail}`
    default: return `Agent：就绪${tail}`
  }
}
