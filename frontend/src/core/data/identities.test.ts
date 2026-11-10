// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { describe, expect, it } from 'vitest'
import { identitiesByContact, identityOwner, identityPlan, imOf, normExternalId, type Identity } from './identities'

let seq = 0
const idn = (p: Partial<Identity>): Identity => {
  seq += 1
  return {
    id: `idn_${seq}`, stakeholder_id: 'stk_a', channel: 'wechat', external_id: `x${seq}`, display_name: '', account: '',
    created_at: '', updated_at: '', ...p,
  }
}

describe('IM 身份', () => {
  it('编号按后端规则规整：去空白，Telegram 去掉开头的 @，别的渠道保留大小写', () => {
    expect(normExternalId('telegram', '  @Name ')).toBe('Name')
    expect(normExternalId('wechat', ' @Wx ')).toBe('@Wx')
  })

  it('按联系人分组，每个渠道取第一个', () => {
    const list = [idn({ channel: 'wechat', external_id: 'a' }), idn({ channel: 'wechat', external_id: 'b' }), idn({ stakeholder_id: 'stk_b', channel: 'qq', external_id: '1' })]
    const m = identitiesByContact(list)
    expect(imOf(m.get('stk_a'))).toEqual({ wechat: 'a' })
    expect(imOf(m.get('stk_b'))).toEqual({ qq: '1' })
    expect(imOf(undefined)).toEqual({})
  })

  it('比出增删改：新填的建、清空的删、改了的改、没变的不动；Telegram 带 @ 和不带算同一个', () => {
    const before = [
      idn({ id: 'idn_w', channel: 'wechat', external_id: 'old' }),
      idn({ id: 'idn_q', channel: 'qq', external_id: '123' }),
      idn({ id: 'idn_t', channel: 'telegram', external_id: 'tg' }),
    ]
    const ops = identityPlan(before, { wechat: 'new', telegram: '@tg', lark: ' ou_1 ' })
    expect(ops).toEqual(expect.arrayContaining([
      { op: 'patch', id: 'idn_w', channel: 'wechat', external_id: 'new' },
      { op: 'delete', id: 'idn_q', channel: 'qq' },
      { op: 'create', channel: 'lark', external_id: 'ou_1' },
    ]))
    expect(ops).toHaveLength(3)
  })

  it('一个渠道多个身份时只改第一个，其余不动', () => {
    const before = [idn({ id: 'idn_1', channel: 'wechat', external_id: 'a' }), idn({ id: 'idn_2', channel: 'wechat', external_id: 'b' })]
    expect(identityPlan(before, {})).toEqual([{ op: 'delete', id: 'idn_1', channel: 'wechat' }])
  })

  it('查编号属于谁', () => {
    const list = [idn({ stakeholder_id: 'stk_b', channel: 'telegram', external_id: 'bob' })]
    expect(identityOwner(list, 'telegram', '@bob')?.stakeholder_id).toBe('stk_b')
    expect(identityOwner(list, 'wechat', 'bob')).toBeUndefined()
    expect(identityOwner(list, 'telegram', '  ')).toBeUndefined()
  })
})
