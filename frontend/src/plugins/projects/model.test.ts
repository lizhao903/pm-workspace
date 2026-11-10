// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { beforeEach, describe, expect, it } from 'vitest'
import type { DictItem, ObjectStatus, ProjectStakeholder, ProjectView, WorkObject } from '../../core/data'
import {
  RECENT_MAX, ago, colorOf, docsDirAbs, docsDirPick, doneStatus, isOpenStatus, reopenStatus, sortByPriority, sortStakeholders, diffForm, dirName, activityOf, groupByActivity, showStatusTag, loadRecent, markText, matchQuery, resetRecentMemo, sortProjects, tabOf,
  touchRecent, hiddenTabsOf, tabsOrderOf, weaveKeys, orderTabs, moveTab, isDefaultOrder, withPluginTabs, TABS, type Form,
} from './model'
import { PROJECT_COLORS } from './markIcons'

const pv = (id: string, x: Partial<ProjectView> = {}): ProjectView => ({
  id, ref: id, name: id, desc: '', status: 'planning', color: '', mark: { text: '' }, root: '', related: [], docsDir: '', sopIds: [], sopHidden: [], agentIds: [], sessionIds: [],
  created_at: '', updated_at: '', ...x,
})

describe('项目列表', () => {
  it('搜名称、说明、项目目录，不区分大小写', () => {
    const p = pv('a', { name: 'PMW 新版', desc: '重做前端', root: '/Volumes/project/Web-Next' })
    expect(matchQuery(p, 'pmw')).toBe(true)
    expect(matchQuery(p, '前端')).toBe(true)
    expect(matchQuery(p, 'web-next')).toBe(true)
    expect(matchQuery(p, '后端')).toBe(false)
  })

  it('最近打开排前面，新的在前；没打开过的保持原顺序排后面', () => {
    const list = ['a', 'b', 'c', 'd'].map((x) => pv(x))
    expect(sortProjects(list, 'recent', ['c', 'a']).map((p) => p.id)).toEqual(['c', 'a', 'b', 'd'])
    expect(sortProjects(list, 'recent', []).map((p) => p.id)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('名称按中文排序规则', () => {
    const list = ['张', '阿', '李'].map((n, i) => pv(String(i), { name: n }))
    expect(sortProjects(list, 'name', []).map((p) => p.name)).toEqual(['阿', '李', '张'])
  })

  it('有原型在跑优先，其次有待回复，其余归「其他」；一个项目只归一组', () => {
    expect(activityOf({ protoRunning: 1, pending: 3 })).toBe('running')
    expect(activityOf({ protoRunning: 0, pending: 2 })).toBe('pending')
    expect(activityOf({ protoRunning: 0, pending: 0 })).toBe('other')
    expect(activityOf(undefined)).toBe('other')
  })

  it('按有原型在跑、有待回复、其他分段，段内保持顺序，空段不要', () => {
    const rows = [pv('a'), pv('b'), pv('c'), pv('d')]
    const of = (p: ProjectView) => (({ a: 'other', b: 'running', c: 'other', d: 'running' }) as const)[p.id as 'a']
    const g = groupByActivity(rows, of)
    expect(g.map((x) => [x.label, x.items.map((p) => p.id)])).toEqual([['有原型在跑', ['b', 'd']], ['其他', ['a', 'c']]])
  })

  it('进行中不标状态，其他状态标', () => {
    expect(showStatusTag('active')).toBe(false)
    expect(showStatusTag('paused')).toBe(true)
    expect(showStatusTag('')).toBe(false)
  })

  it('底色没填时按 id 固定给一个，标志文字取名称第一个字，都空时「项」', () => {
    expect(colorOf({ id: 'x', color: '#123456' })).toBe('#123456')
    expect(PROJECT_COLORS).toContain(colorOf({ id: 'obj_1', color: '' }))
    expect(colorOf({ id: 'obj_1', color: '' })).toBe(colorOf({ id: 'obj_1', color: '' }))
    expect(markText({ name: '工作台', mark: { text: '' } })).toBe('工')
    expect(markText({ name: '', mark: { text: '' } })).toBe('项')
    expect(markText({ name: '工作台', mark: { text: 'PW' } })).toBe('PW')
  })

  it('目录只显示最后一段', () => {
    expect(dirName('/Volumes/project/pm-workspace/')).toBe('pm-workspace')
    expect(dirName('')).toBe('')
  })
})

describe('最近打开', () => {
  beforeEach(() => {
    const m = new Map<string, string>()
    globalThis.localStorage = {
      getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v) },
      removeItem: (k: string) => { m.delete(k) }, clear: () => m.clear(), key: () => null, length: 0,
    } as Storage
    resetRecentMemo()
  })

  it('打开的挪到最前，最多记 20 个，存进 localStorage', () => {
    for (let i = 0; i < 25; i += 1) touchRecent(`p${i}`)
    touchRecent('p10')
    const r = loadRecent()
    expect(r).toHaveLength(RECENT_MAX)
    expect(r[0]).toBe('p10')
    expect(r.filter((x) => x === 'p10')).toHaveLength(1)
    resetRecentMemo()
    expect(loadRecent()).toEqual(r)
  })

  it('存储里是坏数据时当没有', () => {
    localStorage.setItem('pmw-projects-recent', '{oops')
    expect(loadRecent()).toEqual([])
  })
})

describe('设置的保存口径', () => {
  const base: Form = { name: '工作台', desc: '', status: 'planning', root: '', docsDir: '', color: '#3d4fd6', mark: { text: '', icon: 'folder' }, related: [], hidden: [], order: [] }

  it('文档目录（TSK-0718）：去首尾空白存进 props.docs_dir，清空存空串；相对路径接项目目录，选到项目目录里的存相对路径', () => {
    expect(diffForm({ ...base, docsDir: ' docs ' }, base).props).toEqual({ docs_dir: 'docs' })
    expect(diffForm(base, { ...base, docsDir: 'docs' }).props).toEqual({ docs_dir: '' })
    expect(docsDirAbs('docs/prd/', '/Users/me/app')).toBe('/Users/me/app/docs/prd')
    expect(docsDirAbs('../shared', '/Users/me/app')).toBe('/Users/me/shared')
    expect(docsDirAbs('file:///Volumes/x/', '')).toBe('/Volumes/x')
    expect(docsDirAbs('docs', '')).toBe('')
    expect(docsDirPick('/Users/me/app/docs', '/Users/me/app/')).toBe('docs')
    expect(docsDirPick('/Users/me/app', '/Users/me/app')).toBe('.')
    expect(docsDirPick('/Volumes/x', '/Users/me/app')).toBe('/Volumes/x')
  })

  it('名称清空不存，目录去首尾空白', () => {
    expect(diffForm({ ...base, name: '  ' }, base)).toEqual({ patch: {}, props: {} })
    expect(diffForm({ ...base, root: ' /tmp/a ' }, base).patch).toEqual({ workdir: '/tmp/a' })
  })

  it('关联目录路径为空的行不存；只加了空行不算改动', () => {
    expect(diffForm({ ...base, related: [{ path: '', label: '设计稿' }] }, base)).toEqual({ patch: {}, props: {} })
    expect(diffForm({ ...base, related: [{ path: '/a ', label: '设计稿' }, { path: '', label: '' }] }, base).props)
      .toEqual({ related: [{ path: '/a', label: '设计稿' }] })
  })

  it('隐藏的标签进 props.tabs_hidden；读的时候概览、设置和非字符串不认，去重', () => {
    expect(diffForm({ ...base, hidden: ['sop', 'agents'] }, base).props).toEqual({ tabs_hidden: ['sop', 'agents'] })
    expect(diffForm({ ...base, hidden: [] }, { ...base, hidden: ['sop'] }).props).toEqual({ tabs_hidden: [] })
    expect(hiddenTabsOf({ props: { tabs_hidden: ['sop', 'overview', 'settings', 3, 'sop'] } })).toEqual(['sop'])
    expect(hiddenTabsOf({ props: { tabs_hidden: 'sop' } })).toEqual([])
    expect(hiddenTabsOf({ props: null })).toEqual([])
  })

  it('标签顺序进 props.tabs_order；读的时候概览、设置、空串和非字符串不认，去重', () => {
    expect(diffForm({ ...base, order: ['sop', 'comms'] }, base).props).toEqual({ tabs_order: ['sop', 'comms'] })
    expect(diffForm({ ...base, order: [] }, { ...base, order: ['sop'] }).props).toEqual({ tabs_order: [] })
    expect(diffForm(base, base)).toEqual({ patch: {}, props: {} })
    expect(tabsOrderOf({ props: { tabs_order: ['sop', 'overview', 'settings', '', 3, 'sop', 'comms'] } })).toEqual(['sop', 'comms'])
    expect(tabsOrderOf({ props: { tabs_order: 'sop' } })).toEqual([])
    expect(tabsOrderOf({ props: null })).toEqual([])
  })

  it('标志、底色进 props', () => {
    expect(diffForm({ ...base, mark: { text: '工' }, color: '#0f8a8a' }, base).props).toEqual({ mark: { text: '工' }, color: '#0f8a8a' })
  })

  it('标签路径认不出来的不给进', () => {
    expect(tabOf(undefined)).toBe('overview')
    expect(tabOf('settings')).toBe('settings')
    expect(tabOf('nope')).toBeNull()
  })
})

describe('项目标签', () => {
  const st = (stakeholder_id: string, role: string, sort_order: number) =>
    ({ project_id: 'p', stakeholder_id, role, focus: '', sort_order, created_at: '', updated_at: '' }) as ProjectStakeholder
  it('干系人按角色顺序排（决策人、对接人、负责人、参与、知会），同角色按加入顺序', () => {
    const rows = [st('a', 'member', 1), st('b', 'informed', 2), st('c', 'owner', 3), st('d', 'decider', 4), st('e', 'contact', 5), st('f', 'member', 0)]
    expect(sortStakeholders(rows).map((x) => x.stakeholder_id)).toEqual(['d', 'e', 'c', 'f', 'a', 'b'])
  })

  const ts: ObjectStatus[] = [
    { key: 'todo', label: '待办', color: '', terminal: false },
    { key: 'review', label: '待验收', color: '', terminal: false },
    { key: 'done', label: '已完成', color: '', terminal: true },
    { key: 'cancelled', label: '已取消', color: '', terminal: true },
  ]
  it('未完成看终态标记；完成、改回用的状态从状态集取', () => {
    expect(isOpenStatus(ts, 'review')).toBe(true)
    expect(isOpenStatus(ts, 'cancelled')).toBe(false)
    expect(isOpenStatus(ts, 'unknown')).toBe(true)
    expect(doneStatus(ts)).toBe('done')
    expect(doneStatus(ts.filter((s) => s.key !== 'done'))).toBeUndefined()
    expect(reopenStatus(ts)).toBe('todo')
  })

  it('任务按字典里的优先级顺序排，没有优先级的最后', () => {
    const prios = [{ key: 'P0' }, { key: 'P1' }, { key: 'P2' }] as DictItem[]
    const t = (id: string, priority: string, updated_at = '2026-10-01') => ({ id, priority, updated_at }) as WorkObject
    expect(sortByPriority([t('a', ''), t('b', 'P2'), t('c', 'P0'), t('d', 'P2', '2026-10-02')], prios).map((x) => x.id)).toEqual(['c', 'd', 'b', 'a'])
  })

  it('相对时间', () => {
    const now = Date.parse('2026-10-29T12:00:00Z')
    expect(ago('2026-10-29T11:59:40Z', now)).toBe('刚刚')
    expect(ago('2026-10-29T11:30:00Z', now)).toBe('30 分钟前')
    expect(ago('2026-10-29T09:00:00Z', now)).toBe('3 小时前')
    expect(ago('2026-10-26T12:00:00Z', now)).toBe('3 天前')
    expect(ago('bad', now)).toBe('-')
  })
})

describe('标签顺序', () => {
  const keys = (xs: readonly { key: string }[]) => xs.map((t) => t.key)
  const def = keys(TABS)

  it('没存顺序时就是默认顺序', () => {
    expect(keys(orderTabs(TABS, []))).toEqual(def)
    expect(isDefaultOrder(TABS, [])).toBe(true)
  })

  it('按存的顺序排，概览固定第一、设置固定最后；存的顺序里写了概览、设置也不挪', () => {
    const order = ['prototypes', 'sop', 'comms', 'attachments', 'stakeholders', 'tasks', 'schedules', 'docs', 'agents', 'materials', 'profile']
    expect(keys(orderTabs(TABS, order))).toEqual(['overview', ...order, 'settings'])
    expect(keys(orderTabs(TABS, ['settings', ...order, 'overview']))).toEqual(['overview', ...order, 'settings'])
    expect(isDefaultOrder(TABS, order)).toBe(false)
  })

  it('存的顺序里没有的标签按默认位置插入：跟在默认顺序里前一个标签后面，前面没有就放最前', () => {
    // 只存了一部分：comms 不在里面，默认在 overview 后，前面没有可跟的，放最前
    expect(keys(orderTabs(TABS, ['tasks', 'sop']))).toEqual(['overview', 'comms', 'attachments', 'stakeholders', 'tasks', 'schedules', 'docs', 'sop', 'agents', 'materials', 'prototypes', 'profile', 'settings'])
    // 插件后来登记的「商单」（默认在任务后面）跟着任务走
    const all = withPluginTabs([{ key: 'deals', label: '商单', after: 'tasks', page: null as never, plugin: 'video' }])
    const saved = ['prototypes', 'tasks', 'comms', 'attachments', 'stakeholders', 'docs', 'sop', 'agents', 'materials']
    expect(keys(orderTabs(all, saved))).toEqual(['overview', 'prototypes', 'profile', 'tasks', 'deals', 'schedules', 'comms', 'attachments', 'stakeholders', 'docs', 'sop', 'agents', 'materials', 'settings'])
  })

  it('存的顺序里认不出的 key（插件没在跑）跳过', () => {
    const order = ['deals', 'prototypes', 'sop', 'comms', 'attachments', 'stakeholders', 'tasks', 'schedules', 'docs', 'agents', 'materials', 'profile']
    expect(keys(orderTabs(TABS, order))).toEqual(['overview', ...order.slice(1), 'settings'])
    expect(keys(orderTabs(TABS, ['deals']))).toEqual(def)
    expect(isDefaultOrder(TABS, ['deals'])).toBe(true)
  })

  it('挪动返回要存的整个顺序；没列出来的插件标签按原来的邻居留着', () => {
    const vis = ['comms', 'tasks', 'sop']
    expect(moveTab(vis, [], 'sop', 0)).toEqual(['sop', 'comms', 'tasks'])
    expect(moveTab(vis, [], 'comms', 9)).toEqual(['tasks', 'sop', 'comms'])
    expect(moveTab(vis, ['comms', 'tasks', 'deals', 'sop'], 'sop', 0)).toEqual(['sop', 'comms', 'tasks', 'deals'])
  })

  it('补 key 时连着的几个保持先后', () => {
    expect(weaveKeys(['c'], ['a', 'b', 'c', 'd', 'e'])).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(weaveKeys(['e', 'a'], ['a', 'b', 'c', 'd', 'e'])).toEqual(['e', 'a', 'b', 'c', 'd'])
  })
})
