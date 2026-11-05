import { describe, expect, it } from 'vitest'
import { describeSource } from './sessionSources'

// TSK-0460：任务交给工作台 Agent 执行建的会话，来源跳回那条任务的执行记录，不经插件登记
describe('会话来源 task_run', () => {
  it('跳到任务抽屉的执行记录、定位到那次执行', () => {
    const got = describeSource([], { kind: 'task_run', label: '任务 TSK-0001 整理 的执行', object_id: 'obj_1', ref: 'TSK-0001', run_id: 'run_9' })
    expect(got).toEqual({ label: '任务 TSK-0001 整理 的执行', to: '/tasks?t=obj_1&tab=runs&run=run_9', title: '打开这条任务的执行记录' })
  })
  it('没有 object_id 时退回只显示 label', () => {
    expect(describeSource([], { kind: 'task_run', label: '某次执行' })).toEqual({ label: '某次执行', to: '' })
  })
})
