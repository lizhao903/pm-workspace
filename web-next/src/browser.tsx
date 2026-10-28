import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type MouseEvent as ReactMouseEvent } from 'react'
import './browser.css'
import {
  DRIVE_HOME, DRIVE_RECENT, DRIVE_SHARED, GOOGLE_SCOPES, HOME_URL,
  avatarColorFor, classify, displayUrl, driveUrl, normalize, parseDrive, portOf, sameUrl, seedDriveFiles,
  type BrowserTab, type DriveFile, type DriveMime, type DriveRoute, type GoogleAccount, type TabKind,
} from './browserdata'
import { PageTitle } from './topbar'
import { cls, timeAgo } from './ui'
import { newId } from './ids'

// 内置浏览器：多标签，原型和普通网页用真 iframe 加载；Google Drive 是模拟的文件浏览器和预览
// 标签页只在组件内存里，刷新不保留

export interface ProtoEntry { id: string; name: string; project: string; projectId?: string; port: number; status: 'running' | 'stopped' | 'starting' | 'stopping' | 'error' }

interface Recent { url: string; title: string; kind: TabKind; at: string }

const MAX_TABS = 12
const isFrame = (k: TabKind) => k === 'web' || k === 'proto'
const protoUrl = (p: ProtoEntry) => `http://127.0.0.1:${p.port}`
const openExternal = (url: string) => { if (classify(url) !== 'home') window.open(url, '_blank', 'noopener') }
const KIND_LABEL: Record<TabKind, string> = { home: '新标签页', proto: '原型', drive: 'Google Drive', web: '网页' }
const STATUS_LABEL: Record<ProtoEntry['status'], string> = { running: '运行中', stopped: '未运行', starting: '启动中', stopping: '停止中', error: '启动失败' }

function protoFor(url: string, protos: ProtoEntry[]) {
  if (classify(url) !== 'proto') return undefined
  const port = portOf(url)
  return protos.find((p) => p.port === port)
}

function titleOf(url: string, protos: ProtoEntry[]): string {
  const kind = classify(url)
  if (kind === 'home') return '新标签页'
  if (kind === 'proto') {
    const p = protoFor(url, protos)
    return p ? `${p.name} · ${p.project}` : displayUrl(url)
  }
  if (kind === 'drive') {
    const r = parseDrive(url)
    if (r.view === 'my') return '我的云端硬盘'
    if (r.view === 'shared') return '与我共享'
    if (r.view === 'recent') return '最近'
    if (r.view !== 'folder' && r.view !== 'file') return 'Google Drive'
    const id = r.id
    return seedDriveFiles.find((f) => f.id === id)?.name ?? 'Google Drive'
  }
  try {
    const u = new URL(url)
    const q = u.hostname.endsWith('google.com') && u.pathname === '/search' ? u.searchParams.get('q') : null
    return q ? `${q} - 搜索` : u.hostname.replace(/^www\./, '')
  } catch { return url }
}

const makeTab = (url: string, title: string): BrowserTab => {
  const kind = classify(url)
  return { id: newId('bt'), url, title, kind, history: [url], cursor: 0, loading: isFrame(kind) }
}

