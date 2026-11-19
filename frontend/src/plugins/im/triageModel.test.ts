// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { describe, expect, it } from 'vitest'
import type { ImMessage, SopInputRun } from '../../core/data'
import { alreadyRun, focusText, latestByMessage, messageBrief, queueSplit, QUEUE_RECENT, repliesNote, retryStep, triageNote, triageTag, triageTargets, waitFor } from './triageModel'

let seq = 0
function run(p: Partial<SopInputRun> = {}): SopInputRun {
  seq += 1
  return {
    id: `spr_${seq}`, flow_id: 'sop_a', flow_name: '分诊', flow_version: 1, title: '', step_through: false, stopped: false, status: 'running',
    source: 'manual', started_at: `2026-11-02T0${seq % 10}:00:00.000Z`, updated_at: `2026-11-02T0${seq % 10}:00:00.000Z`, focus: 0,
    steps: [{ key: 'read', name: '读取消息', kind: 'im_get_message', status: 'running' }], input_value: 'msg_1', ...p,
  }
}
const msg = (p: Partial<ImMessage>) => ({ id: 'msg_1', text: '', sender_name: 'Lin', contact_name: '', conversation: '', ...p }) as ImMessage

describe('分诊状态和处理队列', () => {
  it('每条消息取最近一次；小标按状态，终止了的不标', () => {
    const xs = [run({ input_value: 'a', status: 'done' }), run({ input_value: 'a', status: 'failed' }), run({ input_value: 'b', status: 'waiting' })]
    const m = latestByMessage(xs)
    expect(m.get('a')?.status).toBe('done')
    expect(triageTag(m.get('a'))?.label).toBe('已分诊')
    expect(triageTag(m.get('b'))?.label).toBe('分诊等确认')
    expect(triageTag(run({ status: 'running' }))?.label).toBe('分诊中')
    expect(triageTag(run({ status: 'failed' }))?.tone).toBe('bad')
    expect(triageTag(run({ status: 'stopped' }))).toBeNull()
    expect(triageTag(undefined)).toBeNull()
  })

  it('进行中按开始先后，最近结束按结束时间倒序最多 20 条', () => {
    const a = run({ started_at: '2026-11-02T03:00:00.000Z' })
    const b = run({ status: 'waiting', started_at: '2026-11-02T01:00:00.000Z' })
    const ended = Array.from({ length: QUEUE_RECENT + 3 }, (_, i) => run({ status: 'done', ended_at: `2026-11-01T${String(i).padStart(2, '0')}:00:00.000Z` }))
    const q = queueSplit([a, b, ...ended])
    expect(q.active.map((r) => r.id)).toEqual([b.id, a.id])
    expect(q.recent).toHaveLength(QUEUE_RECENT)
    expect(q.recent[0].ended_at).toBe('2026-11-01T22:00:00.000Z')
  })

  it('当前步骤说法、排队、重试、等待时长', () => {
    expect(focusText(run())).toBe('读取消息 · 执行中')
    expect(focusText(run({ steps: [{ key: 'ai', name: '判断', kind: 'ai', status: 'running', queue: { ahead: 2 } }] }))).toBe('判断 · 排队中，前面 2 个')
    expect(retryStep(run({ status: 'failed', steps: [{ key: 'a', name: '甲', kind: 'x', status: 'failed' }] }))).toBe(0)
    expect(retryStep(run())).toBeNull()
    const now = new Date('2026-11-02T10:00:00.000Z').getTime()
    expect(waitFor('2026-11-02T09:59:30.000Z', now)).toBe('不到 1 分钟')
    expect(waitFor('2026-11-02T09:15:00.000Z', now)).toBe('45 分钟')
    expect(waitFor('2026-11-02T07:00:00.000Z', now)).toBe('3 小时')
    expect(waitFor('2026-10-30T10:00:00.000Z', now)).toBe('3 天')
  })

  it('要分诊的：有勾选用勾选，否则当前筛选结果；超上限不发起；已跑过的条数', () => {
    const rows = [msg({ id: 'a' }), msg({ id: 'b' }), msg({ id: 'c' })]
    expect(triageTargets([rows[0]], rows, 2)).toEqual({ from: 'picked', list: [rows[0]], over: false, replies: 0 })
    expect(triageTargets([], rows, 2)).toEqual({ from: 'filter', list: rows, over: true, replies: 0 })
    expect(alreadyRun([run({ input_value: 'a' }), run({ input_value: 'b', flow_id: 'sop_b' })], 'sop_a', ['a', 'b', 'c'])).toBe(1)
    expect(messageBrief(msg({ text: ' 一  二\n三 ', conversation: '#p' }))).toEqual({ who: 'Lin', where: '#p', text: '一 二 三' })
    expect(triageNote({ started: [{ index: 0, key: 'a' }], skipped: [{ index: 1, key: 'b' }], failed: [] }))
      .toEqual({ text: '分诊发起 1 条，跳过 1 条已跑过的', bad: false })
  })
})

// 消息列回复也走分诊（SPEC-messages-1.51、1.63）：不勾时收起的消息列回复只算还没处理的；勾了的照勾的；条数提示写含几条回复
describe('批量分诊带上消息列回复', () => {
  const p = msg({ id: 'p', status: 'done' })
  const r1 = msg({ id: 'r1', status: 'pending' })
  const r2 = msg({ id: 'r2', status: 'ignored' })
  const r3 = msg({ id: 'r3', status: 'expired' })
  const isReply = (m: ImMessage) => m.id.startsWith('r')
  it('不勾时：非回复照旧（处理过的也在），回复只留还没处理的', () => {
    const t = triageTargets([], [p, r1, r2, r3], 10, isReply)
    expect(t.list.map((m) => m.id)).toEqual(['p', 'r1', 'r3'])
    expect(t.replies).toBe(2)
  })
  it('勾了时用勾的，数出其中的回复', () => {
    const t = triageTargets([r1, p], [p, r1, r2, r3], 10, isReply)
    expect(t).toMatchObject({ from: 'picked', replies: 1 })
    expect(repliesNote(t.replies)).toBe('（含 1 条消息列回复）')
    expect(repliesNote(0)).toBe('')
  })
})
