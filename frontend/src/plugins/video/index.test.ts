import { describe, expect, it } from 'vitest'
import { PLUGIN_API_VERSION, deactivatePlugin, discoverPlugins, loadPlugins, moduleStore, sopNodeView, todayCardStore } from '../../core/plugin'

describe('视频创作插件', () => {
  it('启用后注册视频模块，停用后撤掉', async () => {
    const r = await loadPlugins(discoverPlugins(), { enabled: ['projects', 'video'], apiVersion: PLUGIN_API_VERSION })
    expect(r.problems).toEqual([])
    const video = r.plugins.find((p) => p.id === 'video')!
    expect(video.permissions).toEqual(['fs:read:project', 'fs:write:project', 'network:media-platforms', 'process:spawn'])
    expect(r.modules.filter((m) => m.plugin.id === 'video').map((m) => [m.def.id, m.def.label, m.def.path])).toEqual([['videos', '视频', 'videos']])
    // SOP 节点的展示：名字给流程图用，阶段、检查点按带不带检查点分开
    expect(sopNodeView('video_run_stage')?.label).toBe('跑视频阶段')
    expect(sopNodeView('video_wait_checkpoint')?.fields.find((f) => f.key === 'checkpoint')?.options?.().map((o) => o.value)).toEqual(['plan', 'ch1', 'audio', 'distribution'])
    expect(sopNodeView('video_run_stage')?.fields.find((f) => f.key === 'stage')?.options?.().map((o) => o.label)).not.toContain('规划检查')
    // 今日卡片：视频三张和商单一张，停用后都撤掉（VID-07b）
    const cards = () => todayCardStore.ofOwner('video').map((c) => c.key)
    expect(cards()).toEqual(['video_waiting', 'video_scheduled', 'video_failed', 'video_deal_due'])
    expect(deactivatePlugin('video')).toBe(true)
    expect(moduleStore.ofOwner('video')).toEqual([])
    expect(sopNodeView('video_run_stage')).toBeUndefined()
    expect(cards()).toEqual([])
    // 重新启用后又出现
    await loadPlugins(discoverPlugins(), { enabled: ['projects', 'video'], apiVersion: PLUGIN_API_VERSION })
    expect(cards()).toHaveLength(4)
    deactivatePlugin('video')
    deactivatePlugin('projects')
  })

  it('只启用 video 不启用 projects 时不加载，提示缺依赖', async () => {
    const r = await loadPlugins(discoverPlugins(), { enabled: ['video'], apiVersion: PLUGIN_API_VERSION })
    expect(r.modules.filter((m) => m.plugin.id === 'video')).toEqual([])
    expect(r.problems.some((p) => p.id === 'video')).toBe(true)
  })
})
