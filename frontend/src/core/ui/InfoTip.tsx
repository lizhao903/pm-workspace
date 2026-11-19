// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// info 图标加提示气泡（任务详情精简，用户 2026-11-19 提）：原来常驻在标题、按钮旁的灰字说明收进一个 i 图标，
// 鼠标悬停或键盘聚焦到图标时显示，移开、失焦、按 Esc 收起（Esc 只收气泡，不关抽屉）。
// 气泡用 fixed 定位、按视口夹住，抽屉滚动区和右边缘都裁不掉它。说明文字一直在 DOM 里（aria-describedby 指向它），读屏照常读到。
import { useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { cls } from './cls'
import { IconInfo } from './icons'
import './infoTip.css'

// 气泡最宽多少、离视口边缘留多少
const MAX_W = 300
const EDGE = 8

export function InfoTip({ children, label = '说明', className }: {
  /** 气泡里的说明 */
  children: ReactNode
  /** 图标的读屏名，如「工作区说明」 */
  label?: string
  className?: string
}) {
  const id = useId()
  const btn = useRef<HTMLButtonElement>(null)
  const [hover, setHover] = useState(false)
  const [focus, setFocus] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const [pos, setPos] = useState<CSSProperties>({})
  const open = (hover || focus) && !dismissed

  useLayoutEffect(() => {
    if (!open || !btn.current) return
    const r = btn.current.getBoundingClientRect()
    const vw = window.innerWidth || document.documentElement.clientWidth
    const width = Math.min(MAX_W, vw - EDGE * 2)
    const left = Math.max(EDGE, Math.min(r.left + r.width / 2 - width / 2, vw - width - EDGE))
    setPos({ top: r.bottom + 6, left, maxWidth: width })
  }, [open])

  return (
    <span className={cls('info-tip', className)} onMouseEnter={() => setHover(true)}
      onMouseLeave={() => { setHover(false); setDismissed(false) }}>
      <button ref={btn} type="button" className="info-tip-btn" aria-label={label} aria-describedby={id}
        onFocus={() => setFocus(true)} onBlur={() => { setFocus(false); setDismissed(false) }}
        onClick={(e) => e.preventDefault()}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && open) {
            e.preventDefault()
            e.stopPropagation()
            setDismissed(true)
          }
        }}>
        <IconInfo />
      </button>
      <span id={id} role="tooltip" className={cls('info-tip-pop', open && 'on')} style={pos}>{children}</span>
    </span>
  )
}
