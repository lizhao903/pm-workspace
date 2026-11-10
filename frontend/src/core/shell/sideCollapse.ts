// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { useSyncExternalStore } from 'react'
import { readCollapsed, writeCollapsed } from './menu'

// 一级菜单收起：侧栏左上角的按钮、命令面板和设置 / 外观（SPEC-settings-21.4）是同一个状态。
// 每次都从存储读，拿不到存储时用本次会话的值
let session: boolean | null = null
const listeners = new Set<() => void>()

const storageOk = (() => {
  try { localStorage.getItem('pmw-side'); return true } catch { return false }
})()

const snapshot = () => (storageOk ? readCollapsed() : session ?? false)

export function setSideCollapsed(v: boolean) {
  session = v
  writeCollapsed(v)
  listeners.forEach((l) => l())
}

function subscribe(l: () => void) {
  listeners.add(l)
  return () => { listeners.delete(l) }
}

export function useSideCollapsed(): [boolean, (v: boolean) => void] {
  return [useSyncExternalStore(subscribe, snapshot), setSideCollapsed]
}