// memo：App 别的状态变化时不跟着重渲染；回调要由 App 传稳定的引用
export const BrowserPage = memo(function BrowserPage({ openRequest, prototypes, onStartProto, google, onGoogleLogin, onGoogleLogout, hidden = false }: {
  /** 外部要求打开一个地址（来自项目原型、视频预览、发布链接）；n 变化即触发一次，同 url 已开就切过去 */
  openRequest: { url: string; title?: string; n: number } | null
  prototypes: ProtoEntry[]
  onStartProto: (id: string) => void
  google: GoogleAccount | null
  onGoogleLogin: (acc: GoogleAccount) => void
  onGoogleLogout: () => void
  /** 切到别的模块时浏览器只是藏起来：iframe 留着保住页面，新标签页这类纯数据视图不渲染 */
  hidden?: boolean
}) {
  const [tabs, setTabs] = useState<BrowserTab[]>(() => [makeTab(HOME_URL, '新标签页')])
  /** 新标签页里项目分组手动展开 / 收起过的，按项目记；没记的按「有原型在跑就展开」 */
  const [protoOpen, setProtoOpen] = useState<Record<string, boolean>>({})
  const [active, setActive] = useState(() => tabs[0].id)
  const [reloads, setReloads] = useState<Record<string, number>>({})
  /** 标签 id -> 等它启动完要打开的原型 id */
  const [pending, setPending] = useState<Record<string, string>>({})
  const [recent, setRecent] = useState<Recent[]>([])
  const [loginOpen, setLoginOpen] = useState(false)
  const [ctx, setCtx] = useState<{ id: string; x: number; y: number } | null>(null)
  const tab = tabs.find((t) => t.id === active) ?? tabs[0]
  /** 原型没在运行：iframe 不挂，也就不该转圈 */
  const idleProto = (t: BrowserTab) => { const p = protoFor(t.url, prototypes); return !!p && p.status !== 'running' }

  const patch = (id: string, f: (t: BrowserTab) => BrowserTab) => setTabs((ts) => ts.map((t) => (t.id === id ? f(t) : t)))
  const remember = (url: string, title: string) => {
    const kind = classify(url)
    if (kind === 'home') return
    const at = new Date().toISOString()
    setRecent((rs) => [{ url, title, kind, at }, ...rs.filter((r) => !sameUrl(r.url, url))].slice(0, 8))
  }

  const navigate = (id: string, url: string, title?: string) => {
    const kind = classify(url)
    const name = title ?? titleOf(url, prototypes)
    patch(id, (t) => {
      const history = [...t.history.slice(0, t.cursor + 1), url]
      return { ...t, url, kind, title: name, history, cursor: history.length - 1, loading: isFrame(kind) }
    })
    remember(url, name)
  }
  const go = (delta: number) => {
    const i = tab.cursor + delta
    if (i < 0 || i >= tab.history.length) return
    const url = tab.history[i]
    const kind = classify(url)
    patch(tab.id, (t) => ({ ...t, url, kind, cursor: i, title: titleOf(url, prototypes), loading: isFrame(kind) }))
  }
  const reload = (id: string) => {
    const t = tabs.find((x) => x.id === id)
    if (!t) return
    setReloads((r) => ({ ...r, [id]: (r[id] ?? 0) + 1 }))
    if (isFrame(t.kind)) patch(id, (x) => ({ ...x, loading: true }))
  }
  /** 新开一个标签；满 12 个时改在当前标签里打开 */
  const openTab = (url: string, title?: string) => {
    const name = title ?? titleOf(url, prototypes)
    if (tabs.length >= MAX_TABS) { navigate(tab.id, url, name); return tab.id }
    const t = makeTab(url, name)
    setTabs((ts) => [...ts, t])
    setActive(t.id)
    remember(url, name)
    return t.id
  }
  const closeTab = (id: string) => {
    const rest = tabs.filter((t) => t.id !== id)
    if (!rest.length) { const n = makeTab(HOME_URL, '新标签页'); setTabs([n]); setActive(n.id); return }
    setTabs(rest)
    if (id === active) setActive(rest[Math.max(0, tabs.findIndex((t) => t.id === id) - 1)].id)
  }
  const closeOthers = (id: string) => {
    const keep = tabs.filter((t) => t.id === id || t.pinned)
    setTabs(keep)
    setActive(id)
  }
  // 固定的标签排在最前面
  const togglePin = (id: string) => setTabs((ts) => {
    const next = ts.map((t) => (t.id === id ? { ...t, pinned: !t.pinned } : t))
    return [...next.filter((t) => t.pinned), ...next.filter((t) => !t.pinned)]
  })

  // 外部打开请求：n 变一次处理一次；ref 防止 StrictMode 下重复开标签
  const handledN = useRef<number | null>(null)
  useEffect(() => {
    if (!openRequest || handledN.current === openRequest.n) return
    handledN.current = openRequest.n
    const url = normalize(openRequest.url)
    const hit = tabs.find((t) => sameUrl(t.url, url))
    if (hit) { setActive(hit.id); return }
    openTab(url, openRequest.title)
  }, [openRequest?.n])

  // 「启动并打开」：等原型状态变成 running 再在那个标签里加载
  useEffect(() => {
    const ids = Object.keys(pending)
    if (!ids.length) return
    const next = { ...pending }
    let changed = false
    for (const tid of ids) {
      const p = prototypes.find((x) => x.id === pending[tid])
      const alive = tabs.some((t) => t.id === tid)
      if (!p || !alive || p.status === 'error') { delete next[tid]; changed = true; continue }
      if (p.status === 'running') { delete next[tid]; changed = true; navigate(tid, protoUrl(p)) }
    }
    if (changed) setPending(next)
  }, [prototypes, pending])

  // 当前标签滚进可视范围（窄屏标签栏是横向滚动的）
  const stripRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = stripRef.current?.querySelector<HTMLElement>('.br-tab.on')
    const strip = stripRef.current
    if (!el || !strip) return
    if (el.offsetLeft < strip.scrollLeft) strip.scrollLeft = el.offsetLeft - 8
    else if (el.offsetLeft + el.offsetWidth > strip.scrollLeft + strip.clientWidth) strip.scrollLeft = el.offsetLeft + el.offsetWidth - strip.clientWidth + 8
  }, [active, tabs.length])
  // 标签压到最窄还放不下（窄屏、固定的多）时，右边出「全部标签」
  const [overflow, setOverflow] = useState(false)
  useLayoutEffect(() => {
    const strip = stripRef.current
    if (!strip) return
    const check = () => setOverflow(strip.scrollWidth > strip.clientWidth + 1)
    check()
    const ro = new ResizeObserver(check)
    ro.observe(strip)
    return () => ro.disconnect()
  }, [tabs])

  const startAndOpen = (p: ProtoEntry, tabId = tab.id) => {
    if (p.status === 'running') { navigate(tabId, protoUrl(p)); return }
    setPending((m) => ({ ...m, [tabId]: p.id }))
    if (p.status === 'stopped' || p.status === 'error') onStartProto(p.id)
  }

  return (
    <div className="br-page">
      <PageTitle desc={tab.title} actions={
        <button className="btn btn-outline" disabled={tab.kind === 'home'} onClick={() => openExternal(tab.url)}>在系统浏览器打开</button>
      }>浏览器</PageTitle>

      <div className="br-tabbar">
      <div className="br-tabs" role="tablist" ref={stripRef}>
        {tabs.map((t) => (
          <div key={t.id} role="tab" aria-selected={t.id === tab.id} title={t.pinned ? `${t.title}（右键可取消固定）` : t.title}
            className={cls('br-tab', t.id === tab.id && 'on', t.pinned && 'br-tab-pinned')}
            onClick={() => setActive(t.id)}
            onAuxClick={(e) => { if (e.button === 1 && !t.pinned) closeTab(t.id) }}
            onContextMenu={(e) => { e.preventDefault(); setCtx({ id: t.id, x: e.clientX, y: e.clientY }) }}>
            <TabIcon kind={t.kind} busy={!!pending[t.id] || (!!t.loading && !idleProto(t))} />
            {!t.pinned && <span className="br-tab-title ellipsis">{t.title}</span>}
            {!t.pinned && (
              <button className="br-tab-btn br-tab-pin" title="固定标签页" onClick={(e) => { e.stopPropagation(); togglePin(t.id) }}>
                <svg viewBox="0 0 16 16" width="10" height="10"><path d="M6 2h4l-.5 4 2.5 2.5H4L6.5 6 6 2ZM8 8.5V14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" strokeLinecap="round" /></svg>
              </button>
            )}
            {!t.pinned && (
              <button className="br-tab-btn" title="关闭标签页" onClick={(e) => { e.stopPropagation(); closeTab(t.id) }}>
                <svg viewBox="0 0 16 16" width="9" height="9"><path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
              </button>
            )}
          </div>
        ))}
      </div>
        {/* 新建按钮在滚动区外面，标签再多也看得到 */}
        <button className="br-tab-add" disabled={tabs.length >= MAX_TABS} onClick={() => openTab(HOME_URL, '新标签页')}
          title={tabs.length >= MAX_TABS ? `最多 ${MAX_TABS} 个标签页` : '新标签页'}>
          <svg viewBox="0 0 16 16" width="12" height="12"><path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
        </button>
        {overflow && <AllTabs tabs={tabs} active={tab.id} onPick={setActive} />}
      </div>

      <Toolbar tab={tab} google={google} onBack={() => go(-1)} onForward={() => go(1)} onReload={() => reload(tab.id)}
        onSubmit={(url) => navigate(tab.id, url)} onLogin={() => setLoginOpen(true)} onLogout={onGoogleLogout} />

      <div className="br-body">
        {tabs.map((t) => (
          <div key={t.id} className="br-view" hidden={t.id !== tab.id}>
            {/* 新标签页只渲染当前这一个，藏起来时也不渲染 */}
            {t.kind === 'home' && t.id === tab.id && !hidden && (
              <HomeView prototypes={prototypes} pendingProto={pending[t.id]} google={google} recent={recent}
                open={protoOpen} onToggle={(k, v) => setProtoOpen((m) => ({ ...m, [k]: v }))}
                onOpen={(url, title) => navigate(t.id, url, title)} onStart={(p) => startAndOpen(p, t.id)} onLogin={() => setLoginOpen(true)} />
            )}
            {isFrame(t.kind) && (
              <FrameView tab={t} reloadKey={reloads[t.id] ?? 0} proto={protoFor(t.url, prototypes)} starting={!!pending[t.id]}
                onLoaded={() => patch(t.id, (x) => ({ ...x, loading: false }))}
                onStart={(p) => { if (p.status === 'stopped' || p.status === 'error') onStartProto(p.id) }} />
            )}
            {t.kind === 'drive' && (
              <DriveView url={t.url} google={google} onLogin={() => setLoginOpen(true)}
                onNavigate={(url) => navigate(t.id, url)} onOpenFile={(f) => openTab(driveUrl(f), f.name)} />
            )}
          </div>
        ))}
      </div>

      {ctx && (() => {
        const t = tabs.find((x) => x.id === ctx.id)
        if (!t) return null
        return (
          <TabMenu x={ctx.x} y={ctx.y} onClose={() => setCtx(null)} items={[
            { label: t.pinned ? '取消固定' : '固定标签页', run: () => togglePin(t.id) },
            { label: '刷新', run: () => reload(t.id) },
            { label: '在系统浏览器打开', run: () => openExternal(t.url), disabled: t.kind === 'home' },
            { label: '关闭其他标签页', run: () => closeOthers(t.id), disabled: tabs.length === 1 },
            { label: '关闭', run: () => closeTab(t.id), disabled: t.pinned },
          ]} />
        )
      })()}

      {loginOpen && <LoginModal onClose={() => setLoginOpen(false)} onDone={(acc) => { setLoginOpen(false); onGoogleLogin(acc) }} />}
    </div>
  )
})

