import { describe, expect, it } from 'vitest'
import { PLUGIN_API_VERSION, deactivatePlugin, discoverPlugins, loadPlugins, moduleStore } from '../../core/plugin'

describe('宽基监控插件', () => {
  it('启用后注册模块 etf（不占交易插件的 monitor），停用后撤掉', async () => {
    const r = await loadPlugins(discoverPlugins(), { enabled: ['etf'], apiVersion: PLUGIN_API_VERSION })
    expect(r.problems).toEqual([])
    expect(r.modules.map((m) => [m.def.id, m.def.label, m.def.path])).toEqual([['etf', '宽基监控', 'etf']])
    expect(r.plugins[0].permissions).toEqual(['network:market-data'])
    expect(r.plugins[0].version).toBe('0.2.0')
    expect(deactivatePlugin('etf')).toBe(true)
    expect(moduleStore.ofOwner('etf')).toEqual([])
  })
})
