// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { describe, expect, it } from 'vitest'
import type { ObjectStatus } from '../../core/data'
import { liveTask, splitByState, terminalOf } from './taskModel'

const st = (key: string, terminal: boolean): ObjectStatus => ({ key, label: key, color: '', terminal })
const statuses = [st('todo', false), st('doing', false), st('done', true), st('cancelled', true)]

// SPEC-messages-1.68：只显示没到终态的关联任务，终态按状态集的 terminal 认，不写死状态名；不知道状态的照旧显示
describe('消息上的关联任务', () => {
  const isT = terminalOf(statuses)
  it('按状态集判断终态', () => {
    expect([isT('done'), isT('cancelled'), isT('doing'), isT(''), isT(undefined), isT('unknown')]).toEqual([true, true, false, false, false, false])
    // 状态集还没取到：一律不算终态
    expect(terminalOf(undefined)('done')).toBe(false)
  })
  it('转成的任务到终态就不显示', () => {
    expect(liveTask({ task_id: 'obj_1', task_status: 'doing' }, isT)).toBe(true)
    expect(liveTask({ task_id: 'obj_1', task_status: 'done' }, isT)).toBe(false)
    expect(liveTask({ task_id: 'obj_1', task_status: '' }, isT)).toBe(true)
    expect(liveTask({ task_id: null, task_status: '' }, isT)).toBe(false)
  })
  it('拆出来的任务分成显示的和折叠的', () => {
    const r = splitByState([{ id: 'a', status: 'todo' }, { id: 'b', status: 'done' }, { id: 'c' }, { id: 'd', status: 'cancelled' }], isT)
    expect(r.live.map((t) => t.id)).toEqual(['a', 'c'])
    expect(r.closed.map((t) => t.id)).toEqual(['b', 'd'])
  })
})
