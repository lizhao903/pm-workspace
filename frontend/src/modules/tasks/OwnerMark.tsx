// 负责人显示（TSK-0500，SPEC-tasks-2.27）：负责人是工作台 Agent 时带 Agent 头像和「Agent」标，
// 是 CLI（Claude Code、DeepSeek）时带终端标和「CLI」标，是人时只写名字。列表、看板共用。
import type { WorkObject } from '../../core/data'
import { cls } from '../../core/ui'
import { AgentAvatar, type AgentAvatarSource } from '../../core/ui/AgentAvatar'
import { aiOwnerTag } from './model'
import './owner.css'

/** Agent id → 头像来源，由页面从 useAgents 取好传进来；没取到时 Agent 用名字首字 */
export type AgentLooks = ReadonlyMap<string, AgentAvatarSource>

export function CliGlyph({ size = 16 }: { size?: number }) {
  return (
    <span className="ai-cli" aria-hidden="true" style={{ width: size, height: size }}>
      <svg viewBox="0 0 16 16" width={size * 0.7} height={size * 0.7}>
        <path d="m3 4.5 3.5 3.5L3 11.5M8.5 12H13" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  )
}

export function OwnerMark({ t, agents, size = 16, className, tag: showTag = true }: {
  t: Pick<WorkObject, 'owner' | 'owner_name' | 'owner_id' | 'owner_ai_kind' | 'owner_ai_ref'>
  agents?: AgentLooks
  size?: number
  className?: string
  /** 列表的负责人列窄，只留头像或终端标，不带「Agent」/「CLI」字样（悬停照样看得到） */
  tag?: boolean
}) {
  const name = t.owner_name || t.owner || ''
  const tag = t.owner_id ? aiOwnerTag(t) : ''
  if (!tag) return <span className={cls('ellipsis', className)}>{name || '未分配'}</span>
  const look = t.owner_ai_kind === 'agent' && t.owner_ai_ref ? agents?.get(t.owner_ai_ref) : undefined
  return (
    <span className={cls('ai-owner', className)} title={`${name}（${tag === 'Agent' ? '工作台 Agent' : 'CLI 执行器'}）`}>
      {t.owner_ai_kind === 'agent'
        ? <AgentAvatar agent={look ?? { name, color: '' }} size={size} />
        : <CliGlyph size={size} />}
      <span className="ellipsis">{name}</span>
      {showTag && <span className="ai-tag">{tag}</span>}
    </span>
  )
}

/** 只有头像（或终端标）和「Agent」/「CLI」标，不带名字：抽屉里负责人字段标题旁用 */
export function AiBadge({ kind, name, look, size = 14 }: { kind: 'agent' | 'cli'; name: string; look?: AgentAvatarSource; size?: number }) {
  return (
    <span className="ai-owner ai-badge" title={kind === 'agent' ? `${name} 是工作台 Agent` : `${name} 是 CLI 执行器`}>
      {kind === 'agent' ? <AgentAvatar agent={look ?? { name, color: '' }} size={size} /> : <CliGlyph size={size} />}
      <span className="ai-tag">{kind === 'agent' ? 'Agent' : 'CLI'}</span>
    </span>
  )
}
