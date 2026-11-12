// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import './symbolpick.css'
import { cls } from './ui'
import { INSTRUMENTS, MARKETS, instOf, type Instrument } from './tradedata'

// 标的搜索：下单抽屉、提醒抽屉共用。按钮显示当前标的，点开搜代码、名称、交易所
// 只渲染前 limit 条匹配项，其余提示继续输入

export const KIND_SHORT: Record<Instrument['kind'], string> = { spot: '现货', perp: '永续', future: '期货', option: '期权' }

const hay = (i: Instrument) => `${i.symbol} ${i.name} ${i.venue} ${MARKETS[i.market].label} ${KIND_SHORT[i.kind]}`.toLowerCase()

export function SymbolPicker({ value, onChange, pool = INSTRUMENTS, side, limit = 10 }: {
  value: string
  onChange: (symbol: string) => void
  /** 可选的标的，默认全部；期权等不在 INSTRUMENTS 里的从这里传 */
  pool?: Instrument[]
  /** 按钮右侧的内容，比如现价 */
  side?: ReactNode
  limit?: number
}) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [hi, setHi] = useState(0)
  const boxRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const inst = instOf(value)

  const all = useMemo(() => {
    const kw = q.trim().toLowerCase().split(/\s+/).filter(Boolean)
    return kw.length ? pool.filter((i) => { const h = hay(i); return kw.every((w) => h.includes(w)) }) : pool
  }, [q, pool])
  const matches = all.slice(0, limit)
  const more = all.length - matches.length

  useEffect(() => {
    if (!open) return
    const off = (e: MouseEvent) => { if (!boxRef.current?.contains(e.target as Node)) setOpen(false) }
    window.addEventListener('mousedown', off)
    return () => window.removeEventListener('mousedown', off)
  }, [open])
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-i="${hi}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [hi])

  const pick = (s: string) => { setOpen(false); setQ(''); if (s !== value) onChange(s) }
  const toggle = () => { setQ(''); setHi(0); setOpen(!open) }

  return (
    <div className="sp" ref={boxRef}>
      <button type="button" className={cls('sp-btn', open && 'open')} onClick={toggle} title={inst ? `${inst.name} · ${inst.symbol}` : value}>
        <span className="sp-name ellipsis">{inst?.name ?? value}</span>
        {inst && <span className="faint ellipsis">{inst.venue} · {KIND_SHORT[inst.kind]} · {inst.symbol}</span>}
        <span className="spacer" />
        {side}
      </button>
      {open && (
        <div className="sp-pop">
          <input autoFocus placeholder="搜代码、名称、交易所" value={q} onChange={(e) => { setQ(e.target.value); setHi(0) }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(0, Math.min(matches.length - 1, h + (e.key === 'ArrowDown' ? 1 : -1)))) }
              if (e.key === 'Enter' && matches[hi]) { e.preventDefault(); pick(matches[hi].symbol) }
              if (e.key === 'Escape') { e.stopPropagation(); setOpen(false) }
            }} />
          <div className="sp-list" ref={listRef}>
            {matches.map((i, k) => (
              <button key={i.symbol} type="button" data-i={k} className={cls('sp-item', i.symbol === value && 'on', k === hi && 'hi')}
                onMouseMove={() => { if (hi !== k) setHi(k) }} onClick={() => pick(i.symbol)}>
                <span className="ellipsis">{i.name}</span>
                <span className="faint ellipsis">{MARKETS[i.market].label} · {KIND_SHORT[i.kind]} · {i.symbol}</span>
              </button>
            ))}
            {!matches.length && <div className="mount-empty">没有匹配的标的</div>}
            {more > 0 && <div className="sp-more">还有 {more} 个，继续输入筛选</div>}
          </div>
        </div>
      )}
    </div>
  )
}
