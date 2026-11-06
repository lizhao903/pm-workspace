import { describe, expect, it } from 'vitest'
import type { ImConversationSummary, ImNameRefillResult } from '../../core/data'
import {
  GROUP_BATCH_MAX, adoptable, chunks, displayName, filterGroups, mergeResults, needsRefill, pickAllGroups, pickedGroups, refillBatchText, refillOneText, refillTitle, refillable,
  resultText, suggestAll, suggestFor, suggestReason, togglePick,
} from './groupAdminModel'

const conv = (p: Partial<ImConversationSummary> & { conversation_id: string }): ImConversationSummary => ({
  channel: 'slack', kind: 'group', name: '', external_id: 'C0', participants: [], total: 1, pending: 0, unread: 0, last_at: '2026-03-01T00:00:00Z',
  project_id: null, project_ref: '', project_name: '', connector_id: 'cn_sl', sent: 0, last_sent_at: null, unresolved_users: [], name_unresolved: false, can_refill: true, refill_error: '', ...p,
})

const projects = [
  { id: 'obj_acme', title: 'Acme', ref: 'PRJ-0009' },
  { id: 'obj_globex', title: 'Globex', ref: 'PRJ-0008' },
  { id: 'obj_ns', title: 'NS 系统', ref: 'PRJ-0010' },
  { id: 'obj_one', title: '一人之下控制台', ref: 'PRJ-0007' },
]

describe('显示名', () => {
  it('群用群名，私聊显示对方，多人私信带上前三个人', () => {
    expect(displayName(conv({ conversation_id: 'a', name: '#product' }))).toBe('#product')
    expect(displayName(conv({ conversation_id: 'b', kind: 'direct', participants: ['林原'] }))).toBe('林原')
    expect(displayName(conv({ conversation_id: 'c', kind: 'direct', external_id: 'D01' }))).toBe('D01')
    expect(displayName(conv({ conversation_id: 'd', name: '多人私信', participants: ['甲', '乙', '丙', '丁'] }))).toBe('多人私信：甲、乙、丙 等')
    expect(displayName(conv({ conversation_id: 'e', name: '多人私信', participants: ['甲', '乙'] }))).toBe('多人私信：甲、乙')
  })
})

describe('筛选', () => {
  const rows = [
    conv({ conversation_id: 'g1', name: '#ai-acme-platform', participants: ['林原'], project_id: 'obj_acme', project_name: 'Acme' }),
    conv({ conversation_id: 'g2', name: '#globex-waas', channel: 'telegram' }),
    conv({ conversation_id: 'd1', kind: 'direct', participants: ['周舟'] }),
  ]
  it('按渠道、类型、没设归属、搜索筛，顺序不变', () => {
    expect(filterGroups(rows, { channel: '', kind: '', q: '', unset: false }).map((s) => s.conversation_id)).toEqual(['g1', 'g2', 'd1'])
    expect(filterGroups(rows, { channel: 'slack', kind: '', q: '', unset: false }).map((s) => s.conversation_id)).toEqual(['g1', 'd1'])
    expect(filterGroups(rows, { channel: '', kind: 'direct', q: '', unset: false }).map((s) => s.conversation_id)).toEqual(['d1'])
    expect(filterGroups(rows, { channel: '', kind: 'group', q: '', unset: true }).map((s) => s.conversation_id)).toEqual(['g2'])
    // 搜成员、项目名都能搜到，不分大小写
    expect(filterGroups(rows, { channel: '', kind: '', q: '林原', unset: false }).map((s) => s.conversation_id)).toEqual(['g1'])
    expect(filterGroups(rows, { channel: '', kind: '', q: 'ACME', unset: false }).map((s) => s.conversation_id)).toEqual(['g1'])
    expect(filterGroups(rows, { channel: '', kind: '', q: '周舟', unset: false }).map((s) => s.conversation_id)).toEqual(['d1'])
  })
})

describe('勾选', () => {
  it('最多勾 200 个；全选只取前 200；换了筛选看不见的不算', () => {
    const many = Array.from({ length: GROUP_BATCH_MAX + 5 }, (_, i) => conv({ conversation_id: `c${i}` }))
    const all = pickAllGroups(many)
    expect(all.size).toBe(GROUP_BATCH_MAX)
    expect(togglePick(all, 'c204').size).toBe(GROUP_BATCH_MAX)
    expect(togglePick(all, 'c0').has('c0')).toBe(false)
    expect(pickedGroups(many.slice(0, 3), all).map((s) => s.conversation_id)).toEqual(['c0', 'c1', 'c2'])
  })
})

