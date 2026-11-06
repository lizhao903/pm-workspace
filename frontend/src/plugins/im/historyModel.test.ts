import { describe, expect, it } from 'vitest'
import type { ImHistoryBackfillResult, ImMember } from '../../core/data'
import { addToBatch, backfillBlock, backfillText, batchText, contactCandidates, emptyBatch } from './historyModel'

const res = (p: Partial<ImHistoryBackfillResult>): ImHistoryBackfillResult => ({
  conversation_id: 'cv_1', connector_id: 'cn_1', range: '7d', scanned: 0, threads_checked: 0, added: 0, expired: 0, muted: 0,
  duplicates: 0, bodies_filled: 0, complete: true, limited: false, capped: false, cursor: '', ...p,
})
const member = (p: Partial<ImMember>): ImMember => ({
  external_id: 'U1', name: '', sender_name: '', identity_id: '', contact_id: '', source: 'conversation', last_at: '2026-11-01T00:00:00Z', is_bot: false, is_self: false, ...p,
})

describe('补全消息（TSK-0724）', () => {
  it('能不能补：没消息、渠道不支持给原因', () => {
    expect(backfillBlock({ total: 0, can_backfill: true, backfill_note: '' })).toContain('还没收到过消息')
    expect(backfillBlock({ total: 3, can_backfill: false, backfill_note: 'Telegram 的 Bot 只能收到加入之后的新消息，拉不到历史消息' })).toContain('Telegram')
    expect(backfillBlock({ total: 3, can_backfill: true, backfill_note: '' })).toBe('')
  })

  it('单个结果：补了多少、跳过多少、补正文；限流和没补完提示继续', () => {
    expect(backfillText(res({ added: 12, expired: 11, muted: 1, duplicates: 20, bodies_filled: 1 })).text)
      .toBe('最近 7 天：已补 12 条（11 条较早的标为已过期，1 条因自动忽略标为已忽略），跳过 20 条已有的，补上 1 条空正文')
    expect(backfillText(res({ duplicates: 5 })).text).toBe('最近 7 天：跳过 5 条已有的')
    expect(backfillText(res({})).text).toBe('最近 7 天：没有要补的消息')
    expect(backfillText(res({ range: '30d', added: 3, complete: false, limited: true, cursor: 'x' })).text).toBe('最近 30 天：已补 3 条；渠道限流停下了，剩余的稍后点「继续补全」')
    expect(backfillText(res({ added: 3, complete: false, cursor: 'x' })).text).toContain('还没补完')
    expect(backfillText(res({ range: 'all', added: 5000, capped: true })).text).toContain('最多翻 5000 条')
  })

  it('批量汇总：限流停下、跳过、失败', () => {
    let b = emptyBatch(3, 1)
    b = addToBatch(b, res({ added: 2, duplicates: 1 }))
    b = addToBatch(b, res({ added: 1, complete: false, limited: true }))
    b = { ...b, left: 1 }
    expect(batchText(b, '30d')).toEqual({ bad: false, text: '最近 30 天补全 2 个会话：已补 3 条，跳过 1 条已有的；1 个没补完，在行上点「继续补全」；渠道限流停下了，还有 1 个会话没补，稍后再点；1 个渠道不支持或还没消息，跳过' })
    const f = { ...emptyBatch(1, 0), done: 1, failed: [{ name: '#ops', error: '连接器「Slack」已暂停' }] }
    expect(batchText(f, '7d')).toEqual({ bad: true, text: '最近 7 天补全 1 个会话：没有要补的消息；1 个没补成：#ops：连接器「Slack」已暂停' })
  })

  it('全部加为联系人的名单：发过言、没认上、不是机器人和自己', () => {
    const list = [
      member({ external_id: 'U1', sender_name: 'Lin' }),
      member({ external_id: 'U2', contact_id: 'stk_2', name: '周舟' }),
      member({ external_id: 'B1', is_bot: true }),
      member({ external_id: 'U3', is_self: true }),
      member({ external_id: 'U4', last_at: '', source: 'contact' }),
    ]
    expect(contactCandidates(list).map((m) => m.external_id)).toEqual(['U1'])
  })
})
