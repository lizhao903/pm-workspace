import { describe, expect, it } from 'vitest'
import type { SopFlow, SopRunBrief, SopRunStep } from '../../core/data'
import {
  baseRuns, branchingOf, daySegOf, defaultTab, flowOptions, flowPlugins, flowStats, focusIndex, libraryRows, missingFlowPlugins, parseJsonObject,
  progressText, ranks, recentFlows, sortRuns, triggerLabelOf, upstreamOf,
} from './model'

const flow = (p: Partial<SopFlow> = {}): SopFlow => ({
  id: 'sop_a', name: '甲', desc: '', trigger: '手动', fields: [], version: 1, created_at: '', updated_at: '',
  steps: [{ key: 'a', name: 'A', kind: 'auto' }, { key: 'b', name: 'B', kind: 'review' }], ...p,
})

let seq = 0
const brief = (p: Partial<SopRunBrief> = {}): SopRunBrief => ({
  id: `spr_${++seq}`, flow_id: 'sop_a', flow_name: '甲', flow_version: 1, title: '甲 · x', step_through: false, stopped: false,
  status: 'running', started_at: '2026-10-29T08:00:00Z', updated_at: '', focus: 0,
  steps: [{ key: 'a', name: 'A', kind: 'auto', status: 'running' }], ...p,
})
const step = (p: Partial<SopRunStep> = {}): SopRunStep => ({ key: 'a', status: 'pending', input: null, output: null, attempts: 0, log: [], ...p })

describe('流程图分列', () => {
  it('没写 after 接在上一步后面；并行同列，汇合在下一列', () => {
    const f = flow({
      steps: [
        { key: 'a', name: 'A', kind: 'auto' },
        { key: 'b', name: 'B', kind: 'ai', after: ['a'] },
        { key: 'c', name: 'C', kind: 'ai', after: ['a'] },
        { key: 'd', name: 'D', kind: 'aggregate', after: ['b', 'c'] },
      ],
    })
    expect(ranks(f)).toEqual([0, 1, 1, 2])
  })

  it('依赖不存在或成环不会死循环', () => {
    expect(ranks(flow({ steps: [{ key: 'a', name: 'A', kind: 'auto', after: ['b'] }, { key: 'b', name: 'B', kind: 'auto', after: ['a'] }] }))).toHaveLength(2)
    expect(ranks(flow({ steps: [{ key: 'a', name: 'A', kind: 'auto', after: ['x'] }] }))).toEqual([0])
  })

  it('分支节点按后端节点类型表认；表没回来时看 cases', () => {
    const b = branchingOf([{ kind: 'decide', group: '逻辑', branching: true, required: [] }])
    expect(b({ key: 'x', name: 'X', kind: 'decide' })).toBe(true)
    expect(b({ key: 'x', name: 'X', kind: 'auto' })).toBe(false)
    expect(branchingOf(undefined)({ key: 'x', name: 'X', kind: 'classifier', cases: [{ key: 'a', label: 'A' }] })).toBe(true)
  })
})

describe('执行列表', () => {
  it('段内按状态再按开始时间倒序', () => {
    const rows = sortRuns([
      brief({ id: 'r1', status: 'done', started_at: '2026-10-29T09:00:00Z' }),
      brief({ id: 'r2', status: 'waiting', started_at: '2026-10-29T07:00:00Z' }),
      brief({ id: 'r3', status: 'failed' }),
      brief({ id: 'r4', status: 'waiting', started_at: '2026-10-29T08:30:00Z' }),
    ])
    expect(rows.map((r) => r.id)).toEqual(['r4', 'r2', 'r3', 'r1'])
  })

  it('待我处理只留 waiting 和 failed；搜索标题和流程名，不分大小写', () => {
    const rs = [brief({ status: 'waiting', title: 'Alpha' }), brief({ status: 'failed', flow_name: '乙' }), brief({ status: 'done' })]
    expect(baseRuns(rs, { waitingOnly: true })).toHaveLength(2)
    expect(baseRuns(rs, { q: 'alpha' })).toHaveLength(1)
    expect(baseRuns(rs, { q: '乙' })).toHaveLength(1)
  })

  it('进度文字', () => {
    expect(progressText(brief({ status: 'done', steps: [{ key: 'a', name: 'A', kind: 'auto', status: 'done' }, { key: 'b', name: 'B', kind: 'auto', status: 'bypassed' }] }))).toBe('1 步全部完成')
    expect(progressText(brief({ steps: [{ key: 'a', name: 'A', kind: 'auto', status: 'running' }, { key: 'b', name: 'B', kind: 'auto', status: 'running' }] }))).toBe('2 路并行执行中')
    expect(progressText(brief({ status: 'waiting', focus: 1, steps: [{ key: 'a', name: 'A', kind: 'auto', status: 'done' }, { key: 'b', name: '确认', kind: 'review', status: 'review' }] }))).toBe('1/2 确认')
  })

  it('按开始日期分段，周一算一周第一天', () => {
    // 2026-10-29 是周四
    const seg = daySegOf(new Date(2026, 9, 29, 15))
    expect(seg(new Date(2026, 9, 29, 1).toISOString())).toBe('today')
    expect(seg(new Date(2026, 9, 28, 23).toISOString())).toBe('yesterday')
    expect(seg(new Date(2026, 9, 26, 9).toISOString())).toBe('week')
    expect(seg(new Date(2026, 9, 25, 9).toISOString())).toBe('older')
  })

  it('流程筛选的选项带次数，含已删除的流程', () => {
    const opts = flowOptions([flow()], [brief(), brief(), brief({ flow_id: 'sop_gone', flow_name: '旧流程' })])
    expect(opts).toEqual([{ value: 'sop_a', label: '甲', hint: '2 次' }, { value: 'sop_gone', label: '旧流程', hint: '1 次' }])
  })
})

