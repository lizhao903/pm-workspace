import { describe, expect, it } from 'vitest'
import { PLUGIN_API_VERSION, deactivatePlugin, discoverPlugins, loadPlugins, moduleStore } from '../../core/plugin'

describe('交易套件插件', () => {
  it('启用后注册行情、盯盘、策略、交易四个模块，停用后全部撤掉', async () => {
    const r = await loadPlugins(discoverPlugins(), { enabled: ['trade'], apiVersion: PLUGIN_API_VERSION })
    expect(r.problems).toEqual([])
    expect(r.modules.map((m) => [m.def.id, m.def.label, m.def.path])).toEqual([
      ['markets', '行情', 'markets'],
      ['monitor', '盯盘', 'monitor'],
      ['strategy', '策略', 'strategy'],
      ['trading', '交易', 'trading'],
    ])
    expect(r.plugins[0].permissions).toEqual(['network:market-data', 'network:exchanges'])
    expect(deactivatePlugin('trade')).toBe(true)
    expect(moduleStore.ofOwner('trade')).toEqual([])
  })
})
