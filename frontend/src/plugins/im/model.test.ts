import { describe, expect, it } from 'vitest'
import type { Connector, ImMessage } from '../../core/data'
import {
  GROUP_TAB_MAX, replyNoteOf, channelTable, convBatch, convIdOf, convKey, convOk, convTabs, dmTab, pickedRows, togglePick, convOptions, dayLabel, filterRows, fmtSize, inView, mentionParts, nextWake, replyBlocker, replyWarning, snoozeOptions, statusItems, statusView, viewsOf,
  taskTitleOf, clip100, contactCandidates, nameCloseness, PROJECT_NONE, baseOk, projectCounts, projectFilterOptions, projectOk,
} from './model'

let seq = 0
function msg(p: Partial<ImMessage> = {}): ImMessage {
  seq += 1
  return {
    id: `msg_${seq}`, channel: 'slack', connector_id: '', external_id: `C:${seq}`, conversation_id: null, conversation_external_id: 'C01',
    conversation_kind: 'group', conversation: '#product', sender_id: 'U1', sender_name: 'Lin Yuan', identity_id: null, stakeholder_id: null,
    contact_name: '', text: '你好', attachments: [], relevance: '', status: 'pending', read: false, snooze_until: null,
    at: '2026-10-29T01:00:00.000Z', received_at: '2026-10-29T01:00:00.000Z', adapter: 'fake', task_id: null, task_ref: '', replies: [],
    reply_error: '', expired_at: null, project_id: null, project_name: '', project_source: '', sessions: [], split_tasks: [], materials: [], thread: null, reply_count: 0, ...p,
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

  it('已过期（IM-07）单独一个视图，不算待处理也不算稍后', () => {
    const x = msg({ status: 'expired', expired_at: '2026-10-29T01:00:00.000Z' })
    expect(inView(x, 'expired', NOW)).toBe(true)
    expect(inView(x, 'pending', NOW)).toBe(false)
    expect(inView(x, 'snoozed', NOW)).toBe(false)
    expect(inView(x, 'ignored', NOW)).toBe(false)
    expect(inView(x, 'all', NOW)).toBe(true)
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
    expect(replyBlocker(msg({ connector_id: 'cn_1' }), [conn({ status: 'error', error: '409 Conflict' })])).toBeNull()
    expect(replyWarning(msg({ connector_id: 'cn_1' }), [conn({ status: 'error', error: '409 Conflict' })])).toContain('409 Conflict')
    expect(replyWarning(msg({ connector_id: 'cn_1' }), [conn({})])).toBeNull()
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
    expect(items.map((i) => [i.key, i.label])).toEqual([['done', '搞定'], ['pending', '待办'], ['ignored', '已忽略'], ['expired', '已过期']])
    expect(statusItems(undefined).map((i) => i.key)).toEqual(['pending', 'done', 'ignored', 'expired'])
    // 字典里还没有已过期（后端 0041 只有三项）时补在已忽略后面；视图里排在已忽略后
    expect(viewsOf(statusView(statusItems(undefined))).map(([v]) => v)).toEqual(['pending', 'snoozed', 'done', 'ignored', 'expired'])
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
  it('勾选只算还在列表里的待处理和已过期', () => {
    const a = msg(), b = msg({ status: 'done' }), c = msg({ status: 'expired' })
    let sel = togglePick(new Set(), a.id)
    sel = togglePick(sel, b.id)
    sel = togglePick(sel, 'msg_gone')
    expect(pickedRows([a, b, c], sel).map((m) => m.id)).toEqual([a.id])
    expect(togglePick(sel, a.id).has(a.id)).toBe(false)
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
    // 没登记的会话超过后端一次 500 的上限也不截断（TSK-0492），由 useImBatch 分批
    const many = Array.from({ length: 503 }, () => msg({ conversation_external_id: 'C08' }))
    expect(convBatch(many, convKey(many[0]), NOW)?.input).toEqual({ ids: many.map((m) => m.id) })
    expect(convBatch([xs[3]], 'cv:cv_1', NOW)).toBeNull()
  })
})

describe('群组标签', () => {
  it('没选渠道没有标签；群按条数再按群名排，私聊合成一个，多出来的群和单个私聊进「更多」', () => {
    const xs: ImMessage[] = []
    for (let i = 0; i < GROUP_TAB_MAX + 2; i++) {
      // 第 i 个群有 i+1 条，条数多的排前面
      for (let k = 0; k <= i; k++) xs.push(msg({ conversation_id: `cv_g${i}`, conversation: `#g${i}`, conversation_external_id: `G${i}` }))
    }
    xs.push(msg({ conversation_id: 'cv_d1', conversation: '', conversation_kind: 'direct', conversation_external_id: 'D1', sender_name: '阿明', sender_id: 'U9' }))
    xs.push(msg({ conversation_id: 'cv_d2', conversation: '', conversation_kind: 'direct', conversation_external_id: 'D2', sender_name: '小周', sender_id: 'U8', status: 'done' }))
    xs.push(msg({ channel: 'telegram', conversation_id: 'cv_t', conversation: '运营群' }))
    expect(convTabs(xs, '', NOW)).toEqual({ groups: [], dm: null, more: [], moreGroups: 0 })
    const t = convTabs(xs, 'slack', NOW)
    expect(t.groups.map((g) => g.label)).toEqual([...Array(GROUP_TAB_MAX)].map((_, i) => `#g${GROUP_TAB_MAX + 1 - i}`))
    expect(t.groups[0]).toEqual({ value: `cv:cv_g${GROUP_TAB_MAX + 1}`, label: `#g${GROUP_TAB_MAX + 1}`, pending: GROUP_TAB_MAX + 2, n: GROUP_TAB_MAX + 2 })
    expect(t.dm).toEqual({ value: 'dm:slack', label: '私聊', pending: 1, n: 2 })
    expect(t.more.map((o) => o.label)).toEqual(['#g1', '#g0', '阿明', '小周'])
    expect(t.moreGroups).toBe(2)
  })

  it('私聊标签筛这个渠道的全部私聊；默认项目只认登记过的会话', () => {
    const g = msg({ conversation_id: 'cv_1' })
    const d = msg({ conversation_id: 'cv_d', conversation: '', conversation_kind: 'direct' })
    const tg = msg({ channel: 'telegram', conversation_id: 'cv_t', conversation: '', conversation_kind: 'direct' })
    expect([g, d, tg].filter((m) => convOk(m, dmTab('slack')))).toEqual([d])
    expect(filterRows([g, d, tg], { view: 'all', channel: 'slack', conv: 'dm:slack', unreadOnly: false, mine: '', q: '' }, NOW)).toEqual([d])
    expect(convBatch([g, d], 'dm:slack', NOW)).toEqual({ n: 1, input: { ids: [d.id] } })
    expect(convIdOf('cv:cv_1')).toBe('cv_1')
    expect(convIdOf('dm:slack')).toBeNull()
    expect(convIdOf('g:slack|C01')).toBeNull()
  })
})

describe('认人的候选联系人（IM-05）', () => {
  const c = (id: string, name: string, company = '', title = '') => ({ id, name, company, title })
  const list = [c('a', '王五'), c('b', 'Lin Yuan', 'Globex'), c('c', 'Yuan Li', 'Acme', '产品'), c('d', '林予安')]

  it('名字相近程度：一样、包含、有一个词对上、不像', () => {
    expect(nameCloseness('Lin Yuan', 'lin yuan')).toBe(0)
    expect(nameCloseness('Lin Yuan', 'Lin')).toBe(1)
    expect(nameCloseness('Yuan Li', 'Lin Yuan')).toBe(2)
    expect(nameCloseness('王五', 'Lin Yuan')).toBe(3)
    expect(nameCloseness('王五', '')).toBe(3)
  })

  it('没输入时相近的排前，同样近的按姓名（拼音序）；排除现在挂着的人', () => {
    expect(contactCandidates(list, 'Lin Yuan', '').map((x) => x.id)).toEqual(['b', 'c', 'd', 'a'])
    expect(contactCandidates(list, 'Lin Yuan', '', 'b').map((x) => x.id)).toEqual(['c', 'd', 'a'])
  })

  it('搜姓名、公司、职位', () => {
    expect(contactCandidates(list, '', 'acme').map((x) => x.id)).toEqual(['c'])
    expect(contactCandidates(list, '', '产品').map((x) => x.id)).toEqual(['c'])
    expect(contactCandidates(list, '', '林').map((x) => x.id)).toEqual(['d'])
  })

  it('昵称、账号截到 100 字', () => {
    expect(clip100(` ${'字'.repeat(120)} `)).toHaveLength(100)
  })
})

describe('转任务回执没发起的提示（SPEC-messages-2.50）', () => {
  it('勾了回复、后端说没发起时才提示', () => {
    expect(replyNoteOf(true, { enabled: false, note: 'SOP 编排插件没在运行' })).toBe('任务建好了，但SOP 编排插件没在运行')
    expect(replyNoteOf(true, { enabled: false })).toBe('任务建好了，但回执流程没发起')
    expect(replyNoteOf(true, { enabled: true, run_id: 'run_1' })).toBeUndefined()
    expect(replyNoteOf(false, { enabled: false })).toBeUndefined()
    expect(replyNoteOf(true, undefined)).toBeUndefined()
  })
})

describe('项目筛选（TSK-0723）', () => {
  const a = msg({ project_id: 'obj_a', project_source: 'message', conversation_id: 'cv_1' })
  const b = msg({ project_id: 'obj_a', project_source: 'conversation', conversation_id: 'cv_2', status: 'done' })
  const c = msg({ conversation_id: 'cv_1' })
  const d = msg({ project_id: 'obj_b', project_source: 'message', conversation_id: 'cv_1', relevance: 'me' })
  const all = [a, b, c, d]

  it('按读出的 project_id 筛：空串不筛，none 是没归的', () => {
    expect(all.filter((m) => projectOk(m, '')).length).toBe(4)
    expect(all.filter((m) => projectOk(m, 'obj_a'))).toEqual([a, b])
    expect(all.filter((m) => projectOk(m, PROJECT_NONE))).toEqual([c])
    expect(all.filter((m) => baseOk(m, { channel: '', conv: 'cv:cv_1', mine: '', project: 'obj_a' }))).toEqual([a])
    const f = { view: 'all' as const, channel: '', conv: '', unreadOnly: false, mine: 'at' as const, q: '', project: 'obj_b' }
    expect(filterRows(all, f, NOW)).toEqual([d])
    expect(filterRows(all, { ...f, project: 'obj_a' }, NOW)).toEqual([])
  })

  it('各项目条数按当前视图算、不算项目本身；选项未归项目在前，没归档、没删的项目按条数排', () => {
    const counts = projectCounts(all, { view: 'pending', channel: '', conv: '', unreadOnly: false, mine: '', q: '', project: 'obj_b' }, NOW)
    expect([...counts.entries()].sort()).toEqual([['none', 1], ['obj_a', 1], ['obj_b', 1]])
    const opts = projectFilterOptions([
      { id: 'obj_b', title: 'Beta', archived_at: null, deleted_at: null },
      { id: 'obj_z', title: 'Zeta', archived_at: null, deleted_at: null },
      { id: 'obj_a', title: 'Alpha', archived_at: null, deleted_at: null },
      { id: 'obj_old', title: '归档的', archived_at: '2026-01-01', deleted_at: null },
      { id: 'obj_del', title: '删了的', archived_at: null, deleted_at: '2026-01-01' },
    ], new Map([['obj_b', 3], ['obj_a', 1], ['none', 2]]))
    expect(opts.map((o) => `${o.label} ${o.hint}`)).toEqual(['未归项目 2 条', 'Beta 3 条', 'Alpha 1 条', 'Zeta 0 条'])
  })

  it('选了项目时「这个会话全部标为已处理」按 id，不连别的项目的一起标', () => {
    expect(convBatch([a], 'cv:cv_1', NOW, true)).toEqual({ n: 1, input: { ids: [a.id] } })
  })
})
