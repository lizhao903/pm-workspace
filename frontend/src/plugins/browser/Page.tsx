// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 内置浏览器页（BR-01b，SPEC-browser-1 到 4）：整页没有顶栏，最上面一排标签，下面一行工具栏（后退、前进、刷新、地址栏、
// 在系统浏览器打开、账号），再下面是当前标签的内容。标签存后端，刷新后恢复（store.ts）。
// 别的模块要在这里打开地址时跳 /browser?open=<地址>&title=<标题>，处理完从地址栏去掉。
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode, type RefObject } from 'react'
import { useSearchParams } from 'react-router'
import { IconButton, LoadingState, cls } from '../../core/ui'
import {
  errorText, isApiError, prototypeUp, useAddBrowserAllow, useBrowserAllowlist, useBrowserGoogle, useDomainSettings, useTerminalProtoAction, useTerminalPrototypes,
  type BrowserGoogleState, type TerminalPrototype,
} from '../../core/data'
import { FrameView } from './Frame'
import { AccountButton, LoginDialog, OAuthDone } from './Google'
import { HomeView } from './Home'
import { IconBack, IconDown, IconExternal, IconForward, IconPin, IconPlus, IconReload, IconX, KindIcon, TabIcon } from './icons'
import { KIND_LABEL, MAX_TABS, activeTab, displayUrl, frameAllowed, hostOf, normalize, protoFor, protoUrl, type FrameAllow, type Tab } from './model'
import * as store from './store'
import './browser.css'

export default function BrowserPage() {
  const [params] = useSearchParams()
  const oauth = params.get('oauth')
  // 授权回调回到的窗口：不碰标签，只显示结果
  if (oauth) return <OAuthDone ok={oauth === 'ok'} connector={params.get('connector') ?? ''} message={params.get('message') ?? ''} />
  return <BrowserView />
}

/**
 * 标签栏、工具栏和内容。一级菜单整页用它；会话旁边的浏览器（SPEC-sessions-1.36）也用它，和一级菜单是同一套标签。
 * bar：工具栏下面多放的一行（会话里的链接）
 */
