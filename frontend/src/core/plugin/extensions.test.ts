import { lazy } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { definePlugin, type PluginApi } from './api'
import { registeredCommands } from './commands'
import {
  defineCoreModule, disposeExtensionsOf, moduleStore, notImplemented, objectTypeView, registerCoreModules, retiredModules,
  settingsStore, sopNodeStore, sopNodeView, sortCards, todayCardStore, type PluginTodayCard,
} from './extensions'
import { PLUGIN_API_VERSION, type PluginManifest } from './manifest'
import { activatePlugin, activePlugins, deactivatePlugin, discoverPlugins, initPlugins, loadPlugins, pluginApi } from './registry'

const state = (enabled: string[]) => ({ enabled, apiVersion: PLUGIN_API_VERSION })
const page = lazy(() => Promise.resolve({ default: () => null }))
const card = () => null

function manifest(extra: Partial<PluginManifest> = {}): PluginManifest {
  return {
    id: 'aa', name: '甲', version: '1.0.0', core: '^1.0.0', permissions: [],
    provides: { modules: ['aa'], settings: ['main'], today_cards: ['aa_due'], object_types: ['aa_item'], commands: ['aa.go'] },
    ...extra,
  }
}

afterEach(() => {
  for (const id of ['aa', 'bb', 'hello', 'im']) deactivatePlugin(id)
  for (const id of ['aa', 'bb']) disposeExtensionsOf(id)
})

describe('扩展点注册', () => {
  it('设置分节、今日卡片、对象类型渲染器按清单检查，带上插件来源，dispose 后撤掉', () => {
    const api = pluginApi(manifest(), [], true)
    const s = api.settings.register({ key: 'main', label: '甲的设置', page })
    const c = api.todayCards.register({ key: 'aa_due', title: '甲的卡片', render: card })
    const t = api.objectTypes.register({ typeId: 'aa_item', summary: () => ({ sub: '副标题' }) })
    expect(settingsStore.list()).toMatchObject([{ key: 'main', label: '甲的设置', plugin: 'aa', pluginName: '甲' }])
    expect(todayCardStore.list()).toMatchObject([{ key: 'aa_due', plugin: 'aa' }])
    expect(objectTypeView('aa_item')?.plugin).toBe('aa')
    s.dispose()
    c.dispose()
    t.dispose()
    expect(settingsStore.list()).toEqual([])
    expect(todayCardStore.list()).toEqual([])
    expect(objectTypeView('aa_item')).toBeUndefined()
  })

  it('不在清单里：严格模式抛错，否则拒绝并记原因', () => {
    const strict = pluginApi(manifest({ provides: {} }), [], true)
    expect(() => strict.settings.register({ key: 'main', label: 'x', page })).toThrow('注册的设置分节 main 不在清单 provides.settings 里')
    expect(() => strict.todayCards.register({ key: 'aa_due', title: 'x', render: card })).toThrow('注册的今日卡片 aa_due 不在清单 provides.today_cards 里')
    expect(() => strict.objectTypes.register({ typeId: 'task' })).toThrow('注册的对象类型 task 不在清单 provides.object_types 或 adopts.object_types 里')
    const reasons: string[] = []
    const loose = pluginApi(manifest({ provides: {} }), reasons, false)
    loose.settings.register({ key: 'main', label: 'x', page })
    loose.modules.register({ id: 'aa', label: 'x', path: 'aa', load: async () => ({ default: () => null }) })
    expect(reasons).toEqual(['注册的设置分节 main 不在清单 provides.settings 里', '注册的模块 aa 不在清单 provides.modules 里'])
    expect(settingsStore.list()).toEqual([])
  })

  it('认领的对象类型也能注册渲染器；同一类型只能有一个', () => {
    pluginApi(manifest({ provides: {}, adopts: { object_types: ['project'] } }), [], true).objectTypes.register({ typeId: 'project' })
    const bb = pluginApi(manifest({ id: 'bb', provides: {}, adopts: { object_types: ['project'] } }), [], true)
    expect(() => bb.objectTypes.register({ typeId: 'project' })).toThrow('对象类型 project 的渲染器已被插件 aa 注册')
  })

  it('插件模块不能标 core', () => {
    const api = pluginApi(manifest(), [], true)
    expect(() => api.modules.register({ id: 'aa', label: 'x', path: 'aa', core: true, load: async () => ({ default: () => null }) }))
      .toThrow('插件模块 aa 不能标 core')
  })

  it('今日卡片按 order 排，没给按 100，同 order 按注册顺序', () => {
    const c = (key: string, order?: number) => ({ key, title: key, order, render: card, plugin: 'aa' }) as PluginTodayCard
    expect(sortCards([c('x'), c('y', 5), c('z'), c('w', 200)]).map((x) => x.key)).toEqual(['y', 'x', 'z', 'w'])
  })
})

