import { describe, expect, it, vi } from 'vitest'
import type { ModuleDef } from './index'
import { definePlugin, type PluginEntry } from './api'
import { PLUGIN_API_VERSION, type PluginManifest } from './manifest'
import { discoverPlugins, fetchPluginState, loadPlugins, mergeModules, resolvePlugins, type PluginSource } from './registry'

const state = (enabled: string[], apiVersion = PLUGIN_API_VERSION) => ({ enabled, apiVersion })

function manifest(id: string, extra: Partial<PluginManifest> = {}): PluginManifest {
  return { id, name: id + ' 插件', version: '1.0.0', core: '^1.0.0', provides: { modules: [id] }, permissions: [], ...extra }
}

const page = () => Promise.resolve({ default: () => null })

// 入口只注册一个和插件同名的模块
function entry(id: string): () => Promise<{ default: PluginEntry }> {
  return () => Promise.resolve({
    default: definePlugin({ activate: (api) => void api.modules.register({ id, label: id, path: id, load: page }) }),
  })
}

function src(id: string, extra: Partial<PluginManifest> = {}): PluginSource {
  return { id, manifest: manifest(id, extra), load: entry(id) }
}

const reasons = (r: { problems: { id: string; reasons: string[] }[] }, id: string) =>
  r.problems.find((p) => p.id === id)?.reasons ?? []

describe('discoverPlugins', () => {
  it('找到 src/plugins 下的 hello，清单是数据、入口是懒加载函数', () => {
    const hello = discoverPlugins().find((s) => s.id === 'hello')
    expect(hello).toBeDefined()
    expect((hello!.manifest as PluginManifest).provides.modules).toEqual(['hello'])
    expect(typeof hello!.load).toBe('function')
  })

  it('本地启用列表里有 hello', async () => {
    expect((await fetchPluginState()).enabled).toContain('hello')
  })
})

describe('resolvePlugins', () => {
  it('按启用列表的顺序挑，没启用的不要', () => {
    const r = resolvePlugins([src('aa'), src('bb'), src('cc')], state(['cc', 'aa', 'cc']))
    expect(r.ok.map((m) => m.id)).toEqual(['cc', 'aa'])
    expect(r.problems).toEqual([])
  })

  it('依赖一个不存在的插件：不加载，给出原因', () => {
    const r = resolvePlugins([src('aa', { depends: { nope: '^1.0.0' } })], state(['aa']))
    expect(r.ok).toEqual([])
    expect(r.problems).toEqual([{ id: 'aa', name: 'aa 插件', reasons: ['depends.nope 依赖的插件不存在'] }])
  })

  it('依赖版本不符不加载', () => {
    const r = resolvePlugins([src('aa', { depends: { bb: '^2.0.0' } }), src('bb')], state(['aa', 'bb']))
    expect(r.ok.map((m) => m.id)).toEqual(['bb'])
    expect(reasons(r, 'aa')).toEqual(['depends.bb 要求 ^2.0.0，已有版本 1.0.0'])
  })

  it('依赖装了但没启用，以及被拦下的插件连带拦下依赖它的', () => {
    const sources = [src('aa', { depends: { bb: '^1.0.0' } }), src('bb', { depends: { cc: '^1.0.0' } }), src('cc')]
    const r = resolvePlugins(sources, state(['aa', 'bb']))
    expect(r.ok).toEqual([])
    expect(reasons(r, 'bb')).toEqual(['depends.cc 依赖的插件没有启用或没能加载'])
    expect(reasons(r, 'aa')).toEqual(['depends.bb 依赖的插件没有启用或没能加载'])
  })

  it('core 范围不包含当前插件 API 版本不加载', () => {
    const r = resolvePlugins([src('aa', { core: '^2.0.0' })], state(['aa']))
    expect(reasons(r, 'aa')).toEqual([`core 不包含当前插件 API 版本 ${PLUGIN_API_VERSION}：^2.0.0`])
  })

  it('启用列表里没有的插件、缺清单、清单不合法、id 和目录不符、缺入口', () => {
    const sources: PluginSource[] = [
      { id: 'noman', manifest: undefined, load: entry('noman') },
      { id: 'bad', manifest: { id: 'bad' }, load: entry('bad') },
      { id: 'dir', manifest: manifest('other'), load: entry('dir') },
      { id: 'noentry', manifest: manifest('noentry') },
    ]
    const r = resolvePlugins(sources, state(['ghost', 'noman', 'bad', 'dir', 'noentry']))
    expect(r.ok).toEqual([])
    expect(reasons(r, 'ghost')).toEqual(['没有这个插件'])
    expect(reasons(r, 'noman')).toEqual(['缺少清单 plugin.json'])
    expect(reasons(r, 'bad')).toContain('清单 name 必填')
    expect(reasons(r, 'dir')).toEqual(['清单 id 是 other，和目录名 dir 不一致'])
    expect(reasons(r, 'noentry')).toEqual(['缺少入口 index.ts'])
  })
})

