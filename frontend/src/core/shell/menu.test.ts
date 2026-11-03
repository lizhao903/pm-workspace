import { beforeEach, describe, expect, it } from 'vitest'
import type { ModuleDef } from '../plugin'
import { buildMenu, readCollapsed, readFolded, toggleId, writeCollapsed, writeFolded } from './menu'

const mod = (id: string): ModuleDef => ({ id, label: id, path: id, load: async () => ({ default: () => null }) })

describe('buildMenu', () => {
  it('按默认分组排，设置放底部，空组不出现，多出来的放「未分组」', () => {
    const m = buildMenu(['today', 'tasks', 'settings', 'hello', 'contacts'].map(mod))
    expect(m.groups.map((g) => [g.name, g.items.map((x) => x.id)])).toEqual([
      ['', ['today']],
      ['工作', ['tasks']],
      ['沟通', ['contacts']],
      ['未分组', ['hello']],
    ])
    expect(m.foot.map((x) => x.id)).toEqual(['settings'])
  })

  it('同一个模块写在两个组里只出现在第一个', () => {
    const m = buildMenu(['a', 'b'].map(mod), [{ id: 'x', name: '甲', modules: ['a', 'b'] }, { id: 'y', name: '乙', modules: ['a'] }])
    expect(m.groups.map((g) => g.id)).toEqual(['x'])
  })
})

describe('本地记忆', () => {
  // unit 环境没有 localStorage，补一个最简单的
  beforeEach(() => {
    const data = new Map<string, string>()
    globalThis.localStorage = {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => { data.set(k, v) },
      removeItem: (k: string) => { data.delete(k) },
      clear: () => data.clear(),
      key: () => null,
      length: 0,
    } as Storage
  })

  it('收起状态和折叠的分组存得进读得出', () => {
    expect(readCollapsed()).toBe(false)
    writeCollapsed(true)
    expect(readCollapsed()).toBe(true)
    writeFolded(['work'])
    expect(readFolded()).toEqual(['work'])
  })

  it('存的不是数组或解析不了时当作没折叠', () => {
    localStorage.setItem('pmw-side-folded', '{"a":1}')
    expect(readFolded()).toEqual([])
    localStorage.setItem('pmw-side-folded', 'not json')
    expect(readFolded()).toEqual([])
  })

  it('toggleId', () => {
    expect(toggleId(['a'], 'b')).toEqual(['a', 'b'])
    expect(toggleId(['a', 'b'], 'a')).toEqual(['b'])
  })
})