describe('流程库', () => {
  const a = flow({ id: 'sop_a', name: '甲' })
  const b = flow({ id: 'sop_b', name: '乙' })
  const c = flow({ id: 'sop_c', name: '丙', desc: '周会' })
  const runs = [
    brief({ flow_id: 'sop_a', status: 'done', started_at: '2026-10-29T09:00:00Z' }),
    brief({ flow_id: 'sop_b', status: 'waiting', started_at: '2026-10-28T09:00:00Z' }),
  ]
  const stats = flowStats(runs)

  it('有待处理的在前，其余按最近执行，没执行过的排最后', () => {
    expect(libraryRows([a, b, c], stats, '', '').map((f) => f.id)).toEqual(['sop_b', 'sop_a', 'sop_c'])
    expect(libraryRows([a, b, c], stats, 'never', '').map((f) => f.id)).toEqual(['sop_c'])
    expect(libraryRows([a, b, c], stats, '', '周会').map((f) => f.id)).toEqual(['sop_c'])
  })

  it('最近用过按最近一次开始时间排', () => {
    expect(recentFlows([a, b, c], stats).map((f) => f.id)).toEqual(['sop_a', 'sop_b'])
  })

  it('搜索认触发方式的显示名；要别的模块的排最后', () => {
    const w = flow({ id: 'sop_w', name: '周报', trigger: 'weekly' })
    const label = triggerLabelOf()
    expect(libraryRows([a, w], stats, '', '每周一', { trigger: label }).map((f) => f.id)).toEqual(['sop_w'])
    expect(libraryRows([a, b, c], stats, '', '', { elsewhere: (f) => f.id === 'sop_b' }).map((f) => f.id)).toEqual(['sop_a', 'sop_c', 'sop_b'])
  })
})

describe('触发方式和插件', () => {
  it('触发方式：枚举优先，再内置中文名，都没有原样', () => {
    const l = triggerLabelOf([{ key: 'manual', label: '手工' }])
    expect([l('manual'), l('weekly'), l('webhook'), l('IM 消息'), l('')]).toEqual(['手工', '每周一 18:00', 'Webhook', 'IM 消息', '手动'])
    expect(triggerLabelOf()('manual')).toBe('手动')
  })

  it('插件节点按清单认提供者，认不出取前缀；内置节点不算', () => {
    const f = flow({ steps: [{ key: 'a', name: 'A', kind: 'auto' }, { key: 'b', name: 'B', kind: 'video_run_stage' }, { key: 'c', name: 'C', kind: 'im_send_message' }] })
    const plugins = [{ id: 'video', provides: { sop_nodes: ['video_run_stage'] } }]
    expect(flowPlugins(f, plugins)).toEqual(['video', 'im'])
    expect(missingFlowPlugins(f, new Set(['im', 'sop']), plugins)).toEqual(['video'])
    expect(missingFlowPlugins(f, null, plugins)).toEqual([])
    expect(flowPlugins(flow())).toEqual([])
  })
})

describe('运行页', () => {
  it('默认看等人的步骤，再看执行中的，都没有看最后完成的', () => {
    expect(focusIndex([step({ status: 'running' }), step({ status: 'review' })])).toBe(1)
    expect(focusIndex([step({ status: 'done', ended_at: '2026-10-29T08:00:02Z' }), step({ status: 'done', ended_at: '2026-10-29T08:00:01Z' })])).toBe(0)
  })

  it('状态最该看的标签', () => {
    const def = { key: 'a', name: 'A', kind: 'review' }
    expect(defaultTab(def, step({ status: 'review', output: { x: 1 } }))).toBe('output')
    expect(defaultTab(def, step({ status: 'paused' }))).toBe('input')
    expect(defaultTab({ key: 'd', name: 'D', kind: 'decide' }, step({ status: 'review', output: { x: 1 } }))).toBe('input')
  })

  it('退回重做只算走到的上游', () => {
    const f = flow({
      steps: [
        { key: 'a', name: 'A', kind: 'decide', cases: [{ key: 'y', label: '是' }, { key: 'n', label: '否' }] },
        { key: 'b', name: 'B', kind: 'auto', after: ['a'], branch: { of: 'a', case: 'y' } },
        { key: 'c', name: 'C', kind: 'auto', after: ['a'], branch: { of: 'a', case: 'n' } },
        { key: 'd', name: 'D', kind: 'review', after: ['b', 'c'] },
      ],
    })
    const run = { flow: f, steps: [step({ status: 'done' }), step({ status: 'done' }), step({ status: 'bypassed' }), step({ status: 'review' })] }
    expect(upstreamOf(run as never, 3).map((d) => d.key)).toEqual(['b'])
  })

  it('改的 JSON 要是对象', () => {
    expect(parseJsonObject('{"a":1}')).toEqual({ ok: true, value: { a: 1 } })
    expect(parseJsonObject('[1]')).toEqual({ ok: false, error: '需要是一个 JSON 对象，形如 { "字段": 值 }' })
    const bad = parseJsonObject('{a')
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.error).toMatch(/^JSON 格式不对：/)
  })
})
