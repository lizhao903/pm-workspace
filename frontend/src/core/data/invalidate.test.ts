import { QueryClient, type QueryKey } from '@tanstack/react-query'
import { describe, expect, it } from 'vitest'
import { applyChange, invalidationsFor, type Change } from './invalidate'
import { dataKeys, normFilter } from './keys'

// 各页面会用到的缓存，挨个种进一个空缓存，看一次改动把哪些标成过期
const seeded = {
  taskList: dataKeys.objects.listAll({ type: ['task'], q: '', overdue: false }),
  overdueList: dataKeys.objects.listAll({ type: ['task'], overdue: true }),
  todayList: dataKeys.objects.list({ type: ['task'], due_before: '2026-10-29', not_terminal: true }),
  projectTab: dataKeys.objects.listAll({ type: ['task'], project: 'obj_p1' }),
  projectOptions: dataKeys.objects.listAll({ type: ['project'], sort: 'title' }),
  detail: dataKeys.objects.detail('obj_a'),
  otherDetail: dataKeys.objects.detail('obj_b'),
  progress: dataKeys.objects.progress('obj_a'),
  otherProgress: dataKeys.objects.progress('obj_b'),
  revisions: dataKeys.objects.revisions('obj_a'),
  taskCounts: dataKeys.counts.of('task'),
  menuCounts: dataKeys.counts.of(),
  stakeholders: dataKeys.stakeholders.list(),
  types: dataKeys.objectTypes,
  dictItems: dataKeys.dictionaries.items('priority'),
  artifacts: dataKeys.artifacts.list({ object_id: 'obj_a', limit: 500 }),
  artifactStats: dataKeys.artifacts.stats({ object_id: 'obj_a' }),
  runs: dataKeys.runs.list('obj_a'),
  otherRuns: dataKeys.runs.list('obj_b'),
  run: dataKeys.runs.detail('run_1'),
  workdir: dataKeys.workdir('/tmp'),
} satisfies Record<string, QueryKey>

type Name = keyof typeof seeded

async function stale(c: Change): Promise<Name[]> {
  const qc = new QueryClient()
  for (const k of Object.values(seeded)) qc.setQueryData(k, {})
  await applyChange(qc, c)
  return (Object.keys(seeded) as Name[]).filter((n) => qc.getQueryState(seeded[n])?.isInvalidated)
}

describe('失效规则', () => {
  it('任务改了状态：所有对象列表（任务、逾期、今日、项目的任务标签页）、对象本身、计数（逾期徽标、侧栏红点）都刷新', async () => {
    const s = await stale({ kind: 'object', id: 'obj_a' })
    expect(s).toEqual(expect.arrayContaining([
      'taskList', 'overdueList', 'todayList', 'projectTab', 'projectOptions',
      'detail', 'progress', 'revisions', 'taskCounts', 'menuCounts', 'stakeholders',
    ]))
    // 和对象无关的不动
    for (const n of ['types', 'dictItems', 'artifacts', 'artifactStats', 'runs', 'run', 'workdir'] as Name[]) expect(s).not.toContain(n)
  })

  it('只记进展：刷这个对象的进展、修订和对象本身，不刷列表和计数', async () => {
    expect(await stale({ kind: 'progress', id: 'obj_a' })).toEqual(['detail', 'progress', 'revisions'])
  })

  it('登记产出物：列表和统计一起刷（删除确认里的产出物数）', async () => {
    expect(await stale({ kind: 'artifact', objectId: 'obj_a' })).toEqual(['artifacts', 'artifactStats'])
  })

  it('执行开始只刷这个对象的执行列表', async () => {
    expect(await stale({ kind: 'run-started', objectId: 'obj_a' })).toEqual(['runs'])
  })

  it('执行收尾：执行记录、产出物、对象和计数都刷（执行里可能改了状态、登记了产出物）', async () => {
    const s = await stale({ kind: 'run-settled', objectId: 'obj_a' })
    expect(s).toEqual(expect.arrayContaining(['runs', 'otherRuns', 'run', 'artifacts', 'artifactStats', 'taskList', 'todayList', 'detail', 'taskCounts']))
    expect(s).not.toContain('types')
    expect(s).not.toContain('workdir')
  })

  it('取消执行只刷执行记录', async () => {
    expect(await stale({ kind: 'run-canceled' })).toEqual(['runs', 'otherRuns', 'run'])
  })

  it('干系人、字典、类型各刷各的', async () => {
    const st = await stale({ kind: 'stakeholder' })
    expect(st).toContain('stakeholders')
    expect(st).toContain('taskList')
    expect(st).not.toContain('taskCounts')
    expect(await stale({ kind: 'dictionary' })).toEqual(['dictItems'])
    expect(await stale({ kind: 'object-type' })).toEqual(['taskCounts', 'menuCounts', 'types'])
  })

  it('每种改动都有规则', () => {
    const all: Change[] = [
      { kind: 'object' }, { kind: 'progress', id: 'x' }, { kind: 'artifact' }, { kind: 'run-started', objectId: 'x' },
      { kind: 'run-settled', objectId: 'x' }, { kind: 'run-canceled' }, { kind: 'stakeholder' }, { kind: 'dictionary' },
      { kind: 'object-type' },
    ]
    for (const c of all) expect(invalidationsFor(c).length).toBeGreaterThan(0)
  })
})

describe('缓存键', () => {
  it('过滤条件归一：字段顺序、空值不影响键', () => {
    expect(dataKeys.objects.list({ q: '', type: ['task'], overdue: false, tag: [] }))
      .toEqual(dataKeys.objects.list({ type: ['task'] }))
    expect(normFilter({ b: 1, a: 'x', c: undefined })).toEqual({ a: 'x', b: 1 })
    expect(Object.keys(normFilter({ b: 1, a: 'x' }))).toEqual(['a', 'b'])
  })

  it('整份和单页分开缓存，都在对象列表前缀下', () => {
    const page = dataKeys.objects.list({ type: ['task'] })
    const all = dataKeys.objects.listAll({ type: ['task'] })
    expect(page).not.toEqual(all)
    expect(page.slice(0, 2)).toEqual(dataKeys.objects.lists)
    expect(all.slice(0, 2)).toEqual(dataKeys.objects.lists)
  })

  it('计数：全局和收窄到类型的分开，都在 counts 前缀下', () => {
    expect(dataKeys.counts.of()).not.toEqual(dataKeys.counts.of('task'))
    expect(dataKeys.counts.of('task')[0]).toBe(dataKeys.counts.all[0])
  })
})
