// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { beforeAll, describe, expect, inject, it } from 'vitest'
import { ApiError, setApiBase } from './client'
import { counts, dictionaries, objectTypes, objects, stakeholders } from './resources'

// 连测试实例的只读联调，不写数据。默认跳过，用法见 README「接口层」一节：
//   PMW_LIVE_API=http://127.0.0.1:7796 npm test
// 只连测试实例或临时实例，不要指向真实服务。

declare module 'vitest' {
  export interface ProvidedContext {
    liveApi: string
  }
}

const live = inject('liveApi')

describe.skipIf(!live)('联调测试实例（只读）', () => {
  beforeAll(() => setApiBase(live))

  it('objects.list({type:[task]}) 返回 data 和 total', async () => {
    const res = await objects.list({ type: ['task'], limit: 5 })
    expect(Array.isArray(res.data)).toBe(true)
    expect(typeof res.total).toBe('number')
    expect(res.total).toBeGreaterThanOrEqual(res.data.length)
    for (const o of res.data) expect(o.type_id).toBe('task')
  })

  it('取不存在的 id 得到 not_found', async () => {
    const err = await objects.get('obj_does_not_exist').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err).toMatchObject({ status: 404, code: 'not_found' })
  })

  it('非法参数得到 validation', async () => {
    const err = await objects.list({ sort: 'nope' as never }).catch((e: unknown) => e)
    expect(err).toMatchObject({ status: 400, code: 'validation' })
  })

  it('类型、字典、干系人、计数能读', async () => {
    const types = await objectTypes.list()
    expect(types.find((t) => t.id === 'task')?.statuses.length).toBeGreaterThan(0)
    expect((await dictionaries.list({ withItems: true })).some((d) => d.id === 'priority')).toBe(true)
    expect(Array.isArray(await stakeholders.list())).toBe(true)
    expect(typeof (await counts()).total).toBe('number')
  })

  it('进展和修订带 actor_name、session_id', async () => {
    const { data } = await objects.list({ type: ['task'], limit: 20 })
    for (const o of data) {
      const ps = await objects.progress(o.id, { limit: 5 })
      if (!ps.length) continue
      const p = ps[0]
      expect(p).toHaveProperty('kind')
      expect(Array.isArray(p.commits)).toBe(true)
      expect(Array.isArray(p.files)).toBe(true)
      expect(p).toHaveProperty('status')
      expect(p).toHaveProperty('session_id')
      const rs = await objects.revisions(o.id, { limit: 5 })
      expect(rs[0]).toHaveProperty('actor_name')
      expect(rs[0]).toHaveProperty('session_id')
      return
    }
  })
})
