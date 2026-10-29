// 「挂载」下拉，照原型 web-next/src/agents.tsx MountPicker（SPEC-settings-9.13、9.21）：
// 列出还没挂的项，点一个挂上、下拉关闭；超过 8 个时顶部能搜（回车挑第一个，Esc 关闭）；传了 group 就按它分组。
import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react'
import { Button } from '../../../core/ui'
import { MiniSearch } from './parts'
import { hasAll } from './model'

export function MountPicker<T extends { id: string }>({ label, items, render, text, group, onPick, empty }: {
  label: string
  items: T[]
  render: (t: T) => ReactNode
  /** 搜索时匹配的文字 */
  text: (t: T) => string
  group?: (t: T) => string
  onPick: (id: string) => void
  empty: string
}) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  const groups = group ? [...new Set(items.map(group))] : []
  const sorted = group ? [...items].sort((a, b) => groups.indexOf(group(a)) - groups.indexOf(group(b))) : items
  const shown = sorted.filter((t) => hasAll(text(t), q))
  const pick = (id: string) => { onPick(id); setOpen(false) }
  useEffect(() => {
    if (!open) return
    const off = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    window.addEventListener('mousedown', off)
    return () => window.removeEventListener('mousedown', off)
  }, [open])
  return (
    <div className="ag-menu-wrap" ref={ref} onKeyDown={(e) => { if (e.key === 'Escape' && open) { e.stopPropagation(); setOpen(false) } }}>
      <Button size="sm" variant="outline" aria-expanded={open} onClick={() => { setOpen(!open); setQ('') }}>
        <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true"><path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
        {label}
      </Button>
      {open && (
        <div className="menu ag-mount-menu" role="menu" aria-label={label}>
          {items.length > 8 && (
            <div className="ag-mount-search">
              <MiniSearch value={q} onChange={setQ} placeholder={`搜索，共 ${items.length} 个`} autoFocus
                onKeyDown={(e) => { if (e.key === 'Enter' && shown[0]) pick(shown[0].id) }} />
            </div>
          )}
          {items.length ? shown.map((t, i) => (
            <Fragment key={t.id}>
              {group && group(t) !== (i ? group(shown[i - 1]) : '') && <div className="menu-label">{group(t)}</div>}
              <button type="button" role="menuitem" className="menu-item ag-mount-item" onClick={() => pick(t.id)}>{render(t)}</button>
            </Fragment>
          )) : <div className="ag-menu-empty">{empty}</div>}
          {items.length > 0 && !shown.length && <div className="ag-menu-empty">没有匹配的</div>}
        </div>
      )}
    </div>
  )
}
