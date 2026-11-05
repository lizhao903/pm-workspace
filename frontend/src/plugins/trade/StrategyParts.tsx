// 策略与回测页共用的小件：进度条、状态、数字输入、折线图、小资金曲线、标的标签。照原型 web-next/src/strategy.tsx 搬。
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { TradeBacktestStatus } from '../../core/data'
import { Pill, cls } from '../../core/ui'
import { fmtPct } from './model'
import { BT_STATUS, instName, prog, tone } from './strategyModel'

export const Signed = ({ x, text }: { x: number; text?: string }) => <span className="sg-num" style={{ color: tone(x) }}>{text ?? fmtPct(x)}</span>

export function ProgressBar({ p, label }: { p: number; label?: boolean }) {
  return (
    <span className="bt-prog-wrap" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(prog(p) * 100)}>
      <span className="bt-prog"><i style={{ width: `${prog(p) * 100}%` }} /></span>
      {label !== false && <span className="sg-num sg-muted">{Math.round(prog(p) * 100)}%</span>}
    </span>
  )
}

export function StatusCell({ b }: { b: { status: TradeBacktestStatus; progress: number } }) {
  if (b.status === 'running') return <ProgressBar p={b.progress} />
  return <Pill {...BT_STATUS[b.status]} />
}

export const PlusIcon = ({ s = 12 }: { s?: number }) => (
  <svg viewBox="0 0 16 16" width={s} height={s} aria-hidden="true"><path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" /></svg>
)
export const XIcon = () => (
  <svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
)
export const SearchIcon = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
)

/** 数字输入：允许中途输入空串和负号，合法时才回传；失焦时不合法就恢复成原值（SPEC-strategy-3.14） */
export function NumInput({ value, onChange, className, step, min, title, placeholder, label }: {
  value: number; onChange: (v: number) => void; className?: string; step?: number; min?: number; title?: string; placeholder?: string; label?: string
}) {
  const [txt, setTxt] = useState(String(value))
  const [prev, setPrev] = useState(value)
  // 外面的值变了（别处改的）就跟上；正在输入的中间态不打断
  if (prev !== value) {
    setPrev(value)
    if (Number(txt) !== value || txt.trim() === '') setTxt(String(value))
  }
  return (
    <input className={className} type="number" inputMode="decimal" step={step ?? 'any'} min={min} title={title} placeholder={placeholder} aria-label={label ?? title} value={txt}
      onChange={(e) => {
        const v = e.target.value
        setTxt(v)
        const n = Number(v)
        if (v.trim() !== '' && Number.isFinite(n)) onChange(n)
      }}
      onBlur={() => { if (txt.trim() === '' || !Number.isFinite(Number(txt))) setTxt(String(value)) }} />
  )
}

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const [w, setW] = useState(0)
  useEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(([e]) => setW(Math.floor(e.contentRect.width)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, w] as const
}

/* ---------- 折线图：资金曲线、回撤、对比共用 ---------- */

export type Line = { label: string; values: number[]; color: string; dash?: boolean; fill?: boolean }

