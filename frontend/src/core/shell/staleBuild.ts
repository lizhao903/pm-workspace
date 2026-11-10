// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 服务换了新构建、页面还是旧的：旧分包的文件名对不上（404），或旧代码不认识新接口返回的值。
// 出错时去取一次 index.html，入口脚本和当前页面的不一样就说明有新版本，刷新一次。
// 同一个新版本只自动刷新一次，免得新版本本身有问题时来回刷。
//
// 检查同一时刻只跑一次：分包失败时 vite 的 preloadError 监听和「出错了」页会同时来查，
// 原来各查各的，先回来的那次刷新、后回来的看到「这个版本刷过了」就当成没换版本去上报，
// 赶在页面跳走前把「版本一致」的误报发了出去（TSK-0390 等 6 条）。现在共用一次检查，刷新一旦发起就一直回 reloading。

import { fetchAppIndex } from '../api'

const RELOADED_KEY = 'pmw.staleReload'

/**
 * 一次检查的结论：
 * - reloading：服务器上是新版本，已经发起刷新（页面马上跳走）
 * - looped：服务器上是新版本，但这个版本已经自动刷过一次，不再刷，免得来回刷
 * - same：服务器上的版本和页面一致，不是换版本
 * - unreachable：取不到 index.html（服务在重启、网络断了），判断不了
 * - dev：开发服务器，入口没有 hash，没法比
 */
export type BuildCheck = 'reloading' | 'looped' | 'same' | 'unreachable' | 'dev'

/** 页面里入口脚本的地址，形如 /assets/index-abc123.js；开发服务器下没有 hash，返回 null */
export function entryOf(html: string): string | null {
  const m = html.match(/<script[^>]+type="module"[^>]+src="([^"]*\/assets\/[^"]+\.js)"/)
  return m ? m[1] : null
}

/** 当前页面的入口脚本；开发服务器下为 null。上报运行异常时也带上它（INC-01b） */
export function currentEntry(): string | null {
  const el = document.querySelector<HTMLScriptElement>('script[type="module"][src*="/assets/"]')
  return el ? new URL(el.src, location.href).pathname : null
}

/** 服务器上的入口和当前页面比：新入口 / 一样 / 取不到 / 开发服务器 */
export async function serverBuild(): Promise<{ status: 'newer'; next: string } | { status: 'same' | 'unreachable' | 'dev' }> {
  const cur = currentEntry()
  if (!cur) return { status: 'dev' }
  const html = await fetchAppIndex()
  if (html == null) return { status: 'unreachable' }
  const next = entryOf(html)
  // 回来的不是带 hash 入口的页面（被代理换成了别的内容等），当成取不到，不下「版本一致」的结论
  if (!next) return { status: 'unreachable' }
  return next !== cur ? { status: 'newer', next } : { status: 'same' }
}

let inflight: Promise<BuildCheck> | null = null
let reloading = false
let navTarget: () => string | null = () => null

/**
 * 刷新时去哪：点了某个模块、分包还没取到时地址栏还停在上一页，直接刷新会回到上一页。
 * main.tsx 接上路由「正在去的地址」，刷新改成直接打开那个地址
 */
export function setReloadTarget(fn: () => string | null) {
  navTarget = fn
}

async function runCheck(): Promise<BuildCheck> {
  const r = await serverBuild()
  if (r.status !== 'newer') return r.status
  try {
    if (sessionStorage.getItem(RELOADED_KEY) === r.next) return 'looped'
    sessionStorage.setItem(RELOADED_KEY, r.next)
  } catch {
    // 存不了就不防重复，照样刷
  }
  reloading = true
  const to = navTarget()
  if (to && to !== location.pathname + location.search + location.hash) location.assign(to)
  else location.reload()
  return 'reloading'
}

/** 看服务器是不是换了新版本，是就刷新（同一个新版本只刷一次）。同时来的调用共用一次检查 */
export function checkBuild(): Promise<BuildCheck> {
  if (reloading) return Promise.resolve('reloading')
  if (!inflight) inflight = runCheck().finally(() => { inflight = null })
  return inflight
}

/** 有新版本就刷新，回是否刷新了 */
export async function reloadIfStale(): Promise<boolean> {
  return (await checkBuild()) === 'reloading'
}

/** 测试用：清掉进程内的状态 */
export function resetBuildCheck() {
  inflight = null
  reloading = false
  navTarget = () => null
}

/**
 * 分包加载失败（vite 的 preloadError）时先看是不是换了版本。不拦这个错误：
 * 页面分包由 loadChunk 重试；其余的照样抛给出错的地方，「出错了」页显示原因，不静默地缺样式
 */
export function watchStaleBuild() {
  window.addEventListener('vite:preloadError', () => { void checkBuild() })
}
