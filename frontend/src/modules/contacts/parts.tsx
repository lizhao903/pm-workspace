// 联系人列表和抽屉共用的小件：星标、分组标签、IM 渠道徽标
import type { CSSProperties } from 'react'
import { Pill, cls } from '../../core/ui'
import type { Contact } from '../../core/data'
import { IM_CHANNELS, groupColor, type GroupItem } from './model'

/** 行首和抽屉里的星标：点了只切星标，不打开抽屉 */
export function Star({ on, name, onToggle }: { on: boolean; name: string; onToggle: () => void }) {
  const label = on ? `取消星标：${name}` : `加星标：${name}`
  return (
    <button type="button" className={cls('ct-star', on && 'on')} title={on ? '取消星标' : '加星标'} aria-label={label} aria-pressed={on}
      onClick={(e) => { e.stopPropagation(); onToggle() }}>
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
        <path d="m8 1.8 1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.6l-3.8 2 .7-4.3-3.1-3 4.3-.6Z" fill={on ? 'currentColor' : 'none'}
          stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      </svg>
    </button>
  )
}

/** 分组标签：名字和颜色取分组枚举；枚举里删掉了的按原值显示、用灰 */
export function GroupPill({ items, g }: { items: GroupItem[]; g: string }) {
  return <Pill label={items.find((i) => i.key === g)?.label ?? g} color={groupColor(items, g)} />
}

/** IM 列：只列有编号的渠道，悬停看编号 */
export function ImBadges({ im }: { im: NonNullable<Contact['im']> }) {
  const has = IM_CHANNELS.filter((ch) => im[ch.key])
  if (!has.length) return <span className="faint">-</span>
  return (
    <span className="ct-im">
      {has.map((ch) => (
        <span key={ch.key} className="ct-im-mark" title={`${ch.label}：${im[ch.key]}`} style={{ '--c': ch.color } as CSSProperties}>{ch.short}</span>
      ))}
    </span>
  )
}