export function BrowserView({ bar }: { bar?: ReactNode }) {
  const { tabs, ready, saveFailed, recent, reloads, pending } = store.useBrowserState()
  const [params, setParams] = useSearchParams()
  const protos = useTerminalPrototypes()
  const protoAction = useTerminalProtoAction()
  const google = useBrowserGoogle()
  // 能不能嵌入（BR-02a）：白名单走插件接口；内网域名后缀只在设置里开着时带上，内网域名插件没装就没有
  const allowlist = useBrowserAllowlist()
  const domains = useDomainSettings()
  const addAllow = useAddBrowserAllow()
  const allow: FrameAllow = {
    hosts: allowlist.data?.map((e) => e.host) ?? [],
    suffix: domains.data?.enabled ? domains.data.suffix : undefined,
  }
  const allowChecking = allowlist.isPending || domains.isPending
  const [loginOpen, setLoginOpen] = useState(false)
  const [ctx, setCtx] = useState<{ id: string; x: number; y: number } | null>(null)
  const [notice, setNotice] = useState('')
  const list = protos.data ?? []

  useEffect(() => { void store.initBrowser() }, [])
  useEffect(() => { if (protos.data) store.syncPrototypes(protos.data) }, [protos.data])

  // 别的模块的「打开」：等标签读回来再处理，处理完从地址栏去掉，刷新不会再开一次
  const openParam = params.get('open')
  useEffect(() => {
    if (!ready || !openParam) return
    store.openRequest(openParam, params.get('title') ?? undefined)
    setParams((p) => { const n = new URLSearchParams(p); n.delete('open'); n.delete('title'); return n }, { replace: true })
  }, [ready, openParam, params, setParams])

  const tab = activeTab(tabs)
  if (!ready || !tab) return <div className="br-page"><LoadingState /></div>

  const startProto = (p: TerminalPrototype, tabId?: string) => {
    if (tabId) {
      if (prototypeUp(p.status)) { store.openHere(protoUrl(p), undefined, tabId); return }
      store.waitFor(tabId, p.id)
    }
    if (p.status === 'stopped' || p.status === 'crashed') {
      protoAction.mutate({ projectId: p.project_id, protoId: p.id, action: 'start' }, {
        onError: (e) => {
          if (tabId) store.stopWaiting(tabId)
          setNotice(`启动「${p.name}」失败：${errorText(e)}`)
        },
      })
    }
  }
  const protoError = protos.isError ? `读不到项目原型：${errorText(protos.error)}` : ''

  const allowHost = (url: string) => {
    const host = hostOf(url)
    if (!host) return
    addAllow.mutate({ host }, {
      // 已经在白名单里（409）不算失败，刷回来就会挂上 iframe
      onError: (e) => { if (!(isApiError(e) && e.code === 'conflict')) setNotice(`加进白名单失败：${errorText(e)}`) },
    })
  }
  const allowedOf = (t: Tab) => frameAllowed(t.url, allow)

  return (
    <div className="br-page">
      <TabBar tabs={tabs.tabs} active={tab.id} pending={pending} protos={list} allowed={allowedOf}
        onContext={(id, x, y) => setCtx({ id, x, y })} />

      <Toolbar tab={tab} google={google.data} saveFailed={saveFailed}
        onLogin={() => setLoginOpen(true)} onSubmit={(url) => store.openHere(url)} />

      {bar}

      {notice && (
        <div className="br-notice-bar" role="status">
          <span className="ellipsis">{notice}</span>
          <button type="button" className="br-tab-btn" aria-label="关闭提示" onClick={() => setNotice('')}><IconX /></button>
        </div>
      )}

      <div className="br-body">
        {tabs.tabs.map((t) => (
          <div key={t.id} className="br-view" hidden={t.id !== tab.id}>
            {t.kind === 'home' && t.id === tab.id && (
              <HomeView prototypes={list} protoError={protoError} pendingProto={pending[t.id]} google={google.data} recent={recent}
                onOpen={(url, title) => store.openHere(url, title, t.id)} onStart={(p) => startProto(p, t.id)} onLogin={() => setLoginOpen(true)} />
            )}
            {t.kind !== 'home' && !allowedOf(t) && allowChecking && <LoadingState />}
            {t.kind !== 'home' && (allowedOf(t) || !allowChecking) && (
              <FrameView tab={t} reloadKey={reloads[t.id] ?? 0} proto={protoFor(t.url, list)} starting={!!pending[t.id]}
                allowed={allowedOf(t)} adding={addAllow.isPending && addAllow.variables?.host === hostOf(t.url)}
                onAllow={() => allowHost(t.url)} onExternal={() => store.openExternal(t.url)}
                onLoaded={() => store.frameLoaded(t.id)} onStart={(p) => startProto(p, t.id)} />
            )}
          </div>
        ))}
      </div>

      {ctx && <TabContextMenu ctx={ctx} tabs={tabs.tabs} onClose={() => setCtx(null)} />}
      {loginOpen && <LoginDialog google={google.data} onClose={() => setLoginOpen(false)} />}
    </div>
  )
}

/** 原型没在运行、等着启动时，或者不在白名单里时 iframe 不挂，也就不转圈 */
function busyOf(t: Tab, pending: Record<string, string>, protos: readonly TerminalPrototype[], allowed: boolean) {
  if (pending[t.id]) return true
  const p = protoFor(t.url, protos)
  return t.loading && allowed && !(p && !prototypeUp(p.status))
}

