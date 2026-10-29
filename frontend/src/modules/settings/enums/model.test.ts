import { describe, expect, it } from 'vitest'
import type { Category, DictItem, Dictionary, ObjectType } from '../../../core/data'
import { categoryGroup, moduleShown, newItem, planEmpty, sameGroup, savePlan, statusGroup, toGroup, validate } from './model'

const dict = (id: string): Dictionary => ({ id, name: id, description: '', scope: 'global', builtin: true, sort_order: 0, created_at: '', updated_at: '' })
const item = (key: string, p: Partial<DictItem> = {}): DictItem => ({
  id: 'dit_' + key, dict_id: 'priority', type_id: null, key, label: key, color: '#c92a2a', description: '', sort_order: 0,
  meta: {}, archived_at: null, created_at: '', updated_at: '', usage: 0, ...p,
})
const prio = () => toGroup(dict('priority'), [
  item('P1', { sort_order: 20, usage: 3 }), item('P0', { sort_order: 10 }), item('P2', { sort_order: 30 }), item('P3', { sort_order: 40, archived_at: '2026-01-01' }),
])

describe('toGroup', () => {
  it('按 sort_order 排，停用的标 enabled=false，优先级没标默认时兜底 P2，接了数据的带使用数', () => {
    const g = prio()
    expect(g.items.map((i) => i.key)).toEqual(['P0', 'P1', 'P2', 'P3'])
    expect(g.items[3].enabled).toBe(false)
    expect(g.default_key).toBe('P2')
    expect(g.module).toBe('任务')
    expect(g.items[1].usage).toBe(3)
  })

  it('meta.default 标了的优先；关联关系全是系统值；没接数据的字典没有使用数', () => {
    expect(toGroup(dict('priority'), [item('P1', { meta: { default: true } }), item('P2')]).default_key).toBe('P1')
    const rel = toGroup(dict('link_relation'), [item('blocks'), item('relates')])
    expect(rel.items.every((i) => i.locked)).toBe(true)
    const kind = toGroup(dict('artifact_kind'), [item('doc'), item('other', { usage: 2 })])
    expect(kind.items.map((i) => [i.locked, i.usage])).toEqual([[false, 0], [true, 2]])
    expect(kind.module).toBe('产出物')
    expect(toGroup(dict('my_enum'), [item('a', { usage: 1 })]).items[0].usage).toBeUndefined()
  })

  it('联系人分组「其他」是系统值、兜底默认；IM 消息状态全是系统值，默认由程序定', () => {
    const grp = toGroup(dict('contact_group'), [item('客户'), item('其他')])
    expect([grp.module, grp.default_key, grp.items.map((i) => i.locked)]).toEqual(['联系人', '其他', [false, true]])
    const msg = toGroup(dict('msg_status'), [item('pending'), item('done')])
    expect(msg.module).toBe('IM 消息')
    expect(msg.items.every((i) => i.locked)).toBe(true)
    expect(msg.defaultHint).toBeTruthy()
  })
})

describe('任务状态、文档分类', () => {
  const task: ObjectType = {
    id: 'task', name: '任务', plural: '', ref_prefix: 'TSK', icon: '', color: '', builtin: true, sort_order: 0, created_at: '', updated_at: '',
    statuses: [{ key: 'todo', label: '未开工', color: '#868e96', terminal: false }, { key: 'done', label: '已完成', color: '#2b8a3e', terminal: true, description: '算完成' }],
  }
  const cat = (id: string, p: Partial<Category> = {}): Category => ({
    id, type_id: 'doc', parent_id: null, name: id, slug: id, path: `/${id}/`, depth: 0, color: '', description: '', sort_order: 0,
    created_at: '', updated_at: '', count: 0, total_count: 0, ...p,
  })

  it('任务状态全是系统值，使用数取 counts.by_status 的 task:<key>，说明来自 description', () => {
    const g = statusGroup(task, { 'task:todo': 5, 'doc:todo': 9 })
    expect(g.items.map((i) => [i.key, i.usage, i.locked, i.desc])).toEqual([['todo', 5, true, ''], ['done', 0, true, '算完成']])
    expect([g.source, g.module, g.defaultHint && 'hint']).toEqual(['status', '任务', 'hint'])
  })

  it('文档分类只取一级、按 sort_order 排，使用数含子分类，不能停用', () => {
    const g = categoryGroup('doc', [cat('b', { sort_order: 20, total_count: 3, children: [cat('b1', { parent_id: 'b' })] }), cat('a', { sort_order: 10, color: '#111' })])
    expect(g.items.map((i) => [i.id, i.key, i.usage, i.meta.children])).toEqual([['a', 'a', 0, 0], ['b', 'b', 3, 1]])
    expect(g.items[0].color).toBe('#111')
    expect(g.noArchive).toBe(true)
  })

  it('当前工作台没开的模块不显示；其他、自定义一直显示；没有工作台信息时全显示', () => {
    expect(moduleShown('产出物', ['tasks'])).toBe(false)
    expect(moduleShown('产出物', ['tasks', 'videos'])).toBe(true)
    expect(moduleShown('IM 消息', ['messages'])).toBe(true)
    expect(moduleShown('自定义', [])).toBe(true)
    expect(moduleShown('产出物', undefined)).toBe(true)
  })
})

