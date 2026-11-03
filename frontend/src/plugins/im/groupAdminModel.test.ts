import { describe, expect, it } from 'vitest'
import type { ImConversationSummary } from '../../core/data'
import {
  GROUP_BATCH_MAX, adoptable, chunks, displayName, filterGroups, mergeResults, pickAllGroups, pickedGroups, resultText, suggestAll, suggestFor, suggestReason, togglePick,
} from './groupAdminModel'

const conv = (p: Partial<ImConversationSummary> & { conversation_id: string }): ImConversationSummary => ({
  channel: 'slack', kind: 'group', name: '', external_id: 'C0', participants: [], total: 1, pending: 0, unread: 0, last_at: '2026-03-01T00:00:00Z',
  project_id: null, project_ref: '', project_name: '', connector_id: 'cn_sl', sent: 0, last_sent_at: null, ...p,
})

const projects = [
  { id: 'obj_octok', title: 'Octok', ref: 'PRJ-0009' },
  { id: 'obj_xaue', title: 'XAUE', ref: 'PRJ-0008' },
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
    conv({ conversation_id: 'g1', name: '#ai-octok-platform', participants: ['林原'], project_id: 'obj_octok', project_name: 'Octok' }),
    conv({ conversation_id: 'g2', name: '#xaue-waas', channel: 'telegram' }),
    conv({ conversation_id: 'd1', kind: 'direct', participants: ['周舟'] }),
  ]
  it('按渠道、类型、没设归属、搜索筛，顺序不变', () => {
    expect(filterGroups(rows, { channel: '', kind: '', q: '', unset: false }).map((s) => s.conversation_id)).toEqual(['g1', 'g2', 'd1'])
    expect(filterGroups(rows, { channel: 'slack', kind: '', q: '', unset: false }).map((s) => s.conversation_id)).toEqual(['g1', 'd1'])
    expect(filterGroups(rows, { channel: '', kind: 'direct', q: '', unset: false }).map((s) => s.conversation_id)).toEqual(['d1'])
    expect(filterGroups(rows, { channel: '', kind: 'group', q: '', unset: true }).map((s) => s.conversation_id)).toEqual(['g2'])
    // 搜成员、项目名都能搜到，不分大小写
    expect(filterGroups(rows, { channel: '', kind: '', q: '林原', unset: false }).map((s) => s.conversation_id)).toEqual(['g1'])
    expect(filterGroups(rows, { channel: '', kind: '', q: 'OCTOK', unset: false }).map((s) => s.conversation_id)).toEqual(['g1'])
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
  it('octok、xaue、-ns- 三条关键字和项目编号、项目名', () => {
    expect(suggestFor(conv({ conversation_id: 'a', name: '#ai-octok-platform' }), projects)).toEqual({ ids: ['obj_octok'], hits: ['octok'] })
    expect(suggestFor(conv({ conversation_id: 'b', name: '#沟通-xaue-产研' }), projects)?.ids).toEqual(['obj_xaue'])
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
      conv({ conversation_id: 'two', name: '#xaue-octok-智能客服支持' }),
      conv({ conversation_id: 'one', name: '#octok-平台反馈' }),
      conv({ conversation_id: 'set', name: '#octok-x', project_id: 'obj_xaue' }),
      conv({ conversation_id: 'dm', kind: 'direct', name: '', participants: ['octok 小助手'] }),
      conv({ conversation_id: 'mp', name: '多人私信', participants: ['octok'] }),
    ]
    const s = suggestAll(rows, projects)
    expect(s.get('two')?.ids).toEqual(['obj_xaue', 'obj_octok'])
    expect([...s.keys()]).toEqual(['two', 'one'])
    expect(adoptable(rows, s)).toEqual([{ conversation_id: 'one', project_id: 'obj_octok' }])
    expect(suggestReason(s.get('two')!)).toBe('群名里有「xaue」、「octok」')
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
    expect(resultText(r, '设为「Octok」', (id) => (id === 'b' ? '#ops' : ''))).toEqual({ text: '已设为「Octok」：1 个会话；1 个没设成：#ops：会话不存在', bad: true })
    expect(resultText({ updated: r.updated, failed: [] }, '清除归属', () => '')).toEqual({ text: '已清除归属：1 个会话', bad: false })
  })
})
