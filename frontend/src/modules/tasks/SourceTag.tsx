// 列表上的来源标签（SPEC-tasks-0 TaskSource）：人工、IM、Webhook · 名称、定时 · 名称、异常 · 标题
import type { WorkObject } from '../../core/data'
import { sourceTag } from './sourceModel'

export function SourceTag({ task, hookName }: {
  task: WorkObject
  /** Webhook 名；undefined 是列表还没取到，null 是已删除 */
  hookName: (id: string) => string | null | undefined
}) {
  const s = sourceTag(task, hookName)
  if (!s) return null
  return <span className={`src-tag src-${s.kind}`} title={s.title ?? s.text}>{s.text}</span>
}
