// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { describe, expect, it } from 'vitest'
import type { WorkObject } from '../../core/data'
import { taskCommand } from './search'

describe('taskCommand', () => {
  it('编号加标题，副标题是优先级和负责人，回车去任务页打开抽屉', () => {
    const t = { id: 'obj_1', ref: 'TSK-0001', title: '修登录', priority: 'P1', owner_name: '' } as WorkObject
    const cmd = taskCommand(t, 'tasks')
    expect(cmd).toMatchObject({ group: '任务', title: 'TSK-0001 修登录', sub: 'P1 · 未分配' })
    const to: string[] = []
    void cmd.run({ shell: { navigate: (x) => to.push(x) } })
    expect(to).toEqual(['/tasks?t=obj_1'])
  })
})
