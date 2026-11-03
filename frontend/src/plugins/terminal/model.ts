// 终端页的纯函数（SPEC-terminal-1）：标签、格子、布局、对会话列表重连。不发请求，store.ts 调它们。
import type { TerminalPrototype, TerminalSession } from '../../core/data'

/** 一格一个后端会话；started 是从这一格启动的项目原型，关格时停掉 */
export type Pane = { id: string; session: string; cwd: string; started: string[] }
/** name 空串表示没改过名，显示焦点格目录的最后一段；dir 在第一次拆分时定下 */
export type TermTab = { id: string; name: string; dir: 'row' | 'col'; panes: Pane[]; focus: string }
export type Layout = { tabs: TermTab[]; active: string }

export const MAX_PANES = 4
/** 一级菜单的第一个标签叫这个 */
export const FIRST_TAB_NAME = '工作台'

export const EMPTY_LAYOUT: Layout = { tabs: [], active: '' }

export function newId(prefix: string) {
  const b = new Uint8Array(8)
  globalThis.crypto.getRandomValues(b)
  return `${prefix}_${Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')}`
}

export const newPane = (s: Pick<TerminalSession, 'id' | 'cwd'>): Pane => ({ id: newId('tp'), session: s.id, cwd: s.cwd, started: [] })

export function newTab(panes: Pane[], name = '', dir: 'row' | 'col' = 'row'): TermTab {
  return { id: newId('tb'), name, dir, panes, focus: panes[panes.length - 1]?.id ?? '' }
}

export const baseName = (cwd: string) => cwd.split('/').filter(Boolean).pop() ?? '/'

/** 家目录下写成 ~/… */
export function shortPath(cwd: string, home: string) {
  if (!home) return cwd
  if (cwd === home) return '~'
  return cwd.startsWith(`${home}/`) ? `~${cwd.slice(home.length)}` : cwd
}

export function focusPane(t: TermTab): Pane | undefined {
  return t.panes.find((p) => p.id === t.focus) ?? t.panes[0]
}

export const tabName = (t: TermTab) => t.name || baseName(focusPane(t)?.cwd ?? '/')

/** 1 格 l1；2 格按 dir 左右 l2r 或上下 l2c；3 格 l3（第一格占左边整列）；4 格 l4 */
export function layoutClass(t: TermTab | undefined) {
  const n = t?.panes.length ?? 1
  if (n <= 1) return 'l1'
  if (n === 2) return t!.dir === 'row' ? 'l2r' : 'l2c'
  return n === 3 ? 'l3' : 'l4'
}

const mapTab = (l: Layout, id: string, f: (t: TermTab) => TermTab): Layout => ({ ...l, tabs: l.tabs.map((t) => (t.id === id ? f(t) : t)) })

export function findPane(l: Layout, paneId: string): { tab: TermTab; pane: Pane } | undefined {
  for (const tab of l.tabs) {
    const pane = tab.panes.find((p) => p.id === paneId)
    if (pane) return { tab, pane }
  }
}

const trimSlash = (p: string) => (p.length > 1 ? p.replace(/\/+$/, '') : p)

/** 停在某个目录的格子：当前标签的焦点格、当前标签的别的格、别的标签，依次找；目录比较忽略末尾斜杠，空目录不算 */
export function findPaneByCwd(l: Layout, cwd: string): { tab: TermTab; pane: Pane } | undefined {
  const want = trimSlash(cwd.trim())
  if (!want) return undefined
  const cur = activeTab(l)
  const tabs = cur ? [cur, ...l.tabs.filter((t) => t !== cur)] : l.tabs
  for (const tab of tabs) {
    const panes = [...tab.panes].sort((a, b) => Number(b.id === tab.focus) - Number(a.id === tab.focus))
    const pane = panes.find((p) => trimSlash(p.cwd) === want)
    if (pane) return { tab, pane }
  }
}

export function addTab(l: Layout, t: TermTab): Layout {
  return { tabs: [...l.tabs, t], active: t.id }
}

/** 加一格并把焦点给它；第一次拆分决定左右还是上下；满 4 格不动 */
export function addPane(l: Layout, tabId: string, p: Pane, dir: 'row' | 'col'): Layout {
  return mapTab(l, tabId, (t) =>
    t.panes.length >= MAX_PANES ? t : { ...t, dir: t.panes.length === 1 ? dir : t.dir, panes: [...t.panes, p], focus: p.id })
}

/** 关标签：关的是当前标签时切到它左边那个，最左的就切到新的最左 */
export function removeTab(l: Layout, tabId: string): Layout {
  const i = l.tabs.findIndex((t) => t.id === tabId)
  if (i < 0) return l
  const tabs = l.tabs.filter((t) => t.id !== tabId)
  const active = l.active !== tabId ? l.active : (tabs[Math.max(0, i - 1)]?.id ?? '')
  return { tabs, active }
}

