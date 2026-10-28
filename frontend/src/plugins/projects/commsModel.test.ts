import { describe, expect, it } from 'vitest'
import type { Contact, Conversation, Identity, ImMessage } from '../../core/data'
import { DM_PEEK, awaitingReply, channelLabeler, directCandidates, groupCandidates, mentionParts, peopleOf, pendingByConversation } from './commsModel'

const conv = (id: string, p: Partial<Conversation> = {}): Conversation => ({
  id, channel: 'slack', external_id: id, kind: 'group', name: `#${id}`, members: [], created_at: '', updated_at: '', ...p,
})
const m = (p: Partial<ImMessage>) => ({ status: 'pending', snooze_until: null, conversation_id: 'cv_a', at: '2026-10-29T00:00:00Z', ...p }) as ImMessage

describe('沟通的纯函数', () => {
  it('待回复不含稍后', () => {
    const now = Date.parse('2026-10-29T00:00:00Z')
    expect(awaitingReply(m({}), now)).toBe(true)
    expect(awaitingReply(m({ snooze_until: '2026-10-29T01:00:00Z' }), now)).toBe(false)
    expect(awaitingReply(m({ snooze_until: '2026-10-28T01:00:00Z' }), now)).toBe(true)
    expect(awaitingReply(m({ status: 'done' }), now)).toBe(false)
    expect(pendingByConversation([m({}), m({}), m({ conversation_id: 'cv_b', status: 'done' })], now)).toEqual(new Map([['cv_a', 2]]))
  })

  it('渠道名：连接器定义优先，没有时内置兜底，再没有原样', () => {
    const l = channelLabeler([{ tool: 'slack', label: 'Slack 工作区', category: 'im' }] as never)
    expect(l('slack')).toBe('Slack 工作区')
    expect(l('lark')).toBe('飞书')
    expect(l('mystery')).toBe('mystery')
  })

  it('群候选去掉已绑的，最近有消息的在前，没搜只露 8 个', () => {
    const convs = Array.from({ length: 10 }, (_, i) => conv(`g${i}`))
    const last = new Map([['g9', '2026-10-29T00:00:00Z'], ['g3', '2026-10-28T00:00:00Z']])
    const r = groupCandidates(convs, new Set(['g0']), last, (k) => k, '')
    expect(r.pool).toBe(9)
    expect(r.shown).toHaveLength(DM_PEEK)
    expect(r.shown.slice(0, 2).map((x) => x.conv.id)).toEqual(['g9', 'g3'])
    expect(groupCandidates(convs, new Set(), last, (k) => k, 'g5').shown.map((x) => x.conv.id)).toEqual(['g5'])
  })

  it('私聊候选按成员认联系人，按公司也能搜', () => {
    const people = peopleOf([{ id: 'idn_1', stakeholder_id: 'stk_1' }] as Identity[], [{ id: 'stk_1', name: '林予安', company: '星河', title: '' }] as Contact[])
    const convs = [conv('d1', { kind: 'direct', name: '', members: ['idn_1'] }), conv('d2', { kind: 'direct', name: 'U999', external_id: 'D2' })]
    const r = directCandidates(convs, new Set(), people, '星河')
    expect(r.shown.map((x) => x.label)).toEqual(['林予安'])
    expect(directCandidates(convs, new Set(['d1']), people, '').shown.map((x) => x.label)).toEqual(['U999'])
  })

  it('正文 @ 切分，@我 和 @所有人 醒目', () => {
    expect(mentionParts('@我 看下，@Lin Yuan 也看 @所有人')).toEqual([
      { name: '我', hot: true }, ' 看下，', { name: 'Lin Yuan', hot: false }, ' 也看 ', { name: '所有人', hot: true },
    ])
  })
})
