import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router'
import { useWorkspaces } from '../data'
import {
  commandProviders, pluginProblems, registeredCommands, setShellHost, useActiveModules, type CommandDef, type ModuleDef, type ShellApi,
} from '../plugin'
import { cls, DrawerHostContext, IconButton, IconSearch, setTheme, SubnavHostContext, TopbarContext, useTheme } from '../ui'
import { CommandPalette } from './CommandPalette'
import { IconMenu, IconNewSession, IconSectionChevron, IconSideToggle, ModuleIcon } from './icons'
import { useMenuMarks, type MenuMark } from './marks'
import { moduleIconKey } from './pluginIcons'
import { QuickSessionHost } from './QuickSession'
import { buildMenu, isGroupFolded, readFolded, toggleId, writeFolded } from './menu'
import { useSideCollapsed } from './sideCollapse'
import { modKey, type PaletteItem } from './palette'
import { PluginNotice } from './PluginNotice'
import { CATALOG_IDS, homeModule, resolveCurrent, useCurrentWorkspaceId, workspaceMenuGroups } from './workspace'
import { useWorkspaceSwitch } from './useWorkspaceSwitch'
import { WorkspaceSwitcher } from './WorkspaceSwitcher'
import './shell.css'

/**
 * 外壳：一级菜单 | 二级菜单位置 | 顶栏加内容 | 抽屉位置，照原型 web-next/src/App.tsx。
 * 宽屏侧栏可收起成图标；760px 以下侧栏收成从左边滑出的抽屉，顶栏左边出菜单按钮。
 */
