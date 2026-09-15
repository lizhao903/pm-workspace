// 三栏 shell 组装 + 全局快捷键。业务状态全在 useWorkspace()，这里只管布局与键盘。
import { useCallback, useEffect, useRef, useState } from 'react'
import TopBar from './components/TopBar'
import Sidebar from './components/Sidebar'
import StatusBar from './components/StatusBar'
import CommandPalette from './components/CommandPalette'
import DetailDrawer from './components/DetailDrawer'
import CategoryManager from './components/CategoryManager'
import QuickCapture from './components/QuickCapture'
import AgentDock from './components/AgentDock'
import ObjectListView from './views/ObjectListView'
import ShortcutsPage, { runShortcut, useShortcuts } from './views/ShortcutsPage'
import SettingsPage from './views/SettingsPage'
import { useWorkspace, type FocusKind, type ViewDescriptor } from './hooks/workspace'
import type { ViewMode } from './lib/types'

const SIDE_KEY = 'pmw.sidebar-collapsed'
const VIEW_ORDER: ViewMode[] = ['list', 'board', 'table', 'calendar', 'timeline']
// Shift+1..6 对应的聚焦档位。聚焦从侧栏搬到工具条后没了键盘入口，这里补上；
// 第一档是 null，即「全部」，让用户能一键退回不带聚焦的列表。
const FOCUS_ORDER: (FocusKind | null)[] = [null, 'inbox', 'today', 'week', 'overdue', 'stalled']

// 断点与 index.css 里的 media query 一一对应，两边要一起改
const MQ_RAIL = '(max-width: 959.98px)'
const MQ_DRAWER_FLOAT = '(max-width: 1279.98px)'

function useMediaQuery(query: string): boolean {
  const [match, setMatch] = useState(() => window.matchMedia(query).matches)
  useEffect(() => {
    const mq = window.matchMedia(query)
    const on = () => setMatch(mq.matches)
    on()
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [query])
  return match
}

/** 输入态：除 Esc 外所有单键快捷键都要让路 */
function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el || typeof el.tagName !== 'string') return false
  const tag = el.tagName.toLowerCase()
  return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable
}

/** Enter / Space 在按钮上有原生语义，别让全局快捷键抢走 */
function isInteractive(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  return !!el?.closest?.('button, a, [role="button"], summary')
}

