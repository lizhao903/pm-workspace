// 终端页的状态：模块级，切菜单、切工作台再回来都还在（SPEC-terminal-1.10）；布局存本机，刷新后按会话列表重连。
// 会话的新建、结束走 core/data 的 terminalApi，完了报 terminal-session。副作用都在这里的动作函数里，不进 setState。
import { useSyncExternalStore } from 'react'
import { errorText, isApiError, notifyChange, terminalApi, TERMINAL_MAX_SESSIONS } from '../../core/data'
import {
  EMPTY_LAYOUT, FIRST_TAB_NAME, MAX_PANES, activeTab, addPane, addTab, findPane, focusPane, newPane, newTab, parseLayout, patchPane,
  reconcile, removePane, removeTab, renameTab, setActive, setFocus, type Layout, type Pane,
} from './model'

const STORAGE_KEY = 'pmw-terminal'

type State = { layout: Layout; ready: boolean; busy: boolean; notice: string }

let state: State = { layout: EMPTY_LAYOUT, ready: false, busy: false, notice: '' }
const listeners = new Set<() => void>()
let noticeTimer: ReturnType<typeof setTimeout> | undefined

function set(next: Partial<State>) {
  state = { ...state, ...next }
  if (next.layout) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state.layout))
    } catch {
      // 拿不到本机存储时只在这次打开里有效
    }
  }
  for (const f of listeners) f()
}

export function useTerminalState(): State {
  return useSyncExternalStore((f) => { listeners.add(f); return () => listeners.delete(f) }, () => state)
}

export function showNotice(text: string) {
  clearTimeout(noticeTimer)
  set({ notice: text })
  noticeTimer = setTimeout(() => set({ notice: '' }), 6000)
}

function failText(e: unknown) {
  if (isApiError(e, 'conflict')) return `最多同时开 ${TERMINAL_MAX_SESSIONS} 个终端，先关掉几个`
  return `打开终端失败：${errorText(e)}`
}

/** 目录不存在（项目目录填错、被删）时退到主目录开，并提示一句 */
async function createSession(cwd: string) {
  try {
    return await terminalApi.create({ cwd })
  } catch (e) {
    if (!cwd || !isApiError(e, 'validation')) throw e
    const s = await terminalApi.create({})
    showNotice(`打不开目录 ${cwd}，已在主目录打开`)
    return s
  }
}

async function openSession(cwd: string): Promise<Pane> {
  const s = await createSession(cwd)
  notifyChange({ kind: 'terminal-session' })
  return newPane(s)
}

/** 结束会话；已经没了（404）不算失败 */
async function closeSession(id: string) {
  try {
    await terminalApi.remove(id)
  } catch (e) {
    if (!isApiError(e, 'not_found')) showNotice(`结束终端失败：${errorText(e)}`)
  } finally {
    notifyChange({ kind: 'terminal-session' })
  }
}

/** 一次只做一个新建，免得连点拆出第 5 格 */
async function withBusy(f: () => Promise<void>) {
  if (state.busy) return
  set({ busy: true })
  try {
    await f()
  } catch (e) {
    showNotice(failText(e))
  } finally {
    set({ busy: false })
  }
}

let initing: Promise<void> | null = null

/** 第一次打开：读回本机存的布局，对上会话列表；一个标签都没有就开一个。只做一次 */
export function initTerminal(defaultCwd: string): Promise<void> {
  initing ??= (async () => {
    let saved = EMPTY_LAYOUT
    try {
      saved = parseLayout(localStorage.getItem(STORAGE_KEY))
    } catch {
      // 同上
    }
    let layout = saved
    try {
      layout = reconcile(saved, await terminalApi.list())
    } catch (e) {
      showNotice(`读终端会话失败：${errorText(e)}`)
    }
    set({ layout, ready: true })
    if (!layout.tabs.length) await newTerminalTab(defaultCwd, FIRST_TAB_NAME)
  })()
  return initing
}

export function newTerminalTab(cwd: string, name = '') {
  return withBusy(async () => {
    const p = await openSession(cwd)
    set({ layout: addTab(state.layout, newTab([p], name)) })
  })
}

/** 在当前标签加一格，沿用焦点格的目录 */
export function splitPane(dir: 'row' | 'col') {
  const tab = activeTab(state.layout)
  if (!tab || tab.panes.length >= MAX_PANES) return Promise.resolve()
  const cwd = focusPane(tab)?.cwd ?? ''
  return withBusy(async () => {
    const p = await openSession(cwd)
    set({ layout: addPane(state.layout, tab.id, p, dir) })
  })
}

/** 关标签；一级菜单里关掉最后一个马上开一个新的 */
export function closeTab(tabId: string, defaultCwd: string) {
  const tab = state.layout.tabs.find((t) => t.id === tabId)
  if (!tab) return
  set({ layout: removeTab(state.layout, tabId) })
  for (const p of tab.panes) void closeSession(p.session)
  if (!state.layout.tabs.length) void newTerminalTab(defaultCwd)
}

export function closePane(paneId: string, defaultCwd: string) {
  const hit = findPane(state.layout, paneId)
  if (!hit) return
  set({ layout: removePane(state.layout, paneId) })
  void closeSession(hit.pane.session)
  if (!state.layout.tabs.length) void newTerminalTab(defaultCwd)
}

/** 会话没了或进程退出后，在同一目录新开一个会话顶上；dropOld 时顺手删掉退出了的旧会话 */
export function reopenPane(paneId: string, dropOld = true) {
  const hit = findPane(state.layout, paneId)
  if (!hit) return Promise.resolve()
  return withBusy(async () => {
    const s = await createSession(hit.pane.cwd)
    notifyChange({ kind: 'terminal-session' })
    set({ layout: patchPane(state.layout, paneId, (p) => ({ ...p, session: s.id, cwd: s.cwd })) })
    if (dropOld) void closeSession(hit.pane.session)
  })
}

export const focusTerminalPane = (paneId: string) => set({ layout: setFocus(state.layout, paneId) })
export const activateTab = (tabId: string) => set({ layout: setActive(state.layout, tabId) })
export const renameTerminalTab = (tabId: string, name: string) => set({ layout: renameTab(state.layout, tabId, name) })

export function setPaneCwd(paneId: string, cwd: string) {
  if (findPane(state.layout, paneId)?.pane.cwd === cwd) return
  set({ layout: patchPane(state.layout, paneId, (p) => ({ ...p, cwd })) })
}

export function markStarted(paneId: string, protoId: string, on: boolean) {
  set({
    layout: patchPane(state.layout, paneId, (p) => ({
      ...p, started: on ? [...new Set([...p.started, protoId])] : p.started.filter((x) => x !== protoId),
    })),
  })
}

/** 测试用：回到没打开过的样子 */
export function resetTerminalStore() {
  initing = null
  clearTimeout(noticeTimer)
  state = { layout: EMPTY_LAYOUT, ready: false, busy: false, notice: '' }
  for (const f of listeners) f()
}
