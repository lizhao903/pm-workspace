import { render, screen, waitFor } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { moduleStore } from '../plugin'
import { frontReport, isChunkError, reportFrontError, resetReported } from './errorReport'
import { RouteError } from './RouteError'

let reports: Record<string, unknown>[]
let failReport = false

beforeEach(() => {
  reports = []
  failReport = false
  resetReported()
  vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(url), 'http://x')
    if (u.pathname === '/api/incidents/report') {
      reports.push(JSON.parse(String(init!.body)))
      if (failReport) return new Response(JSON.stringify({ error: { code: 'internal', message: 'too many' } }), { status: 429 })
      return new Response(JSON.stringify({ data: { id: 'inc_9' } }), { status: 201 })
    }
    return new Response('<html></html>', { status: 200 })
  }))
})
afterEach(() => { vi.unstubAllGlobals() })

describe('frontReport', () => {
  it('模块取当前路由所属模块，指纹 front:<模块路径>:<类别>:<报错>，带堆栈和构建入口', () => {
    const owner = moduleStore.add('test-owner', { id: 'tasks-x', label: '任务', path: 'tasks-x', load: async () => ({ default: () => null }) })
    try {
      const r = frontReport('route', new TypeError("Cannot read properties of undefined (reading 'label')"), {
        pathname: '/tasks-x/schedules', search: '?a=1', href: 'http://h/tasks-x/schedules?a=1', entry: '/assets/index-Ab12.js',
      })
      expect(r).toMatchObject({
        level: 'error', module: '任务', title: "Cannot read properties of undefined (reading 'label')",
        fingerprint: "front:tasks-x:route:Cannot read properties of undefined (reading 'label')",
        url: 'http://h/tasks-x/schedules?a=1', context: { 页面: '/tasks-x/schedules?a=1', 构建: 'index-Ab12.js', 来源: '页面出错' },
      })
      expect(r.stack).toMatch(/TypeError/)
      // 全局 error 和路由出错是同一个缺陷，指纹相同才能合并
      expect(frontReport('error', new TypeError("Cannot read properties of undefined (reading 'label')"), { pathname: '/tasks-x' }).fingerprint).toBe(r.fingerprint)
    } finally {
      owner.dispose()
    }
  })

  it('认不出模块记「前端」；没处理的 Promise 和分包失败各自成类', () => {
    expect(frontReport('rejection', 'boom', { pathname: '/' })).toMatchObject({ module: '前端', title: '未处理的 Promise 异常：boom', fingerprint: 'front:app:rejection:boom' })
    expect(isChunkError(new TypeError('Failed to fetch dynamically imported module: http://h/assets/Page-x.js'))).toBe(true)
    expect(isChunkError(new Error('Unable to preload CSS for /assets/a.css'))).toBe(true)
    expect(isChunkError(new Error('x is undefined'))).toBe(false)
  })
})

describe('reportFrontError', () => {
  it('同一个错误一次会话只报一次，不同的错误各报一次', async () => {
    const a = await reportFrontError('error', new Error('一号错误'))
    const b = await reportFrontError('error', new Error('一号错误'))
    await reportFrontError('error', new Error('一号错误'))
    expect(a).toEqual({ ok: true, id: 'inc_9' })
    expect(b.ok).toBe(true)
    expect(reports).toHaveLength(1)
    await reportFrontError('error', new Error('二号错误'))
    expect(reports).toHaveLength(2)
  })

  it('页面刷新后（同一会话）不再报', async () => {
    await reportFrontError('error', new Error('刷新前'))
    // 模拟刷新：内存里的清掉，会话存储还在
    resetReportedMemoryOnly()
    const r = await reportFrontError('error', new Error('刷新前'))
    expect(r.ok).toBe(true)
    expect(reports).toHaveLength(1)
  })

  it('上报失败静默，不抛', async () => {
    failReport = true
    await expect(reportFrontError('rejection', new Error('限流'))).resolves.toEqual({ ok: false })
  })

  it('浏览器噪音不报', async () => {
    await reportFrontError('error', new Error('ResizeObserver loop completed with undelivered notifications.'))
    expect(reports).toHaveLength(0)
  })
})

// 只清内存里的记录，会话存储里的指纹留着
function resetReportedMemoryOnly() {
  const kept = sessionStorage.getItem('pmw.reportedErrors')
  resetReported()
  if (kept) sessionStorage.setItem('pmw.reportedErrors', kept)
}

describe('「出错了」页（RouteError）', () => {
  function renderBroken(message: string) {
    const Boom = () => { throw new TypeError(message) }
    const router = createMemoryRouter([
      { path: '/', errorElement: <RouteError />, children: [{ path: 'tasks', element: <Boom /> }, { path: 'settings/*', element: <div>设置页</div> }] },
    ], { initialEntries: ['/tasks'] })
    return render(<RouterProvider router={router} />)
  }

  it('检查过不是换版本后记成运行异常，提示并给链接；同一个错误再进不再报', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const v = renderBroken("Cannot read properties of undefined (reading 'label')")
    expect(await screen.findByText('出错了')).toBeInTheDocument()
    const link = await screen.findByRole('link', { name: '设置 / 运行异常' })
    expect(link).toHaveAttribute('href', '/settings/incidents?open=inc_9')
    expect(reports).toHaveLength(1)
    expect(reports[0]).toMatchObject({ level: 'error', title: "Cannot read properties of undefined (reading 'label')" })
    v.unmount()
    renderBroken("Cannot read properties of undefined (reading 'label')")
    await screen.findByRole('link', { name: '设置 / 运行异常' })
    expect(reports).toHaveLength(1)
  })

  it('上报失败时不写「已记到」', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    failReport = true
    renderBroken('另一个错误')
    expect(await screen.findByText('另一个错误')).toBeInTheDocument()
    await waitFor(() => expect(reports).toHaveLength(1))
    expect(screen.queryByText(/已记到/)).toBeNull()
  })
})
