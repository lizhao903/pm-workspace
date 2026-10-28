import { afterEach, describe, expect, it, vi } from 'vitest'
import { mergeProps, saveObject } from './taskEdit'

describe('props 合并', () => {
  it('只动改了的 key，其它原样保留；空值去掉 key', () => {
    expect(mergeProps({ x: 1, acceptance: 'a', repo: 'r' }, { acceptance: 'b', repo: null })).toEqual({ x: 1, acceptance: 'b' })
    expect(mergeProps(null, { repo: '/r' })).toEqual({ repo: '/r' })
  })
})

describe('saveObject', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('改 props 时先读回对象再合并，PATCH 体里只有 props', async () => {
    const calls: { method: string; url: string; body?: unknown }[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ method: init.method ?? 'GET', url, body: init.body ? JSON.parse(String(init.body)) : undefined })
      const data = init.method === 'GET' ? { id: 'o', props: { x: 1, acceptance: 'old' } } : { id: 'o' }
      return new Response(JSON.stringify({ data }), { status: 200 })
    }))
    await saveObject({ id: 'o', patch: {}, props: { acceptance: 'new' } })
    expect(calls.map((c) => c.method)).toEqual(['GET', 'PATCH'])
    expect(calls[1].body).toEqual({ props: { x: 1, acceptance: 'new' } })
  })

  it('什么都没改不发请求', async () => {
    const f = vi.fn()
    vi.stubGlobal('fetch', f)
    expect(await saveObject({ id: 'o', patch: {} })).toBeNull()
    expect(f).not.toHaveBeenCalled()
  })
})
