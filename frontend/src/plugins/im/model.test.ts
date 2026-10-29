import { describe, expect, it } from 'vitest'
import type { Connector, ImMessage } from '../../core/data'
import {
  BATCH_MAX, channelTable, convBatch, convKey, pickAll, pickedRows, togglePick, convOptions, dayLabel, filterRows, fmtSize, inView, mentionParts, nextWake, replyBlocker, snoozeOptions, statusItems,
  taskTitleOf,
} from './model'

let seq = 0
function msg(p: Partial<ImMessage> = {}): ImMessage {
  seq += 1
  return {
    id: `msg_${seq}`, channel: 'slack', connector_id: '', external_id: `C:${seq}`, conversation_id: null, conversation_external_id: 'C01',
    conversation_kind: 'group', conversation: '#product', sender_id: 'U1', sender_name: 'Lin Yuan', identity_id: null, stakeholder_id: null,
    contact_name: '', text: '你好', attachments: [], relevance: '', status: 'pending', read: false, snooze_until: null,
    at: '2026-10-29T01:00:00.000Z', received_at: '2026-10-29T01:00:00.000Z', adapter: 'fake', task_id: null, task_ref: '', replies: [],
    reply_error: '', ...p,
  }
}

const NOW = new Date('2026-10-29T10:00:00+08:00').getTime()
const conn = (p: Partial<Connector>): Connector => ({
  id: 'cn_1', tool: 'slack', name: 'Slack 工作区', account: '', status: 'connected', error: '', auth_mode: 'token', config: {}, secret_hints: {},
  direction: 'both', interval: 5, tools: [], tools_at: null, last_tested_at: null, last_sync_at: null, available: true,
  created_at: '', updated_at: '', ...p,
})

describe('视图', () => {
  it('待处理不含稍后，稍后是待处理且没到点的', () => {
    const later = msg({ snooze_until: new Date(NOW + 3600_000).toISOString() })
    const passed = msg({ snooze_until: new Date(NOW - 1000).toISOString() })
    expect(inView(later, 'pending', NOW)).toBe(false)
    expect(inView(later, 'snoozed', NOW)).toBe(true)
    expect(inView(passed, 'pending', NOW)).toBe(true)
    expect(inView(msg({ status: 'done', snooze_until: later.snooze_until }), 'snoozed', NOW)).toBe(false)
  })

  it('筛选：渠道、会话、与我相关、未读、搜索（含联系人姓名），按时间倒序', () => {
    const a = msg({ text: '@我 看下', relevance: 'me', at: '2026-10-29T02:00:00Z' })
    const b = msg({ text: '@所有人 开会', relevance: 'all', read: true, at: '2026-10-29T03:00:00Z' })
    const c = msg({ channel: 'telegram', conversation: '', conversation_kind: 'direct', relevance: 'dm', contact_name: '宋砚', sender_id: 'song' })
    const list = [a, b, c]
    const f = { view: 'all' as const, channel: '', conv: '', unreadOnly: false, mine: '' as const, q: '' }
    expect(filterRows(list, f, NOW).map((m) => m.id)).toEqual([b.id, a.id, c.id])
    expect(filterRows(list, { ...f, mine: 'mine' }, NOW)).toHaveLength(3)
    expect(filterRows(list, { ...f, mine: 'at' }, NOW).map((m) => m.id)).toEqual([a.id])
    expect(filterRows(list, { ...f, unreadOnly: true }, NOW).map((m) => m.id)).toEqual([a.id, c.id])
    expect(filterRows(list, { ...f, channel: 'telegram' }, NOW).map((m) => m.id)).toEqual([c.id])
    expect(filterRows(list, { ...f, q: '宋砚' }, NOW).map((m) => m.id)).toEqual([c.id])
    expect(filterRows(list, { ...f, conv: convKey(c) }, NOW).map((m) => m.id)).toEqual([c.id])
  })
})

describe('会话', () => {
  it('认上会话的按会话 id，没认上的群按群编号、私聊按发信人', () => {
    expect(convKey(msg({ conversation_id: 'cv_1' }))).toBe('cv:cv_1')
    expect(convKey(msg())).toBe('g:slack|C01')
    expect(convKey(msg({ conversation: '', conversation_kind: 'direct', sender_id: 'U9' }))).toBe('d:slack:U9')
  })

  it('选项分群聊、私聊两组，各按待处理数再按最近时间排', () => {
    const list = [
      msg({ conversation_external_id: 'C01', conversation: '#a', status: 'done', at: '2026-10-29T05:00:00Z' }),
      msg({ conversation_external_id: 'C02', conversation: '#b', at: '2026-10-29T01:00:00Z' }),
      msg({ conversation: '', conversation_kind: 'direct', sender_id: 'U7', sender_name: 'Song', contact_name: '宋砚' }),
    ]
    const opts = convOptions(list, '', NOW)
    expect(opts.map((o) => [o.group, o.label, o.pending])).toEqual([['群聊', '#b', 1], ['群聊', '#a', 0], ['私聊', '宋砚', 1]])
    expect(opts[2].keywords).toBe('Song U7')
    expect(convOptions(list, 'telegram', NOW)).toEqual([])
  })
})

