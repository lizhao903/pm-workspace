// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 顶栏：品牌 / 工作区 / 全局搜索 / 快速捕获 / 主题 / 通知 / 头像。
import { useEffect, useRef, useState } from 'react'
import { useWorkspace } from '../hooks/workspace'
import { isBlocked, runShortcut, useShortcuts } from '../views/ShortcutsPage'

const THEME_KEY = 'pmw.theme'
export type Theme = 'light' | 'dark'

export function getTheme(): Theme {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'
}

export function applyTheme(t: Theme) {
  document.documentElement.dataset.theme = t
  try { localStorage.setItem(THEME_KEY, t) } catch { /* 无痕模式下 localStorage 可能不可写，忽略 */ }
  // 命令面板也能切主题，用事件把状态广播回顶栏
  window.dispatchEvent(new CustomEvent('pmw:theme'))
}

export function toggleTheme() {
  applyTheme(getTheme() === 'dark' ? 'light' : 'dark')
}

export const isMac = typeof navigator !== 'undefined' && /Mac|iP(hone|ad)/.test(navigator.userAgent)
export const modKey = isMac ? 'Cmd' : 'Ctrl'

export default function TopBar({ onToggleSidebar }: { onToggleSidebar: () => void }) {
  const {
    filters, setFilters, counts, selected, applyView,
    setQuickCaptureOpen, setCategoryManagerOpen, setCommandPaletteOpen,
  } = useWorkspace()
  const { items: shortcuts } = useShortcuts()
  const [theme, setTheme] = useState<Theme>(getTheme)
  const [q, setQ] = useState(filters.q)
  // 记录最后一次「我推给 store 的值」，用来区分外部改动与本地输入
  const pushed = useRef(filters.q)

  useEffect(() => {
    const sync = () => setTheme(getTheme())
    window.addEventListener('pmw:theme', sync)
    return () => window.removeEventListener('pmw:theme', sync)
  }, [])

  useEffect(() => {
    if (filters.q !== pushed.current) { pushed.current = filters.q; setQ(filters.q) }
  }, [filters.q])

  useEffect(() => {
    if (q === pushed.current) return
    const t = setTimeout(() => { pushed.current = q; setFilters({ q }) }, 300) // 300ms 防抖，避免每次击键都打后端
    return () => clearTimeout(t)
  }, [q, setFilters])

  const pending = (counts?.overdue ?? 0) + (counts?.stalled ?? 0)
  const pinned = shortcuts.filter((x) => x.pinned).slice(0, 6)

  return (
    <>
      <button
        type="button"
        className="icon-btn topbar-menu"
        title="导航"
        aria-label="切换侧栏"
        onClick={onToggleSidebar}
      >
        <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M2 4h12M2 8h12M2 12h12" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      </button>

      <span className="brand">PM Workspace</span>
      <span className="ws-chip">工作区：默认</span>

      <div className="topbar-search">
        <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true" style={{ color: 'var(--faint)', flex: 'none' }}>
          <circle cx="7" cy="7" r="4.4" fill="none" stroke="currentColor" strokeWidth="1.4" />
          <path d="M10.4 10.4 14 14" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
        <input
          id="global-search"
          value={q}
          placeholder="搜索需求 / 文档 / 待办…"
          aria-label="全局搜索"
          onChange={(e) => setQ(e.target.value)}
        />
        {q && (
          <button type="button" className="btn-sm btn-ghost" onClick={() => setQ('')} aria-label="清空搜索">清空</button>
        )}
        {/* 输入框本身要能打字做列表过滤，所以把「开命令面板」挂在 kbd 提示上，
            另有 Cmd/Ctrl+K 全局快捷键，二者等价 */}
        <button type="button" className="kbd" title="命令面板" onClick={() => setCommandPaletteOpen(true)}>
          {modKey} K
        </button>
      </div>

      {pinned.length > 0 && (
        <div className="sc-pins">
          {pinned.map((sc) => {
            const blocked = isBlocked(sc, selected)
            return (
              <button
                key={sc.id}
                type="button"
                className={`icon-btn sc-pin${blocked ? ' sc-disabled' : ''}`}
                title={blocked ? `${sc.label}（需先选中一个工作对象）` : sc.label}
                onClick={() => runShortcut(sc, { selected, applyView, setQuickCaptureOpen, setCategoryManagerOpen })}
              >
                <span className="sc-icon sc-icon-sm" style={sc.color ? { background: sc.color } : undefined}>
                  {sc.icon || sc.label.slice(0, 1) || '·'}
                </span>
              </button>
            )
          })}
        </div>
      )}

      <div className="topbar-actions">
        <button type="button" className="btn btn-primary" onClick={() => setQuickCaptureOpen(true)}>
          + 快速捕获
        </button>

        <button
          type="button"
          className="icon-btn"
          title={theme === 'dark' ? '切到浅色' : '切到深色'}
          aria-label="切换主题"
          onClick={toggleTheme}
        >
          {theme === 'dark' ? (
            // 月牙：两个圆做减法，纯几何，不引图标库
            <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M13 10.2A5.6 5.6 0 0 1 5.8 3a5.6 5.6 0 1 0 7.2 7.2Z" fill="currentColor" />
            </svg>
          ) : (
            <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
              <circle cx="8" cy="8" r="3.1" fill="currentColor" />
              <path d="M8 1v1.8M8 13.2V15M1 8h1.8M13.2 8H15M3.1 3.1l1.3 1.3M11.6 11.6l1.3 1.3M12.9 3.1l-1.3 1.3M4.4 11.6l-1.3 1.3"
                stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
            </svg>
          )}
        </button>

        <button
          type="button"
          className="icon-btn topbar-notify"
          title={`待处理：逾期 ${counts?.overdue ?? 0} · 停滞 ${counts?.stalled ?? 0}`}
          aria-label="通知"
        >
          <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M4 6.6a4 4 0 0 1 8 0v3l1.1 1.7H2.9L4 9.6Z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
            <path d="M6.6 13a1.5 1.5 0 0 0 2.8 0" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          </svg>
          {pending > 0 && <span className="icon-badge">{pending > 99 ? '99+' : pending}</span>}
        </button>

        <span className="avatar" title="我">我</span>
      </div>
    </>
  )
}