export function Shell({ modules }: { modules: ModuleDef[] }) {
  const navigate = useNavigate()
  const location = useLocation()
  const { resolved, pref } = useTheme()
  // 插件停用后它的模块从菜单里去掉；内核模块一直在
  const live = useActiveModules(modules)
  const liveIds = useMemo(() => new Set(live.map((m) => m.id)), [live])
  const marks = useMenuMarks(liveIds)
  // 菜单分组和顺序由当前工作台决定；第一次取工作台时先不出菜单（免得闪一下默认的），取不到就用默认分组
  const workspaces = useWorkspaces()
  const current = resolveCurrent(workspaces.data, useCurrentWorkspaceId())
  const menu = useMemo(() => {
    if (current) return buildMenu(live, workspaceMenuGroups(current), CATALOG_IDS)
    if (workspaces.isPending) return { groups: [], foot: [] }
    return buildMenu(live)
  }, [live, current, workspaces.isPending])
  // 切工作台只换菜单；不在设置里时打开新工作台的默认模块
  const { switchTo, prompt: switchPrompt } = useWorkspaceSwitch((w) => {
    if (location.pathname.startsWith('/settings')) return
    const home = homeModule(w, live)
    if (home) void navigate('/' + home.path)
  })

  // 和设置 / 外观的「收起一级菜单」是同一个状态
  const [collapsed, setCollapsed] = useSideCollapsed()
  const [folded, setFolded] = useState(readFolded)
  useEffect(() => { writeFolded(folded) }, [folded])

  // 窄屏的菜单抽屉
  const [menuOpen, setMenuOpen] = useState(false)
  const sideRef = useRef<HTMLElement>(null)
  const menuBtnRef = useRef<HTMLButtonElement>(null)
  const closeMenu = useCallback(() => {
    setMenuOpen(false)
    menuBtnRef.current?.focus()
  }, [])
  useEffect(() => {
    if (!menuOpen) return
    sideRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      e.preventDefault()
      closeMenu()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [menuOpen, closeMenu])

  const [palette, setPalette] = useState<PaletteItem[] | null>(null)
  // 快速新建会话：侧栏按钮、命令面板、Cmd/Ctrl+J 唤出；建好后跳到会话页，第一句话由会话页自动发出
  const [quick, setQuick] = useState(false)
  const openQuick = () => {
    setMenuOpen(false)
    setPalette(null)
    setQuick(true)
  }
  const convPath = live.find((m) => m.id === 'conversations')?.path
  const shellApi: ShellApi = useMemo(() => ({ navigate: (to) => { void navigate(to) } }), [navigate])
  // 插件拿到的 api.shell 经这里转给外壳
  useEffect(() => {
    setShellHost(shellApi)
    return () => setShellHost(null)
  }, [shellApi])
  const toItem = useCallback((c: CommandDef): PaletteItem => ({
    id: 'cmd-' + c.id, group: c.group, title: c.title, sub: c.sub, keywords: c.keywords,
    run: () => { void Promise.resolve(c.run({ shell: shellApi })).catch((e) => console.error(`命令 ${c.id} 执行出错`, e)) },
  }), [shellApi])

  // 打开那一刻拼一次条目，面板开着时外面重渲染也不重拼
  const buildItems = (): PaletteItem[] => [
    { id: 'k-theme', group: '操作', title: resolved === 'dark' ? '切换到浅色' : '切换到深色', keywords: '配色 主题 dark light 外观', run: () => setTheme(resolved === 'dark' ? 'light' : 'dark') },
    ...(pref === 'system' ? [] : [{ id: 'k-theme-system', group: '操作', title: '配色跟随系统', keywords: '配色 主题 system 外观', run: () => setTheme('system') }]),
    ...(convPath ? [{ id: 'k-quick-session', group: '操作', title: '新建会话', sub: '挑个 Agent 直接开聊（' + modKey() + 'J）', keywords: 'session chat agent 会话 对话 新建', run: openQuick }] : []),
    { id: 'k-side', group: '操作', title: collapsed ? '展开左侧菜单' : '收起左侧菜单', keywords: '侧栏 菜单 sidebar', run: () => setCollapsed(!collapsed) },
    ...registeredCommands().map(toItem),
    ...[...menu.groups.flatMap((g) => g.items), ...menu.foot].map((m) => ({
      id: 'go-' + m.id, group: '跳转', title: m.label, sub: '功能模块', keywords: m.id, run: () => { void navigate('/' + m.path) },
    })),
  ]
  const openPalette = () => {
    setMenuOpen(false)
    setQuick(false)
    setPalette(buildItems())
  }
  const search = useCallback(async (q: string) => {
    const lists = await Promise.all(commandProviders().map((p) => p.fn(q).catch((e) => {
      console.warn(`命令面板数据源 ${p.source} 出错`, e)
      return [] as CommandDef[]
    })))
    return lists.flat().map(toItem)
  }, [toItem])

  // Cmd/Ctrl+K 开关命令面板。用 ref 拿最新的条目构造，免得每次渲染都重绑监听
  const toggleRef = useRef<() => void>(() => {})
  const quickRef = useRef<() => void>(() => {})
  useEffect(() => {
    toggleRef.current = () => {
      if (palette) setPalette(null)
      else openPalette()
    }
    quickRef.current = () => {
      if (quick) setQuick(false)
      else if (convPath) openQuick()
    }
  })
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return
      const k = e.key.toLowerCase()
      if (k !== 'k' && k !== 'j') return
      e.preventDefault()
      if (k === 'k') toggleRef.current()
      else quickRef.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const [topSlot, setTopSlot] = useState<HTMLElement | null>(null)
  const [subnavSlot, setSubnavSlot] = useState<HTMLElement | null>(null)
  const [drawerSlot, setDrawerSlot] = useState<HTMLElement | null>(null)

  const item = (m: ModuleDef, hidden = false) => (
    <MenuItem key={m.id} m={m} mark={marks[m.id]} collapsed={collapsed} hidden={hidden} onPick={() => setMenuOpen(false)} />
  )

  return (
    <TopbarContext.Provider value={topSlot}>
    <SubnavHostContext.Provider value={subnavSlot}>
    <DrawerHostContext.Provider value={drawerSlot}>
    <div className={cls('shell', menuOpen && 'shell-menu-open')}>
      <aside ref={sideRef} tabIndex={-1} className={cls('shell-side', collapsed && 'side-collapsed')} aria-label="一级菜单">
        <div className="brand-row">
          <WorkspaceSwitcher list={workspaces.data ?? []} current={current} collapsed={collapsed}
            onSwitch={(w) => { setMenuOpen(false); switchTo(w) }}
            onManage={() => { setMenuOpen(false); void navigate('/settings/workspace') }} />
          <IconButton size="sm" className="side-toggle" label={collapsed ? '展开菜单' : '收起菜单'} aria-expanded={!collapsed}
            onClick={() => setCollapsed(!collapsed)}>
            <IconSideToggle collapsed={collapsed} />
          </IconButton>
        </div>
        <div className="side-actions">
          <button type="button" className="side-act" onClick={openPalette} title="搜索和命令（Cmd/Ctrl+K）" aria-label="搜索和命令">
            <IconSearch size={15} />
            <span className="side-label">搜索</span>
          </button>
          {convPath && (
            <button type="button" className="side-act" onClick={openQuick} title={`新建会话（${modKey()}J）`} aria-label="新建会话">
              <IconNewSession />
              <span className="side-label">新建会话</span>
            </button>
          )}
        </div>
        <nav className="side-group" aria-label="功能模块">
          {/* 分组名为空只留间距；菜单收起时分组之间画一条线、不显示标题也不折叠 */}
          {menu.groups.map((g, gi) => {
            const isFolded = isGroupFolded(g, folded)
            return (
              <div key={g.id} className={cls('side-sec', gi > 0 && 'side-sec-gap', isFolded && 'side-sec-folded')}>
                {g.name && (
                  <button type="button" className="side-sec-title" aria-expanded={!isFolded} title={isFolded ? '展开' : '折叠'}
                    onClick={() => setFolded(toggleId(folded, g.id))}>
                    <IconSectionChevron />
                    <span>{g.name}</span>
                    {/* 折叠后组里有事等你处理，红点挪到标题上 */}
                    {isFolded && g.items.some((m) => marks[m.id]?.alert) && <span className="side-dot" />}
                  </button>
                )}
                {/* 折叠的组里只留当前打开的那一项（由样式按 active 判断） */}
                {g.items.map((m) => item(m, isFolded))}
              </div>
            )
          })}
        </nav>
        <div className="side-foot">
          <PluginNotice problems={pluginProblems()} />
          {menu.foot.map((m) => item(m))}
        </div>
      </aside>
      {menuOpen && <div className="shell-scrim" onClick={closeMenu} aria-hidden="true" />}
      <div className="shell-subnav" ref={setSubnavSlot} />
      <div className="shell-main">
        <header className="topbar">
          <IconButton ref={menuBtnRef} className="tb-menu" label="打开菜单" aria-expanded={menuOpen} onClick={() => setMenuOpen(true)}>
            <IconMenu />
          </IconButton>
          <div className="tb-slot" ref={setTopSlot} />
          <IconButton className="tb-search" label="搜索和命令" onClick={openPalette}>
            <IconSearch size={15} />
          </IconButton>
        </header>
        <main className="shell-content">
          <Outlet />
        </main>
      </div>
      <div className="shell-drawer" ref={setDrawerSlot} />
      {switchPrompt}
      {palette && <CommandPalette items={palette} search={search} onClose={() => setPalette(null)} />}
      {quick && convPath && (
        <QuickSessionHost onClose={() => setQuick(false)}
          onOpen={(id) => { setQuick(false); void navigate(`/${convPath}?s=${encodeURIComponent(id)}`) }} />
      )}
    </div>
    </DrawerHostContext.Provider>
    </SubnavHostContext.Provider>
    </TopbarContext.Provider>
  )
}

function MenuItem({ m, mark, collapsed, hidden, onPick }: {
  m: ModuleDef
  mark?: MenuMark
  collapsed: boolean
  hidden: boolean
  onPick: () => void
}) {
  return (
    <NavLink to={'/' + m.path} onClick={onPick} title={collapsed ? m.label + (mark?.alert ? '：' + mark.hint : '') : undefined}
      aria-label={m.label + (mark?.alert ? '，' + mark.hint : '')}
      className={({ isActive }) => cls('side-item', isActive && 'active', hidden && !isActive && 'side-item-folded')}>
      <ModuleIcon id={m.id} icon={moduleIconKey(m.id)} />
      <span className="side-label">{m.label}</span>
      {/* 菜单上不放数量，只在有事等你处理时给个红点 */}
      {mark?.alert && <span className="side-dot" title={mark.hint} />}
    </NavLink>
  )
}
