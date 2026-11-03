import { describe, expect, it } from 'vitest'
import type { Connector, ImConversationSummary } from '../../core/data'
import { parseTarget, sendBlocker, sendInput, sendOptions, sentReplyTitle } from './sendModel'

const conv = (p: Partial<ImConversationSummary> & { conversation_id: string }): ImConversationSummary => ({
  channel: 'slack', kind: 'group', name: '', external_id: 'C0', connector_id: 'cn_a', participants: [], total: 1, pending: 0, unread: 0,
  last_at: '2026-03-01T00:00:00Z', project_id: null, project_ref: '', project_name: '', sent: 0, last_sent_at: null, ...p,
})
const rows = [
  conv({ conversation_id: 'cv_dm', kind: 'direct', participants: ['阿青'], external_id: 'D1' }),
  conv({ conversation_id: 'cv_g', name: '#product', external_id: 'C1' }),
  conv({ conversation_id: 'cv_b', name: '#other', external_id: 'C2', connector_id: 'cn_b' }),
  conv({ conversation_id: 'cv_tg', channel: 'telegram', name: '群', external_id: '-100' }),
  conv({ conversation_id: 'cv_set', name: '#set-only', external_id: 'C3', total: 0, last_at: null }),
]
const extra = [
  { id: 'C1', name: 'product', kind: 'public' as const, is_member: true, is_archived: false },
  { id: 'C9', name: 'ops', kind: 'private' as const, is_member: true, is_archived: false },
  { id: 'C8', name: 'old', kind: 'public' as const, is_member: true, is_archived: true },
  { id: 'C7', name: 'notin', kind: 'public' as const, is_member: false, is_archived: false },
]

describe('能发的会话', () => {
  it('群聊在前、私聊在后，再接上没收过消息的频道；没消息的会话、别的渠道不列', () => {
    const o = sendOptions(rows, extra, 'slack', 'cn_a', false)
    expect(o.map((x) => [x.value, x.group])).toEqual([
      ['cv:cv_g', '群聊'], ['cv:cv_b', '群聊'], ['cv:cv_dm', '私聊'], ['ext:C9', '还没收过消息的频道'],
    ])
    expect(o.find((x) => x.value === 'ext:C9')?.label).toBe('#ops')
  })
  it('多个实例时只列这个实例上的', () => {
    expect(sendOptions(rows, [], 'slack', 'cn_b', true).map((x) => x.value)).toEqual(['cv:cv_b'])
  })
  it('请求体：已有会话带实例；新频道带编号和名字', () => {
    const o = sendOptions(rows, extra, 'slack', 'cn_a', false)
    expect(sendInput(parseTarget('cv:cv_g', o)!, 'cn_a', ' 你好 ')).toEqual({ conversation_id: 'cv_g', connector_id: 'cn_a', text: '你好' })
    expect(sendInput(parseTarget('ext:C9', o)!, 'cn_a', '上线')).toEqual({ connector_id: 'cn_a', conversation_external_id: 'C9', conversation_name: 'ops', text: '上线' })
    expect(parseTarget('', o)).toBeNull()
  })
})

describe('发不了的原因和回复说明', () => {
  it('暂停、断开、只收', () => {
    const c = (p: Partial<Connector>) => ({ id: 'x', name: 'Slack', status: 'connected', direction: 'both', ...p }) as Connector
    expect(sendBlocker(c({}))).toBeNull()
    expect(sendBlocker(c({ status: 'paused' }))).toBe('连接器「Slack」已暂停')
    expect(sendBlocker(c({ direction: 'receive' }))).toBe('连接器「Slack」设置为只收消息')
    expect(sendBlocker(undefined)).toBe('先选渠道')
  })
  it('消息列回复和下一条来信', () => {
    const now = new Date('2026-03-01T01:00:00Z').getTime()
    expect(sentReplyTitle({ replied_sent: { outbox_id: 'ob', text: '方案看了吗', at: '2026-03-01T00:30:00Z', via: 'thread' } }, now)).toBe('在消息列里回复了我 30 分钟前发出的「方案看了吗」')
    expect(sentReplyTitle({ replied_sent: { outbox_id: 'ob', text: '好', at: '2026-03-01T00:30:00Z', via: 'next' } }, now)).toBe('回复了我 30 分钟前发出的「好」')
    expect(sentReplyTitle({ replied_sent: null })).toBe('')
  })
})
