import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, requestEnvelope, requestList, setApiBase } from './client'
import { objects } from './resources'

type Call = { url: string; init: RequestInit }

// 打桩 fetch：按给定状态码和响应体回一次，并记下请求
function mockFetch(status: number, body: unknown, raw = false) {
  const calls: Call[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      const text = raw ? String(body) : JSON.stringify(body)
      return new Response(text, { status, headers: { 'Content-Type': raw ? 'text/html' : 'application/json' } })
    }),
  )
  return calls
}

afterEach(() => {
  vi.unstubAllGlobals()
  setApiBase('')
})

describe('信封解析', () => {
  it('解开 data 和 meta', async () => {
    mockFetch(200, { data: [{ id: 'a' }], meta: { total: 86, limit: 50, offset: 0 } })
    const res = await requestEnvelope<{ id: string }[]>('GET', '/api/objects')
    expect(res.data).toEqual([{ id: 'a' }])
    expect(res.meta).toEqual({ total: 86, limit: 50, offset: 0 })
  })

  it('列表带上 meta.total，没有 meta 时取本页条数', async () => {
    mockFetch(200, { data: [{ id: 'a' }, { id: 'b' }], meta: { total: 86, limit: 2, offset: 0 } })
    expect(await requestList('/api/objects')).toEqual({ data: [{ id: 'a' }, { id: 'b' }], total: 86, limit: 2, offset: 0 })
    mockFetch(200, { data: [{ id: 'a' }] })
    expect((await requestList('/api/x')).total).toBe(1)
  })

  it('data 为 null 的成功响应照常返回', async () => {
    mockFetch(200, { data: null })
    expect((await requestEnvelope('DELETE', '/api/objects/x')).data).toBeNull()
  })

  it('成功状态但缺 data 时报 internal', async () => {
    mockFetch(200, { ok: true })
    await expect(requestEnvelope('GET', '/api/x')).rejects.toMatchObject({ status: 200, code: 'internal' })
  })
})

describe('错误映射成 ApiError', () => {
  const cases = [
    [400, 'validation'],
    [404, 'not_found'],
    [409, 'conflict'],
    [403, 'readonly'],
    [500, 'internal'],
  ] as const

  for (const [status, code] of cases) {
    it(`${status} ${code}`, async () => {
      mockFetch(status, { error: { code, message: 'object not found' } })
      const err = await requestEnvelope('GET', '/api/x').catch((e: unknown) => e)
      expect(err).toBeInstanceOf(ApiError)
      expect(err).toMatchObject({ status, code, message: 'object not found' })
    })
  }

  it('非 JSON 响应按状态码归类', async () => {
    mockFetch(502, '<html>Bad Gateway</html>', true)
    await expect(requestEnvelope('GET', '/api/x')).rejects.toMatchObject({ status: 502, code: 'internal' })
    mockFetch(404, 'not found', true)
    await expect(requestEnvelope('GET', '/api/x')).rejects.toMatchObject({ status: 404, code: 'not_found' })
  })

  it('不认识的错误码按状态码归类', async () => {
    mockFetch(409, { error: { code: 'weird', message: 'm' } })
    await expect(requestEnvelope('GET', '/api/x')).rejects.toMatchObject({ code: 'conflict', message: 'm' })
  })

  it('请求没到后端时是 network', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('fetch failed'))))
    await expect(requestEnvelope('GET', '/api/x')).rejects.toMatchObject({ status: 0, code: 'network' })
  })
})

describe('请求头和请求体', () => {
  it('写请求带 X-Actor-Source: ui，读请求不带', async () => {
    const calls = mockFetch(200, { data: {} })
    await objects.patch('obj_1', { title: 't' })
    await objects.get('obj_1')
    const w = new Headers(calls[0].init.headers)
    expect(calls[0].init.method).toBe('PATCH')
    expect(w.get('X-Actor-Source')).toBe('ui')
    expect(w.get('Content-Type')).toBe('application/json')
    expect(new Headers(calls[1].init.headers).get('X-Actor-Source')).toBeNull()
  })

  it('PATCH 原样保留 null 和空串，丢掉 undefined', async () => {
    const calls = mockFetch(200, { data: {} })
    await objects.patch('obj_1', { category_id: null, owner_id: '', title: undefined })
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ category_id: null, owner_id: '' })
  })

  it('id 转义，query 拼到路径后，base 生效', async () => {
    const calls = mockFetch(200, { data: [] })
    setApiBase('http://127.0.0.1:7796/')
    await objects.delete('a/b', { hard: true })
    await objects.list({ type: ['task'] })
    expect(calls[0].url).toBe('http://127.0.0.1:7796/api/objects/a%2Fb?hard=true')
    expect(calls[1].url).toBe('http://127.0.0.1:7796/api/objects?type=task')
  })
})
