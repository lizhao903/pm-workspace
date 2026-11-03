// Agent 标签（SPEC-projects-10）的纯函数：项目 Agent（props.agent_ids，第一个是默认）、候选、项目里的会话。
// 后端会话没有 project_id，项目里开的会话记在 props.session_ids，按它从全局会话里挑
import type { Agent, AgentSession } from '../../core/data'

/** 项目里的会话先露几条（SPEC-projects-10.7） */
export const SESSION_PEEK = 10

/** 项目 Agent，按 agent_ids 的顺序；找不到的（已删）跳过（SPEC-projects-10.12） */
export function linkedAgents(ids: readonly string[], agents: readonly Agent[]): Agent[] {
  const byId = new Map(agents.map((a) => [a.id, a]))
  return ids.map((id) => byId.get(id)).filter((a): a is Agent => !!a)
}

/** 默认 Agent：第一个还在的；概览的「项目 Agent」显示它（SPEC-projects-3.6） */
export const defaultAgent = (ids: readonly string[], agents: readonly Agent[]): Agent | undefined => linkedAgents(ids, agents)[0]

/** 下拉候选：还没加的 Agent，保持 Agent 列表的顺序 */
export const availAgents = (ids: readonly string[], agents: readonly Agent[]) => agents.filter((a) => !ids.includes(a.id))

/** 加到末尾，已有的不重复加（SPEC-projects-10.2） */
export const addAgent = (ids: readonly string[], id: string) => (ids.includes(id) ? [...ids] : [...ids, id])
/** 设为默认：挪到第一个（SPEC-projects-10.4） */
export const makeDefault = (ids: readonly string[], id: string) => [id, ...ids.filter((x) => x !== id)]
/** 移除：只从 agent_ids 拿掉，Agent 本身和已有会话不动（SPEC-projects-10.6） */
export const removeAgent = (ids: readonly string[], id: string) => ids.filter((x) => x !== id)

/** 新开的会话记在最前；已有的不重复记 */
export const addSession = (ids: readonly string[], id: string) => [id, ...ids.filter((x) => x !== id)]

/**
 * 项目里的会话：session_ids 里还在的会话，按更新时间倒序（SPEC-projects-10.7）。
 * 一句话都没发的空会话不列，和会话页一致（切走时会话页会删掉它）
 */
export function projectSessions(ids: readonly string[], sessions: readonly AgentSession[]): AgentSession[] {
  const set = new Set(ids)
  return sessions.filter((s) => set.has(s.id) && s.message_count > 0)
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
}
