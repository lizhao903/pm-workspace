import { describe, expect, it } from 'vitest'
import type { Contact, Conversation, Identity, ImMessage } from '../../core/data'
import {
  DM_PEEK, awaitingCount, awaitingReply, channelLabeler, directCandidates, fmtSize, groupCandidates, latestByContact, mentionParts, peopleOf,
  pendingByConversation, snippet,
} from './commsModel'

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

describe('项目消息的汇总', () => {
  it('待回复条数不含稍后和已处理', () => {
    const now = Date.parse('2026-10-29T00:00:00Z')
    expect(awaitingCount([m({}), m({ status: 'done' }), m({ snooze_until: '2026-10-29T01:00:00Z' })], now)).toBe(1)
  })

  it('每个联系人最近的一条：先认 stakeholder_id，没有时按身份认', () => {
    const list = [
      m({ id: 'a', stakeholder_id: 'stk_lin', at: '2026-10-29T01:00:00Z' }),
      m({ id: 'b', stakeholder_id: 'stk_lin', at: '2026-10-29T03:00:00Z' }),
      m({ id: 'c', stakeholder_id: null, identity_id: 'idn_zhou', at: '2026-10-29T02:00:00Z' }),
      m({ id: 'd', stakeholder_id: null, identity_id: 'idn_x', at: '2026-10-29T04:00:00Z' }),
    ]
    const got = latestByContact(list, new Map([['idn_zhou', 'stk_zhou']]))
    expect(got.get('stk_lin')?.id).toBe('b')
    expect(got.get('stk_zhou')?.id).toBe('c')
    expect(got.size).toBe(2)
  })

  it('正文前 14 字，超出才加省略号', () => {
    expect(snippet('一二三四五六七八九十一二三四')).toBe('一二三四五六七八九十一二三四')
    expect(snippet('一二三四五六七八九十一二三四五')).toBe('一二三四五六七八九十一二三四…')
    expect(snippet('  a\n b ')).toBe('a b')
  })

  it('附件大小', () => {
    expect(fmtSize(undefined)).toBe('')
    expect(fmtSize(512)).toBe('512 B')
    expect(fmtSize(2048)).toBe('2 KB')
    expect(fmtSize(3 * 1024 * 1024)).toBe('3.0 MB')
  })
})
