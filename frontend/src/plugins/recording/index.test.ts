// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { describe, expect, it } from 'vitest'
import { PLUGIN_API_VERSION, deactivatePlugin, discoverPlugins, loadPlugins, moduleStore, registeredCommands, settingsStore } from '../../core/plugin'

describe('录音转写插件入口', () => {
  it('启用后注册录音模块、设置分节和「开始录音」命令，停用后全部撤掉', async () => {
    const r = await loadPlugins(discoverPlugins(), { enabled: ['recording'], apiVersion: PLUGIN_API_VERSION })
    expect(r.problems).toEqual([])
    expect(r.modules.map((m) => [m.def.id, m.def.label, m.def.path])).toEqual([['recording', '录音', 'recording']])
    expect(settingsStore.ofOwner('recording').map((s) => [s.key, s.label])).toEqual([['recording', '录音转写']])
    const start = registeredCommands().filter((c) => c.id === 'recording.start')
    expect(start.map((c) => [c.group, c.title])).toEqual([['操作', '开始录音']])
    expect(r.plugins[0].permissions).toContain('network:model')

    expect(deactivatePlugin('recording')).toBe(true)
    expect(moduleStore.ofOwner('recording')).toEqual([])
    expect(settingsStore.ofOwner('recording')).toEqual([])
    expect(registeredCommands().some((c) => c.id === 'recording.start')).toBe(false)
  })
})