describe('按群名建议项目', () => {
  it('acme、globex、-ns- 三条关键字和项目编号、项目名', () => {
    expect(suggestFor(conv({ conversation_id: 'a', name: '#ai-acme-platform' }), projects)).toEqual({ ids: ['obj_acme'], hits: ['acme'] })
    expect(suggestFor(conv({ conversation_id: 'b', name: '#沟通-globex-产研' }), projects)?.ids).toEqual(['obj_globex'])
    expect(suggestFor(conv({ conversation_id: 'c', name: '#fde-bi-ns-support' }), projects)).toEqual({ ids: ['obj_ns'], hits: ['-ns-'] })
    // -ns- 在开头也认，夹在词里不认
    expect(suggestFor(conv({ conversation_id: 'd', name: '#ns-ops' }), projects)?.ids).toEqual(['obj_ns'])
    expect(suggestFor(conv({ conversation_id: 'e', name: '#dns-fix' }), projects)).toBeNull()
    expect(suggestFor(conv({ conversation_id: 'f', name: '#transactions' }), projects)).toBeNull()
    // 编号、项目名（不少于 3 个字）
    expect(suggestFor(conv({ conversation_id: 'g', name: '#prj-0007-讨论' }), projects)?.ids).toEqual(['obj_one'])
    expect(suggestFor(conv({ conversation_id: 'h', name: '一人之下控制台 反馈' }), projects)?.ids).toEqual(['obj_one'])
  })

  it('几个项目都命中时按在群名里出现的先后列出，全部采纳不管它', () => {
    const rows = [
      conv({ conversation_id: 'two', name: '#globex-acme-智能客服支持' }),
      conv({ conversation_id: 'one', name: '#acme-平台反馈' }),
      conv({ conversation_id: 'set', name: '#acme-x', project_id: 'obj_globex' }),
      conv({ conversation_id: 'dm', kind: 'direct', name: '', participants: ['acme 小助手'] }),
      conv({ conversation_id: 'mp', name: '多人私信', participants: ['acme'] }),
    ]
    const s = suggestAll(rows, projects)
    expect(s.get('two')?.ids).toEqual(['obj_globex', 'obj_acme'])
    expect([...s.keys()]).toEqual(['two', 'one'])
    expect(adoptable(rows, s)).toEqual([{ conversation_id: 'one', project_id: 'obj_acme' }])
    expect(suggestReason(s.get('two')!)).toBe('群名里有「globex」、「acme」')
  })

  it('项目不在时这条关键字不建议', () => {
    expect(suggestFor(conv({ conversation_id: 'a', name: '#fde-bi-ns-support' }), projects.filter((p) => p.id !== 'obj_ns'))).toBeNull()
  })
})

describe('批量请求', () => {
  it('超过 200 个切开，结果合起来', () => {
    expect(chunks(Array.from({ length: 450 }, (_, i) => i)).map((c) => c.length)).toEqual([200, 200, 50])
    const r = mergeResults([
      { updated: [{ conversation_id: 'a', project_id: 'p', project_ref: '', project_name: '', updated_at: '' }], failed: [] },
      { updated: [], failed: [{ conversation_id: 'b', project_id: 'x', code: 'not_found', message: '会话不存在' }] },
    ])
    expect(r.updated.length).toBe(1)
    expect(r.failed.length).toBe(1)
    expect(resultText(r, '设为「Acme」', (id) => (id === 'b' ? '#ops' : ''))).toEqual({ text: '已设为「Acme」：1 个会话；1 个没设成：#ops：会话不存在', bad: true })
    expect(resultText({ updated: r.updated, failed: [] }, '清除归属', () => '')).toEqual({ text: '已清除归属：1 个会话', bad: false })
  })
})

describe('查询回填', () => {
  const res = (p: Partial<ImNameRefillResult>): ImNameRefillResult => ({ conversations: 1, checked: 1, filled: [], failed: [], skipped: 0, remaining: 0, ...p })
  it('哪些行要回填、哪些能批量', () => {
    const rows = [
      conv({ conversation_id: 'a', unresolved_users: ['U1'] }),
      conv({ conversation_id: 'b', name_unresolved: true }),
      conv({ conversation_id: 'c', unresolved_users: ['123'], can_refill: false }),
      conv({ conversation_id: 'd' }),
    ]
    expect(rows.map(needsRefill)).toEqual([true, true, true, false])
    expect(refillable(rows).map((s) => s.conversation_id)).toEqual(['a', 'b'])
    expect(refillable([conv({ conversation_id: 'f', unresolved_users: ['U9'], refill_error: '查不到这个人' })])).toEqual([])
    expect(refillTitle(rows[2])).toContain('查不了')
    expect(refillTitle(conv({ conversation_id: 'e', name_unresolved: true, unresolved_users: ['U1', 'U2', 'U3', 'U4'] }))).toBe('回渠道查群名、4 个只有编号的人（U1、U2、U3 等）的名字并补上；只补空的，不改联系人和手动改过的名字')
  })
  it('结果说成一句', () => {
    const f = { conversation_id: 'a', kind: 'user', external_id: 'U1', name: 'Mia', source: 'channel' }
    const x = { conversation_id: 'a', kind: 'user', external_id: 'U2', code: 'user_not_found', message: '查不到这个人' }
    expect(refillOneText(res({ filled: [f] }))).toEqual({ text: '已补上：Mia', bad: false })
    expect(refillOneText(res({ failed: [x] }))).toEqual({ text: '没查到 1 个：查不到这个人', bad: true })
    expect(refillOneText(res({ remaining: 2 })).text).toContain('限流')
    expect(refillOneText(res({ checked: 0 }))).toEqual({ text: '没有要补的名字了', bad: false })
    expect(refillBatchText(res({ checked: 5, filled: [f], failed: [x], skipped: 1, remaining: 2 })).text)
      .toBe('补上 1 个名字，1 个没查到（查不到这个人），1 个之前就没查到，这次跳过，还剩 2 个没查（一次最多查 100 个、撞上限流就停），再点一次接着查')
    expect(refillBatchText(res({ checked: 0 }))).toEqual({ text: '没有缺名字的会话', bad: false })
    expect(refillBatchText(res({ checked: 5, skipped: 5 }))).toEqual({ text: '没补上新的名字，5 个之前就没查到，这次跳过', bad: false })
  })
})
