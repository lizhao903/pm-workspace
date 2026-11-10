// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { lazy } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { sessionToolRegistry, sessionToolStore, sortSessionTools } from './sessionTools'

const panel = lazy(async () => ({ default: () => null }))
const icon = () => null

afterEach(() => { sessionToolStore.removeOwner('a'); sessionToolStore.removeOwner('b') })

describe('会话旁边的工具扩展点（SPEC-sessions-1.34）', () => {
  it('按 order 排，同 order 按登记顺序；按插件撤掉', () => {
    sessionToolRegistry('b').register({ key: 'browser', label: '浏览器', icon, order: 20, panel })
    sessionToolRegistry('a').register({ key: 'terminal', label: '终端', icon, order: 10, panel })
    sessionToolRegistry('a').register({ key: 'x', label: 'X', icon, panel })
    expect(sortSessionTools(sessionToolStore.list()).map((t) => `${t.plugin}:${t.key}`)).toEqual(['a:terminal', 'b:browser', 'a:x'])
    sessionToolStore.removeOwner('a')
    expect(sortSessionTools(sessionToolStore.list()).map((t) => t.key)).toEqual(['browser'])
  })
  it('key 全局唯一', () => {
    sessionToolRegistry('a').register({ key: 'terminal', label: '终端', icon, panel })
    expect(() => sessionToolRegistry('b').register({ key: 'terminal', label: '终端', icon, panel })).toThrow('会话工具 terminal 重复注册')
  })
})