describe('SOP 节点（2.7）', () => {
  const node = (kind: string) => ({ kind, label: '发消息', group: '沟通', desc: '往会话里发一条', color: '#0f8a8a', fields: [] })

  it('按清单检查，带上插件来源；dispose、停用插件后撤掉', () => {
    const api = pluginApi(manifest({ provides: { sop_nodes: ['aa_send'] } }), [], true)
    const d = api.sopNodes.register(node('aa_send'))
    expect(sopNodeView('aa_send')).toMatchObject({ label: '发消息', plugin: 'aa' })
    d.dispose()
    expect(sopNodeView('aa_send')).toBeUndefined()
    api.sopNodes.register(node('aa_send'))
    disposeExtensionsOf('aa')
    expect(sopNodeStore.list()).toEqual([])
  })

  it('kind 不在清单里：严格模式抛错写明原因，否则拒绝并记原因', () => {
    const strict = pluginApi(manifest({ provides: { sop_nodes: ['aa_send'] } }), [], true)
    expect(() => strict.sopNodes.register(node('aa_wait'))).toThrow('注册的 SOP 节点 aa_wait 不在清单 provides.sop_nodes 里')
    const reasons: string[] = []
    pluginApi(manifest({ provides: {} }), reasons, false).sopNodes.register(node('aa_send'))
    expect(reasons).toEqual(['注册的 SOP 节点 aa_send 不在清单 provides.sop_nodes 里'])
    expect(sopNodeStore.list()).toEqual([])
  })

  it('同一个 kind 不能注册两次', () => {
    const api = pluginApi(manifest({ provides: { sop_nodes: ['aa_send'] } }), [], true)
    api.sopNodes.register(node('aa_send'))
    expect(() => api.sopNodes.register(node('aa_send'))).toThrow('SOP 节点 aa_send 已被插件 aa 注册')
  })

  it('真实的 IM 插件登记发消息、等待回复、读取消息、标记消息，不依赖 SOP 插件；停用后消失', async () => {
    const r = await loadPlugins(discoverPlugins(), state(['im']))
    expect(r.problems).toEqual([])
    expect(sopNodeStore.list().map((v) => [v.kind, v.label, v.plugin])).toEqual([
      ['im_send_message', '发消息', 'im'], ['im_wait_reply', '等待回复', 'im'], ['im_get_message', '读取消息', 'im'], ['im_mark_message', '标记消息', 'im'],
    ])
    expect(sopNodeView('im_send_message')?.fields.map((f) => f.key)).toEqual(['conversation', 'text'])
    expect(sopNodeView('im_wait_reply')?.fields.map((f) => f.key)).toEqual(['conversation', 'timeout'])
    expect(sopNodeView('im_get_message')?.fields.map((f) => f.key)).toEqual(['message'])
    expect(sopNodeView('im_mark_message')?.fields.map((f) => [f.key, f.required ?? false])).toEqual([['state', true], ['message', false]])
    deactivatePlugin('im')
    expect(sopNodeStore.list()).toEqual([])
  })
})

describe('没实现的扩展点', () => {
  it('调用就抛出明确的错误，不当 thenable', () => {
    const api = pluginApi(manifest(), [], true)
    expect(() => api.connectors.register({ tool: 'slack', label: 'Slack', color: '', category: 'im', desc: '', fields: [] }))
      .toThrow('插件 API 的 connectors.register 还没实现（docs/plugin-api.md 2.5）')
    expect(() => api.events.on('object.created', () => {})).toThrow('插件 API 的 events.on 还没实现（docs/plugin-api.md 2.10）')
    expect(() => api.agent.registerToolView({ name: 'aa_x', label: 'x' })).toThrow('agent.registerToolView 还没实现')
    expect(() => api.migrations.list()).toThrow('migrations.list 还没实现（docs/plugin-api.md 2.4）')
    expect((notImplemented<object>('x', '2.0') as { then?: unknown }).then).toBeUndefined()
  })

  it('activate 里用到时插件加载失败并写明原因，已注册的一起撤掉', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const entry = definePlugin({
      activate(api: PluginApi) {
        api.settings.register({ key: 'main', label: 'x', page })
        api.events.on('object.created', () => {})
      },
    })
    const r = await loadPlugins([{ id: 'aa', manifest: manifest(), load: async () => ({ default: entry }) }], state(['aa']))
    expect(r.problems).toEqual([{ id: 'aa', name: '甲', reasons: ['加载失败：插件 API 的 events.on 还没实现（docs/plugin-api.md 2.10）'] }])
    expect(settingsStore.list()).toEqual([])
    expect(activePlugins()).not.toContain('aa')
    vi.restoreAllMocks()
  })
})