function TabBar({ tabs, active, pending, protos, allowed, onContext }: {
  tabs: Tab[]
  active: string
  pending: Record<string, string>
  protos: readonly TerminalPrototype[]
  allowed: (t: Tab) => boolean
  onContext: (id: string, x: number, y: number) => void
}) {
  const stripRef = useRef<HTMLDivElement>(null)
  // 当前标签滚进可视范围（窄屏标签栏是横向滚动的）
  useEffect(() => {
    const strip = stripRef.current
    const el = strip?.querySelector<HTMLElement>('.br-tab.on')
    if (!el || !strip) return
    if (el.offsetLeft < strip.scrollLeft) strip.scrollLeft = el.offsetLeft - 8
    else if (el.offsetLeft + el.offsetWidth > strip.scrollLeft + strip.clientWidth) strip.scrollLeft = el.offsetLeft + el.offsetWidth - strip.clientWidth + 8
  }, [active, tabs.length])
  // 标签压到最窄还放不下时，右边出「全部标签」
  const [overflow, setOverflow] = useState(false)
  useLayoutEffect(() => {
    const strip = stripRef.current
    if (!strip) return
    const check = () => setOverflow(strip.scrollWidth > strip.clientWidth + 1)
    check()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(check)
    ro.observe(strip)
    return () => ro.disconnect()
  }, [tabs])
  const full = tabs.length >= MAX_TABS

  return (
    <div className="br-tabbar">
      <div className="br-tabs" role="tablist" aria-label="浏览器标签页" ref={stripRef}>
        {tabs.map((t) => (
          <div key={t.id} role="tab" aria-selected={t.id === active} aria-label={t.title}
            title={t.pinned ? `${t.title}（右键可取消固定）` : t.title}
            className={cls('br-tab', t.id === active && 'on', t.pinned && 'br-tab-pinned')}
            onClick={() => store.activate(t.id)}
            onAuxClick={(e) => { if (e.button === 1 && !t.pinned) store.close(t.id) }}
            onContextMenu={(e) => { e.preventDefault(); onContext(t.id, e.clientX, e.clientY) }}>
            <TabIcon kind={t.kind} busy={busyOf(t, pending, protos, allowed(t))} />
            {!t.pinned && <span className="br-tab-title ellipsis">{t.title}</span>}
            {!t.pinned && (
              <button type="button" className="br-tab-btn br-tab-pin" title="固定标签页" aria-label="固定标签页"
                onClick={(e) => { e.stopPropagation(); store.togglePin(t.id) }}><IconPin /></button>
            )}
            {!t.pinned && (
              <button type="button" className="br-tab-btn" title="关闭标签页" aria-label="关闭标签页"
                onClick={(e) => { e.stopPropagation(); store.close(t.id) }}><IconX /></button>
            )}
          </div>
        ))}
      </div>
      <button type="button" className="br-tab-add" disabled={full} onClick={() => store.newTab()}
        title={full ? `最多 ${MAX_TABS} 个标签页` : '新标签页'} aria-label="新标签页"><IconPlus /></button>
      {overflow && <AllTabs tabs={tabs} active={active} />}
    </div>
  )
}

function useDismiss(open: boolean, ref: RefObject<HTMLElement | null>, close: () => void, resize = false) {
  useEffect(() => {
    if (!open) return
    const off = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) close() }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    window.addEventListener('mousedown', off)
    window.addEventListener('keydown', esc)
    if (resize) window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('mousedown', off)
      window.removeEventListener('keydown', esc)
      window.removeEventListener('resize', close)
    }
  }, [open, ref, close, resize])
}