/** 关格：关的是焦点格时焦点给第一格；只剩这一格时等于关掉整个标签 */
export function removePane(l: Layout, paneId: string): Layout {
  const hit = findPane(l, paneId)
  if (!hit) return l
  if (hit.tab.panes.length === 1) return removeTab(l, hit.tab.id)
  return mapTab(l, hit.tab.id, (t) => {
    const panes = t.panes.filter((p) => p.id !== paneId)
    return { ...t, panes, focus: t.focus === paneId ? panes[0].id : t.focus }
  })
}

export function patchPane(l: Layout, paneId: string, f: (p: Pane) => Pane): Layout {
  const hit = findPane(l, paneId)
  if (!hit) return l
  return mapTab(l, hit.tab.id, (t) => ({ ...t, panes: t.panes.map((p) => (p.id === paneId ? f(p) : p)) }))
}

export function setFocus(l: Layout, paneId: string): Layout {
  const hit = findPane(l, paneId)
  if (!hit || hit.tab.focus === paneId) return l
  return mapTab(l, hit.tab.id, (t) => ({ ...t, focus: paneId }))
}

/** 改名：去首尾空格，清空就恢复按目录显示 */
export function renameTab(l: Layout, tabId: string, name: string): Layout {
  return mapTab(l, tabId, (t) => ({ ...t, name: name.trim() }))
}

export function setActive(l: Layout, tabId: string): Layout {
  return l.tabs.some((t) => t.id === tabId) ? { ...l, active: tabId } : l
}

/** 当前标签：active 对不上时取第一个 */
export const activeTab = (l: Layout) => l.tabs.find((t) => t.id === l.active) ?? l.tabs[0]

/**
 * 刷新后按会话列表重连：布局里记着的会话照旧（已经没了的由格子自己显示「会话已结束」），
 * 布局里没有、还在跑的会话（别的窗口开的、本机存储被清了）收进新标签，每个标签最多 4 格。
 */
export function reconcile(l: Layout, sessions: readonly TerminalSession[]): Layout {
  const known = new Set(l.tabs.flatMap((t) => t.panes.map((p) => p.session)))
  const orphans = sessions.filter((s) => s.status === 'running' && !known.has(s.id))
  let out = l
  for (let i = 0; i < orphans.length; i += MAX_PANES) {
    out = addTab(out, newTab(orphans.slice(i, i + MAX_PANES).map(newPane)))
  }
  if (out !== l) out = { ...out, active: l.tabs.some((t) => t.id === l.active) ? l.active : out.tabs[0].id }
  return out
}

/** 本机存的布局读回来：字段不对的整条丢掉，不让坏数据把页面弄挂 */
export function parseLayout(raw: string | null): Layout {
  if (!raw) return EMPTY_LAYOUT
  try {
    const v = JSON.parse(raw) as Partial<Layout>
    const str = (x: unknown): x is string => typeof x === 'string'
    const tabs = (Array.isArray(v.tabs) ? v.tabs : []).flatMap((t: Partial<TermTab>) => {
      if (!t || !str(t.id) || !Array.isArray(t.panes)) return []
      const panes = t.panes.filter((p: Partial<Pane>) => p && str(p.id) && str(p.session) && str(p.cwd))
        .slice(0, MAX_PANES).map((p: Pane) => ({ id: p.id, session: p.session, cwd: p.cwd, started: (p.started ?? []).filter(str) }))
      if (!panes.length) return []
      const focus = panes.some((p) => p.id === t.focus) ? t.focus! : panes[0].id
      return [{ id: t.id, name: str(t.name) ? t.name : '', dir: t.dir === 'col' ? 'col' as const : 'row' as const, panes, focus }]
    })
    return { tabs, active: str(v.active) ? v.active : (tabs[0]?.id ?? '') }
  } catch {
    return EMPTY_LAYOUT
  }
}

/** 这一格的目录是哪个项目原型的目录（原型 dir 是绝对路径，去掉末尾斜杠比） */
export function protoForCwd(protos: readonly TerminalPrototype[] | undefined, cwd: string): TerminalPrototype | undefined {
  const norm = (s: string) => s.replace(/\/+$/, '') || '/'
  const c = norm(cwd)
  return protos?.find((x) => x.dir && norm(x.dir) === c)
}

/** OSC 7 报的当前目录：file://主机/路径，路径按 URL 编码 */
export function cwdFromOsc7(data: string): string | null {
  const m = /^file:\/\/[^/]*(\/.*)$/.exec(data.trim())
  if (!m) return null
  try {
    return decodeURIComponent(m[1])
  } catch {
    return null
  }
}
