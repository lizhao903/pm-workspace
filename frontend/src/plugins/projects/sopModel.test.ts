import { describe, expect, it } from 'vitest'
import type { SopFlow, SopRunBrief } from '../../core/data'
import { SOP_RUN_PEEK, addSop, availFlows, linkedFlows, recentRuns, removeSop, runLook } from './sopModel'

const flow = (id: string): SopFlow => ({ id, name: id, desc: '', trigger: '', fields: [], steps: [], version: 1, created_at: '', updated_at: '' })
const run = (id: string, flow_id: string, started_at: string): SopRunBrief => ({
  id, flow_id, flow_name: flow_id, flow_version: 1, title: id, step_through: false, stopped: false, status: 'done',
  started_at, updated_at: started_at, focus: 0, steps: [],
})

describe('项目的 SOP 标签', () => {
  const flows = [flow('sop_a'), flow('sop_b'), flow('sop_c')]

  it('关联的流程按 sop_ids 的顺序，找不到的（已删）跳过', () => {
    expect(linkedFlows(['sop_c', 'sop_gone', 'sop_a'], flows).map((f) => f.id)).toEqual(['sop_c', 'sop_a'])
  })

  it('候选是还没关联的', () => {
    expect(availFlows(['sop_b'], flows).map((f) => f.id)).toEqual(['sop_a', 'sop_c'])
    expect(availFlows(['sop_a', 'sop_b', 'sop_c'], flows)).toEqual([])
  })

  it('加到末尾不重复，取消关联只拿掉这一个', () => {
    expect(addSop(['sop_a'], 'sop_b')).toEqual(['sop_a', 'sop_b'])
    expect(addSop(['sop_a'], 'sop_a')).toEqual(['sop_a'])
    expect(removeSop(['sop_a', 'sop_b'], 'sop_a')).toEqual(['sop_b'])
  })

  it('最近执行只算关联的流程，按开始时间倒序取前 8 条', () => {
    const runs = [
      run('r_old', 'sop_a', '2026-10-01T00:00:00Z'), run('r_other', 'sop_b', '2026-10-29T00:00:00Z'),
      run('r_new', 'sop_a', '2026-10-28T00:00:00Z'), run('r_c', 'sop_c', '2026-10-20T00:00:00Z'),
    ]
    expect(recentRuns(linkedFlows(['sop_a', 'sop_c'], flows), runs).map((r) => r.id)).toEqual(['r_new', 'r_c', 'r_old'])
    const many = Array.from({ length: 12 }, (_, i) => run(`r${i}`, 'sop_a', `2026-10-${String(i + 1).padStart(2, '0')}T00:00:00Z`))
    const top = recentRuns([flows[0]], many)
    expect(top).toHaveLength(SOP_RUN_PEEK)
    expect(top[0].id).toBe('r11')
  })

  it('执行状态显示中文，不认识的原样', () => {
    expect(runLook('waiting').label).toBe('待我处理')
    expect(runLook('odd').label).toBe('odd')
  })
})