/* ---------- 标签与工具栏 ---------- */

function TabIcon({ kind, busy }: { kind: TabKind; busy: boolean }) {
  return busy ? <span className="br-spin" /> : <KindIcon kind={kind} />
}

function KindIcon({ kind }: { kind: TabKind }) {
  const common = { viewBox: '0 0 16 16', width: 13, height: 13, className: cls('br-kicon', `br-kicon-${kind}`), fill: 'none', stroke: 'currentColor', strokeWidth: 1.4 }
  if (kind === 'home') return <svg {...common}><rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1" /><rect x="9" y="2.5" width="4.5" height="4.5" rx="1" /><rect x="2.5" y="9" width="4.5" height="4.5" rx="1" /><rect x="9" y="9" width="4.5" height="4.5" rx="1" /></svg>
  if (kind === 'proto') return <svg {...common}><rect x="1.8" y="2.8" width="12.4" height="8.4" rx="1.4" /><path d="M5.5 13.5h5M8 11.2v2.3" strokeLinecap="round" /></svg>
  if (kind === 'drive') return <svg {...common} strokeLinejoin="round"><path d="M5.8 2.5h4.4l4 7-2.2 3.8H4l-2.2-3.8 4-7Z" /><path d="M5.8 2.5 10 9.5M1.8 9.5h8.4M10.2 2.5 6 9.5" /></svg>
  return <svg {...common}><circle cx="8" cy="8" r="6" /><path d="M2 8h12M8 2c1.8 1.8 2.6 3.8 2.6 6S9.8 12.2 8 14M8 2C6.2 3.8 5.4 5.8 5.4 8s.8 4.2 2.6 6" /></svg>
}

function Toolbar({ tab, google, onBack, onForward, onReload, onSubmit, onLogin, onLogout }: {
  tab: BrowserTab
  google: GoogleAccount | null
  onBack: () => void
  onForward: () => void
  onReload: () => void
  onSubmit: (url: string) => void
  onLogin: () => void
  onLogout: () => void
}) {
  const [addr, setAddr] = useState(displayUrl(tab.url))
  const [editing, setEditing] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => { if (!editing) setAddr(displayUrl(tab.url)) }, [tab.id, tab.url, editing])
  // 新标签页直接把光标放进地址栏
  useEffect(() => { if (tab.kind === 'home') inputRef.current?.focus() }, [tab.id])

  const submit = (e: FormEvent) => {
    e.preventDefault()
    onSubmit(normalize(addr))
    setEditing(false)
    inputRef.current?.blur()
  }

  return (
    <div className="br-bar">
      <button className="icon-btn" disabled={tab.cursor <= 0} onClick={onBack} title="后退">
        <svg viewBox="0 0 16 16" width="14" height="14"><path d="M10 3 5 8l5 5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>
      <button className="icon-btn" disabled={tab.cursor >= tab.history.length - 1} onClick={onForward} title="前进">
        <svg viewBox="0 0 16 16" width="14" height="14"><path d="m6 3 5 5-5 5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>
      <button className="icon-btn" onClick={onReload} title="刷新">
        <svg viewBox="0 0 16 16" width="14" height="14"><path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5v3h-3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>
      <form className="br-addr" onSubmit={submit}>
        {tab.kind !== 'home' && !editing && <span className={cls('br-kind', `br-kind-${tab.kind}`)}><KindIcon kind={tab.kind} />{KIND_LABEL[tab.kind]}</span>}
        <input ref={inputRef} value={addr} spellCheck={false} autoComplete="off" placeholder="输入网址、端口号或搜索内容"
          onChange={(e) => setAddr(e.target.value)}
          onFocus={(e) => { setEditing(true); e.target.select() }}
          onBlur={() => setEditing(false)}
          onKeyDown={(e) => { if (e.key === 'Escape') { setAddr(displayUrl(tab.url)); inputRef.current?.blur() } }} />
      </form>
      <AccountButton google={google} onLogin={onLogin} onLogout={onLogout} />
    </div>
  )
}

function AccountButton({ google, onLogin, onLogout }: { google: GoogleAccount | null; onLogin: () => void; onLogout: () => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const off = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    window.addEventListener('mousedown', off)
    return () => window.removeEventListener('mousedown', off)
  }, [open])

  if (!google) {
    return (
      <button className="act br-login-btn" onClick={onLogin}>
        <span className="br-g">G</span><span className="br-login-text">登录 Google</span>
      </button>
    )
  }
  return (
    <div className="menu-wrap" ref={ref}>
      <button className="br-acc" title={google.email} onClick={() => setOpen((o) => !o)}>
        <GAvatar acc={google} size={28} />
      </button>
      {open && (
        <div className="menu br-acc-menu">
          <div className="br-acc-head">
            <GAvatar acc={google} size={40} />
            <div className="br-acc-text">
              <div className="br-acc-name ellipsis">{google.name}</div>
              <div className="muted ellipsis">{google.email}</div>
              <div className="faint">{timeAgo(google.connected_at)}登录</div>
            </div>
          </div>
          <div className="menu-sep" />
          <div className="menu-label">已授权的范围</div>
          <div className="br-acc-scopes">
            {GOOGLE_SCOPES.map((s) => (
              <div key={s.key} className={cls('br-scope-line', !google.scopes.includes(s.key) && 'off')}>
                <span className="br-scope-mark">{google.scopes.includes(s.key) ? '已授权' : '未授权'}</span>
                <span className="ellipsis">{s.label}</span>
              </div>
            ))}
          </div>
          <div className="menu-sep" />
          <button className="menu-item" onClick={() => { setOpen(false); onLogin() }}>切换账号或重新授权</button>
          <button className="menu-item br-danger-item" onClick={() => { setOpen(false); onLogout() }}>退出登录</button>
        </div>
      )}
    </div>
  )
}

