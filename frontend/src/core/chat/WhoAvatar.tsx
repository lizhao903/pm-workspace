// 会话里「和谁聊」的头像：Agent 用 Agent 头像，已删除的用灰色机器人，旧会话用服务商的字母头像。
import { Avatar } from '../ui'
import { AgentAvatar, type AgentAvatarSource } from '../ui/AgentAvatar'
import { GONE_AGENT, avatarName, type ChatWho } from './chatModel'

// 已删除的 Agent：灰色机器人（SPEC-sessions-1.27）
const GONE: AgentAvatarSource = { name: GONE_AGENT, color: 'var(--faint)', avatar: { kind: 'icon', value: 'robot' } }

export function WhoAvatar({ who, size }: { who: ChatWho; size: number }) {
  if (who.kind === 'agent') return <AgentAvatar agent={who.agent} size={size} />
  if (who.kind === 'provider') return <Avatar name={avatarName(who.provider)} size={size} />
  return <AgentAvatar agent={GONE} size={size} />
}
