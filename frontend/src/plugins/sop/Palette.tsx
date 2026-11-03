// 节点选择器（SPEC-sop-11.1 到 11.4）：搜索、按分组列节点；点外面或 Esc 关闭，贴着屏幕边缘时往里收
import { useEffect, useRef, useState } from 'react'
import { IconSearch } from '../../core/ui'
import { filterPalette, groupsOf, type PaletteItem } from './edit'
import { KindIcon } from './parts'

export function Palette({ at, items, onPick, onClose }: {
  at: { x: number; y: number }
  items: readonly PaletteItem[]
  onPick: (p: PaletteItem) => void
  onClose: () => void
}) {
  const [q, setQ] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const off = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) onClose() }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }
    window.addEventListener('mousedown', off)
    window.addEventListener('keydown', esc, true)
    return () => { window.removeEventListener('mousedown', off); window.removeEventListener('keydown', esc, true) }
  }, [onClose])
  const shown = filterPalette(items, q)
  const left = Math.max(8, Math.min(at.x, window.innerWidth - 300))
  const top = Math.max(8, Math.min(at.y, window.innerHeight - 420))
  return (
    <div ref={ref} className="sop-palette" style={{ left, top }} role="dialog" aria-label="选择节点">
      <div className="search">
        <IconSearch />
        <input autoFocus placeholder="搜索节点" aria-label="搜索节点" value={q} onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && shown[0]) onPick(shown[0]) }} />
      </div>
      <div className="sop-palette-list">
        {groupsOf(shown).map((g) => (
          <div key={g} role="group" aria-label={g}>
            <div className="sop-palette-group">{g}</div>
            {shown.filter((p) => p.group === g).map((p) => (
              <button key={p.id} type="button" className="sop-palette-item" onClick={() => onPick(p)}>
                <KindIcon kind={p.kind} manual={p.manual} />
                <span className="sop-palette-text"><span>{p.label}</span><span className="sop-palette-desc">{p.desc}</span></span>
              </button>
            ))}
          </div>
        ))}
        {!shown.length && <div className="sop-io-empty">没有匹配的节点</div>}
      </div>
      <div className="sop-palette-tip">从同一个节点连出多条线就是并行；一个节点连进多条线就是汇合</div>
    </div>
  )
}
