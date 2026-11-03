import { cls } from './cls'
import { IconChevronRight } from './icons'

/** 列表分段的段标题：可折叠，带数量；tone=danger 用于「已逾期」这类 */
export function ListSegHead({ label, n, open, onToggle, tone }: {
  label: string
  n: number
  open: boolean
  onToggle: () => void
  tone?: 'danger'
}) {
  return (
    <button type="button" className={cls('list-seg-head', tone === 'danger' && 'danger-text')} onClick={onToggle} aria-expanded={open}>
      <span className={cls('tree-chev', open && 'open')}><IconChevronRight /></span>
      <span>{label}</span>
      <span className="seg-n">{n}</span>
    </button>
  )
}

/** 段尾「这一段还有 N 条」；n 不大于 0 时不显示 */
export function ListSegMore({ n, onMore, text }: { n: number; onMore: () => void; text?: string }) {
  if (n <= 0) return null
  return <button type="button" className="list-seg-more" onClick={onMore}>{text ?? `这一段还有 ${n} 条`}</button>
}
