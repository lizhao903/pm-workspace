// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { lazy } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { objectSectionRegistry, objectSectionStore, sectionTabs, sectionsFor } from './objectSections'

const section = lazy(async () => ({ default: () => null }))

afterEach(() => { objectSectionStore.removeOwner('a'); objectSectionStore.removeOwner('b') })

describe('对象详情区块扩展点（SOP-06）', () => {
  it('按类型挑、按 order 排，按插件撤掉', () => {
    objectSectionRegistry('a').register({ key: 'sop', typeIds: ['task'], order: 50, section })
    objectSectionRegistry('b').register({ key: 'x', typeIds: ['task', 'requirement'], section })
    objectSectionRegistry('b').register({ key: 'early', typeIds: ['task'], order: 10, section })
    const list = objectSectionStore.list()
    expect(sectionsFor(list, 'task').map((s) => `${s.plugin}:${s.key}`)).toEqual(['b:early', 'a:sop', 'b:x'])
    expect(sectionsFor(list, 'requirement').map((s) => s.key)).toEqual(['x'])
    expect(sectionsFor(list, 'project')).toEqual([])
    objectSectionStore.removeOwner('b')
    expect(sectionsFor(objectSectionStore.list(), 'task').map((s) => s.key)).toEqual(['sop'])
  })
  it('同一插件同一个 key 不能登记两次，别的插件可以', () => {
    objectSectionRegistry('a').register({ key: 'sop', typeIds: ['task'], section })
    expect(() => objectSectionRegistry('a').register({ key: 'sop', typeIds: ['task'], section })).toThrow('对象区块 sop 重复注册')
    expect(() => objectSectionRegistry('b').register({ key: 'sop', typeIds: ['task'], section })).not.toThrow()
  })
  it('登记了 tab 的区块按标签分组，同 key 合在一起，按排好的先后；没给 tab 的不进标签', () => {
    objectSectionRegistry('a').register({ key: 'runs', typeIds: ['task'], order: 50, section, tab: { key: 'sop', label: 'SOP', focusParam: 'sop_run' } })
    objectSectionRegistry('b').register({ key: 'plain', typeIds: ['task'], order: 10, section })
    objectSectionRegistry('b').register({ key: 'more', typeIds: ['task'], order: 60, section, tab: { key: 'sop', label: 'SOP' } })
    objectSectionRegistry('b').register({ key: 'v', typeIds: ['task'], order: 20, section, tab: { key: 'video', label: '视频' } })
    const tabs = sectionTabs(sectionsFor(objectSectionStore.list(), 'task'))
    expect(tabs.map((t) => [t.tab.key, t.sections.map((s) => s.key)])).toEqual([['video', ['v']], ['sop', ['runs', 'more']]])
  })
})
