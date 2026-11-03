// 项目设置里的「显示哪些标签」（SPEC-projects-13.19、13.20）：一行一个标签，勾选决定显示不显示，拖动或上移、下移按钮调先后。
// 概览固定第一、设置固定最后：概览是默认标签，设置里才能把藏掉的标签开回来，两头固定才找得到，所以不能勾掉也不参与排序。
// 勾掉的标签照样在列表里、照样能排，开回来时就在排好的位置。勾选和排序都立即保存（由 Settings 存）。
import { useEffect, useRef, useState } from 'react'
import { Button, Checkbox, IconButton, cls } from '../../core/ui'
import { ALWAYS_TABS, isDefaultOrder, moveTab, orderTabs, type TabItem } from './model'

function Arrow({ up }: { up?: boolean }) {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
      <path d={up ? 'm4 10 4-4 4 4' : 'm4 6 4 4 4-4'} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function Grip() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
      {[4, 8, 12].flatMap((y) => [6, 10].map((x) => <circle key={`${x}-${y}`} cx={x} cy={y} r="1.2" fill="currentColor" />))}
    </svg>
  )
}

export function TabPicks({ tabs, hidden, order, onHidden, onOrder }: {
  /** 全部标签（含插件的），默认顺序 */
  tabs: readonly TabItem[]
  hidden: readonly string[]
  /** 存下的顺序（props.tabs_order），可能含这会儿没列出来的插件标签 */
  order: readonly string[]
  onHidden: (hidden: string[]) => void
  onOrder: (order: string[]) => void
}) {
  const rows = orderTabs(tabs, order)
  const movable = rows.filter((t) => !ALWAYS_TABS.includes(t.key)).map((t) => t.key)
  const [drag, setDrag] = useState<string | null>(null)
  const [over, setOver] = useState<string | null>(null)
  // 读屏念的结果：「SOP」移到第 3 个
  const [said, setSaid] = useState('')
  // 按钮挪完行会换位置，焦点跟着那一行的按钮走；到头了那个按钮置灰，焦点换到另一个
  const btns = useRef(new Map<string, HTMLButtonElement | null>())
  const refocus = useRef<{ key: string; up: boolean } | null>(null)
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
    const next = moveTab(movable, order, key, to)
    onOrder(next)
    const label = tabs.find((t) => t.key === key)?.label ?? key
    // 概览固定第一，所以显示上的位置要 +2
    setSaid(`「${label}」移到第 ${to + 2} 个`)
  }
  const step = (key: string, up: boolean) => {
    const i = movable.indexOf(key)
    moveTo(key, up ? i - 1 : i + 1)
    refocus.current = { key, up }
  }
  // 拖到哪一行就占那一行的位置：往下拖落在它后面，往上拖落在它前面；概览算最前、设置算最后
  const rank = (k: string) => (k === 'overview' ? -1 : k === 'settings' ? movable.length : movable.indexOf(k))
  const dragIdx = drag ? movable.indexOf(drag) : -1
  const drop = (target: string) => {
    if (!drag) return
    const to = target === 'overview' ? 0 : target === 'settings' ? movable.length - 1 : movable.indexOf(target)
    moveTo(drag, to)
    setDrag(null)
    setOver(null)
  }

  return (
    <>
      <ul className="pj-tab-picks" aria-label="标签顺序">
        {rows.map((t) => {
          const fixed = ALWAYS_TABS.includes(t.key)
          const i = movable.indexOf(t.key)
          return (
            <li key={t.key} className={cls('pj-tab-pick', fixed && 'fixed', drag === t.key && 'dragging', over === t.key && drag !== t.key && (dragIdx < rank(t.key) ? 'over-after' : 'over-before'))}
              draggable={!fixed} title={fixed ? (t.key === 'overview' ? '一直显示，固定在第一个' : '一直显示，固定在最后') : '拖动调整顺序'}
              onDragStart={fixed ? undefined : (e) => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', t.key); setDrag(t.key) }}
              onDragEnd={() => { setDrag(null); setOver(null) }}
              onDragOver={(e) => { if (!drag) return; e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (over !== t.key) setOver(t.key) }}
              onDragLeave={() => { if (over === t.key) setOver(null) }}
              onDrop={(e) => { e.preventDefault(); drop(t.key) }}>
              <span className="pj-tab-grip">{!fixed && <Grip />}</span>
              <Checkbox checked={fixed || !hidden.includes(t.key)} disabled={fixed}
                title={fixed ? '一直显示' : t.key === 'attachments' ? 'IM 消息插件没在跑时本来就不显示' : undefined}
                onCheckedChange={(on) => onHidden(on ? hidden.filter((k) => k !== t.key) : [...hidden, t.key])}>
                {t.label}
              </Checkbox>
              {fixed ? <span className="pj-tab-fixed">{t.key === 'overview' ? '固定第一' : '固定最后'}</span> : (
                <span className="pj-tab-moves">
                  <IconButton size="sm" label={`上移「${t.label}」`} disabled={i <= 0}
                    ref={(el) => { btns.current.set(`${t.key}:up`, el) }} onClick={() => step(t.key, true)}><Arrow up /></IconButton>
                  <IconButton size="sm" label={`下移「${t.label}」`} disabled={i >= movable.length - 1}
                    ref={(el) => { btns.current.set(`${t.key}:down`, el) }} onClick={() => step(t.key, false)}><Arrow /></IconButton>
                </span>
              )}
            </li>
          )
        })}
      </ul>
      <div className="pj-tab-picks-foot">
        <Button size="sm" variant="outline" disabled={isDefaultOrder(tabs, order)}
          onClick={() => { onOrder([]); setSaid('已恢复默认顺序') }}>恢复默认顺序</Button>
        <span className="pj-sr" aria-live="polite">{said}</span>
      </div>
    </>
  )
}