describe('真实的 hello 插件', () => {
  it('注册模块、命令、设置分节和今日卡片；停用后全部撤掉，并调 deactivate', async () => {
    const r = await loadPlugins(discoverPlugins(), state(['hello']))
    expect(r.problems).toEqual([])
    expect(settingsStore.list()).toMatchObject([{ key: 'hello', label: '示例插件', plugin: 'hello' }])
    expect(todayCardStore.list()).toMatchObject([{ key: 'hello_greeting', title: '示例插件', plugin: 'hello' }])
    expect(registeredCommands().map((c) => c.id)).toContain('hello.open')
    expect(moduleStore.ofOwner('hello').map((m) => m.id)).toEqual(['hello'])
    expect(activePlugins()).toContain('hello')

    expect(deactivatePlugin('hello')).toBe(true)
    expect(settingsStore.list()).toEqual([])
    expect(todayCardStore.list()).toEqual([])
    expect(registeredCommands().map((c) => c.id)).not.toContain('hello.open')
    expect(retiredModules().has('hello')).toBe(true)
    expect(deactivatePlugin('hello')).toBe(false)

    // 再启用：模块回来，不注册两份
    await loadPlugins(discoverPlugins(), state(['hello']))
    await loadPlugins(discoverPlugins(), state(['hello']))
    expect(retiredModules().has('hello')).toBe(false)
    expect(settingsStore.list()).toHaveLength(1)
  })

  it('deactivate 钩子被调用', async () => {
    const off = vi.fn()
    const entry = definePlugin({ activate: (api) => void api.modules.register({ id: 'aa', label: 'x', path: 'aa', load: async () => ({ default: () => null }) }), deactivate: off })
    await loadPlugins([{ id: 'aa', manifest: manifest(), load: async () => ({ default: entry }) }], state(['aa']))
    deactivatePlugin('aa')
    expect(off).toHaveBeenCalledOnce()
    expect(retiredModules().has('aa')).toBe(true)
  })
})

describe('activatePlugin', () => {
  const mod = { id: 'aa', label: 'x', path: 'aa', load: async () => ({ default: () => null }) }
  const aa = definePlugin({ activate: (api) => void api.modules.register(mod) })
  const src = (extra: Partial<PluginManifest> = {}) => ({ id: 'aa', manifest: manifest(extra), load: async () => ({ default: aa }) })

  // 后端列表为空时示例插件 hello 按 enabled.ts 加载，启动时就建了路由
  async function boot() {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: [] }))))
    try {
      await initPlugins([])
    } finally {
      vi.unstubAllGlobals()
    }
  }

  it('停用后再启用：模块回到菜单；启动时就有路由，不用整页重新加载；已在跑的不重复加载', async () => {
    await boot()
    deactivatePlugin('hello')
    expect(retiredModules().has('hello')).toBe(true)
    expect(await activatePlugin('hello')).toEqual({ ok: true, reload: false })
    expect(retiredModules().has('hello')).toBe(false)
    expect(activePlugins()).toContain('hello')
    expect(await activatePlugin('hello')).toEqual({ ok: true, reload: false })
    expect(settingsStore.list().filter((x) => x.plugin === 'hello')).toHaveLength(1)
  })

  it('启动时没建路由的插件模块：启用后要整页重新加载', async () => {
    await boot()
    expect(await activatePlugin('aa', [src()])).toEqual({ ok: true, reload: true })
    expect(moduleStore.ofOwner('aa').map((m) => m.id)).toEqual(['aa'])
  })

  it('依赖没启用、清单不合法、加载出错时不加载并给原因；没有前端入口的直接算成功', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const dep = await activatePlugin('aa', [src({ depends: { bb: '^1.0.0' } })])
    expect(dep.ok).toBe(false)
    expect(activePlugins()).not.toContain('aa')
    expect(await activatePlugin('aa', [{ id: 'aa', manifest: { id: 'aa' }, load: src().load }])).toMatchObject({ ok: false })
    expect(await activatePlugin('aa', [{ ...src(), load: () => Promise.reject(new Error('断了')) }])).toEqual({ ok: false, reasons: ['加载失败：断了'] })
    expect(await activatePlugin('aa', [{ id: 'aa', manifest: manifest() }])).toEqual({ ok: true, reload: false })
    expect(await activatePlugin('ghost', [])).toEqual({ ok: true, reload: false })
  })
})

describe('内核模块', () => {
  it('defineCoreModule 标 core，登记进模块注册表；不能停用', () => {
    const today = defineCoreModule({ id: 'today', label: '今日', path: 'today', load: async () => ({ default: () => null }) })
    expect(today.core).toBe(true)
    registerCoreModules([today])
    registerCoreModules([today])
    expect(moduleStore.ofOwner('core').filter((m) => m.id === 'today')).toHaveLength(1)
    expect(() => deactivatePlugin('today')).toThrow('today 是内核模块，不能停用')
    expect(() => deactivatePlugin('core')).toThrow('core 是内核模块，不能停用')
    expect(() => registerCoreModules([{ id: 'x', label: 'x', path: 'x', load: today.load }])).toThrow('内核模块 x 没有标 core')
  })

  it('真实的内核模块清单全部标了 core', async () => {
    const mods = await Promise.all(['today', 'tasks', 'docs', 'contacts', 'conversations', 'settings'].map((d) => import(`../../modules/${d}/index.ts`)))
    expect(mods.map((m) => [m.module.id, m.module.core])).toEqual([
      ['today', true], ['tasks', true], ['docs', true], ['contacts', true], ['conversations', true], ['settings', true],
    ])
  })
})
