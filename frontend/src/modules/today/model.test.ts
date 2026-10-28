import { describe, expect, it } from 'vitest'
import type { PluginTodayCard } from '../../core/plugin'
import type { WorkObject } from '../../core/data'
import { dayRows, greet, hotLevels, itemText, mergePluginCards, pickHot } from './model'

const t = (id: string, p: Partial<WorkObject> = {}) => ({ id, status: 'todo', priority: '', due_at: null, ...p }) as WorkObject
const card = (key: string, plugin: string, order?: number): PluginTodayCard => ({ key, title: key, plugin, order, render: () => null })

describe('今日页的纯函数', () => {
  it('问候语按小时', () => {
    expect([5, 6, 10, 11, 12, 13, 17, 18, 23].map(greet)).toEqual(['夜深了', '早上好', '早上好', '中午好', '中午好', '下午好', '下午好', '晚上好', '晚上好'])
  })

  it('高优先级：字典前两档，第一档任意状态，第二档只算进行中；截止在今天或更早的不重复算', () => {
    const levels = hotLevels([
      { key: 'P1', sort_order: 20, archived_at: null }, { key: 'P0', sort_order: 10, archived_at: null }, { key: 'P2', sort_order: 30, archived_at: null },
    ] as never)
    expect(levels).toEqual(['P0', 'P1'])
    const rows = [
      t('a', { priority: 'P0' }), t('b', { priority: 'P1', status: 'doing' }), t('c', { priority: 'P1' }),
      t('d', { priority: 'P0', due_at: 'x' }), t('e', { priority: 'P2', status: 'doing' }),
    ]
    const due = (x: WorkObject) => (x.due_at ? '2026-10-29' : null)
    expect(pickHot(rows, levels, '2026-10-29', due).map((x) => x.id)).toEqual(['a', 'b'])
  })

  it('今天的任务：逾期、今天、高优先级依次排，去重，刚点了完成的先藏起来', () => {
    const r = dayRows([t('a'), t('b')], [t('c')], [t('a'), t('d', { status: 'doing' }), t('e')], '进行中', new Set(['b']))
    expect(r.map((x) => [x.task.id, x.tag ?? ''])).toEqual([['a', '逾期'], ['c', '今天'], ['d', '进行中'], ['e', '']])
  })

  it('插件卡片合并：接口给的都显示，有后端的插件没给就不显示，只有前端的插件照常显示，按 order 排', () => {
    const backend = [
      { key: 'demo_inbox', title: '收件箱', order: 50, total: 2, items: [] },
      { key: 'im_mentions', title: '与我相关', order: 0, total: 1, items: [] },
    ]
    const out = mergePluginCards([card('hello_greeting', 'hello'), card('demo_inbox', 'demo', 20), card('demo_idle', 'demo')], backend, new Set(['demo', 'im']))
    expect(out.map((c) => [c.key, c.order, !!c.data, !!c.render])).toEqual([
      ['demo_inbox', 20, true, true], ['hello_greeting', 100, false, true], ['im_mentions', 100, true, false],
    ])
  })

  it('通用卡片的条目文字', () => {
    expect([itemText('一条'), itemText({ title: '标题' }), itemText({ name: '名字' }), itemText({ x: 1 }), itemText(3)]).toEqual(['一条', '标题', '名字', '', ''])
  })
})
