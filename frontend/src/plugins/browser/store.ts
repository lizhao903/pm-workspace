// 内置浏览器的状态：模块级，切菜单再回来标签都还在；标签整体存后端（BR-01a 的 GET/PUT /api/browser/tabs），
// 启动时读回，变化后防抖整体 PUT，页面关掉、刷新前再补存一次。存不上不打断浏览，地址栏右边提示，下次变化时再试（SPEC-browser-1.19）。
// 副作用都在这里的动作函数里，不进 setState。
import { useSyncExternalStore } from 'react'
import { browserApi, prototypeUp, type TerminalPrototype } from '../../core/data'
import * as m from './model'
import type { Recent, Tabs } from './model'

/** 标签变了多久后存 */
export const SAVE_DELAY_MS = 500

type State = {
  tabs: Tabs
  ready: boolean
  /** 上一次存没存上 */
  saveFailed: boolean
  recent: Recent[]
  /** 标签 id -> 刷新了几次，iframe 的 key */
  reloads: Record<string, number>
  /** 标签 id -> 等它启动完要打开的原型 id（「启动并打开」） */
  pending: Record<string, string>
}

const initial = (): State => ({ tabs: { tabs: [], active: '' }, ready: false, saveFailed: false, recent: [], reloads: {}, pending: {} })

let state: State = initial()
const listeners = new Set<() => void>()
let protos: readonly TerminalPrototype[] = []

let saveTimer: ReturnType<typeof setTimeout> | undefined
let saving = false
let again = false
/** 后端上现在存着的（比对用，一样就不发） */
let saved = ''

function set(next: Partial<State>) {
  state = { ...state, ...next }
  for (const f of listeners) f()
}

export function useBrowserState(): State {
  return useSyncExternalStore((f) => { listeners.add(f); return () => listeners.delete(f) }, () => state)
}

export const getBrowserState = () => state

function scheduleSave() {
  if (!state.ready) return
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => { void saveNow() }, SAVE_DELAY_MS)
}

/** 立刻存；正在存时等它完了再存一次最新的。keepalive 用于页面关掉前 */
export async function saveNow(keepalive = false): Promise<void> {
  clearTimeout(saveTimer)
  if (!state.ready) return
  const key = m.saveKey(state.tabs)
  if (key === saved && !state.saveFailed) return
  if (saving && !keepalive) { again = true; return }
  saving = true
  try {
    await browserApi.putTabs(m.toRecords(state.tabs), keepalive)
    saved = key
    if (state.saveFailed) set({ saveFailed: false })
  } catch {
    if (!state.saveFailed) set({ saveFailed: true })
  } finally {
    saving = false
    if (again) { again = false; scheduleSave() }
  }
}

function setTabs(tabs: Tabs) {
  if (tabs === state.tabs) return
  set({ tabs })
  scheduleSave()
}

const flushOnHide = () => { void saveNow(true) }
const flushOnHidden = () => { if (document.visibilityState === 'hidden') void saveNow(true) }

let initing: Promise<void> | null = null

/** 第一次打开：读回后端存的标签；读不到（插件没开、后端不可用）就从一个新标签页开始。只做一次 */
export function initBrowser(): Promise<void> {
  initing ??= (async () => {
    let tabs = m.homeTabs()
    let ok = false
    try {
      const rows = await browserApi.tabs()
      tabs = m.fromRecords(rows, protos)
      ok = true
      if (rows.length) saved = m.saveKey(tabs)
    } catch {
      // 读不到也照常用，存的时候再报
    }
    set({ tabs, ready: true, saveFailed: !ok })
    if (!ok || !saved) scheduleSave()
    window.addEventListener('pagehide', flushOnHide)
    document.addEventListener('visibilitychange', flushOnHidden)
  })()
  return initing
}

const titleOf = (url: string) => m.titleOf(url, protos)

function rememberUrl(url: string, title: string) {
  if (m.classify(url) !== 'home') set({ recent: m.remember(state.recent, url, title) })
}