describe('其它', () => {
  it('按天分段', () => {
    const now = new Date(2026, 9, 29, 10)
    expect(dayLabel(new Date(2026, 9, 29, 1).toISOString(), now)).toBe('今天')
    expect(dayLabel(new Date(2026, 9, 28, 23).toISOString(), now)).toBe('昨天')
    expect(dayLabel(new Date(2026, 9, 20).toISOString(), now)).toBe('更早')
  })

  it('稍后：过了 20:00 没有「今晚」', () => {
    expect(snoozeOptions(new Date(2026, 9, 29, 10)).map((o) => o.label)).toEqual(['1 小时后', '今晚 20:00', '明天 9:00'])
    expect(snoozeOptions(new Date(2026, 9, 29, 21)).map((o) => o.label)).toEqual(['1 小时后', '明天 9:00'])
  })

  it('最早的稍后到点时间', () => {
    const t1 = new Date(NOW + 60_000).toISOString()
    const t2 = new Date(NOW + 120_000).toISOString()
    expect(nextWake([msg({ snooze_until: t2 }), msg({ snooze_until: t1 }), msg({ status: 'done', snooze_until: t1 })], NOW)).toBe(NOW + 60_000)
    expect(nextWake([msg()], NOW)).toBeNull()
  })

  it('回不了的原因按连接器状态说；没有连接器 id 时交给后端判', () => {
    expect(replyBlocker(msg(), [])).toBeNull()
    expect(replyBlocker(msg({ connector_id: 'cn_x' }), [conn({})])).toBe('渠道已删除，这条消息只能查看')
    expect(replyBlocker(msg({ connector_id: 'cn_1' }), [conn({ status: 'paused' })])).toBe('连接器「Slack 工作区」已暂停')
    expect(replyBlocker(msg({ connector_id: 'cn_1' }), [conn({ direction: 'receive' })])).toBe('连接器「Slack 工作区」设置为只收消息')
    expect(replyBlocker(msg({ connector_id: 'cn_1' }), [conn({})])).toBeNull()
  })

  it('@ 解析：已知称呼整串匹配，英文名带一个空格', () => {
    expect(mentionParts('@我 看下 @Lin Yuan 和 @所有人')).toEqual([
      { name: '我', hot: true }, ' 看下 ', { name: 'Lin Yuan', hot: false }, ' 和 ', { name: '所有人', hot: true },
    ])
    expect(mentionParts('没有提及')).toEqual(['没有提及'])
  })

  it('状态：字典有就按字典的顺序和名字，缺的按内置补', () => {
    const items = statusItems([
      { key: 'done', label: '搞定', color: '', sort_order: 1, archived_at: null },
      { key: 'pending', label: '待办', color: 'red', sort_order: 2, archived_at: null },
    ] as never)
    expect(items.map((i) => [i.key, i.label])).toEqual([['done', '搞定'], ['pending', '待办'], ['ignored', '已忽略']])
    expect(statusItems(undefined).map((i) => i.key)).toEqual(['pending', 'done', 'ignored'])
  })

  it('渠道：连接器定义优先，没有时用内置表', () => {
    const t = channelTable([{ tool: 'slack', label: 'Slack 企业版', category: 'im', color: '' }, { tool: 'discord', label: 'Discord', category: 'im', color: '' }] as never)
    expect(t.find((c) => c.key === 'slack')?.label).toBe('Slack 企业版')
    expect(t.at(-1)?.key).toBe('discord')
  })

  it('转任务默认标题和附件大小', () => {
    expect(taskTitleOf({ text: '  一二  三\n四 ', contact_name: '', sender_name: 'A' })).toBe('一二 三 四')
    expect(taskTitleOf({ text: '', contact_name: '', sender_name: 'Kevin' })).toBe('来自 Kevin 的消息')
    expect([fmtSize(900), fmtSize(48213), fmtSize(3 * 1024 * 1024), fmtSize()]).toEqual(['900 B', '47 KB', '3.0 MB', ''])
  })
})

describe('批量处理（PR-03）', () => {
  it('勾选只算还在列表里的待处理', () => {
    const a = msg(), b = msg({ status: 'done' }), c = msg()
    let sel = togglePick(new Set(), a.id)
    sel = togglePick(sel, b.id)
    sel = togglePick(sel, 'msg_gone')
    expect(pickedRows([a, b, c], sel).map((m) => m.id)).toEqual([a.id])
    expect(togglePick(sel, a.id).has(a.id)).toBe(false)
    expect([...pickAll([a, b, c])]).toEqual([a.id, c.id])
    expect(pickAll(Array.from({ length: BATCH_MAX + 3 }, () => msg())).size).toBe(BATCH_MAX)
  })

  it('会话：登记过的按会话 + 最近一条时间点，没登记的按 id；不含稍后和已处理', () => {
    const later = new Date(NOW + 3600_000).toISOString()
    const xs = [
      msg({ conversation_id: 'cv_1', at: '2026-10-29T01:00:00.000Z' }), msg({ conversation_id: 'cv_1', at: '2026-10-29T02:00:00.000Z' }),
      msg({ conversation_id: 'cv_1', at: '2026-10-29T03:00:00.000Z', snooze_until: later }), msg({ conversation_id: 'cv_1', status: 'done', at: '2026-10-29T04:00:00.000Z' }),
    ]
    expect(convBatch(xs, 'cv:cv_1', NOW)).toEqual({ n: 2, input: { conversation_id: 'cv_1', before: '2026-10-29T02:00:00.000Z' } })
    const loose = msg({ conversation_external_id: 'C09' })
    expect(convBatch([loose], convKey(loose), NOW)).toEqual({ n: 1, input: { ids: [loose.id] } })
    expect(convBatch(xs, '', NOW)).toBeNull()
    expect(convBatch([xs[3]], 'cv:cv_1', NOW)).toBeNull()
  })
})
