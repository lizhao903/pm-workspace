import { useSyncExternalStore } from 'react'

// 主题：浅色、深色、跟随系统。偏好存在这台电脑的浏览器里，拿不到存储时只在本次会话生效。
// 实际生效的明暗写到 <html data-theme>，tokens.css 按它切换变量。
export type ThemePref = 'light' | 'dark' | 'system'

export const THEMES: { key: ThemePref; label: string }[] = [
  { key: 'light', label: '浅色' },
  { key: 'dark', label: '深色' },
  { key: 'system', label: '跟随系统' },
]

// 旧前端用的是 pmw.theme，换一个键，同域上线时互不干扰
const KEY = 'pmw-theme'
const mq = window.matchMedia('(prefers-color-scheme: dark)')
const listeners = new Set<() => void>()

function readPref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY)
    if (v === 'light' || v === 'dark' || v === 'system') return v
  } catch { /* 拿不到存储就用默认 */ }
  return 'light'
}

let pref = readPref()

function apply() {
  document.documentElement.dataset.theme = pref === 'system' ? (mq.matches ? 'dark' : 'light') : pref
}

// 模块加载时就写上，避免首屏先按浅色画一帧
apply()

mq.addEventListener('change', () => {
  if (pref !== 'system') return
  apply()
  listeners.forEach((l) => l())
})

// 别的标签页改了偏好，这里跟着变
window.addEventListener('storage', (e) => {
  if (e.key !== KEY) return
  const next = readPref()
  if (next === pref) return
  pref = next
  apply()
  listeners.forEach((l) => l())
})

export function setTheme(next: ThemePref) {
  if (next === pref) return
  pref = next
  try { localStorage.setItem(KEY, next) } catch { /* 无痕模式下拿不到存储，主题只在本次会话生效 */ }
  apply()
  listeners.forEach((l) => l())
}

function subscribe(l: () => void) {
  listeners.add(l)
  return () => { listeners.delete(l) }
}

/** 当前偏好和实际生效的明暗 */
export function useTheme(): { pref: ThemePref; resolved: 'light' | 'dark'; setTheme: (t: ThemePref) => void } {
  const p = useSyncExternalStore(subscribe, () => pref)
  const dark = useSyncExternalStore(subscribe, () => mq.matches)
  return { pref: p, resolved: p === 'system' ? (dark ? 'dark' : 'light') : p, setTheme }
}
