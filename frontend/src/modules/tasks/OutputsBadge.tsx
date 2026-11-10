// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 任务行、看板卡片上的产出物标记（TSK-0497）：「产出 3 · 提交 2 文档 1」，点它打开任务抽屉的产出物面板。
// 没有产出的不显示；汇总还没取到时也不显示（不当成「没有」）。
import type { ArtifactObjectSummary } from '../../core/data'
import { cls } from '../../core/ui'
import { kindParts, summaryText, summaryTitle, type KindInfo } from './outputSummary'

export function OutputsBadge({ summary, kinds, onOpen, className }: {
  summary: ArtifactObjectSummary | undefined
  kinds: readonly KindInfo[]
  /** 不给就只显示、不能点 */
  onOpen?: () => void
  className?: string
}) {
  if (!summary || summary.total === 0) return null
  const parts = kindParts(summary.by_kind, kinds)
  const text = summaryText(summary.total, parts)
  const title = summaryTitle(summary.total, parts)
  if (!onOpen) return <span className={cls('out-badge', className)} title={title}>产出 {text}</span>
  return (
    <button type="button" className={cls('out-badge', className)} title={`${title}\n点开看产出物`}
      aria-label={`${summary.object_ref} 的产出物：${text}`}
      onClick={(e) => { e.stopPropagation(); onOpen() }}
      onKeyDown={(e) => e.stopPropagation()}>
      产出 {text}
    </button>
  )
}