function GAvatar({ acc, size }: { acc: GoogleAccount; size: number }) {
  const glyph = Array.from(acc.name.trim() || acc.email)[0]?.toUpperCase() ?? '?'
  return <span className="br-avatar" style={{ width: size, height: size, fontSize: size * 0.44, ['--c' as string]: acc.avatarColor }}>{glyph}</span>
}

function TabMenu({ x, y, items, onClose }: { x: number; y: number; items: { label: string; run: () => void; disabled?: boolean }[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const off = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) onClose() }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('mousedown', off)
    window.addEventListener('keydown', esc)
    window.addEventListener('resize', onClose)
    return () => { window.removeEventListener('mousedown', off); window.removeEventListener('keydown', esc); window.removeEventListener('resize', onClose) }
  }, [])
  // 贴着鼠标弹出，但不超出视口
  const left = Math.min(x, window.innerWidth - 200)
  const top = Math.min(y, window.innerHeight - items.length * 32 - 16)
  return (
    <div ref={ref} className="menu br-ctx" style={{ left: Math.max(8, left), top: Math.max(8, top) }}>
      {items.map((it) => (
        <button key={it.label} className="menu-item" disabled={it.disabled} onClick={() => { onClose(); it.run() }}>{it.label}</button>
      ))}
    </div>
  )
}

