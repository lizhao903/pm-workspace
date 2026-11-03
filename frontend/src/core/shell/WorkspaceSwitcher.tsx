import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import type { Workspace } from '../data'
import { cls, IconCheck, IconChevronDown } from '../ui'
import { AppLogo } from './Logo'
import { MARK_PATHS } from './markIcons'

// 左上角的工作台切换，位置和样子照原型 web-next/src/workspaces.tsx WorkspaceSwitcher。
// 列表来自 GET /api/workspaces；取不到时只显示默认名字，菜单里只能去设置
const FALLBACK = '我的工作台'

/** 工作台标识（照原型 BenchMark、imagepick.tsx Mark）：上传的图片 > 内置图标 > 文字；都没有就用产品标志 */
export function WorkspaceMarkView({ w, size }: { w: Workspace | undefined; size: number }) {
  const m = w?.mark
  const path = m?.icon ? MARK_PATHS[m.icon] : undefined
  if (!m || (!m.image && !m.text && !path)) return <AppLogo size={size} />
  const style: CSSProperties = { width: size, height: size, background: m.color }
  if (m.image) return <img className="ws-mark ws-mark-img" src={m.image} alt="" style={style} />
  if (path) {
    return (
      <span className="ws-mark" aria-hidden="true" style={style}>
        <svg viewBox="0 0 24 24" width={Math.round(size * 0.58)} height={Math.round(size * 0.58)} aria-hidden="true">
          <path d={path} fill="none" stroke="currentColor" strokeWidth={size < 20 ? 2.6 : 2} strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
    )
  }
  return <span className="ws-mark" aria-hidden="true" style={{ ...style, fontSize: size * (m.text.length > 1 ? 0.34 : 0.44) }}>{m.text}</span>
}

export function WorkspaceSwitcher({ list, current, collapsed, onSwitch, onManage }: {
  list: readonly Workspace[]
  current: Workspace | undefined
  collapsed: boolean
  onSwitch: (w: Workspace) => void
  onManage: () => void
}) {
  const name = current?.name ?? FALLBACK
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
      <button ref={ref} type="button" className="brand-btn" onClick={toggle} title={collapsed ? `一人之下 · ${name}` : '切换工作台'}
        aria-label={`一人之下，当前工作台：${name}`} aria-haspopup="menu" aria-expanded={open}>
        <AppLogo size={30} />
        <span className="brand-text">
          <span className="brand-name">一人之下</span>
          <span className="brand-sub"><WorkspaceMarkView w={current} size={14} /><span className="ellipsis">{name}</span></span>
        </span>
        <IconChevronDown className="brand-chev" />
      </button>
      {pos && createPortal(
        <div className="menu ws-menu" role="menu" ref={menuRef} style={{ left: pos.left, top: pos.top }}>
          <div className="menu-label">切换工作台</div>
          {/* 工作台多了只滚这一段，底部的设置入口一直看得到 */}
          {list.length ? (
            <div className="ws-menu-list">
              {list.map((w) => {
                const on = w.id === current?.id
                return (
                  <button key={w.id} type="button" role="menuitemradio" aria-checked={on} className={cls('menu-item ws-menu-item', on && 'on')}
                    onClick={() => { setPos(null); if (!on) onSwitch(w) }}>
                    <WorkspaceMarkView w={w} size={24} />
                    <span className="ws-menu-text">
                      <span className="ellipsis">{w.name}</span>
                      {w.role && <span className="ws-menu-role ellipsis">{w.role}</span>}
                    </span>
                    {on && <IconCheck />}
                  </button>
                )
              })}
            </div>
          ) : <div className="ws-menu-hint">工作台列表没取到，菜单先用默认的</div>}
          <div className="menu-sep" />
          <button type="button" role="menuitem" className="menu-item" onClick={() => { setPos(null); onManage() }}>工作台与模块设置…</button>
        </div>,
        document.body,
      )}
    </div>
  )
}
