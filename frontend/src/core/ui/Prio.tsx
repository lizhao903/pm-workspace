// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import type { CSSProperties } from 'react'
import { cls } from './cls'
import { prioText } from './prioText'

/**
 * 优先级标签：编号加名称，按字典颜色铺底（同原型 PriorityTag）。
 * item 传字典项（/api/dictionaries/priority 的一条），找不到时只显示编号、灰色。
 */
export function PrioTag({ p, item, className }: { p: string; item?: { label: string; color?: string; description?: string }; className?: string }) {
  return (
    <span className={cls('prio-tag', className)} title={item?.description || undefined}
      style={{ '--c': item?.color || 'var(--faint)' } as CSSProperties}>
      {prioText(p, item)}
    </span>
  )
}