function AllTabs({ tabs, active }: { tabs: Tab[]; active: string }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const close = useCallback(() => setOpen(false), [])
  useDismiss(open, ref, close)
  return (
    <div className="br-tab-all-wrap" ref={ref}>
      <button type="button" className="br-tab-add" title={`全部标签（${tabs.length} 个）`} aria-label={`全部标签（${tabs.length} 个）`}
        aria-expanded={open} onClick={() => setOpen((o) => !o)}><IconDown /></button>
      {open && (
        <div className="menu br-all-menu">
          <div className="menu-label">全部标签 · {tabs.length} 个</div>
          {tabs.map((t) => (
            <button key={t.id} type="button" className={cls('menu-item', t.id === active && 'on')} title={t.title}
              onClick={() => { setOpen(false); store.activate(t.id) }}>
              <KindIcon kind={t.kind} /><span className="ellipsis">{t.title}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function TabContextMenu({ ctx, tabs, onClose }: { ctx: { id: string; x: number; y: number }; tabs: Tab[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useDismiss(true, ref, onClose, true)
  const t = tabs.find((x) => x.id === ctx.id)
  if (!t) return null
  const items = [
    { label: t.pinned ? '取消固定' : '固定标签页', run: () => store.togglePin(t.id) },
    { label: '刷新', run: () => store.reload(t.id) },
    { label: '在系统浏览器打开', run: () => store.openExternal(t.url), disabled: t.kind === 'home' },
    { label: '关闭其他标签页', run: () => store.closeOthers(t.id), disabled: tabs.length === 1 },
    { label: '关闭', run: () => store.close(t.id), disabled: t.pinned },
  ]
  // 贴着鼠标弹出，但不超出视口
  const left = Math.max(8, Math.min(ctx.x, window.innerWidth - 200))
  const top = Math.max(8, Math.min(ctx.y, window.innerHeight - items.length * 32 - 16))
  return (
    <div ref={ref} className="menu br-ctx" role="menu" style={{ left, top }}>
      {items.map((it) => (
        <button key={it.label} type="button" role="menuitem" className="menu-item" disabled={it.disabled}
          onClick={() => { onClose(); it.run() }}>{it.label}</button>
      ))}
    </div>
  )
}

function Toolbar({ tab, google, saveFailed, onLogin, onSubmit }: {
  tab: Tab
  google: BrowserGoogleState | undefined
  saveFailed: boolean
  onLogin: () => void
  onSubmit: (url: string) => void
}) {
  /** 正在改的地址；不在编辑（或切了标签）时显示当前地址 */
  const [draft, setDraft] = useState<{ tab: string; text: string } | null>(null)
  const editing = draft?.tab === tab.id
  const addr = editing ? draft.text : displayUrl(tab.url)
  const setAddr = (text: string) => setDraft({ tab: tab.id, text })
  const inputRef = useRef<HTMLInputElement>(null)
  // 切到新标签页时光标直接进地址栏
  useEffect(() => { if (tab.kind === 'home') inputRef.current?.focus() }, [tab.id, tab.kind])

  const submit = (e: FormEvent) => {
    e.preventDefault()
    onSubmit(normalize(addr))
    setDraft(null)
    inputRef.current?.blur()
  }

  return (
    <div className="br-bar">
      <IconButton label="后退" disabled={tab.cursor <= 0} onClick={() => store.back(tab.id)}><IconBack /></IconButton>
      <IconButton label="前进" disabled={tab.cursor >= tab.history.length - 1} onClick={() => store.forward(tab.id)}><IconForward /></IconButton>
      <IconButton label="刷新" onClick={() => store.reload(tab.id)}><IconReload /></IconButton>
      <form className="br-addr" onSubmit={submit} role="search">
        {tab.kind !== 'home' && !editing && <span className={cls('br-kind', `br-kind-${tab.kind}`)}><KindIcon kind={tab.kind} />{KIND_LABEL[tab.kind]}</span>}
        <input ref={inputRef} value={addr} spellCheck={false} autoComplete="off" placeholder="输入网址、端口号或搜索内容" aria-label="地址栏"
          onChange={(e) => setAddr(e.target.value)}
          onFocus={(e) => { setAddr(displayUrl(tab.url)); e.target.select() }}
          onBlur={() => setDraft(null)}
          onKeyDown={(e) => { if (e.key === 'Escape') { setDraft(null); inputRef.current?.blur() } }} />
      </form>
      {saveFailed && (
        <button type="button" className="br-save-warn" title="点一下再存一次" onClick={() => { void store.saveNow() }}>
          标签没保存上，刷新会丢<span className="br-save-retry">重试</span>
        </button>
      )}
      <IconButton label="在系统浏览器打开" disabled={tab.kind === 'home'} onClick={() => store.openExternal(tab.url)}><IconExternal /></IconButton>
      <AccountButton google={google} onLogin={onLogin} />
    </div>
  )
}