describe('loadPlugins', () => {
  it('只加载启用且检查通过的插件的入口', async () => {
    const used = vi.fn(entry('aa'))
    const unused = vi.fn(entry('bb'))
    const blocked = vi.fn(entry('cc'))
    const r = await loadPlugins(
      [{ ...src('aa'), load: used }, { ...src('bb'), load: unused }, { ...src('cc', { depends: { nope: '^1.0.0' } }), load: blocked }],
      state(['aa', 'cc']),
    )
    expect(used).toHaveBeenCalledOnce()
    expect(unused).not.toHaveBeenCalled()
    expect(blocked).not.toHaveBeenCalled()
    expect(r.modules.map((m) => [m.plugin.id, m.def.id])).toEqual([['aa', 'aa']])
    expect(r.problems.map((p) => p.id)).toEqual(['cc'])
  })

  // 页面在 Shell.test.tsx 里渲染，这里是 node 环境，不加载页面
  it('真实的 hello 插件注册出 hello 模块', async () => {
    const r = await loadPlugins(discoverPlugins(), state(['hello']))
    expect(r.problems).toEqual([])
    expect(r.modules.map((m) => m.def)).toMatchObject([{ id: 'hello', label: '示例插件', path: 'hello' }])
  })

  it('入口加载失败或 activate 抛错只影响这个插件', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const r = await loadPlugins(
      [
        { ...src('aa'), load: () => Promise.reject(new Error('网络断了')) },
        { ...src('bb'), load: () => Promise.resolve({ default: { activate: () => { throw new Error('坏了') } } }) },
        src('cc'),
      ],
      state(['aa', 'bb', 'cc']),
    )
    expect(r.modules.map((m) => m.def.id)).toEqual(['cc'])
    expect(reasons(r, 'aa')).toEqual(['加载失败：网络断了'])
    expect(reasons(r, 'bb')).toEqual(['加载失败：坏了'])
  })

  it('注册清单 provides.modules 之外的模块：开发环境抛错', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const r = await loadPlugins([{ ...src('aa'), load: entry('zz') }], state(['aa']))
    expect(r.modules).toEqual([])
    expect(reasons(r, 'aa')).toEqual(['加载失败：注册的模块 zz 不在清单 provides.modules 里'])
  })
})

describe('mergeModules', () => {
  const mod = (id: string, path = id): ModuleDef => ({ id, label: id, path, load: page })

  it('插件模块接在内核模块后面，id 或路径撞了的不要', () => {
    const plugin = manifest('aa')
    const problems: { id: string; reasons: string[] }[] = []
    const out = mergeModules([mod('today'), mod('tasks')], [
      { plugin, def: mod('aa') },
      { plugin, def: mod('tasks', 'x') },
      { plugin, def: mod('bb', 'today') },
    ], problems)
    expect(out.map((m) => m.id)).toEqual(['today', 'tasks', 'aa'])
    expect(problems.flatMap((p) => p.reasons)).toEqual([
      '模块 tasks 和已有的模块 tasks 冲突，没有加进菜单',
      '模块 bb 和已有的模块 today 冲突，没有加进菜单',
    ])
  })
})
