import { describe, expect, it, vi } from 'vitest'
import type { DictItem, ObjectStatus, WorkObject } from '../../core/data'
import {
  ALL, OPEN, OWNER_ME, OWNER_NONE, dueSeg, dueText, isOverdue, loadMe, matchOwner, matchQuery, matchStatus, ownerOptions, prioText,
  priorityRank, saveMe, segment, sortSeg, sortTasks, statusButtons, terminalOf, weekEnd,
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

describe('优先级显示名', () => {
  it('编号加名称，名称已带编号的不重复，不在字典里的只显示编号', () => {
    expect(prioText('P0', { label: '最高' })).toBe('P0 最高')
    expect(prioText('P0', { label: 'P0 紧急' })).toBe('P0 紧急')
    expect(prioText('P1', { label: 'P1' })).toBe('P1')
    expect(prioText('P9')).toBe('P9')
    expect(prioText('P2', { label: ' ' })).toBe('P2')
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

describe('段内排序（B-06）', () => {
  const rank = priorityRank([{ key: 'P0', sort_order: 10 }, { key: 'P2', sort_order: 30 }] as DictItem[])
  const at = (d: string) => `2026-10-${d}T10:00:00Z`
  const rows = [
    task({ ref: 'TSK-0001', priority: 'P2', created_at: at('01'), updated_at: at('20'), completed_at: at('21') }),
    task({ ref: 'TSK-0002', priority: 'P0', created_at: at('03'), updated_at: at('10'), completed_at: null }),
    task({ ref: 'TSK-0003', priority: 'P2', created_at: at('02'), updated_at: at('25'), completed_at: at('15') }),
  ]
  const refs = (r: WorkObject[]) => r.map((t) => t.ref)

  it('默认：已结束按完成时间倒序（没记完成时间的看最近更新），无截止按最近更新，其余按优先级', () => {
    expect(refs(sortSeg(rows, 'closed', '', rank))).toEqual(['TSK-0001', 'TSK-0003', 'TSK-0002'])
    expect(refs(sortSeg(rows, 'none', '', rank))).toEqual(['TSK-0003', 'TSK-0001', 'TSK-0002'])
    expect(refs(sortSeg(rows, 'week', '', rank))).toEqual(['TSK-0002', 'TSK-0001', 'TSK-0003'])
  })

  it('选了排序方式各段都按它排', () => {
    expect(refs(sortSeg(rows, 'closed', 'priority', rank))).toEqual(['TSK-0002', 'TSK-0001', 'TSK-0003'])
    expect(refs(sortSeg(rows, 'week', 'updated', rank))).toEqual(['TSK-0003', 'TSK-0001', 'TSK-0002'])
    expect(refs(sortSeg(rows, 'none', 'created', rank))).toEqual(['TSK-0002', 'TSK-0003', 'TSK-0001'])
  })

  it('同一时刻编号大的在前，时间取不到的在后', () => {
    const r = [task({ ref: 'TSK-0001', updated_at: at('20') }), task({ ref: 'TSK-0002', updated_at: '' }), task({ ref: 'TSK-0003', updated_at: at('20') })]
    expect(refs(sortSeg(r, 'none', '', rank))).toEqual(['TSK-0003', 'TSK-0001', 'TSK-0002'])
  })
})

describe('负责人筛选和搜索（B-07）', () => {
  const mine = task({ ref: 'TSK-0001', owner_id: 'stk_me', owner_name: '张三' })
  const agent = task({ ref: 'TSK-0002', owner_id: 'stk_cc', owner_name: 'Claude Code', title: '接口' })
  const legacy = task({ ref: 'TSK-0003', owner: '老周' })
  const none = task({ ref: 'TSK-0004', body: '要导出 Excel' })

  it('未分配不含旧的自由文本负责人；「我」要先选过是哪位干系人', () => {
    const pick = (f: string, me = '') => [mine, agent, legacy, none].filter((t) => matchOwner(t, f, me)).map((t) => t.ref)
    expect(pick('')).toHaveLength(4)
    expect(pick(OWNER_NONE)).toEqual(['TSK-0004'])
    expect(pick(OWNER_ME)).toEqual([])
    expect(pick(OWNER_ME, 'stk_me')).toEqual(['TSK-0001'])
    expect(pick('stk_cc')).toEqual(['TSK-0002'])
  })

  it('搜索覆盖标题、描述、编号、负责人名，不区分大小写', () => {
    const hit = (q: string) => [mine, agent, legacy, none].filter((t) => matchQuery(t, q)).map((t) => t.ref)
    expect(hit('claude')).toEqual(['TSK-0002'])
    expect(hit('张三')).toEqual(['TSK-0001'])
    expect(hit('老周')).toEqual(['TSK-0003'])
    expect(hit('excel')).toEqual(['TSK-0004'])
    expect(hit('tsk-0002')).toEqual(['TSK-0002'])
    expect(hit('  ')).toHaveLength(4)
  })

  it('负责人选项取列表里出现过的，任务多的在前', () => {
    expect(ownerOptions([mine, agent, agent, legacy, none])).toEqual([
      { id: 'stk_cc', name: 'Claude Code', n: 2 }, { id: 'stk_me', name: '张三', n: 1 },
    ])
  })

  it('「我」记在浏览器里，清空就删掉；拿不到存储时当没选', () => {
    const store = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k),
    })
    saveMe('stk_me')
    expect(loadMe()).toBe('stk_me')
    saveMe('')
    expect(store.size).toBe(0)
    const boom = () => { throw new Error('blocked') }
    vi.stubGlobal('localStorage', { getItem: boom, setItem: boom, removeItem: boom })
    expect(() => saveMe('stk_me')).not.toThrow()
    expect(loadMe()).toBe('')
    vi.unstubAllGlobals()
  })
})
