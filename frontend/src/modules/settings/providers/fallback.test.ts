// 「失败时改用」（TSK-0392，SPEC-settings-7.22）：存在 extra.fallback_id，选项不含自己、停用的不能选。
import { describe, expect, it } from 'vitest'
import type { AgentProvider } from '../../../core/data'
import { kindOf } from './catalog'
import { createBody, fallbackOptions, initialForm, patchBody } from './model'

const pv = (id: string, over: Partial<AgentProvider> = {}): AgentProvider => ({
  id, name: id, kind: 'openai', base_url: 'https://x', model: 'm', enabled: true, is_default: false,
  api_key_masked: '', has_api_key: true, extra: {}, created_at: '', updated_at: '', ...over,
})

describe('失败时改用', () => {
  it('选项不含自己，停用的不能选，选着的已删除也列上', () => {
    const list = [pv('a'), pv('b'), pv('c', { enabled: false })]
    const opts = fallbackOptions(list, 'a', 'gone')
    expect(opts.map((o) => o.value)).toEqual(['', 'b', 'c', 'gone'])
    expect(opts.find((o) => o.value === 'c')?.disabled).toBe(true)
    expect(opts.find((o) => o.value === 'b')?.disabled).toBe(false)
    expect(opts.at(-1)?.label).toBe('已删除的服务商')
  })

  it('读写 extra.fallback_id，清空时去掉，其余 extra 原样保留', () => {
    const def = kindOf('openai')
    const p = pv('a', { extra: { fallback_id: 'b', keep: 1 } })
    const f = initialForm(def, p)
    expect(f.fallback).toBe('b')
    expect(patchBody(def, f, p).extra).toBeUndefined()
    const cleared = patchBody(def, { ...f, fallback: '' }, p)
    expect(cleared.extra).toEqual({ keep: 1 })
    expect(patchBody(def, { ...f, fallback: 'c' }, p).extra).toEqual({ fallback_id: 'c', keep: 1 })
    expect(createBody(def, { ...initialForm(def), fallback: 'b' }).extra).toMatchObject({ fallback_id: 'b' })
  })
})
