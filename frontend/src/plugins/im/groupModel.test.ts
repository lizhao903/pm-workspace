import { describe, expect, it } from 'vitest'
import type { ImMessage } from '../../core/data'
import { clusterMessages, countLabel, nestThreads, pickState, previewText, rowTime, threadBadge, threadBadgeLabel, threadForMany, threadForTask, threadHint, threadOf, threadTaskBody, THREAD_TASK_MAX, toggleRow, toRows } from './groupModel'

let seq = 0
const T0 = Date.parse('2026-11-02T10:00:00Z')
const at = (min: number) => new Date(T0 + min * 60_000).toISOString()
function msg(p: Partial<ImMessage>): ImMessage {
  seq += 1
  return {
    id: `m${String(seq).padStart(3, '0')}`, channel: 'slack', connector_id: '', external_id: `x${seq}`, conversation_id: null, conversation_external_id: 'C1',
    conversation_kind: 'group', conversation: '#g', sender_id: 'U1', sender_name: 'A', identity_id: null, stakeholder_id: null, contact_name: '',
    text: 't', attachments: [], relevance: '', status: 'pending', read: true, snooze_until: null, expired_at: null, at: at(0), received_at: at(0),
    adapter: 'fake', task_id: null, task_ref: '', replies: [], reply_error: '', project_id: null, project_name: '', project_source: '', sessions: [], split_tasks: [], materials: [], thread: null, reply_count: 0, ...p,
  }
}
const desc = (xs: ImMessage[]) => [...xs].sort((a, b) => b.at.localeCompare(a.at))

describe('合并显示的分组', () => {
  it('连发：同一人、相邻不超过 10 分钟、中间没人插话', () => {
    const xs = [msg({ text: '一', at: at(0) }), msg({ text: '二', at: at(9) }), msg({ text: '三', at: at(25) }),
      msg({ text: '别人', sender_id: 'U2', at: at(26) }), msg({ text: '四', at: at(27) })]
    const rows = toRows(desc(xs), clusterMessages(xs), true)
    expect(rows.map((r) => [r.kind, r.items.map((m) => m.text)])).toEqual([
      ['single', ['四']], ['single', ['别人']], ['single', ['三']], ['burst', ['二', '一']],
    ])
    expect(previewText(rows[3])).toBe('一 / 二')
    expect(countLabel(rows[3])).toBe('2 条')
  })

  it('重复：同会话同人同正文 24 小时内，中间有人插话也合；隔天不合', () => {
    const xs = [msg({ text: '构建 失败', at: at(0) }), msg({ text: '插话', sender_id: 'U2', at: at(30) }), msg({ text: '构建失败'.replace('构建', '构建 '), at: at(60) }),
      msg({ text: '构建 失败', at: at(60 * 30) })]
    const rows = toRows(desc(xs), clusterMessages(xs), true)
    const dup = rows.find((r) => r.kind === 'dup')!
    expect(dup.items).toHaveLength(2)
    expect(countLabel(dup)).toBe('重复 2 次')
    expect(rows).toHaveLength(3)
  })

  it('私聊整段一组；筛掉的不在行里，但组里的全部还在（抽屉看整段）；不合并时一条一行', () => {
    const dm = (p: Partial<ImMessage>) => msg({ conversation: '', conversation_kind: 'direct', conversation_external_id: 'D1', sender_id: 'U9', ...p })
    const xs = [dm({ at: at(0), status: 'done' }), dm({ at: at(100) }), dm({ at: at(500) })]
    const cs = clusterMessages(xs)
    const rows = toRows(desc(xs.filter((m) => m.status === 'pending')), cs, true)
    expect(rows).toHaveLength(1)
    expect(rows[0].kind).toBe('dm')
    expect(rows[0].items).toHaveLength(2)
    expect(rows[0].all).toHaveLength(3)
    expect(toRows(desc(xs), cs, false)).toHaveLength(3)
    // key 稳定
    expect(clusterMessages(xs).byKey.has(rows[0].key)).toBe(true)
  })

  it('勾一组：全勾、部分、全去掉；已处理的不算', () => {
    const r = { items: [msg({}), msg({}), msg({ status: 'done' })] }
    let sel = toggleRow(new Set(), r)
    expect(pickState(r, sel)).toBe('all')
    expect(sel.size).toBe(2)
    sel.delete(r.items[0].id)
    expect(pickState(r, sel)).toBe('some')
    sel = toggleRow(sel, r)
    expect(pickState(r, sel)).toBe('all')
    expect(pickState(r, toggleRow(sel, r))).toBe('none')
  })
})