/** 当前标签（或给定标签）里打开地址，记进历史和最近打开 */
export function openHere(url: string, title?: string, tabId = state.tabs.active) {
  const name = title ?? titleOf(url)
  setTabs(m.navigate(state.tabs, tabId, url, name))
  rememberUrl(url, name)
}

export function newTab(url = m.HOME_URL, title?: string) {
  const name = title ?? titleOf(url)
  setTabs(m.openTab(state.tabs, url, name).state)
  rememberUrl(url, name)
}

/** 别的模块要打开：同一地址的切过去，否则新开（满了在当前标签打开） */
export function openRequest(raw: string, title?: string) {
  const url = m.normalize(raw)
  const hit = state.tabs.tabs.find((t) => m.sameUrl(t.url, url))
  if (hit) { activate(hit.id); return }
  newTab(url, title)
}

export function back(id = state.tabs.active) { setTabs(m.go(state.tabs, id, -1, titleOf)) }
export function forward(id = state.tabs.active) { setTabs(m.go(state.tabs, id, 1, titleOf)) }

export function reload(id = state.tabs.active) {
  const t = state.tabs.tabs.find((x) => x.id === id)
  if (!t) return
  set({ reloads: { ...state.reloads, [id]: (state.reloads[id] ?? 0) + 1 } })
  if (m.isFrame(t.kind)) set({ tabs: m.setLoading(state.tabs, id, true) })
}

export function activate(id: string) {
  if (state.tabs.active !== id) setTabs({ ...state.tabs, active: id })
}

export function close(id: string) {
  const { [id]: _drop, ...pending } = state.pending
  set({ pending })
  setTabs(m.closeTab(state.tabs, id))
}

export function closeOthers(id: string) {
  setTabs(m.closeOthers(state.tabs, id))
  const keep = new Set(state.tabs.tabs.map((t) => t.id))
  set({ pending: Object.fromEntries(Object.entries(state.pending).filter(([k]) => keep.has(k))) })
}

export function togglePin(id: string) { setTabs(m.togglePin(state.tabs, id)) }

/** iframe load 了：只改界面，不存 */
export function frameLoaded(id: string) { set({ tabs: m.setLoading(state.tabs, id, false) }) }

/** 「启动并打开」：记下这个标签等哪个原型，起来后在这个标签打开（resolvePending） */
export function waitFor(tabId: string, protoId: string) { set({ pending: { ...state.pending, [tabId]: protoId } }) }
export function stopWaiting(tabId: string) {
  if (!(tabId in state.pending)) return
  const { [tabId]: _drop, ...pending } = state.pending
  set({ pending })
}

/** 原型列表变了：等着的原型起来了就在那个标签打开，失败或没了就不等；原型标签的标题跟着原型名变 */
export function syncPrototypes(list: readonly TerminalPrototype[]) {
  protos = list
  const pending = { ...state.pending }
  let changed = false
  for (const [tabId, protoId] of Object.entries(state.pending)) {
    const p = list.find((x) => x.id === protoId)
    const alive = state.tabs.tabs.some((t) => t.id === tabId)
    if (!p || !alive || p.status === 'crashed') { delete pending[tabId]; changed = true; continue }
    if (prototypeUp(p.status)) {
      delete pending[tabId]
      changed = true
      openHere(m.protoUrl(p), undefined, tabId)
    }
  }
  if (changed) set({ pending })
}

/** 在系统浏览器打开（新窗口、noopener）；新标签页没有这个操作 */
export function openExternal(url: string) {
  if (m.classify(url) !== 'home') window.open(url, '_blank', 'noopener')
}

/** 测试用：回到没打开过的样子 */
export function resetBrowserStore() {
  initing = null
  clearTimeout(saveTimer)
  saving = false
  again = false
  saved = ''
  protos = []
  window.removeEventListener('pagehide', flushOnHide)
  document.removeEventListener('visibilitychange', flushOnHidden)
  state = initial()
  for (const f of listeners) f()
}
