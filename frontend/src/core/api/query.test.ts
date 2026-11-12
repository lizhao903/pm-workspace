// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { describe, expect, it } from 'vitest'
import { artifactListQuery, changedFields, focusParams, localDay, objectListQuery } from './query'
import type { WorkObject } from './types'

describe('objectListQuery', () => {
  it('多选逗号拼接，去空白和空串', () => {
    const qs = objectListQuery({ type: ['requirement', ' task '], status: ['doing', '', 'blocked'], priority: ['P0', 'P1'] })
    expect(qs.get('type')).toBe('requirement,task')
    expect(qs.get('status')).toBe('doing,blocked')
    expect(qs.get('priority')).toBe('P0,P1')
  })

  it('来源多选逗号拼接', () => {
    expect(objectListQuery({ type: ['task'], source: ['manual', 'import'] }).get('source')).toBe('manual,import')
  })

  it('空数组和空串不出现', () => {
    expect(objectListQuery({ type: [], status: [''], q: '  ', owner_id: '' }).toString()).toBe('')
  })

  it('tag 是重复参数，不逗号拼接', () => {
    const qs = objectListQuery({ tag: ['云端平台', 'a,b'] })
    expect(qs.getAll('tag')).toEqual(['云端平台', 'a,b'])
    expect(qs.toString()).toBe('tag=%E4%BA%91%E7%AB%AF%E5%B9%B3%E5%8F%B0&tag=a%2Cb')
  })

  it('布尔开关只在 true 时出现', () => {
    const qs = objectListQuery({
      subtree: true,
      uncategorized: false,
      stalled: true,
      not_terminal: true,
      overdue: false,
      inbox: true,
      archived: true,
      deleted: false,
    })
    expect(qs.toString()).toBe('subtree=true&stalled=true&not_terminal=true&inbox=true&archived=true')
  })

  it('纯日期原样传，补时交给后端', () => {
    const qs = objectListQuery({ due_after: '2026-09-15', due_before: '2026-09-15' })
    expect(qs.get('due_after')).toBe('2026-09-15')
    expect(qs.get('due_before')).toBe('2026-09-15')
  })

  it('参数名与契约表一致', () => {
    const qs = objectListQuery({
      type: ['task'],
      category: 'cat_1',
      owner_id: 'stk_1',
      project: 'obj_p',
      q: '多租户',
      sort: '-updated_at',
      limit: 50,
      offset: 100,
    })
    expect([...qs.keys()]).toEqual(['type', 'category', 'owner_id', 'project', 'q', 'sort', 'limit', 'offset'])
    expect(qs.get('limit')).toBe('50')
    expect(qs.get('offset')).toBe('100')
  })
})

describe('artifactListQuery', () => {
  it('has_url / has_path 三态', () => {
    expect(artifactListQuery({}).toString()).toBe('')
    expect(artifactListQuery({ has_url: false, has_path: true }).toString()).toBe('has_url=false&has_path=true')
  })

  it('unscoped 是开关', () => {
    expect(artifactListQuery({ unscoped: true, source: 'mcp' }).toString()).toBe('unscoped=true&source=mcp')
    expect(artifactListQuery({ unscoped: false }).toString()).toBe('')
  })
})

describe('focusParams', () => {
  const now = new Date(2026, 9, 28, 15, 30)

  it('今日：上下界同一天，排除终态', () => {
    expect(focusParams('today', now)).toEqual({ due_after: '2026-10-28', due_before: '2026-10-28', not_terminal: true })
  })

  it('本周：到 +7 天，跨月', () => {
    expect(focusParams('week', now)).toEqual({ due_after: '2026-10-28', due_before: '2026-11-04', not_terminal: true })
  })

  it('逾期、停滞走布尔开关', () => {
    expect(objectListQuery(focusParams('overdue')).toString()).toBe('overdue=true')
    expect(objectListQuery(focusParams('stalled')).toString()).toBe('stalled=true')
  })

  it('localDay 补零', () => {
    expect(localDay(new Date(2026, 0, 5))).toBe('2026-01-05')
  })
})

describe('changedFields', () => {
  const before: WorkObject = {
    id: 'obj_1',
    type_id: 'task',
    ref: 'TSK-0001',
    title: '旧标题',
    body: '',
    status: 'todo',
    priority: 'P1',
    owner: '',
    owner_id: 'stk_1',
    category_id: 'cat_1',
    project_id: null,
    source: '',
    props: { repo: '/x' },
    workdir: '',
    due_at: '2026-10-28T10:00:00+08:00',
    started_at: null,
    completed_at: null,
    archived_at: null,
    deleted_at: null,
    created_at: '2026-10-01T00:00:00Z',
    updated_at: '2026-10-01T00:00:00Z',
    tags: ['a', 'b'],
    link_count: 0,
    participants: [{ id: 'stk_2', name: '甲', color: '' }],
  }

  it('只留改了的字段', () => {
    expect(
      changedFields(before, {
        title: '旧标题',
        status: 'doing',
        tags: ['b', 'a'],
        participant_ids: ['stk_2'],
        props: { repo: '/x' },
        due_at: '2026-10-28T02:00:00Z',
      }),
    ).toEqual({ status: 'doing' })
  })

  it('置空分类传 null，清空负责人传空串', () => {
    expect(changedFields(before, { category_id: null, owner_id: '' })).toEqual({ category_id: null, owner_id: '' })
  })

  it('没出现的字段不算改动', () => {
    expect(changedFields(before, {})).toEqual({})
  })
})
