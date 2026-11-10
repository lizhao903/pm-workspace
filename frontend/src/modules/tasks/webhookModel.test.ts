// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { describe, expect, it } from 'vitest'
import type { Delivery, LastDelivery, Webhook } from '../../core/data'
import {
  buildCreate, buildPatch, curlExample, deliveryText, draftError, draftOf, getPath, hmacHex, mapFields, newDraft, parseJson, passFilter,
  recentHooks, sortHooks,
} from './webhookModel'

function hook(id: string, p: Partial<Webhook> = {}): Webhook {
  return {
    id, name: id, token: `tok_${id}`, enabled: true,
    mapping: { title: 'event.title', desc: '', priority: '', assignee: '', due: '' },
    filter: '', dedupe: '', defaults: { priority: 'P2', assignee: '' }, sample: '{}',
    secret_hint: 'whsec_ab', secret_version: 1, secret_rotated_at: null, created_at: '', updated_at: '', ...p,
  }
}
function dl(result: Delivery['result'], at: string, p: Partial<Delivery> = {}): Delivery {
  return {
    id: `dl_${at}`, hook_id: 'wh', at, payload: {}, result, reason: '', task_id: null, external_id: '', dedupe_key: '',
    mapped: { title: '', desc: '', priority: '', assignee: '', due: '' }, task_ref: '', task_deleted: false, ...p,
  }
}
const last = (d: Delivery | null): LastDelivery => ({ last: d, total: d ? 1 : 0 })

describe('映射和过滤预览', () => {
  const payload = { event: { title: '导出超时', level: 'error', tags: ['a', 'b'] }, items: [{ name: '第一条' }], action: 'created' }

  it('路径支持点和下标，对象转成 JSON 文字', () => {
    expect(getPath(payload, 'items[0].name')).toBe('第一条')
    expect(getPath(payload, ' event.title ')).toBe('导出超时')
    expect(getPath(payload, 'event.nope')).toBeUndefined()
    expect(getPath(payload, '')).toBeUndefined()
    expect(mapFields({ title: 'event.title', desc: 'event.tags', priority: 'event.level', assignee: '', due: 'x' }, payload))
      .toEqual({ title: '导出超时', desc: '["a","b"]', priority: 'error', assignee: '', due: '' })
  })

  it('过滤：== 和 !=，写法不对和不满足各有原因', () => {
    expect(passFilter('', payload)).toEqual({ pass: true })
    expect(passFilter('action == created', payload)).toEqual({ pass: true })
    expect(passFilter("action != 'created'", payload).pass).toBe(false)
    expect(passFilter('action == resolved', payload).reason).toBe('不满足过滤条件 action == resolved（实际是「created」）')
    expect(passFilter('action', payload).reason).toBe('过滤条件写法不对：action')
  })

  it('测试推送 JSON 要是对象', () => {
    expect(parseJson('{"a":1}')).toEqual({ ok: true, value: { a: 1 } })
    expect(parseJson('[1]')).toEqual({ ok: false, error: '推送内容要是一个 JSON 对象' })
    expect(parseJson('{').ok).toBe(false)
  })
})

describe('列表排序', () => {
  it('最近失败的在前，其次启用的，再按最近推送时间', () => {
    const hooks = [hook('a'), hook('b', { enabled: false }), hook('c'), hook('d')]
    const m = { a: last(dl('created', '2026-10-29T01:00:00Z')), b: last(null), c: last(dl('failed', '2026-10-28T01:00:00Z')), d: last(dl('skipped', '2026-10-29T02:00:00Z')) }
    expect(sortHooks(hooks, m).map((h) => h.id)).toEqual(['c', 'd', 'a', 'b'])
    // 菜单「最近推送」只要推送过的，新的在前
    expect(recentHooks(hooks, m).map((h) => h.id)).toEqual(['d', 'a', 'c'])
    expect(recentHooks(hooks, m, 1).map((h) => h.id)).toEqual(['d'])
  })

  it('推送记录的说明：建了任务写编号和标题，其余写原因', () => {
    expect(deliveryText(dl('created', '', { task_ref: 'TSK-0001', mapped: { title: '导出超时', desc: '', priority: '', assignee: '', due: '' } }))).toBe('TSK-0001 导出超时')
    expect(deliveryText(dl('failed', '', { reason: '标题路径 a 取不到值' }))).toBe('标题路径 a 取不到值')
    expect(deliveryText(dl('skipped', ''))).toBe('已忽略')
  })
})

describe('配置草稿', () => {
  it('只挑改动的字段，去首尾空白；mapping 整体替换', () => {
    const before = draftOf(hook('a'))
    expect(buildPatch(before, before)).toEqual({})
    expect(buildPatch(before, { ...before, name: ' a ' })).toEqual({})
    expect(buildPatch(before, { ...before, enabled: false, filter: ' action == created ', mapping: { ...before.mapping, desc: ' event.culprit ' } }))
      .toEqual({ enabled: false, filter: 'action == created', mapping: { title: 'event.title', desc: 'event.culprit', priority: '', assignee: '', due: '' } })
    expect(buildPatch(before, { ...before, sample: '{"a":1}' })).toEqual({ sample: '{"a":1}' })
  })

  it('新建的默认值和必填检查', () => {
    const d = newDraft('P2')
    expect(d.mapping.title).toBe('title')
    expect(d.defaults).toEqual({ priority: 'P2', assignee: '' })
    expect(draftError(d)).toBe('还没有名称')
    expect(draftError({ ...d, name: 'x', mapping: { ...d.mapping, title: ' ' } })).toBe('标题映射必填')
    expect(buildCreate({ ...d, name: ' Sentry ' })).toMatchObject({ name: 'Sentry', enabled: true, mapping: { title: 'title' } })
  })
})

describe('签名', () => {
  it('HMAC-SHA256 十六进制，和标准测试向量一致', async () => {
    expect(await hmacHex('key', 'The quick brown fox jumps over the lazy dog'))
      .toBe('f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8')
  })

  it('curl 示例不写密钥明文，单引号转义', () => {
    const c = curlExample('http://127.0.0.1:7796/api/hooks/abc', `{"t":"it's"}`)
    expect(c).toContain(`SECRET='<Secret>'`)
    expect(c).toContain(`BODY='{"t":"it'\\''s"}'`)
    expect(c).toContain('X-PMW-Signature: $SIG')
  })
})
