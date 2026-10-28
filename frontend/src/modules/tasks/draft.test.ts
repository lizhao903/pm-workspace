import { describe, expect, it } from 'vitest'
import type { DictItem, ObjectStatus, WorkObject } from '../../core/data'
import { buildCreate, buildSave, draftOf, emptyDraft, sameDraft } from './draft'

const due = (d: string) => new Date(`${d}T23:59:59`).toISOString()

function task(p: Partial<WorkObject> = {}): WorkObject {
  return {
    id: 'obj_1', type_id: 'task', ref: 'TSK-0001', title: '标题', body: '正文', status: 'todo', priority: 'P2',
    owner: '', owner_id: 'stk_a', category_id: null, project_id: null, source: 'manual',
    props: { x: 1, acceptance: '- [ ] 一条', repo: '/r' }, workdir: '/w',
    due_at: due('2026-10-30'), started_at: null, completed_at: null, archived_at: null, deleted_at: null,
    created_at: '2026-10-28T00:00:00Z', updated_at: '2026-10-28T00:00:00Z', tags: [], link_count: 0,
    owner_name: '甲', participants: [{ id: 'stk_b', name: '乙', color: '' }], ...p,
  }
}

describe('任务草稿', () => {
  it('没改就什么都不传', () => {
    const t = task()
    const s = buildSave(t, draftOf(t))
    expect(s.patch).toEqual({})
    expect(s.props).toBeUndefined()
  })

  it('只改状态时 patch 只有 status', () => {
    const t = task()
    const s = buildSave(t, { ...draftOf(t), status: 'doing' })
    expect(s.patch).toEqual({ status: 'doing' })
    expect(s.props).toBeUndefined()
  })

  it('只改验收标准时只交出改动的 props key，patch 里没有别的字段', () => {
    const t = task()
    const s = buildSave(t, { ...draftOf(t), acceptance: '- [ ] 两条' })
    expect(s.patch).toEqual({})
    expect(s.props).toEqual({ acceptance: '- [ ] 两条' })
  })

  it('清空关联仓库是去掉这个 key，清空负责人是空串', () => {
    const t = task()
    const s = buildSave(t, { ...draftOf(t), repo: '  ', owner_id: '' })
    expect(s.props).toEqual({ repo: null })
    expect(s.patch).toEqual({ owner_id: '' })
  })

  it('截止日按本地日期比较：同一天不算改动，换一天传纯日期，清空传 null', () => {
    const t = task()
    expect(draftOf(t).due).toBe('2026-10-30')
    expect(buildSave(t, { ...draftOf(t), due: '2026-11-02' }).patch).toEqual({ due_at: '2026-11-02' })
    expect(buildSave(t, { ...draftOf(t), due: '' }).patch).toEqual({ due_at: null })
  })

  it('参与人不看顺序，标题去首尾空白', () => {
    const t = task({ participants: [{ id: 'a', name: 'a', color: '' }, { id: 'b', name: 'b', color: '' }] })
    const d = { ...draftOf(t), participant_ids: ['b', 'a'], title: ' 标题 ' }
    expect(buildSave(t, d).patch).toEqual({})
    expect(sameDraft(d, draftOf(t))).toBe(true)
  })

  it('新建只带填了的字段，开发字段进 props 和 workdir', () => {
    const statuses = [{ key: 'todo', label: '待办', color: '', terminal: false }] as ObjectStatus[]
    const prios = [{ key: 'P1', archived_at: null, meta: {} }, { key: 'P2', archived_at: null, meta: {} }] as DictItem[]
    const d = emptyDraft(statuses, prios)
    expect(d.status).toBe('todo')
    expect(d.priority).toBe('P2')
    expect(buildCreate({ ...d, title: ' 新任务 ' })).toEqual({ type_id: 'task', title: '新任务', source: 'manual', status: 'todo', priority: 'P2' })
    expect(buildCreate({ ...d, title: 't', acceptance: '- [ ] a', repo: ' /r ', workdir: ' /w ', due: '2026-11-01', owner_id: 's' }))
      .toEqual({ type_id: 'task', title: 't', source: 'manual', status: 'todo', priority: 'P2', owner_id: 's', due_at: '2026-11-01', workdir: '/w', props: { acceptance: '- [ ] a', repo: '/r' } })
  })
})
