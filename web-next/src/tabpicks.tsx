// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 项目设置「显示哪些标签」（SPEC-projects-13.19、13.20）：一行一个标签，勾选决定显示不显示，拖动或上移、下移按钮调先后。
// 概览固定第一、设置固定最后，不能勾掉也不参与排序（概览是默认标签，设置里才能把藏掉的开回来）。顺序存 tabs_order。
import { useEffect, useRef, useState } from 'react'
import { cls } from './ui'

/** 一直显示、固定一头一尾的标签 */
export const ALWAYS_TABS: string[] = ['overview', 'settings']

/** ref 里有、keys 里没有的补进 keys：跟在它在 ref 里前一个已在结果里的 key 后面，前面一个都没有就放最前 */
function weaveKeys(keys: readonly string[], ref: readonly string[]): string[] {
  const out = [...keys]
  ref.forEach((k, i) => {
    if (out.includes(k)) return
    let at = 0
    for (let j = i - 1; j >= 0; j -= 1) {
      const prev = out.indexOf(ref[j])
      if (prev >= 0) { at = prev + 1; break }
    }
    out.splice(at, 0, k)
  })
  return out
}

/** 按存的顺序排：概览第一、设置最后；认不出的 key 跳过；顺序里没有的标签放回默认位置；order 为空就是默认顺序 */
export function orderTabs<T extends { key: string }>(all: readonly T[], order: readonly string[] | undefined): T[] {
  const first = all.filter((t) => t.key === 'overview')
  const last = all.filter((t) => t.key === 'settings')
  const mid = all.filter((t) => !ALWAYS_TABS.includes(t.key))
  const ord = (order ?? []).filter((k) => !ALWAYS_TABS.includes(k))
  if (!ord.length) return [...first, ...mid, ...last]
  const known = new Set(mid.map((t) => t.key))
  const keys = weaveKeys([...new Set(ord.filter((k) => known.has(k)))], mid.map((t) => t.key))
  const byKey = new Map(mid.map((t) => [t.key, t]))
  return [...first, ...keys.map((k) => byKey.get(k)!), ...last]
}

const Arrow = ({ up }: { up?: boolean }) => (
  <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d={up ? 'm4 10 4-4 4 4' : 'm4 6 4 4 4-4'} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
)
const Grip = () => (
  <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">{[4, 8, 12].flatMap((y) => [6, 10].map((x) => <circle key={`${x}-${y}`} cx={x} cy={y} r="1.2" fill="currentColor" />))}</svg>
)

