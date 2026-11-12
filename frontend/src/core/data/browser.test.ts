// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { QueryClient } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { browserApi } from './browser'
import { browserKeys } from './browserKeys'
import { applyChange, invalidationsFor } from './invalidate'
import { dataKeys } from './keys'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('浏览器的失效规则', () => {
  it('登录、退出 Google 刷账号和连接器列表', () => {
    expect(invalidationsFor({ kind: 'browser-google' })).toEqual([browserKeys.google, dataKeys.connectors.list])
  })

  it('在连接器里断开、删掉 Drive，浏览器的账号也刷（SPEC-browser-4.13）', async () => {
    const qc = new QueryClient()
    qc.setQueryData(browserKeys.google, {})
    qc.setQueryData(dataKeys.connectors.defs, {})
    await applyChange(qc, { kind: 'connector' })
    expect(qc.getQueryState(browserKeys.google)?.isInvalidated).toBe(true)
    expect(qc.getQueryState(dataKeys.connectors.defs)?.isInvalidated).toBe(false)
  })
})

describe('browserApi', () => {
  it('路径和方法同契约；PUT 整体替换带 tabs，登录带 return_to', async () => {
    const calls: { method: string; url: string; body?: string; keepalive?: boolean }[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ method: init?.method ?? 'GET', url: String(input), body: init?.body as string | undefined, keepalive: init?.keepalive })
      return new Response(JSON.stringify({ data: [], meta: { total: 0 } }), { status: 200 })
    }))
    await browserApi.tabs()
    await browserApi.putTabs([], true)
    await browserApi.google()
    await browserApi.login('/browser')
    await browserApi.logout()
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'GET /api/browser/tabs', 'PUT /api/browser/tabs', 'GET /api/browser/google', 'POST /api/browser/google/login', 'POST /api/browser/google/logout',
    ])
    expect(calls[1]).toMatchObject({ body: '{"tabs":[]}', keepalive: true })
    expect(calls[3].body).toBe('{"return_to":"/browser"}')
    expect(calls[4].body).toBe('{}')
  })
})
