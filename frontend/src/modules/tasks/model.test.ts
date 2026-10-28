import { describe, expect, it } from 'vitest'
import type { DictItem, ObjectStatus, WorkObject } from '../../core/api'
import {
  ALL, OPEN, dueSeg, dueText, isOverdue, matchStatus, priorityRank, segment, sortTasks, statusButtons, terminalOf, weekEnd,
} from './model'

const statuses: ObjectStatus[] = [
  { key: 'todo', label: '待办', color: '', terminal: false },
  { key: 'doing', label: '进行中', color: '', terminal: false },
  { key: 'review', label: '待验收', color: '', terminal: false },
  { key: 'done', label: '已完成', color: '', terminal: true },
  { key: 'cancelled', label: '已取消', color: '', terminal: true },
]
const terminal = terminalOf(statuses)

// 本地时间 2026-10-28（周三）下午
const now = new Date(2026, 9, 28, 15, 0, 0)
const today = '2026-10-28'
// 截止日存成本地当天 23:59:59，和后端补时一致
const due = (d: string) => new Date(`${d}T23:59:59`).toISOString()

function task(p: Partial<WorkObject>): WorkObject {
  return {
    id: p.ref ?? 'x', type_id: 'task', ref: 'TSK-0', title: '', body: '', status: 'todo', priority: 'P2', owner: '', owner_id: null,
    category_id: null, project_id: null, source: '', props: null, workdir: '', due_at: null, started_at: null, completed_at: null,
    archived_at: null, deleted_at: null, created_at: now.toISOString(), updated_at: now.toISOString(), tags: [], link_count: 0,
    participants: [], ...p,
  }
}

describe('截止分段', () => {
  it('本周到周日为止', () => {
    expect(weekEnd(now)).toBe('2026-11-01')
    // 周日当天，本周就是今天
    expect(weekEnd(new Date(2026, 10, 1, 9))).toBe('2026-11-01')
  })

  it('按截止日分到六段，终态一律进已结束', () => {
    const end = weekEnd(now)
    const seg = (p: Partial<WorkObject>) => dueSeg(task(p), terminal, today, end)
    expect(seg({ due_at: due('2026-10-27') })).toBe('overdue')
    expect(seg({ due_at: due('2026-10-28') })).toBe('today')
    expect(seg({ due_at: due('2026-11-01') })).toBe('week')
    expect(seg({ due_at: due('2026-11-02') })).toBe('later')
    expect(seg({ due_at: null })).toBe('none')
    expect(seg({ due_at: due('2026-10-01'), status: 'done' })).toBe('closed')
    expect(seg({ due_at: null, status: 'cancelled' })).toBe('closed')
  })

  it('待验收也算未完成，过了截止日照样逾期', () => {
    const t = task({ status: 'review', due_at: due('2026-10-20') })
    expect(isOverdue(t, terminal, today)).toBe(true)
    expect(matchStatus(t, OPEN, terminal)).toBe(true)
    expect(isOverdue(task({ status: 'done', due_at: due('2026-10-20') }), terminal, today)).toBe(false)
    // 今天到期的不算逾期
    expect(isOverdue(task({ due_at: due(today) }), terminal, today)).toBe(false)
  })

  it('没有条目的段不出现', () => {
    const segs = segment([task({ due_at: due(today) }), task({ status: 'done' })], terminal, now)
    expect(segs.map((s) => s.key)).toEqual(['today', 'closed'])
  })

  it('截止列文字', () => {
    expect(dueText(task({ due_at: due(today) }), today)).toBe('今天')
    expect(dueText(task({ due_at: due('2026-11-05') }), today)).toBe('11-05')
    expect(dueText(task({}), today)).toBe('-')
  })
})

describe('状态筛选', () => {
  it('未完成、全部、单个状态', () => {
    const done = task({ status: 'done' })
    expect(matchStatus(done, OPEN, terminal)).toBe(false)
    expect(matchStatus(done, ALL, terminal)).toBe(true)
    expect(matchStatus(done, 'done', terminal)).toBe(true)
    expect(matchStatus(done, 'todo', terminal)).toBe(false)
  })

  it('不认识的状态算未结束', () => {
    expect(terminal('whatever')).toBe(false)
  })

  it('按钮去掉已取消，超过 5 个的进更多状态', () => {
    const many = [...statuses, ...['a', 'b'].map((k) => ({ key: k, label: k, color: '', terminal: false }))]
    const { head, rest } = statusButtons(many)
    expect(head.map((s) => s.key)).toEqual(['todo', 'doing', 'review', 'done', 'a'])
    expect(rest.map((s) => s.key)).toEqual(['b'])
  })
})

describe('排序', () => {
  it('先按字典里的优先级顺序，再按截止日，没截止的在后', () => {
    const items = [
      { key: 'P1', sort_order: 20 }, { key: 'P0', sort_order: 10 }, { key: 'P2', sort_order: 30 },
    ] as DictItem[]
    const rows = sortTasks([
      task({ ref: 'a', priority: 'P2' }),
      task({ ref: 'b', priority: 'P0' }),
      task({ ref: 'c', priority: 'P0', due_at: due('2026-10-30') }),
      task({ ref: 'd', priority: '' }),
      task({ ref: 'e', priority: 'P9' }),
      task({ ref: 'f', priority: 'P1', due_at: due('2026-10-29') }),
    ], priorityRank(items))
    expect(rows.map((t) => t.ref)).toEqual(['c', 'b', 'f', 'a', 'e', 'd'])
  })
})
