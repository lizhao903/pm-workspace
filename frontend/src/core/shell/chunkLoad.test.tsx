// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 页面分包加载失败（TSK-0390、0393、0394、0395、0396、0424）：
// 瞬时失败重试成功不上报；换了版本自动刷新一次、不误报「版本一致」；重试用完仍失败才上报并给「重新加载」；
// 服务连不上时不下「版本一致」的结论。
import type { ReactNode } from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadChunk } from './chunkLoad'
import { resetReported } from './errorReport'
import { RouteError } from './RouteError'
import * as stale from './staleBuild'

const CHUNK_URL = 'http://localhost/assets/Page-Old1.js'
const chunkErr = () => new TypeError(`Failed to fetch dynamically imported module: ${CHUNK_URL}`)

let reports: Record<string, unknown>[]
/** 服务器 index.html 里的入口；null 表示服务连不上 */
let serverEntry: string | null
let indexFetches: number
let reload: ReturnType<typeof vi.fn>
let assign: ReturnType<typeof vi.fn>
let script: HTMLScriptElement

beforeEach(() => {
  reports = []
  serverEntry = '/assets/index-A.js'
  indexFetches = 0
  resetReported()
  ;(stale as { resetBuildCheck?: () => void }).resetBuildCheck?.()
  sessionStorage.clear()
  // 当前页面停在构建 A
  script = document.createElement('script')
  script.type = 'module'
  script.src = '/assets/index-A.js'
  document.head.appendChild(script)
  reload = vi.fn()
  assign = vi.fn()
  vi.stubGlobal('location', { ...window.location, href: 'http://localhost/tasks', pathname: '/tasks', search: '', hash: '', reload, assign })
  vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(url), 'http://localhost')
    if (u.pathname === '/api/incidents/report') {
      reports.push(JSON.parse(String(init!.body)))
      return new Response(JSON.stringify({ data: { id: 'inc_1' } }), { status: 201 })
    }
    if (u.pathname === '/') {
      indexFetches++
      // 两次检查真的并发：让 fetch 晚一点回来
      await new Promise((r) => setTimeout(r, 5))
      if (serverEntry == null) throw new TypeError('Failed to fetch')
      return new Response(`<!doctype html><script type="module" crossorigin src="${serverEntry}"></script>`, { status: 200 })
    }
    return new Response('{}', { status: 404 })
  }))
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  script.remove()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const FAST = { delays: [0, 0, 0] }

/** 和 router.tsx 一样：模块页面走 loadChunk，出错落到 RouteError */
function renderModule(load: () => Promise<{ default: () => ReactNode }>) {
  const router = createMemoryRouter([
    {
      path: '/', errorElement: <RouteError />,
      children: [{ path: 'tasks/*', lazy: async () => ({ Component: (await loadChunk(load, FAST)).default }) }],
    },
  ], { initialEntries: ['/tasks'] })
  return render(<RouterProvider router={router} />)
}

describe('页面分包加载失败', () => {
  it('瞬时失败：退避重试成功，页面正常出来，不上报', async () => {
    let n = 0
    const load = vi.fn(async () => {
      if (n++ < 2) throw chunkErr()
      return { default: () => <h1>任务页</h1> }
    })
    renderModule(load)
    expect(await screen.findByText('任务页')).toBeInTheDocument()
    expect(load).toHaveBeenCalledTimes(3)
    expect(reports).toHaveLength(0)
    expect(reload).not.toHaveBeenCalled()
  })

  it('换了版本：自动刷新一次，不上报「版本一致」；preloadError 和「出错了」页同时检查也只刷一次', async () => {
    serverEntry = '/assets/index-B.js'
    stale.watchStaleBuild()
    // vite 8 的 __vitePreload 在页面分包失败时也会派发 preloadError，和路由的检查同时发生
    const load = vi.fn(async () => {
      window.dispatchEvent(new Event('vite:preloadError'))
      throw chunkErr()
    })
    renderModule(load)
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1))
    await new Promise((r) => setTimeout(r, 50))
    expect(reload).toHaveBeenCalledTimes(1)
    expect(reports).toHaveLength(0)
    expect(sessionStorage.getItem('pmw.staleReload')).toBe('/assets/index-B.js')
  })

  it('两次检查并发时都认得出要刷新（原来后到的那次当成「没换版本」）', async () => {
    serverEntry = '/assets/index-B.js'
    const rs = await Promise.all([stale.reloadIfStale(), stale.reloadIfStale()])
    expect(rs).toEqual([true, true])
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('点进别的模块时换了版本：刷新直接打开要去的页面，不回到点之前那页', async () => {
    serverEntry = '/assets/index-B.js'
    stale.setReloadTarget(() => '/docs?x=1')
    expect(await stale.checkBuild()).toBe('reloading')
    expect(assign).toHaveBeenCalledWith('/docs?x=1')
    expect(reload).not.toHaveBeenCalled()
  })

  it('新版本已经刷过一次还是旧页面：不再刷，停在「出错了」并上报，说明不是「版本一致」', async () => {
    serverEntry = '/assets/index-B.js'
    sessionStorage.setItem('pmw.staleReload', '/assets/index-B.js')
    renderModule(async () => { throw chunkErr() })
    expect(await screen.findByText('出错了')).toBeInTheDocument()
    await waitFor(() => expect(reports).toHaveLength(1))
    expect(reload).not.toHaveBeenCalled()
    expect(reports[0].message).toMatch(/已是新版本/)
  })

  it('重试用完仍失败：上报一次分包加载失败，给「重新加载」按钮，不白屏', async () => {
    const load = vi.fn(async () => { throw chunkErr() })
    renderModule(load)
    expect(await screen.findByText('出错了')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '重新加载' })).toBeInTheDocument()
    expect(load).toHaveBeenCalledTimes(4)
    await waitFor(() => expect(reports).toHaveLength(1))
    expect(reports[0]).toMatchObject({ title: `分包加载失败：Failed to fetch dynamically imported module: ${CHUNK_URL}` })
    expect(reload).not.toHaveBeenCalled()
  })

  it('服务连不上（多半在重启）：不下「版本一致」的结论、不上报，提示稍后重新加载', async () => {
    serverEntry = null
    renderModule(async () => { throw chunkErr() })
    expect(await screen.findByText(/连不上工作台服务/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '重新加载' })).toBeInTheDocument()
    await new Promise((r) => setTimeout(r, 30))
    expect(reports).toHaveLength(0)
    expect(reload).not.toHaveBeenCalled()
  })

  it('不是分包的错误不重试，直接抛', async () => {
    const load = vi.fn(async () => { throw new Error('x is undefined') })
    await expect(loadChunk(load, FAST)).rejects.toThrow('x is undefined')
    expect(load).toHaveBeenCalledTimes(1)
    expect(indexFetches).toBe(0)
  })
})