export default function App() {
  const {
    objects, selectedId, select, selected,
    nav, applyView, setFilters,
    drawerOpen, setDrawerOpen, setDrawerTab,
    loading, error, reloadObjects,
    setViewMode,
    quickCaptureOpen, setQuickCaptureOpen,
    categoryManagerOpen, setCategoryManagerOpen,
    commandPaletteOpen, setCommandPaletteOpen,
  } = useWorkspace()
  const { items: shortcuts } = useShortcuts()
  const isPage = nav.kind === 'page'

  const narrow = useMediaQuery(MQ_RAIL)
  const drawerFloating = useMediaQuery(MQ_DRAWER_FLOAT)

  const [collapsedPref, setCollapsedPref] = useState(() => {
    try { return localStorage.getItem(SIDE_KEY) === '1' } catch { return false }
  })
  const [sideOverlay, setSideOverlay] = useState(false)
  const gPending = useRef(0) // G 前缀键按下的时刻，1.5s 内接数字才算一次跳转
  // 独立页面的 nav 里没有作用域，可用户在快捷访问页点「存下当前视图」时想存的是他刚才看的那个列表，
  // 所以离开列表前先把作用域留一份（筛选本来就不随导航清空，不用记）。
  const lastScope = useRef<ViewDescriptor>({})
  const wasFloating = useRef<boolean | null>(null) // null = 首帧也要跑一次

  // 窄屏下侧栏恒为图标条，展开时以浮层盖在主区上
  const railed = narrow ? !sideOverlay : collapsedPref

  useEffect(() => { if (!narrow) setSideOverlay(false) }, [narrow])

  // 抽屉在窄屏是盖住列表的浮层，窗口刚缩窄时若没选中对象就先收起，别一进来就糊一屏
  useEffect(() => {
    if (wasFloating.current === drawerFloating) return
    wasFloating.current = drawerFloating
    setDrawerOpen(drawerFloating ? !!selectedId : true)
  }, [drawerFloating, selectedId, setDrawerOpen])

  // 独立页面没有「当前对象」的概念，抽屉留着只会挤掉页面宽度
  useEffect(() => { if (isPage) setDrawerOpen(false) }, [isPage, setDrawerOpen])

  useEffect(() => {
    if (nav.kind !== 'type') return
    const v: ViewDescriptor = {}
    if (nav.typeId) v.typeId = nav.typeId
    if (nav.uncategorized) v.uncategorized = true
    else if (nav.categoryId) { v.categoryId = nav.categoryId; v.subtree = nav.subtree ?? true }
    lastScope.current = v
  }, [nav])

  const toggleSidebar = useCallback(() => {
    if (narrow) { setSideOverlay((v) => !v); return }
    setCollapsedPref((v) => {
      const next = !v
      try { localStorage.setItem(SIDE_KEY, next ? '1' : '0') } catch { /* 忽略写入失败 */ }
      return next
    })
  }, [narrow])

  useEffect(() => {
    const move = (delta: number) => {
      if (!objects.length) return
      const i = objects.findIndex((o) => o.id === selectedId)
      const next = i < 0
        ? (delta > 0 ? 0 : objects.length - 1)
        : Math.min(objects.length - 1, Math.max(0, i + delta))
      select(objects[next].id)
    }

    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey

      // Cmd/Ctrl+K 带修饰键，输入态也要能用（顶栏搜索框里也能直接唤出面板）
      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setCommandPaletteOpen(!commandPaletteOpen)
        return
      }

      // Esc 依次关最上层浮层
      if (e.key === 'Escape') {
        if (commandPaletteOpen) { setCommandPaletteOpen(false); return }
        if (quickCaptureOpen) { setQuickCaptureOpen(false); return }
        if (categoryManagerOpen) { setCategoryManagerOpen(false); return }
        if (sideOverlay) { setSideOverlay(false); return }
        if (drawerOpen) setDrawerOpen(false)
        return
      }

      if (mod || e.altKey || isTyping(e.target)) return
      // 有浮层时不抢单键，交给浮层自己处理
      if (commandPaletteOpen || quickCaptureOpen || categoryManagerOpen) return

      // Shift+1..6 切聚焦。用 e.code 而不是 e.key：Shift+1 在多数布局下 key 是 '!'，
      // 正因如此它和下面裸数字切视图模式天然不冲突。
      if (e.shiftKey) {
        const m = /^Digit([1-6])$/.exec(e.code)
        if (m) {
          e.preventDefault()
          setFilters({ focus: FOCUS_ORDER[Number(m[1]) - 1] })
          return
        }
      }

      // G 前缀：G 之后 1.5s 内按 1..9 跳第 N 个快捷入口
      if (e.key === 'g' || e.key === 'G') { e.preventDefault(); gPending.current = Date.now(); return }
      if (/^[1-9]$/.test(e.key) && Date.now() - gPending.current < 1500) {
        e.preventDefault()
        gPending.current = 0
        const sc = shortcuts[Number(e.key) - 1]
        if (sc) runShortcut(sc, { selected, applyView, setQuickCaptureOpen, setCategoryManagerOpen })
        return
      }

      switch (e.key) {
        case '/':
          e.preventDefault()
          document.getElementById('global-search')?.focus()
          break
        case 'c': case 'C':
          e.preventDefault()
          setQuickCaptureOpen(true)
          break
        case 'j': case 'J':
          e.preventDefault(); move(1); break
        case 'k': case 'K':
          e.preventDefault(); move(-1); break
        case 'Enter':
          if (!selectedId || isInteractive(e.target)) return
          e.preventDefault()
          setDrawerTab('detail')
          setDrawerOpen(true)
          break
        case ' ':
          if (isInteractive(e.target)) return
          e.preventDefault()
          setDrawerOpen(!drawerOpen)
          break
        case '1': case '2': case '3': case '4': case '5':
          e.preventDefault()
          setViewMode(VIEW_ORDER[Number(e.key) - 1])
          break
        default:
          break
      }
    }

    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [
    objects, selectedId, select, drawerOpen, setDrawerOpen, setDrawerTab,
    setViewMode, quickCaptureOpen, setQuickCaptureOpen,
    categoryManagerOpen, setCategoryManagerOpen,
    commandPaletteOpen, setCommandPaletteOpen, sideOverlay,
    shortcuts, selected, applyView, setFilters,
  ])

  const showScrim = (narrow && sideOverlay) || (drawerFloating && drawerOpen)

  return (
    <div
      className="app"
      data-side={railed ? 'collapsed' : 'open'}
      data-side-overlay={narrow && sideOverlay ? 'open' : 'closed'}
      data-drawer={drawerOpen ? 'open' : 'closed'}
    >
      <header className="app-topbar">
        <TopBar onToggleSidebar={toggleSidebar} />
      </header>

      <div className="app-body">
        <aside className="app-sidebar">
          <Sidebar
            collapsed={railed}
            onToggle={toggleSidebar}
            onNavigate={() => { if (narrow) setSideOverlay(false) }}
          />
        </aside>

        <main className="app-main">
          {loading && <div className="loading-bar" />}
          {error && (
            <div className="error-banner">
              <span className="truncate">加载失败：{error}</span>
              <button type="button" className="btn btn-sm status-push" onClick={() => void reloadObjects()}>
                重试
              </button>
            </div>
          )}
          {isPage
            ? (nav.page === 'settings' ? <SettingsPage /> : <ShortcutsPage lastScope={lastScope.current} />)
            : <ObjectListView />}
          {/* 贴主区底部的 Agent 对话框：独立页面下同样可用，展开时主区内容相应收缩 */}
          <AgentDock />
        </main>

        <aside className="app-drawer">
          <DetailDrawer />
        </aside>
      </div>

      <footer className="app-statusbar">
        <StatusBar />
      </footer>

      {showScrim && (
        <div
          className="app-scrim"
          onClick={() => { if (narrow && sideOverlay) setSideOverlay(false); else setDrawerOpen(false) }}
        />
      )}

      {/* 以下三个浮层自己判断显隐 */}
      <QuickCapture />
      <CategoryManager />
      <CommandPalette />
    </div>
  )
}