function AllTabs({ tabs, active, onPick }: { tabs: BrowserTab[]; active: string; onPick: (id: string) => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const off = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('mousedown', off)
    window.addEventListener('keydown', esc)
    return () => { window.removeEventListener('mousedown', off); window.removeEventListener('keydown', esc) }
  }, [open])
  return (
    <div className="menu-wrap br-tab-all-wrap" ref={ref}>
      <button className="br-tab-add" title={`全部标签（${tabs.length} 个）`} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <svg viewBox="0 0 16 16" width="12" height="12"><path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>
      {open && (
        <div className="menu br-all-menu">
          <div className="menu-label">全部标签 · {tabs.length} 个</div>
          {tabs.map((t) => (
            <button key={t.id} className={cls('menu-item', t.id === active && 'on')} title={t.title} onClick={() => { setOpen(false); onPick(t.id) }}>
              <KindIcon kind={t.kind} /><span className="ellipsis">{t.title}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/* ---------- 新标签页 ---------- */

/** 原型超过这个数才给搜索框；搜索结果最多渲染这么多条 */
const PROTO_SEARCH_MIN = 8
const PROTO_MATCH_LIMIT = 60
/** 展开的组先露几条（在跑的排在前面），其余点「还有 N 个」再展 */
const PROTO_GROUP_SHOW = 6
const isLive = (p: ProtoEntry) => p.status === 'running' || p.status === 'starting'
const PROTO_RANK: Record<ProtoEntry['status'], number> = { running: 0, starting: 1, error: 2, stopping: 3, stopped: 4 }

function HomeView({ prototypes, pendingProto, google, recent, open, onToggle, onOpen, onStart, onLogin }: {
  prototypes: ProtoEntry[]
  pendingProto?: string
  google: GoogleAccount | null
  recent: Recent[]
  open: Record<string, boolean>
  onToggle: (key: string, open: boolean) => void
  onOpen: (url: string, title?: string) => void
  onStart: (p: ProtoEntry) => void
  onLogin: () => void
}) {
  const [q, setQ] = useState('')
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean)
  // 按项目分组：有原型在跑的项目排前面并默认展开，其次是有启动失败的，其余按项目顺序；组内在跑的在前
  const groups = useMemo(() => {
    const m = new Map<string, { key: string; name: string; items: ProtoEntry[] }>()
    for (const p of prototypes) {
      const key = p.projectId ?? p.project
      const g = m.get(key) ?? { key, name: p.project, items: [] }
      g.items.push(p)
      m.set(key, g)
    }
    return [...m.values()]
      .map((g) => ({ ...g, items: [...g.items].sort((a, b) => PROTO_RANK[a.status] - PROTO_RANK[b.status]), running: g.items.filter((p) => p.status === 'running').length, failed: g.items.filter((p) => p.status === 'error').length, live: g.items.some(isLive) }))
      .sort((a, b) => Number(b.live) - Number(a.live) || Number(b.failed > 0) - Number(a.failed > 0))
  }, [prototypes])
  const running = prototypes.filter((p) => p.status === 'running').length
  const hit = (p: ProtoEntry) => { const hay = `${p.name} ${p.project} ${p.port}`.toLowerCase(); return words.every((w) => hay.includes(w)) }
  // 搜索时只看命中的，命中的组全展开，渲染条数封顶；不搜索时按组展开收起，不封顶
  const shown = words.length ? groups.map((g) => ({ ...g, items: g.items.filter(hit) })).filter((g) => g.items.length) : groups
  let budget = words.length ? PROTO_MATCH_LIMIT : Infinity
  const matched = shown.reduce((n, g) => n + g.items.length, 0)

  const row = (p: ProtoEntry) => {
    const waiting = pendingProto === p.id
    return (
      <div key={p.id} className="br-proto">
        <span className={`proto-light pl-${p.status}`} />
        <div className="br-proto-text">
          <div className="ellipsis br-proto-name">{p.name}</div>
          <div className="faint ellipsis">127.0.0.1:{p.port} · {STATUS_LABEL[p.status]}</div>
        </div>
        {p.status === 'running' ? (
          <button className="act act-primary" onClick={() => onOpen(protoUrl(p))}>打开</button>
        ) : waiting || p.status === 'starting' ? (
          <button className="act" disabled>{waiting ? '启动后自动打开' : '启动中'}</button>
        ) : p.status === 'stopping' ? (
          <button className="act" disabled>停止中</button>
        ) : (
          <button className="act" onClick={() => onStart(p)}>{p.status === 'error' ? '重新启动并打开' : '启动并打开'}</button>
        )}
      </div>
    )
  }

  return (
    <div className="br-home">
      {/* 最近打开放最上面；还没打开过就不占位置 */}
      {recent.length > 0 && (
      <section className="br-card">
        <div className="br-card-head"><h2>最近打开</h2></div>
          <div className="br-recent">
            {recent.map((r) => (
              <button key={r.url} className="br-recent-row" onClick={() => onOpen(r.url, r.title)}>
                <KindIcon kind={r.kind} />
                <span className="ellipsis br-recent-title">{r.title}</span>
                <span className="faint ellipsis br-recent-url">{displayUrl(r.url)}</span>
                <span className="faint br-recent-at">{timeAgo(r.at)}</span>
              </button>
            ))}
          </div>
      </section>
      )}

      <section className="br-card">
        <div className="br-card-head br-card-head-wrap">
          <h2>项目原型</h2><span className="faint br-card-sub">{running} / {prototypes.length} 个在运行</span>
          {prototypes.length > PROTO_SEARCH_MIN && (
            <div className="search search-sm br-proto-search">
              <svg viewBox="0 0 16 16" width="13" height="13"><circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
              <input value={q} placeholder="搜原型、项目、端口" aria-label="搜索项目原型" onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Escape' && q) { e.stopPropagation(); setQ('') } }} />
              {q && <button type="button" className="search-clear" title="清空" onClick={() => setQ('')}><svg viewBox="0 0 16 16" width="10" height="10"><path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg></button>}
            </div>
          )}
        </div>
        {!prototypes.length ? <div className="br-none">「项目」里还没有登记原型</div>
          : !shown.length ? <div className="br-none">没有匹配「{q.trim()}」的原型</div>
          : (
            <div className="br-pgroups">
              {shown.map((g) => {
                // 原型不多（不出搜索框）时全展开；等着启动的那个所在的组也展开
                const isOpen = words.length > 0 || (open[g.key] ?? (g.live || prototypes.length <= PROTO_SEARCH_MIN || g.items.some((p) => p.id === pendingProto)))
                const full = words.length > 0 || open[`${g.key}:all`]
                const cap = full ? budget : Math.min(budget, PROTO_GROUP_SHOW)
                const items = isOpen && cap > 0 ? g.items.slice(0, cap) : []
                const hiddenN = !full && isOpen ? g.items.length - items.length : 0
                budget -= items.length
                return (
                  <div key={g.key} className="br-pgroup">
                    <button className="br-pgroup-head" aria-expanded={isOpen} disabled={words.length > 0} onClick={() => onToggle(g.key, !isOpen)}>
                      <svg className={cls('br-chev', isOpen && 'on')} viewBox="0 0 16 16" width="12" height="12"><path d="m6 4 4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
                      <span className="ellipsis br-pgroup-name">{g.name}</span>
                      <span className={cls('br-pgroup-meta', g.running > 0 && 'on')}>
                        {words.length ? `${g.items.length} 个匹配` : g.running ? `${g.running} 个在运行` : `${g.items.length} 个原型`}
                        {!words.length && g.failed > 0 && <span className="br-pgroup-bad"> · {g.failed} 个启动失败</span>}
                      </span>
                    </button>
                    {items.length > 0 && (
                      <div className="br-protos">
                        {items.map(row)}
                        {hiddenN > 0 && <button className="br-pgroup-rest" onClick={() => onToggle(`${g.key}:all`, true)}>还有 {hiddenN} 个原型</button>}
                      </div>
                    )}
                  </div>
                )
              })}
              {words.length > 0 && matched > PROTO_MATCH_LIMIT && <div className="br-none">还有 {matched - PROTO_MATCH_LIMIT} 个匹配的没显示，继续输入筛选</div>}
            </div>
          )}
      </section>

      <section className="br-card">
        <div className="br-card-head"><h2>Google Drive</h2>{google && <span className="faint ellipsis">{google.email}</span>}</div>
        {google ? (
          <div className="br-drive-links">
            <button className="br-drive-link" onClick={() => onOpen(DRIVE_HOME)}><DriveIcon mime="folder" />我的云端硬盘</button>
            <button className="br-drive-link" onClick={() => onOpen(DRIVE_SHARED)}><DriveIcon mime="doc" />与我共享</button>
            <button className="br-drive-link" onClick={() => onOpen(DRIVE_RECENT)}><DriveIcon mime="sheet" />最近</button>
          </div>
        ) : (
          <div className="br-drive-guest">
            <span className="muted">登录 Google 后可以在这里浏览、预览云端硬盘里的文件</span>
            <button className="act act-primary" onClick={onLogin}>登录 Google</button>
          </div>
        )}
      </section>
    </div>
  )
}

/* ---------- 原型 / 网页 ---------- */

function FrameView({ tab, reloadKey, proto, starting, onLoaded, onStart }: {
  tab: BrowserTab
  reloadKey: number
  proto?: ProtoEntry
  starting: boolean
  onLoaded: () => void
  onStart: (p: ProtoEntry) => void
}) {
  if (tab.kind === 'proto' && proto && proto.status !== 'running') {
    const busy = starting || proto.status === 'starting' || proto.status === 'stopping'
    return (
      <div className="br-center">
        <div className="br-notice">
          <span className={`proto-light pl-${proto.status}`} />
          <div className="br-notice-title">这个原型没在运行</div>
          <div className="muted">{proto.project} / {proto.name} · 127.0.0.1:{proto.port} · {STATUS_LABEL[proto.status]}</div>
          <button className="btn btn-primary" disabled={busy} onClick={() => onStart(proto)}>
            {proto.status === 'starting' || starting ? '启动中' : proto.status === 'stopping' ? '停止中' : '启动原型'}
          </button>
          <div className="faint">启动完成后这里会自动加载</div>
        </div>
      </div>
    )
  }
  return (
    <div className="br-frame-wrap">
      {tab.loading && <div className="br-progress" />}
      {tab.kind === 'web' && (
        <div className="br-hint">
          <span className="ellipsis">部分网站不允许嵌入显示，可以用系统浏览器打开</span>
          <button className="act act-quiet" onClick={() => openExternal(tab.url)}>在系统浏览器打开</button>
        </div>
      )}
      <iframe key={reloadKey} className="br-frame" src={tab.url} title={tab.title} onLoad={onLoaded}
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups" />
    </div>
  )
}

/* ---------- Google Drive ---------- */

const MIME_META: Record<DriveMime, { label: string; glyph: string; color: string }> = {
  doc: { label: '文档', glyph: '文', color: '#3d78d8' },
  sheet: { label: '表格', glyph: '表', color: '#2f9e55' },
  slide: { label: '幻灯片', glyph: '演', color: '#e5a00d' },
  pdf: { label: 'PDF', glyph: 'PDF', color: '#d9443a' },
  folder: { label: '文件夹', glyph: '夹', color: '#868e96' },
  image: { label: '图片', glyph: '图', color: '#9c5bd6' },
  video: { label: '视频', glyph: '视', color: '#c2255c' },
}

function DriveIcon({ mime, size = 22 }: { mime: DriveMime; size?: number }) {
  const m = MIME_META[mime]
  return (
    <span className="br-ficon" style={{ width: size, height: size, fontSize: size * (m.glyph.length > 1 ? 0.3 : 0.5), ['--c' as string]: m.color }}>
      {mime === 'folder'
        ? <svg viewBox="0 0 16 16" width={size * 0.62} height={size * 0.62}><path d="M1.8 4.2c0-.7.5-1.2 1.2-1.2h3.3l1.4 1.6H13c.7 0 1.2.5 1.2 1.2v6.2c0 .7-.5 1.2-1.2 1.2H3c-.7 0-1.2-.5-1.2-1.2Z" fill="currentColor" /></svg>
        : m.glyph}
    </span>
  )
}

const fmtDate = (iso: string) => {
  const d = new Date(iso)
  return `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function DriveView({ url, google, onLogin, onNavigate, onOpenFile }: {
  url: string
  google: GoogleAccount | null
  onLogin: () => void
  onNavigate: (url: string) => void
  onOpenFile: (f: DriveFile) => void
}) {
  if (!google) {
    return (
      <div className="br-center">
        <div className="br-notice">
          <div className="br-g-word">Google</div>
          <div className="br-notice-title">登录后查看 Google Drive</div>
          <div className="muted">连上 Google 账号后，可以在内置浏览器里浏览、预览云端硬盘里的文件。登录后设置 / 连接器里的 Google Drive、Google 日历会一并连上。</div>
          <button className="btn btn-primary" onClick={onLogin}>登录 Google</button>
        </div>
      </div>
    )
  }
  if (!google.scopes.includes('drive.readonly')) {
    return (
      <div className="br-center">
        <div className="br-notice">
          <div className="br-notice-title">没有授权查看 Drive 文件</div>
          <div className="muted">{google.email} 登录时没有勾选「查看 Google Drive 文件」，重新授权一次就能看了。</div>
          <button className="btn btn-primary" onClick={onLogin}>重新授权</button>
        </div>
      </div>
    )
  }
  const route = parseDrive(url)
  if (route.view === 'file') return <FilePreview url={url} file={seedDriveFiles.find((f) => f.id === route.id)} />
  return <DriveBrowser route={route} onNavigate={onNavigate} onOpenFile={onOpenFile} />
}

function DriveBrowser({ route, onNavigate, onOpenFile }: {
  route: Exclude<DriveRoute, { view: 'file' }>
  onNavigate: (url: string) => void
  onOpenFile: (f: DriveFile) => void
}) {
  const [q, setQ] = useState('')
  const [mode, setMode] = useState<'list' | 'grid'>('list')
  const kw = q.trim().toLowerCase()
  const folder = route.view === 'folder' ? seedDriveFiles.find((f) => f.id === route.id) : undefined
  const ordered = (xs: DriveFile[]) => [...xs].sort((a, b) => (a.mime === 'folder') === (b.mime === 'folder') ? b.modified_at.localeCompare(a.modified_at) : a.mime === 'folder' ? -1 : 1)
  const items = kw
    ? ordered(seedDriveFiles.filter((f) => f.name.toLowerCase().includes(kw)))
    : route.view === 'folder' ? ordered(seedDriveFiles.filter((f) => f.parent === route.id))
      : route.view === 'shared' ? ordered(seedDriveFiles.filter((f) => f.shared && f.owner !== '我'))
        : route.view === 'recent' ? seedDriveFiles.filter((f) => f.mime !== 'folder').sort((a, b) => b.modified_at.localeCompare(a.modified_at)).slice(0, 12)
          : ordered(seedDriveFiles.filter((f) => !f.parent && f.owner === '我'))

  // 面包屑：从当前文件夹往上找到根
  const crumbs: DriveFile[] = []
  for (let f = folder; f; f = f.parent ? seedDriveFiles.find((x) => x.id === f!.parent) : undefined) crumbs.unshift(f)
  const rootLabel = route.view === 'shared' ? '与我共享' : route.view === 'recent' ? '最近' : '我的云端硬盘'
  const open = (f: DriveFile) => (f.mime === 'folder' ? (setQ(''), onNavigate(driveUrl(f))) : onOpenFile(f))
  const navs: { view: 'my' | 'shared' | 'recent'; label: string; url: string }[] = [
    { view: 'my', label: '我的云端硬盘', url: DRIVE_HOME },
    { view: 'shared', label: '与我共享', url: DRIVE_SHARED },
    { view: 'recent', label: '最近', url: DRIVE_RECENT },
  ]
  const current = route.view === 'folder' ? 'my' : route.view

  return (
    <div className="br-drive">
      <nav className="br-drive-side">
        <div className="br-g-word br-drive-brand">Drive</div>
        {navs.map((n) => (
          <button key={n.view} className={cls('br-drive-nav', current === n.view && 'on')} onClick={() => { setQ(''); onNavigate(n.url) }}>{n.label}</button>
        ))}
      </nav>
      <div className="br-drive-main">
        <div className="br-drive-top">
          <div className="search br-drive-search">
            <svg viewBox="0 0 16 16" width="13" height="13"><circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="m10.5 10.5 3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
            <input value={q} placeholder="在云端硬盘中搜索" onChange={(e) => setQ(e.target.value)} />
            {q && <button className="search-clear" title="清空" onClick={() => setQ('')}>
              <svg viewBox="0 0 16 16" width="10" height="10"><path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
            </button>}
          </div>
          <div className="seg seg-sm">
            <button className={cls(mode === 'list' && 'on')} onClick={() => setMode('list')}>列表</button>
            <button className={cls(mode === 'grid' && 'on')} onClick={() => setMode('grid')}>网格</button>
          </div>
        </div>
        <div className="br-crumbs">
          {kw ? <span>搜索「{q.trim()}」<span className="faint"> · {items.length} 项</span></span> : <>
            <button className={cls('br-crumb', !crumbs.length && 'on')} onClick={() => onNavigate(navs.find((n) => n.view === current)!.url)}>{rootLabel}</button>
            {crumbs.map((c, i) => (
              <span key={c.id} className="br-crumb-seg">
                <span className="faint">/</span>
                <button className={cls('br-crumb', i === crumbs.length - 1 && 'on')} onClick={() => onNavigate(driveUrl(c))}>{c.name}</button>
              </span>
            ))}
          </>}
        </div>
        {!items.length ? (
          <div className="br-none br-drive-empty">{kw ? '没有找到匹配的文件' : '这里还没有文件'}</div>
        ) : mode === 'list' ? (
          <div className="br-flist">
            <div className="br-frow br-frow-head"><span>名称</span><span className="br-fcol-owner">所有者</span><span>修改时间</span><span className="br-fcol-size">大小</span></div>
            {items.map((f) => (
              <button key={f.id} className="br-frow" onDoubleClick={() => open(f)} onClick={() => open(f)}>
                <span className="br-fname"><DriveIcon mime={f.mime} /><span className="ellipsis">{f.name}</span>{f.shared && <span className="tag br-shared">共享</span>}</span>
                <span className="br-fcol-owner muted ellipsis">{f.owner}</span>
                <span className="muted ellipsis">{fmtDate(f.modified_at)}</span>
                <span className="br-fcol-size faint">{f.size ?? '-'}</span>
              </button>
            ))}
          </div>
        ) : (
          <div className="br-fgrid">
            {items.map((f) => (
              <button key={f.id} className={cls('br-fcard', f.mime === 'folder' && 'br-fcard-folder')} onClick={() => open(f)}>
                {f.mime !== 'folder' && <div className="br-fthumb" style={{ ['--c' as string]: MIME_META[f.mime].color }}><DriveIcon mime={f.mime} size={36} /></div>}
                <div className="br-fcard-name"><DriveIcon mime={f.mime} size={18} /><span className="ellipsis">{f.name}</span></div>
                {f.mime !== 'folder' && <div className="faint br-fcard-meta ellipsis">{f.owner} · {fmtDate(f.modified_at)}</div>}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function FilePreview({ url, file }: { url: string; file?: DriveFile }) {
  return (
    <div className="br-preview">
      <div className="br-preview-bar">
        {file && <DriveIcon mime={file.mime} />}
        <div className="br-preview-text">
          <div className="br-preview-name ellipsis">{file?.name ?? 'Google Drive 文件'}</div>
          {file && <div className="faint ellipsis">{MIME_META[file.mime].label} · {file.owner} · {fmtDate(file.modified_at)}修改{file.size ? ` · ${file.size}` : ''}</div>}
        </div>
        <button className="act" onClick={() => openExternal(url)}>在 Google Drive 打开</button>
      </div>
      <div className="br-preview-body">
        {!file ? (
          <div className="br-notice">
            <div className="br-notice-title">原型里预览不了这个文件</div>
            <div className="muted">只有演示数据里的文件能在这里预览，可以去 Google Drive 打开原文件。</div>
          </div>
        ) : file.mime === 'doc' ? <DocPreview file={file} />
          : file.mime === 'sheet' ? <SheetPreview file={file} />
            : file.mime === 'slide' ? <SlidePreview file={file} />
              : <MediaPreview file={file} />}
      </div>
    </div>
  )
}

function docSections(name: string): [string, string[]][] {
  if (name.includes('周报')) return [
    ['本周完成', ['任务看板支持按负责人分组，灰度给两个小组试用，反馈整体正向。', '消息中心改版完成第二轮评审，交互稿定稿。']],
    ['下周计划', ['推进 AI 助手接入方案的技术评审，确认模型切换的边界。', '整理第四季度路线图，周五前同步给业务方。']],
    ['风险', ['设计资源紧张，消息中心视觉稿可能延后三天。']],
  ]
  if (name.includes('纪要')) return [
    ['结论', ['第四季度优先做任务流转 v3 和消息中心改版，AI 助手放到下个迭代。', '竞品对比表每月更新一次，由产品负责。']],
    ['待办', ['产品：补齐任务流转的异常流程，10 月 31 日前。', '研发：给出 AI 助手的接口预估，11 月 4 日前。']],
  ]
  if (name.includes('访谈')) return [
    ['访谈对象', ['共 8 位，覆盖个人开发者、小团队负责人和大客户的项目经理。']],
    ['主要发现', ['多数人把待办分散记在三四个工具里，最痛的是找不到上下文。', '对 AI 自动整理需求兴趣很高，但担心改错原文。']],
  ]
  return [
    ['背景', [`「${name}」要解决的是需求从提出到上线之间信息散落、状态不透明的问题。`, '现状下产品、设计、研发各自维护一份进度，每周对齐要花大量时间。']],
    ['目标', ['一个地方看清每条需求走到哪一步、卡在谁那里。', '状态变化自动通知相关人，不靠人去催。']],
    ['方案概述', ['按「提出 - 评审 - 设计 - 开发 - 验收 - 上线」六个阶段流转，每个阶段有明确的进入和退出条件。', '阶段之间的交接自动生成待办，指派给下一环节的负责人。']],
    ['验收标准', ['新建需求到首次评审的平均时长下降 30%。', '每周对齐会时长减半。']],
  ]
}

function DocPreview({ file }: { file: DriveFile }) {
  return (
    <div className="br-doc">
      <h1>{file.name.replace(/\.\w+$/, '')}</h1>
      <div className="faint br-doc-meta">{file.owner} · 最后编辑于 {fmtDate(file.modified_at)}</div>
      {docSections(file.name).map(([h, ps]) => (
        <section key={h}>
          <h3>{h}</h3>
          {ps.map((p) => <p key={p}>{p}</p>)}
        </section>
      ))}
    </div>
  )
}

function SheetPreview({ file }: { file: DriveFile }) {
  const rows: string[][] = file.name.includes('竞品')
    ? [['功能', '我们', '竞品 A', '竞品 B', '备注'], ['需求流转', '支持', '支持', '部分', 'B 只有看板'], ['AI 整理需求', '支持', '不支持', '支持', ''], ['多端同步', '支持', '支持', '支持', ''], ['离线可用', '支持', '不支持', '不支持', '差异点'], ['价格（月）', '0', '68', '45', '人民币']]
    : file.name.includes('OKR')
      ? [['目标', '关键结果', '负责人', '进度', '信心'], ['提升协作效率', '对齐会时长减半', '陈默', '60%', '高'], ['提升协作效率', '需求平均交付周期 -20%', '我', '35%', '中'], ['扩大用户', '周活跃 1.2 万', '林夏', '72%', '高'], ['扩大用户', '付费转化 4%', '周宁', '28%', '低']]
      : [['指标', '本周', '上周', '环比', '目标'], ['周活跃用户', '11,820', '11,240', '+5.2%', '12,000'], ['新建需求数', '1,936', '1,802', '+7.4%', '-'], ['平均交付周期（天）', '6.8', '7.3', '-6.8%', '6.0'], ['付费转化率', '3.6%', '3.4%', '+0.2pt', '4.0%'], ['工单量', '142', '168', '-15.5%', '-']]
  return (
    <div className="br-sheet-wrap">
      <table className="br-sheet">
        <thead><tr><th />{rows[0].map((_, i) => <th key={i}>{String.fromCharCode(65 + i)}</th>)}</tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className={cls(i === 0 && 'br-sheet-head')}><th>{i + 1}</th>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>
          ))}
          {[0, 1, 2].map((k) => <tr key={`e${k}`}><th>{rows.length + k + 1}</th>{rows[0].map((_, j) => <td key={j} />)}</tr>)}
        </tbody>
      </table>
    </div>
  )
}

function SlidePreview({ file }: { file: DriveFile }) {
  const pages = ['目标与范围', '本季度进展', '重点需求', '排期与风险']
  return (
    <div className="br-slides">
      <div className="br-slide br-slide-main">
        <div className="br-slide-title">{file.name}</div>
        <div className="br-slide-sub">{file.owner} · {fmtDate(file.modified_at)}</div>
      </div>
      <div className="br-slide-strip">
        {pages.map((p, i) => (
          <div key={p} className="br-slide br-slide-thumb">
            <span className="br-slide-n">{i + 2}</span>
            <div className="br-slide-thumb-title">{p}</div>
            <div className="br-slide-lines"><i /><i /><i /></div>
          </div>
        ))}
      </div>
    </div>
  )
}

function MediaPreview({ file }: { file: DriveFile }) {
  if (file.mime === 'video') return (
    <div className="br-media br-media-video">
      <svg viewBox="0 0 48 48" width="56" height="56"><circle cx="24" cy="24" r="22" fill="rgba(255,255,255,0.14)" /><path d="M19 15v18l15-9Z" fill="#fff" /></svg>
      <div className="br-media-cap">视频预览 · {file.size ?? ''} · 03:42</div>
    </div>
  )
  if (file.mime === 'image') return (
    <div className="br-media br-media-image" style={{ ['--c' as string]: MIME_META.image.color }}>
      <svg viewBox="0 0 48 48" width="56" height="56" fill="none" stroke="currentColor" strokeWidth="2"><rect x="6" y="9" width="36" height="30" rx="3" /><circle cx="17" cy="19" r="3.5" /><path d="m8 36 11-11 8 8 5-5 10 10" strokeLinejoin="round" /></svg>
      <div className="br-media-cap">图片预览 · {file.size ?? ''}</div>
    </div>
  )
  return (
    <div className="br-pdf">
      {[1, 2].map((n) => (
        <div key={n} className="br-pdf-page">
          {n === 1 && <div className="br-pdf-title">{file.name}</div>}
          <div className="br-slide-lines br-pdf-lines">{Array.from({ length: 10 }, (_, i) => <i key={i} />)}</div>
          <span className="br-pdf-n">{n} / 12</span>
        </div>
      ))}
    </div>
  )
}

/* ---------- 模拟 Google 登录 ---------- */

const SUGGESTED = [
  { name: '陈一', email: 'chen.yi.pm@gmail.com' },
  { name: '陈一（工作）', email: 'chenyi@yirenzhixia.app' },
]

function LoginModal({ onClose, onDone }: { onClose: () => void; onDone: (acc: GoogleAccount) => void }) {
  const [step, setStep] = useState<'pick' | 'consent' | 'working'>('pick')
  const [who, setWho] = useState<{ name: string; email: string } | null>(null)
  const [custom, setCustom] = useState(false)
  const [email, setEmail] = useState('')
  const [err, setErr] = useState('')
  const [scopes, setScopes] = useState<string[]>(GOOGLE_SCOPES.map((s) => s.key))

  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape' && step !== 'working') onClose() }
    window.addEventListener('keydown', esc)
    return () => window.removeEventListener('keydown', esc)
  }, [step])

  // 「允许」之后模拟 0.8 秒的授权回调
  useEffect(() => {
    if (step !== 'working' || !who) return
    const t = window.setTimeout(() => {
      onDone({ email: who.email, name: who.name, avatarColor: avatarColorFor(who.email), scopes, connected_at: new Date().toISOString() })
    }, 800)
    return () => window.clearTimeout(t)
  }, [step])

  const pickCustom = (e: FormEvent) => {
    e.preventDefault()
    const v = email.trim()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) { setErr('请输入有效的邮箱地址'); return }
    setWho({ email: v, name: v.split('@')[0] })
    setStep('consent')
  }
  const onMask = (e: ReactMouseEvent) => { if (e.target === e.currentTarget && step !== 'working') onClose() }

  return (
    <div className="br-mask" onMouseDown={onMask}>
      <div className="br-modal" role="dialog" aria-modal="true" aria-label="登录 Google">
        <div className="br-g-word br-modal-brand">Google</div>
        {step === 'pick' && <>
          <h2 className="br-modal-title">选择账号</h2>
          <div className="muted br-modal-sub">以继续使用「一人之下」</div>
          {!custom ? (
            <div className="br-acc-list">
              {SUGGESTED.map((a) => (
                <button key={a.email} className="br-acc-pick" onClick={() => { setWho(a); setStep('consent') }}>
                  <span className="br-avatar" style={{ width: 32, height: 32, fontSize: 14, ['--c' as string]: avatarColorFor(a.email) }}>{Array.from(a.name)[0]}</span>
                  <span className="br-acc-text"><span className="br-acc-name ellipsis">{a.name}</span><span className="muted ellipsis">{a.email}</span></span>
                </button>
              ))}
              <button className="br-acc-pick" onClick={() => setCustom(true)}>
                <span className="br-avatar br-avatar-blank" style={{ width: 32, height: 32 }}>
                  <svg viewBox="0 0 16 16" width="14" height="14"><circle cx="8" cy="5.5" r="2.6" fill="none" stroke="currentColor" strokeWidth="1.4" /><path d="M3 13.5c.6-2.4 2.6-3.6 5-3.6s4.4 1.2 5 3.6" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
                </span>
                <span className="br-acc-text"><span className="br-acc-name">使用其他账号</span></span>
              </button>
            </div>
          ) : (
            <form className="br-email-form" onSubmit={pickCustom}>
              <label className="field">
                <span className="field-label">邮箱地址</span>
                <input autoFocus value={email} className={cls(err && 'bad')} placeholder="name@gmail.com" onChange={(e) => { setEmail(e.target.value); setErr('') }} />
                {err && <span className="field-err">{err}</span>}
              </label>
              <div className="br-modal-foot">
                <button type="button" className="btn btn-ghost" onClick={() => { setCustom(false); setErr('') }}>返回</button>
                <span className="spacer" />
                <button type="submit" className="btn btn-primary">下一步</button>
              </div>
            </form>
          )}
          <div className="faint br-modal-note">这是原型里的模拟登录，不会把账号信息发给 Google。</div>
        </>}

        {step === 'consent' && who && <>
          <h2 className="br-modal-title">「一人之下」想要访问你的 Google 账号</h2>
          <button className="br-acc-chip" onClick={() => setStep('pick')} title="换一个账号">
            <span className="br-avatar" style={{ width: 20, height: 20, fontSize: 10, ['--c' as string]: avatarColorFor(who.email) }}>{Array.from(who.name)[0]?.toUpperCase()}</span>
            <span className="ellipsis">{who.email}</span>
          </button>
          <div className="br-scope-list">
            {GOOGLE_SCOPES.map((s) => (
              <label key={s.key} className="br-scope">
                <input type="checkbox" checked={scopes.includes(s.key)}
                  onChange={(e) => setScopes((xs) => (e.target.checked ? [...xs, s.key] : xs.filter((x) => x !== s.key)))} />
                <span className="br-scope-text">
                  <span className="br-scope-label">{s.label}</span>
                  <span className="faint">{s.desc}</span>
                  <span className="mono faint br-scope-key">{s.key}</span>
                </span>
              </label>
            ))}
          </div>
          <div className="muted br-modal-note">登录后，设置 / 连接器里的 Google Drive、Google 日历会一并连上；随时可以在这里退出登录或在连接器里断开。</div>
          <div className="br-modal-foot">
            <button className="btn btn-ghost" onClick={onClose}>取消</button>
            <span className="spacer" />
            <button className="btn btn-primary" disabled={!scopes.length} onClick={() => setStep('working')}>允许</button>
          </div>
        </>}

        {step === 'working' && (
          <div className="br-working">
            <span className="br-spin br-spin-lg" />
            <div>正在完成授权…</div>
          </div>
        )}
      </div>
    </div>
  )
}
