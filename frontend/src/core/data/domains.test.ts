import { afterEach, describe, expect, it, vi } from 'vitest'
import { domainKeys } from './domainKeys'
import { domainsApi } from './domains'
import { invalidationsFor } from './invalidate'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('内网域名的失效规则', () => {
  it('设置、路由改了刷整个前缀：完整域名、状态、配置都跟着变', () => {
    expect(invalidationsFor({ kind: 'domains' })).toEqual([domainKeys.all])
    for (const k of [domainKeys.settings, domainKeys.routes, domainKeys.status, domainKeys.config]) expect(k[0]).toBe(domainKeys.all[0])
  })
  it('测试一次只刷路由列表，不重测本机状态', () => {
    expect(invalidationsFor({ kind: 'domain-check' })).toEqual([domainKeys.routes])
  })
})

describe('domainsApi', () => {
  it('路径和方法同契约，写请求带 X-Actor-Source', async () => {
    const calls: { method: string; url: string; body?: string; src?: string | null }[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ method: init?.method ?? 'GET', url: String(input), body: init?.body as string | undefined, src: new Headers(init?.headers).get('X-Actor-Source') })
      return new Response(JSON.stringify({ data: [], meta: { total: 0 } }), { status: 200 })
    }))
    await domainsApi.routes()
    await domainsApi.putSettings({ suffix: 'pmw.lan' })
    await domainsApi.patchRoute('dm_1', { enabled: false })
    await domainsApi.checkRoute('dm_1')
    await domainsApi.removeRoute('dm_1')
    await domainsApi.status()
    await domainsApi.config()
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'GET /api/domains/routes', 'PUT /api/domains/settings', 'PATCH /api/domains/routes/dm_1', 'POST /api/domains/routes/dm_1/check',
      'DELETE /api/domains/routes/dm_1', 'GET /api/domains/status', 'GET /api/domains/config',
    ])
    expect(calls[1].body).toBe('{"suffix":"pmw.lan"}')
    expect(calls[1].src).toBe('ui')
  })
})
