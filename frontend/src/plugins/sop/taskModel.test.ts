import { describe, expect, it } from 'vitest'
import type { SopField, SopRunBrief, WorkObject } from '../../core/data'
import { backToRun, dueText, focusRow, objectRunProgress, taskPrefill, topRuns } from './taskModel'

const task = (o: Partial<WorkObject> = {}): WorkObject => ({
  id: 'obj_t1', ref: 'TSK-0042', type_id: 'task', title: '整理客户反馈', body: '把上周的反馈归类', status: 'doing', priority: 'P1',
  owner: '', owner_id: 'stk_1', owner_name: '林予安', category_id: null, project_id: 'obj_p', project_title: '工作台', source: 'manual',
  props: { acceptance: '- [ ] 每条都有分类' }, workdir: '', due_at: null, started_at: null, completed_at: null, archived_at: null,
  deleted_at: null, created_at: '', updated_at: '', tags: [], link_count: 0, participants: [], ...o,
} as WorkObject)
const f = (key: string, label: string, type: SopField['type'] = 'text', extra: Partial<SopField> = {}): SopField => ({ key, label, type, ...extra })

describe('在任务上执行 SOP 的预填（SOP-06）', () => {
  it('按 key 和字段名认出任务的各项，每项只填第一个；任务上空的不填', () => {
    const fields = [
      f('topic', '议题'), f('content', '内容', 'textarea'), f('who', '负责人'), f('priority', '优先级'), f('ddl', '截止时间'),
      f('ref', '编号'), f('state', '当前状态'), f('proj', '所属项目'), f('acc', '验收标准', 'textarea'), f('task_id', '任务'), f('title2', '另一个标题'),
    ]
    const got = taskPrefill({ fields }, task(), (k) => (k === 'doing' ? '进行中' : undefined))
    expect(got).toEqual({
      topic: '整理客户反馈', content: '把上周的反馈归类', who: '林予安', priority: 'P1', ref: 'TSK-0042', state: '进行中', proj: '工作台',
      acc: '- [ ] 每条都有分类', task_id: 'obj_t1',
    })
    // 截止时间空着不填；title2 字段名含「标题」，但标题已经填进 topic，同一项不填两次
  })

  it('标题没有对应字段时并进正文那一格开头；正文也没对上时用第一个没认出的多行文本', () => {
    expect(taskPrefill({ fields: [f('notes', '备注', 'textarea')] }, task())).toEqual({ notes: '整理客户反馈\n\n把上周的反馈归类' })
    expect(taskPrefill({ fields: [f('x', '客户'), f('raw', '原始材料', 'textarea')] }, task())).toEqual({ raw: '整理客户反馈\n\n把上周的反馈归类' })
    expect(taskPrefill({ fields: [f('raw', '原始材料', 'textarea')] }, task({ body: '' }))).toEqual({ raw: '整理客户反馈' })
    // 没有多行文本：只填认得出的
    expect(taskPrefill({ fields: [f('customer', '客户')] }, task())).toEqual({})
    // key 是 ref 的「参考链接」不当成任务编号
    expect(taskPrefill({ fields: [f('idea', '选题想法', 'textarea'), f('ref', '参考链接')] }, task())).toEqual({ idea: '整理客户反馈\n\n把上周的反馈归类' })
  })

  it('下拉字段只填选项里有的值（按值或显示名）', () => {
    const level = f('priority', '优先级', 'select', { options: [{ value: 'high', label: 'P1' }, { value: 'low', label: 'P3' }] })
    expect(taskPrefill({ fields: [level] }, task())).toEqual({ priority: 'high' })
    expect(taskPrefill({ fields: [level] }, task({ priority: 'P0' }))).toEqual({})
  })

  it('截止时间按本地时间，零点只写日期', () => {
    const d = new Date(2026, 10, 3, 0, 0)
    expect(dueText(d.toISOString())).toBe('2026-11-03')
    expect(dueText(new Date(2026, 10, 3, 18, 5).toISOString())).toBe('2026-11-03 18:05')
    expect(dueText(null)).toBe('')
    expect(taskPrefill({ fields: [f('due', '截止')] }, task({ due_at: d.toISOString() }))).toEqual({ due: '2026-11-03' })
  })
})