describe('validate', () => {
  it('空显示名、坏 key、重复 key、没有启用值、默认值停用', () => {
    const g = prio()
    const d = { ...g, items: [...g.items, { ...newItem(g), key: 'P0' }, { ...newItem(g), key: 'a b', label: 'x' }] }
    expect(validate(d)).toEqual(['第 5 个值没有显示名', 'key「P0」重复了', '「x」的 key 只能用字母、数字、中文、下划线和中划线，32 字以内'])
    expect(validate({ ...g, items: g.items.map((i) => ({ ...i, enabled: false })) })).toEqual(['至少保留一个启用的值', '默认值必须是一个启用的值'])
    expect(validate({ ...g, items: [...g.items, { ...newItem(g), key: '客户', label: '客户' }] })).toEqual([])
  })
})

describe('savePlan', () => {
  it('没改动是空计划', () => {
    const g = prio()
    expect(planEmpty(savePlan(g, structuredClone(g)))).toBe(true)
    expect(sameGroup(g, structuredClone(g))).toBe(true)
  })

  it('改名改色、停用启用、换默认、删除、新加，顺序不变时不重排', () => {
    const g = prio()
    const items = g.items.map((i) =>
      i.key === 'P0' ? { ...i, label: '紧急', color: '#3d4fd6' } : i.key === 'P3' ? { ...i, enabled: true } : i.key === 'P2' ? { ...i, enabled: false } : i)
      .filter((i) => i.key !== 'P1')
    const d = { ...g, default_key: 'v5', items: [...items, { ...newItem(g), key: 'v5', label: '新' }] }
    const p = savePlan(g, d)
    expect(p.deletes).toEqual(['dit_P1'])
    expect(p.creates).toEqual([{ key: 'v5', label: '新', color: expect.any(String), description: '', meta: { default: true }, archived: false }])
    expect(p.patches).toEqual([{ id: 'dit_P0', patch: { label: '紧急', color: '#3d4fd6' } }])
    expect(p.archives).toEqual([{ id: 'dit_P2', archived: true }, { id: 'dit_P3', archived: false }])
    expect(p.order).toBeNull()
  })

  it('换默认值时摘掉原来标的、给新的标上，别的 meta 保留', () => {
    const g = toGroup(dict('priority'), [item('P1', { meta: { default: true, x: 1 } }), item('P2', { meta: { y: 2 } })])
    const p = savePlan(g, { ...g, default_key: 'P2' })
    expect(p.patches).toEqual([{ id: 'dit_P1', patch: { meta: { x: 1 } } }, { id: 'dit_P2', patch: { meta: { y: 2, default: true } } }])
  })

  it('上下移或新值不在末尾时整组重排', () => {
    const g = prio()
    const [a, b, ...rest] = g.items
    expect(savePlan(g, { ...g, items: [b, a, ...rest] }).order).toEqual(['P1', 'P0', 'P2', 'P3'])
    const n = { ...newItem(g), label: '新' }
    expect(savePlan(g, { ...g, items: [n, ...g.items] }).order).toEqual([n.key, 'P0', 'P1', 'P2', 'P3'])
  })
})
