import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { IconCheck, IconChevronDown } from '../ui'
import { AppLogo } from './Logo'

// 左上角的工作台切换，位置和样子照原型 web-next/src/workspaces.tsx。
// 工作台数据在 CORE-10b 接入，这之前只有一个默认工作台，菜单里只能去设置
const CURRENT = '我的工作台'

export function WorkspaceSwitcher({ collapsed, onManage }: { collapsed: boolean; onManage: () => void }) {
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const ref = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const open = pos !== null

  // 弹层挂到 body 上、按按钮位置固定定位：侧栏收起时只剩一条窄轨，放在侧栏里会被裁掉
  const toggle = () => {
    const r = ref.current?.getBoundingClientRect()
    setPos(open || !r ? null : { left: r.left, top: r.bottom + 2 })
  }
  useEffect(() => {
    if (!open) return
    const off = (e: MouseEvent) => {
      const t = e.target as Node
      if (!ref.current?.contains(t) && !menuRef.current?.contains(t)) setPos(null)
    }
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      setPos(null)
      ref.current?.focus()
    }
    const close = () => setPos(null)
    window.addEventListener('mousedown', off)
    window.addEventListener('keydown', esc)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('mousedown', off)
      window.removeEventListener('keydown', esc)
      window.removeEventListener('resize', close)
    }
  }, [open])

  return (
    <div className="ws-brand">
      <button ref={ref} type="button" className="brand-btn" onClick={toggle} title={collapsed ? `一人之下 · ${CURRENT}` : '切换工作台'}
        aria-label={`一人之下，当前工作台：${CURRENT}`} aria-haspopup="menu" aria-expanded={open}>
        <AppLogo size={30} />
        <span className="brand-text">
          <span className="brand-name">一人之下</span>
          <span className="brand-sub ellipsis">{CURRENT}</span>
        </span>
        <IconChevronDown className="brand-chev" />
      </button>
      {pos && createPortal(
        <div className="menu ws-menu" role="menu" ref={menuRef} style={{ left: pos.left, top: pos.top }}>
          <div className="menu-label">切换工作台</div>
          <button type="button" role="menuitemradio" aria-checked="true" className="menu-item ws-menu-item on" onClick={() => setPos(null)}>
            <span className="ellipsis">{CURRENT}</span>
            <IconCheck />
          </button>
          <div className="ws-menu-hint">暂时只有一个工作台</div>
          <div className="menu-sep" />
          <button type="button" role="menuitem" className="menu-item" onClick={() => { setPos(null); onManage() }}>工作台与模块设置…</button>
        </div>,
        document.body,
      )}
    </div>
  )
}
