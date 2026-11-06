// AI 负责人（TSK-0500，SPEC-tasks-2.27、4.83、6.33、11.17）：任务交给工作台 Agent 或 CLI 执行时，
// 负责人改成它；列表、看板、抽屉里带 Agent 头像或终端标和「Agent」/「CLI」小标签。
// 正式产品在名册里为每个 Agent、每种 CLI 各维护一条「AI 成员」（docs/api-contract.md「干系人名册」下「AI 成员」）。
import './aiowner.css'

export type AIKind = 'agent' | 'cli'

/** 命令行执行器在名册里的名字（正式产品还有 DeepSeek，原型没有这个执行器） */
export const CLI_MEMBERS = ['Claude Code', 'DeepSeek']

/** 按负责人名字认是不是 AI 成员：CLI 名字或某个 Agent 的名字 */
export function aiKindOf(name: string, agentNames: readonly string[]): AIKind | undefined {
  const n = name.trim()
  if (!n) return undefined
  if (CLI_MEMBERS.includes(n)) return 'cli'
  if (agentNames.includes(n)) return 'agent'
  return undefined
}

/** 进展里那句：「负责人由「我」改为「Claude Code」（交给 Claude Code 执行）」 */
export function ownerNote(prev: string, next: string): string {
  return prev.trim() ? `负责人由「${prev.trim()}」改为「${next}」（交给 ${next} 执行）` : `负责人设为「${next}」（交给 ${next} 执行）`
}

function Glyph({ kind, name, size = 16 }: { kind: AIKind; name: string; size?: number }) {
  if (kind === 'agent') {
    return <span className="ai-glyph ai-glyph-agent" aria-hidden="true" style={{ width: size, height: size, fontSize: size * 0.5 }}>{(name.trim() || 'A').slice(0, 1)}</span>
  }
  return (
    <span className="ai-glyph ai-glyph-cli" aria-hidden="true" style={{ width: size, height: size }}>
      <svg viewBox="0 0 16 16" width={size * 0.7} height={size * 0.7}><path d="m3 4.5 3.5 3.5L3 11.5M8.5 12H13" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
    </span>
  )
}

/** 头像 / 终端标 + 名字 + 小标签；负责人是人时只写名字。列表的负责人列窄，不带小标签（tag=false） */
export function AiOwner({ name, kind, className, tag = true }: { name: string; kind?: AIKind; className?: string; tag?: boolean }) {
  if (!kind) return <span className={['ellipsis', className].filter(Boolean).join(' ')}>{name || '未分配'}</span>
  return (
    <span className={['ai-owner', className].filter(Boolean).join(' ')} title={`${name}（${kind === 'agent' ? '工作台 Agent' : 'CLI 执行器'}）`}>
      <Glyph kind={kind} name={name} />
      <span className="ellipsis">{name}</span>
      {tag && <span className="ai-tag">{kind === 'agent' ? 'Agent' : 'CLI'}</span>}
    </span>
  )
}

/** 抽屉里负责人标题旁：只有头像 / 终端标和小标签 */
export function AiBadge({ name, kind }: { name: string; kind: AIKind }) {
  return (
    <span className="ai-owner ai-badge" title={kind === 'agent' ? `${name} 是工作台 Agent` : `${name} 是 CLI 执行器`}>
      <Glyph kind={kind} name={name} size={14} />
      <span className="ai-tag">{kind === 'agent' ? 'Agent' : 'CLI'}</span>
    </span>
  )
}