export function Chart({ lines, height = 220, fmtY, xLabel, base, label }: {
  lines: Line[]; height?: number; fmtY: (v: number) => string; xLabel: (f: number) => string; base?: number; label?: string
}) {
  const [ref, w] = useWidth<HTMLDivElement>()
  const [hf, setHf] = useState<number | null>(null)
  const L = 6, R = 6, T = 12, B = 22
  const vals = lines.flatMap((l) => l.values).filter(Number.isFinite)
  let lo = vals.length ? Math.min(...vals) : 0
  let hi = vals.length ? Math.max(...vals) : 1
  if (base !== undefined) {
    lo = Math.min(lo, base)
    hi = Math.max(hi, base)
  }
  if (hi - lo < 1e-9) {
    hi += Math.abs(hi) * 0.01 + 1e-6
    lo -= Math.abs(lo) * 0.01 + 1e-6
  }
  const pad = (hi - lo) * 0.06
  lo -= pad
  hi += pad
  const iw = Math.max(w - L - R, 1)
  const ih = height - T - B
  const X = (i: number, n: number) => L + (n > 1 ? i / (n - 1) : 0) * iw
  const Y = (v: number) => T + ((hi - v) / (hi - lo)) * ih
  const pathOf = (vs: number[]) => vs.map((v, i) => `${i ? 'L' : 'M'}${X(i, vs.length).toFixed(1)} ${Y(v).toFixed(1)}`).join('')
  const ticks = [0.12, 0.5, 0.88].map((f) => hi - (hi - lo) * f)
  const hx = hf === null ? 0 : L + hf * iw
  return (
    <div className="bt-chart" ref={ref} style={{ height }} role="img" aria-label={label}>
      {w > 0 && (
        <svg width={w} height={height} style={{ touchAction: 'pan-y' }}
          onPointerMove={(e) => {
            const r = e.currentTarget.getBoundingClientRect()
            setHf(Math.max(0, Math.min(1, (e.clientX - r.left - L) / iw)))
          }}
          onPointerLeave={() => setHf(null)}>
          {ticks.map((v, k) => (
            <g key={k}>
              <line className="bt-grid" x1={L} x2={L + iw} y1={Y(v)} y2={Y(v)} />
              <text className="bt-axis" x={L + 2} y={Y(v) - 4}>{fmtY(v)}</text>
            </g>
          ))}
          {base !== undefined && <line className="bt-base" x1={L} x2={L + iw} y1={Y(base)} y2={Y(base)} />}
          {lines.map((l, k) => l.values.length > 0 && (
            <g key={k}>
              {l.fill && <path d={`${pathOf(l.values)}L${X(l.values.length - 1, l.values.length)} ${Y(base ?? lo)}L${X(0, l.values.length)} ${Y(base ?? lo)}Z`} style={{ fill: l.color, opacity: 0.16 }} />}
              <path d={pathOf(l.values)} fill="none" style={{ stroke: l.color }} strokeWidth={1.6} strokeDasharray={l.dash ? '4 3' : undefined} strokeLinejoin="round" />
            </g>
          ))}
          {[0, 0.5, 1].map((f) => <text key={f} className="bt-axis" x={L + f * iw} y={height - 6} textAnchor={f === 0 ? 'start' : f === 1 ? 'end' : 'middle'}>{xLabel(f)}</text>)}
          {hf !== null && (
            <g>
              <line className="bt-cross" x1={hx} x2={hx} y1={T} y2={T + ih} />
              {lines.map((l, k) => {
                const n = l.values.length
                if (!n) return null
                const i = Math.round(hf * (n - 1))
                return Number.isFinite(l.values[i]) ? <circle key={k} cx={X(i, n)} cy={Y(l.values[i])} r={3} style={{ fill: l.color }} /> : null
              })}
            </g>
          )}
        </svg>
      )}
      {hf !== null && w > 0 && (
        <div className={cls('bt-tip', hx > w / 2 && 'flip')} style={{ left: hx }}>
          <div className="bt-tip-t">{xLabel(hf)}</div>
          {lines.map((l, k) => {
            const n = l.values.length
            const v = n ? l.values[Math.round(hf * (n - 1))] : NaN
            return <div key={k} className="bt-tip-row"><i style={{ background: l.color }} /><span>{l.label}</span><b className="sg-num">{Number.isFinite(v) ? fmtY(v) : '-'}</b></div>
          })}
        </div>
      )}
    </div>
  )
}

export function Spark({ values, color = 'var(--accent)' }: { values: number[]; color?: string }) {
  if (values.length < 2) return null
  const lo = Math.min(...values)
  const hi = Math.max(...values)
  const d = values.map((v, i) => `${i ? 'L' : 'M'}${((i / (values.length - 1)) * 100).toFixed(2)} ${(hi - lo ? 28 - ((v - lo) / (hi - lo)) * 26 : 15).toFixed(2)}`).join('')
  return <svg className="sg-spark" viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true"><path d={d} fill="none" style={{ stroke: color }} strokeWidth={1.4} vectorEffect="non-scaling-stroke" /></svg>
}

/** 标的标签：一行放得下几个放几个，放不下的收进 +N */
export function SymTags({ symbols, empty }: { symbols: string[]; empty?: string }) {
  const ref = useRef<HTMLSpanElement>(null)
  const head = symbols.slice(0, 6)
  const [hidden, setHidden] = useState(Math.max(0, symbols.length - 2))
  const key = head.join('|')
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const measure = () => {
      const tags = [...el.children] as HTMLElement[]
      const top = tags[0]?.offsetTop ?? 0
      const n = tags.filter((t) => t.offsetTop > top).length + symbols.length - head.length
      setHidden((h) => (h === n ? h : n))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [key, symbols.length, head.length])
  if (!symbols.length) return <span className="sg-syms">{empty && <span className="faint">{empty}</span>}</span>
  return (
    <span className="sg-syms" title={symbols.map(instName).join('、')}>
      <span className="sg-syms-line" ref={ref}>{head.map((x) => <span key={x} className="tag">{instName(x)}</span>)}</span>
      {hidden > 0 && <span className="faint sg-syms-more">+{hidden}</span>}
    </span>
  )
}