export function TabPicks({ tabs, hidden, order, onHidden, onOrder }: {
  /** 列出来的标签，默认顺序 */
  tabs: readonly { key: string; label: string }[]
  hidden: readonly string[]
  /** 存下的顺序，可能含这会儿没列出来的标签（模块没开时的「商单」），挪动时按原来的邻居留着 */
  order: readonly string[] | undefined
  onHidden: (hidden: string[]) => void
  onOrder: (order: string[]) => void
}) {
  const saved = (order ?? []).filter((k) => !ALWAYS_TABS.includes(k))
  const rows = orderTabs(tabs, saved)
  const movable = rows.filter((t) => !ALWAYS_TABS.includes(t.key)).map((t) => t.key)
  const isDefault = movable.join() === tabs.filter((t) => !ALWAYS_TABS.includes(t.key)).map((t) => t.key).join()
  const [drag, setDrag] = useState<string | null>(null)
  const [over, setOver] = useState<string | null>(null)
  const [said, setSaid] = useState('')
  const btns = useRef(new Map<string, HTMLButtonElement | null>())
  const refocus = useRef<{ key: string; up: boolean } | null>(null)
  // 挪完焦点留在那一行的按钮上；到头了那个按钮置灰，焦点换到另一个
  useEffect(() => {
    const f = refocus.current
    if (!f) return
    refocus.current = null
    const el = btns.current.get(`${f.key}:${f.up ? 'up' : 'down'}`)
    const alt = btns.current.get(`${f.key}:${f.up ? 'down' : 'up'}`)
    ;(el && !el.disabled ? el : alt)?.focus()
  })
  const moveTo = (key: string, to: number) => {
    if (movable.indexOf(key) === to) return
    const next = movable.filter((k) => k !== key)
    next.splice(Math.max(0, Math.min(to, next.length)), 0, key)
    onOrder(weaveKeys(next, saved))
    setSaid(`「${tabs.find((t) => t.key === key)?.label ?? key}」移到第 ${to + 2} 个`)
  }
  const step = (key: string, up: boolean) => {
    moveTo(key, movable.indexOf(key) + (up ? -1 : 1))
    refocus.current = { key, up }
  }
  // 拖到哪一行就占那一行的位置；概览算最前、设置算最后
  const rank = (k: string) => (k === 'overview' ? -1 : k === 'settings' ? movable.length : movable.indexOf(k))
  const dragIdx = drag ? movable.indexOf(drag) : -1
  const drop = (target: string) => {
    if (drag) moveTo(drag, Math.max(0, Math.min(rank(target), movable.length - 1)))
    setDrag(null)
    setOver(null)
  }

  return (
    <>
      <ul className="tab-picks" aria-label="标签顺序">
        {rows.map((t) => {
          const fixed = ALWAYS_TABS.includes(t.key)
          const i = movable.indexOf(t.key)
          return (
            <li key={t.key} className={cls('tab-pick', fixed && 'fixed', drag === t.key && 'dragging', over === t.key && drag !== t.key && (dragIdx < rank(t.key) ? 'over-after' : 'over-before'))}
              draggable={!fixed} title={fixed ? (t.key === 'overview' ? '一直显示，固定在第一个' : '一直显示，固定在最后') : '拖动调整顺序'}
              onDragStart={fixed ? undefined : (e) => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', t.key); setDrag(t.key) }}
              onDragEnd={() => { setDrag(null); setOver(null) }}
              onDragOver={(e) => { if (!drag) return; e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (over !== t.key) setOver(t.key) }}
              onDragLeave={() => { if (over === t.key) setOver(null) }}
              onDrop={(e) => { e.preventDefault(); drop(t.key) }}>
              <span className="tab-grip">{!fixed && <Grip />}</span>
              <label title={fixed ? '一直显示' : t.key === 'attachments' ? 'IM 消息模块没开时本来就不显示' : undefined}>
                <input type="checkbox" disabled={fixed} checked={fixed || !hidden.includes(t.key)}
                  onChange={(e) => onHidden(e.target.checked ? hidden.filter((k) => k !== t.key) : [...hidden, t.key])} />
                {t.label}
              </label>
              {fixed ? <span className="tab-fixed">{t.key === 'overview' ? '固定第一' : '固定最后'}</span> : (
                <span className="tab-moves">
                  <button type="button" className="icon-btn icon-btn-sm" aria-label={`上移「${t.label}」`} title={`上移「${t.label}」`} disabled={i <= 0}
                    ref={(el) => { btns.current.set(`${t.key}:up`, el) }} onClick={() => step(t.key, true)}><Arrow up /></button>
                  <button type="button" className="icon-btn icon-btn-sm" aria-label={`下移「${t.label}」`} title={`下移「${t.label}」`} disabled={i >= movable.length - 1}
                    ref={(el) => { btns.current.set(`${t.key}:down`, el) }} onClick={() => step(t.key, false)}><Arrow /></button>
                </span>
              )}
            </li>
          )
        })}
      </ul>
      <div className="tab-picks-foot">
        <button type="button" className="act" disabled={isDefault} onClick={() => { onOrder([]); setSaid('已恢复默认顺序') }}>恢复默认顺序</button>
        <span className="sr-only" aria-live="polite">{said}</span>
      </div>
    </>
  )
}