describe('消息列回复（0010）', () => {
  const thread = (p: ImMessage) => ({ parent_external_id: p.external_id, parent_message_id: p.id, parent_sender_name: p.sender_name, parent_text: p.text })

  it('不参与连发、重复合并；归到原消息那一行，行按最新的回复排', () => {
    const p = msg({ text: '话题', at: at(0) })
    const other = msg({ text: '别的', sender_id: 'U2', at: at(30) })
    const r1 = msg({ text: '好', sender_id: 'U2', at: at(40), thread: thread(p) })
    const r2 = msg({ text: '好', sender_id: 'U2', at: at(41), thread: thread(p) })
    const xs = [p, other, r1, r2]
    const cs = clusterMessages(xs)
    expect(cs.byKey.get(cs.of.get(r1.id)!)!.kind).toBe('single')
    const rows = nestThreads(toRows(desc(xs), cs, true), xs)
    expect(rows.map((r) => r.head.text)).toEqual(['话题', '别的'])
    expect(rows[0].threads![0].replies.map((m) => m.id)).toEqual([r1.id, r2.id])
    expect(rowTime(rows[0])).toBe(r2.at)
    // 连发一段里的原消息：挂在那一组上
    const p2 = msg({ text: '一', at: at(100) })
    const p3 = msg({ text: '二', at: at(101) })
    const r3 = msg({ text: '回', sender_id: 'U2', at: at(110), thread: thread(p2) })
    const ys = [p2, p3, r3]
    const rows2 = nestThreads(toRows(desc(ys), clusterMessages(ys), true), ys)
    expect(rows2).toHaveLength(1)
    expect(rows2[0].kind).toBe('burst')
    expect(rows2[0].threads![0].parent.id).toBe(p2.id)
  })

  it('原消息不在筛选里补一行变淡的；原消息没收到的照普通行', () => {
    const p = msg({ text: '话题', status: 'done', at: at(0) })
    const r = msg({ text: '回', at: at(5), thread: thread(p) })
    const orphan = msg({ text: '孤', at: at(6), thread: { parent_external_id: 'zz', parent_message_id: null, parent_sender_name: '张三', parent_text: '' } })
    const all = [p, r, orphan]
    const rows = nestThreads(toRows(desc([r, orphan]), clusterMessages(all), true), all)
    expect(rows.map((x) => [x.head.text, !!x.faded, x.items.length])).toEqual([['孤', false, 1], ['话题', true, 0]])
    expect(threadHint(orphan)).toBe('回复 张三')
    expect(threadHint(r, p)).toBe('回复 A：话题')
    expect(threadHint(msg({ thread: { parent_external_id: 'x', parent_message_id: null, parent_sender_name: '', parent_text: 'a'.repeat(50) } })))
      .toBe(`回复 原消息：${'a'.repeat(40)}…`)
  })

  it('消息列小标：整个消息列里有未读时标未读数，否则标筛得出来的回复数；整个消息列按时间', () => {
    const p = msg({ text: '话题' })
    const rs = [1, 2, 3, 4].map((i) => msg({ text: `r${i}`, at: at(i), thread: thread(p), read: i < 3 }))
    const all = [p, ...rs]
    const rows = nestThreads(toRows(desc([p, rs[0], rs[1]]), clusterMessages(all), true), all)
    expect(rows).toHaveLength(1)
    const b = threadBadge(rows[0], all)!
    expect([b.parentId, b.unread, b.replies]).toEqual([p.id, 2, 2])
    expect(threadBadgeLabel(b)).toBe('消息列 2 条未读回复')
    expect(threadBadgeLabel({ unread: 0, replies: 3 })).toBe('消息列 3 条回复')
    expect(threadBadge(nestThreads(toRows([p], clusterMessages([p]), true), [p])[0], [p])).toBeNull()
    expect(threadOf(p, [...rs].reverse()).map((m) => m.text)).toEqual(['r1', 'r2', 'r3', 'r4'])
  })
})


describe('转任务附上消息列（SPEC-messages-2.15）', () => {
  const thread = (p: ImMessage) => ({ parent_external_id: p.external_id, parent_message_id: p.id, parent_sender_name: p.sender_name, parent_text: p.text })
  it('原消息取全部回复；回复取原消息加别的回复；没有消息列的为空', () => {
    const p = msg({ text: '话题', at: at(0) })
    const r1 = msg({ text: '一', sender_id: 'U2', sender_name: '王可', at: at(2), thread: thread(p) })
    const r2 = msg({ text: '二', at: at(3), thread: thread(p) })
    const lone = msg({ text: '独', at: at(9) })
    const all = [r2, lone, p, r1]
    expect(threadForTask(p, all).map((m) => m.text)).toEqual(['一', '二'])
    expect(threadForTask(r2, all).map((m) => m.text)).toEqual(['话题', '一'])
    expect(threadForTask(lone, all)).toEqual([])
    expect(threadForMany([p, r2], all).map((m) => m.text)).toEqual(['一'])
    expect(threadForMany([lone], all)).toEqual([])
    const body = threadTaskBody([p, r1], () => 'T')
    expect(body).toBe('## 消息列（2 条）\n\n- **A**（原消息） T：话题\n- **王可** T：一')
    expect(threadTaskBody([])).toBe('')
  })
  it('太长时后面的不附，写明还有几条', () => {
    const p = msg({ text: '话题' })
    const big = (i: number) => msg({ text: 'x'.repeat(THREAD_TASK_MAX / 2), at: at(i), thread: thread(p) })
    const body = threadTaskBody([big(1), big(2), big(3)], () => 'T')
    expect(body).toContain('## 消息列（3 条）')
    expect(body.endsWith('还有 2 条没附上，在原消息里看')).toBe(true)
  })
})
