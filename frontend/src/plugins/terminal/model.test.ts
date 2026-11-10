// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { describe, expect, it } from 'vitest'
import type { TerminalPrototype, TerminalSession } from '../../core/data'
import {
  EMPTY_LAYOUT, addPane, addTab, cwdFromOsc7, layoutClass, newPane, newTab, parseLayout, protoForCwd, reconcile, removePane, removeTab,
  renameTab, setFocus, shortPath, tabName, type Layout,
} from './model'

const sess = (id: string, cwd = '/w/app', status: TerminalSession['status'] = 'running') =>
  ({ id, cwd, status }) as TerminalSession
const pane = (id: string, cwd = '/w/app') => newPane(sess(id, cwd))

function twoTabs(): Layout {
  let l = addTab(EMPTY_LAYOUT, newTab([pane('pn_1')], '工作台'))
  l = addTab(l, newTab([pane('pn_2', '/w/api')]))
  return l
}

describe('标签和格子', () => {
  it('名字：改过名用改的，没改过用焦点格目录的最后一段；改名去首尾空格，清空恢复', () => {
    const l = twoTabs()
    expect(tabName(l.tabs[0])).toBe('工作台')
    expect(tabName(l.tabs[1])).toBe('api')
    expect(tabName(renameTab(l, l.tabs[0].id, '  后端 ').tabs[0])).toBe('后端')
    expect(tabName(renameTab(l, l.tabs[0].id, '   ').tabs[0])).toBe('app')
  })

  it('拆分：第一次决定方向，焦点给新格，满 4 格不再加；布局 l1 到 l4', () => {
    let l = twoTabs()
    const id = l.tabs[0].id
    expect(layoutClass(l.tabs[0])).toBe('l1')
    l = addPane(l, id, pane('pn_3'), 'col')
    expect(layoutClass(l.tabs[0])).toBe('l2c')
    l = addPane(l, id, pane('pn_4'), 'row')
    expect(l.tabs[0].dir).toBe('col')
    expect(layoutClass(l.tabs[0])).toBe('l3')
    l = addPane(l, id, pane('pn_5'), 'row')
    expect(layoutClass(l.tabs[0])).toBe('l4')
    expect(l.tabs[0].focus).toBe(l.tabs[0].panes[3].id)
    expect(addPane(l, id, pane('pn_6'), 'row').tabs[0].panes).toHaveLength(4)
    expect(layoutClass(addPane(twoTabs(), twoTabs().tabs[0].id, pane('x'), 'row').tabs[0])).toBe('l1')
  })

  it('关格：焦点格关了焦点给第一格；只剩一格等于关标签', () => {
    let l = twoTabs()
    const id = l.tabs[0].id
    l = addPane(l, id, pane('pn_3'), 'row')
    const [a, b] = l.tabs[0].panes
    l = removePane(l, b.id)
    expect(l.tabs[0].panes.map((p) => p.id)).toEqual([a.id])
    expect(l.tabs[0].focus).toBe(a.id)
    l = removePane(l, a.id)
    expect(l.tabs).toHaveLength(1)
  })

  it('关当前标签切到左边那个，最左的切到新的最左', () => {
    let l = twoTabs()
    l = addTab(l, newTab([pane('pn_3')]))
    const [t0, t1, t2] = l.tabs
    expect(removeTab(l, t2.id).active).toBe(t1.id)
    expect(removeTab({ ...l, active: t0.id }, t0.id).active).toBe(t1.id)
    expect(removeTab(l, t0.id).active).toBe(t2.id)
    expect(removeTab(removeTab(removeTab(l, t0.id), t1.id), t2.id)).toEqual({ tabs: [], active: '' })
  })

  it('点格子设焦点，同一格不产生新对象', () => {
    let l = twoTabs()
    l = addPane(l, l.tabs[0].id, pane('pn_3'), 'row')
    const first = l.tabs[0].panes[0].id
    const l2 = setFocus(l, first)
    expect(l2.tabs[0].focus).toBe(first)
    expect(setFocus(l2, first)).toBe(l2)
  })
})

describe('刷新后重连', () => {
  it('布局里记着的照旧，没记着、还在跑的会话收进新标签，每个最多 4 格；已退出的不收', () => {
    const l = twoTabs()
    const out = reconcile(l, [
      sess('pn_1'), sess('pn_2'), sess('o1'), sess('o2'), sess('o3'), sess('o4'), sess('o5'), sess('dead', '/w', 'exited'),
    ])
    expect(out.tabs).toHaveLength(4)
    expect(out.tabs[2].panes.map((p) => p.session)).toEqual(['o1', 'o2', 'o3', 'o4'])
    expect(out.tabs[3].panes.map((p) => p.session)).toEqual(['o5'])
    expect(out.active).toBe(l.active)
  })

  it('什么都没有新增时原样返回；空布局接回会话后当前标签是第一个', () => {
    const l = twoTabs()
    expect(reconcile(l, [sess('pn_1')])).toBe(l)
    const out = reconcile(EMPTY_LAYOUT, [sess('a')])
    expect(out.active).toBe(out.tabs[0].id)
  })

  it('存下的布局读回来；坏数据丢掉不报错', () => {
    const l = twoTabs()
    expect(parseLayout(JSON.stringify(l))).toEqual(l)
    expect(parseLayout('not json')).toEqual(EMPTY_LAYOUT)
    expect(parseLayout(null)).toEqual(EMPTY_LAYOUT)
    const bad = parseLayout(JSON.stringify({ tabs: [{ id: 't', panes: [{ id: 'p' }] }, { id: 'u', dir: 'x', focus: 'zz', panes: [{ id: 'p', session: 's', cwd: '/' }] }], active: 1 }))
    expect(bad.tabs).toHaveLength(1)
    expect(bad.tabs[0]).toMatchObject({ id: 'u', dir: 'row', focus: 'p', name: '' })
    expect(bad.active).toBe('u')
  })
})

describe('目录', () => {
  it('家目录下写成 ~/…', () => {
    expect(shortPath('/Users/me/x', '/Users/me')).toBe('~/x')
    expect(shortPath('/Users/me', '/Users/me')).toBe('~')
    expect(shortPath('/Users/meme', '/Users/me')).toBe('/Users/meme')
    expect(shortPath('/a', '')).toBe('/a')
  })

  it('OSC 7 解出路径，非 file URL 不认', () => {
    expect(cwdFromOsc7('file://mac.local/Users/me/%E9%A1%B9%E7%9B%AE')).toBe('/Users/me/项目')
    expect(cwdFromOsc7('file:///tmp')).toBe('/tmp')
    expect(cwdFromOsc7('http://x/y')).toBeNull()
  })

  it('按目录认原型，去掉末尾斜杠比', () => {
    const protos = [{ id: 'pt1', dir: '/w/app/web/' }, { id: 'pt2', dir: '' }] as TerminalPrototype[]
    expect(protoForCwd(protos, '/w/app/web')?.id).toBe('pt1')
    expect(protoForCwd(protos, '/w/app')).toBeUndefined()
    expect(protoForCwd(undefined, '/w')).toBeUndefined()
  })
})
