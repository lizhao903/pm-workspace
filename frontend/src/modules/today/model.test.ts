import { describe, expect, it } from 'vitest'
import type { PluginTodayCard } from '../../core/plugin'
import type { WorkObject } from '../../core/data'
import type { Connector, Progress } from '../../core/data'
import { actorText, connectorNeeds, dayRows, greet, hotLevels, itemText, mergePluginCards, needGroups, pickHot, reviewSub } from './model'

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

  it('需要你处理：没条目的组不出现，没取到的留着；按来源顺序，组内异常在前、新的在前、没时间的最后', () => {
    const it0 = (id: string, tone: 'danger' | 'warn' | 'info', at?: string) => ({ id, tone, title: id, sub: '', at })
    const gs = needGroups([
      { key: 'conn', label: '连接异常', order: 60, total: 1, items: [it0('c', 'danger')] },
      { key: 'empty', label: '空', order: 10, total: 0, items: [] },
      { key: 'bad', label: '没取到', order: 50, total: 0, items: [], error: true },
      { key: 'im', label: 'IM 消息', order: 40, total: 3, items: [it0('a', 'info'), it0('b', 'info', '2026-10-02'), it0('d', 'danger', '2026-10-01')] },
    ])
    expect(gs.map((g) => g.key)).toEqual(['im', 'bad', 'conn'])
    expect(gs[0].items.map((x) => x.id)).toEqual(['d', 'b', 'a'])
  })

  it('连接异常只算 status=error 的连接器', () => {
    const rows = [{ id: '1', name: '甲', status: 'error', error: '凭证失效' }, { id: '2', name: '乙', status: 'paused', error: '' }] as Connector[]
    expect(connectorNeeds(rows)).toEqual([{ id: '1', tone: 'danger', title: '连接器「甲」异常', sub: '凭证失效', action: '去修复', to: '/settings/connectors' }])
  })

  it('任务待验收的说明：操作者提交验收，带项目名；没有提交验收的进展时等你验收', () => {
    const p = { kind: 'review', actor_name: 'claude-code' } as Progress
    expect(actorText('claude-code')).toBe('Claude Code')
    expect(reviewSub(p, '官网')).toBe('Claude Code 提交验收 · 官网')
    expect(reviewSub({ ...p, actor_name: '小王' })).toBe('小王 提交验收')
    expect(reviewSub(undefined, '官网')).toBe('等你验收 · 官网')
    expect(reviewSub(undefined)).toBe('等你验收')
  })
})
