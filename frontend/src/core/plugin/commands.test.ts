import { afterEach, describe, expect, it } from 'vitest'
import { definePlugin } from './api'
import { commandProviders, commandRegistry, disposeCommandsOf, registerCoreSearch, registeredCommands, type CommandDef } from './commands'
import { PLUGIN_API_VERSION } from './manifest'
import { loadPlugins } from './registry'

const cmd = (id: string): CommandDef => ({ id, group: '操作', title: id, run: () => {} })

afterEach(() => {
  for (const id of ['aa', 'bb']) disposeCommandsOf(id)
})

describe('commandRegistry', () => {
  it('清单里有的命令能注册，dispose 后撤掉', () => {
    const r = commandRegistry('aa', { commands: ['aa.one'] }, [], true)
    const d = r.register(cmd('aa.one'))
    expect(registeredCommands().map((c) => c.id)).toEqual(['aa.one'])
    d.dispose()
    expect(registeredCommands()).toEqual([])
  })

  it('不在清单里：严格模式抛错，否则拒绝并记原因', () => {
    expect(() => commandRegistry('aa', {}, [], true).register(cmd('aa.x'))).toThrow('注册的命令 aa.x 不在清单 provides.commands 里')
    const reasons: string[] = []
    commandRegistry('aa', { commands: ['aa.one'] }, reasons, false).register(cmd('aa.x'))
    expect(reasons).toEqual(['注册的命令 aa.x 不在清单 provides.commands 里'])
    expect(registeredCommands()).toEqual([])
  })

  it('内核数据源不经清单，同名只收第一个，dispose 后撤掉', () => {
    const before = commandProviders().length
    const d = registerCoreSearch('zz-test', async () => [])
    registerCoreSearch('zz-test', async () => [cmd('x')])
    expect(commandProviders().filter((p) => p.source === 'zz-test')).toHaveLength(1)
    expect(commandProviders().find((p) => p.source === 'zz-test')?.owner).toBe('core')
    d.dispose()
    expect(commandProviders()).toHaveLength(before)
  })

  it('数据源按 provides.search 检查；disposeCommandsOf 只撤这个插件的', () => {
    const fn = async () => [cmd('aa.hit')]
    commandRegistry('aa', { commands: ['aa.one'], search: ['aa_items'] }, [], true).provide('aa_items', fn)
    commandRegistry('aa', { commands: ['aa.one'] }, [], true).register(cmd('aa.one'))
    commandRegistry('bb', { commands: ['bb.one'] }, [], true).register(cmd('bb.one'))
    expect(() => commandRegistry('aa', {}, [], true).provide('nope', fn)).toThrow('注册的搜索数据源 nope 不在清单 provides.search 里')
    expect(commandProviders().map((p) => p.source)).toEqual(['aa_items'])
    disposeCommandsOf('aa')
    expect(commandProviders()).toEqual([])
    expect(registeredCommands().map((c) => c.id)).toEqual(['bb.one'])
  })
})

describe('loadPlugins 接上 api.commands', () => {
  const manifest = (id: string, commands: string[]) => ({
    id, name: id, version: '0.1.0', core: '^1.0.0', provides: { commands }, permissions: [],
  })
  const state = (enabled: string[]) => ({ enabled, apiVersion: PLUGIN_API_VERSION })

  it('插件注册的命令进注册表', async () => {
    const entry = definePlugin({ activate: (api) => { api.commands.register(cmd('aa.go')) } })
    const r = await loadPlugins([{ id: 'aa', manifest: manifest('aa', ['aa.go']), load: async () => ({ default: entry }) }], state(['aa']))
    expect(r.problems).toEqual([])
    expect(registeredCommands().map((c) => c.id)).toEqual(['aa.go'])
  })

  it('activate 中途出错：已注册的命令一起撤掉', async () => {
    const entry = definePlugin({
      activate: (api) => {
        api.commands.register(cmd('aa.go'))
        throw new Error('坏了')
      },
    })
    const r = await loadPlugins([{ id: 'aa', manifest: manifest('aa', ['aa.go']), load: async () => ({ default: entry }) }], state(['aa']))
    expect(r.problems[0].reasons).toEqual(['加载失败：坏了'])
    expect(registeredCommands()).toEqual([])
  })
})