const run = (status: SopRunBrief['status'], steps: [string, SopRunBrief['steps'][number]['status']][], focus: number, o: Partial<SopRunBrief> = {}): SopRunBrief => ({
  id: 'spr_1', flow_id: 'sop_1', flow_name: '反馈归类', flow_version: 1, title: '反馈归类', step_through: false, stopped: status === 'stopped',
  status, started_at: '2026-11-02T00:00:00Z', updated_at: '', focus,
  steps: steps.map(([name, st], i) => ({ key: `s${i}`, name, kind: 'auto', status: st })), ...o,
})

describe('任务详情里执行的进度', () => {
  it('第几步、共几步，停在哪个人工检查点', () => {
    expect(objectRunProgress(run('waiting', [['整理', 'done'], ['人工检查', 'review'], ['发出', 'pending']], 1))).toBe('1/3 步 · 停在「人工检查」等你处理')
    expect(objectRunProgress(run('waiting', [['整理', 'paused'], ['发出', 'pending']], 0))).toBe('0/2 步 · 停在「整理」确认输入')
    expect(objectRunProgress(run('running', [['整理', 'done'], ['写', 'running'], ['发出', 'pending']], 1))).toBe('1/3 步 · 正在「写」')
    expect(objectRunProgress(run('failed', [['整理', 'failed'], ['发出', 'pending']], 0))).toBe('0/2 步 · 「整理」失败')
    expect(objectRunProgress(run('done', [['整理', 'done'], ['甲路', 'bypassed'], ['发出', 'done']], 2))).toBe('2 步全部完成')
    expect(objectRunProgress(run('stopped', [['整理', 'done'], ['发出', 'pending']], 0))).toBe('1/2 步')
  })

  it('子流程收在父执行里；父执行不在列表里的子执行照样列出', () => {
    const rs = [{ id: 'a' }, { id: 'b', parent_run_id: 'a' }, { id: 'c', parent_run_id: 'zz' }]
    expect(topRuns(rs).map((r) => r.id)).toEqual(['a', 'c'])
  })
})

describe('从运行页回到任务的 SOP 标签', () => {
  it('返回地址带上 tab=sop 和要定位的执行，原来的参数留着、旧的定位换掉', () => {
    expect(backToRun('/tasks?t=obj_t1', 'spr_1')).toBe('/tasks?t=obj_t1&tab=sop&sop_run=spr_1')
    expect(backToRun('/tasks/overdue?t=obj_t1&tab=sop&sop_run=spr_0', 'spr_2')).toBe('/tasks/overdue?t=obj_t1&tab=sop&sop_run=spr_2')
    expect(backToRun('/projects/p1', 'spr_1')).toBe('/projects/p1?tab=sop&sop_run=spr_1')
  })

  it('定位的执行落在哪一行：本身是顶层就是它，子流程顺着父执行往上找，找不到不定位', () => {
    const runs = [{ id: 'a' }, { id: 'b', parent_run_id: 'a' }, { id: 'c', parent_run_id: 'b' }, { id: 'x', parent_run_id: 'gone' }]
    const rows = topRuns(runs)
    expect(rows.map((r) => r.id)).toEqual(['a', 'x'])
    expect(focusRow(runs, rows, 'a')).toBe('a')
    expect(focusRow(runs, rows, 'c')).toBe('a')
    expect(focusRow(runs, rows, 'x')).toBe('x')
    expect(focusRow(runs, rows, 'nope')).toBeUndefined()
    expect(focusRow(runs, rows, undefined)).toBeUndefined()
  })
})
