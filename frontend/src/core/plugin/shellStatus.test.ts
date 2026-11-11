// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { afterEach, describe, expect, it } from 'vitest'
import { shellStatusRegistry, shellStatusStore, sortShellStatus, type PluginShellStatus } from './shellStatus'

const Comp = () => null
const item = (key: string, order?: number): PluginShellStatus => ({ key, order, render: Comp, plugin: 'aa' })

afterEach(() => {
  shellStatusStore.removeOwner('aa')
  shellStatusStore.removeOwner('bb')
})

describe('外壳状态条（shellStatus）', () => {
  it('注册带上插件来源，dispose 后撤掉', () => {
    const d = shellStatusRegistry('aa').register({ key: 'recorder', render: Comp })
    expect(shellStatusStore.list()).toMatchObject([{ key: 'recorder', plugin: 'aa' }])
    d.dispose()
    expect(shellStatusStore.list()).toEqual([])
  })

  it('同一插件 key 不能重复，不同插件可以重名', () => {
    shellStatusRegistry('aa').register({ key: 'recorder', render: Comp })
    expect(() => shellStatusRegistry('aa').register({ key: 'recorder', render: Comp })).toThrow('外壳状态 recorder 重复注册')
    shellStatusRegistry('bb').register({ key: 'recorder', render: Comp })
    expect(shellStatusStore.list()).toHaveLength(2)
  })

  it('按 order 排，没给按 100，同 order 按注册顺序', () => {
    expect(sortShellStatus([item('x'), item('y', 5), item('z'), item('w', 200)]).map((s) => s.key)).toEqual(['y', 'x', 'z', 'w'])
  })
})
