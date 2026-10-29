import { describe, expect, it } from 'vitest'
import { PLUGIN_API_VERSION, deactivatePlugin, discoverPlugins, loadPlugins, moduleStore } from '../../core/plugin'

describe('视频创作插件', () => {
  it('启用后注册视频模块，停用后撤掉', async () => {
    const r = await loadPlugins(discoverPlugins(), { enabled: ['projects', 'video'], apiVersion: PLUGIN_API_VERSION })
    expect(r.problems).toEqual([])
    const video = r.plugins.find((p) => p.id === 'video')!
    expect(video.permissions).toEqual(['fs:read:project', 'fs:write:project', 'network:media-platforms', 'process:spawn'])
    expect(r.modules.filter((m) => m.plugin.id === 'video').map((m) => [m.def.id, m.def.label, m.def.path])).toEqual([['videos', '视频', 'videos']])
    expect(deactivatePlugin('video')).toBe(true)
    expect(moduleStore.ofOwner('video')).toEqual([])
    deactivatePlugin('projects')
  })

  it('只启用 video 不启用 projects 时不加载，提示缺依赖', async () => {
    const r = await loadPlugins(discoverPlugins(), { enabled: ['video'], apiVersion: PLUGIN_API_VERSION })
    expect(r.modules.filter((m) => m.plugin.id === 'video')).toEqual([])
    expect(r.problems.some((p) => p.id === 'video')).toBe(true)
  })
})
