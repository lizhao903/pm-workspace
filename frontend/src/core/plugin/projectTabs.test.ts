import { lazy } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { projectTabRegistry, projectTabStore } from './projectTabs'

const page = lazy(async () => ({ default: () => null }))

afterEach(() => { projectTabStore.removeOwner('a'); projectTabStore.removeOwner('b') })

describe('项目标签扩展点', () => {
  it('登记后带上插件 id，按插件撤掉', () => {
    projectTabRegistry('a').register({ key: 'deals', label: '商单', after: 'tasks', page })
    expect(projectTabStore.list().map((t) => [t.key, t.plugin])).toEqual([['deals', 'a']])
    projectTabStore.removeOwner('a')
    expect(projectTabStore.list()).toEqual([])
  })
  it('同一个 key 不能登记两次', () => {
    projectTabRegistry('a').register({ key: 'deals', label: '商单', page })
    expect(() => projectTabRegistry('b').register({ key: 'deals', label: '又一个', page })).toThrow('项目标签 deals 重复注册')
  })
})
