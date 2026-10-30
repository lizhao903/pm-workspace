// 服务换了新构建、页面还是旧的：旧分包的文件名对不上（404），或旧代码不认识新接口返回的值。
// 出错时去取一次 index.html，入口脚本和当前页面的不一样就说明有新版本，刷新一次。
// 同一个新版本只自动刷新一次，免得新版本本身有问题时来回刷。

import { fetchAppIndex } from '../api'

const RELOADED_KEY = 'pmw.staleReload'

/** 页面里入口脚本的地址，形如 /assets/index-abc123.js；开发服务器下没有 hash，返回 null */
export function entryOf(html: string): string | null {
  const m = html.match(/<script[^>]+type="module"[^>]+src="([^"]*\/assets\/[^"]+\.js)"/)
  return m ? m[1] : null
}

function currentEntry(): string | null {
  const el = document.querySelector<HTMLScriptElement>('script[type="module"][src*="/assets/"]')
  return el ? new URL(el.src, location.href).pathname : null
}

/** 服务器上的入口和当前页面不同时回新入口，否则回 null */
export async function newerBuild(): Promise<string | null> {
  const cur = currentEntry()
  if (!cur) return null
  const html = await fetchAppIndex()
  const next = html ? entryOf(html) : null
  return next && next !== cur ? next : null
}

/** 有新版本就刷新（同一个新版本只刷一次），回是否刷新了 */
export async function reloadIfStale(): Promise<boolean> {
  const next = await newerBuild()
  if (!next) return false
  try {
    if (sessionStorage.getItem(RELOADED_KEY) === next) return false
    sessionStorage.setItem(RELOADED_KEY, next)
  } catch {
    // 存不了就不防重复，照样刷
  }
  location.reload()
  return true
}

/** 分包加载失败（vite 的 preloadError）时先看是不是换了版本 */
export function watchStaleBuild() {
  window.addEventListener('vite:preloadError', (e) => {
    e.preventDefault()
    void reloadIfStale()
  })
}
