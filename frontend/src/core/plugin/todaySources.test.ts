// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { afterEach, describe, expect, it } from 'vitest'
import type { PluginManifest } from './manifest'
import { pluginApi } from './registry'
import { todaySourceStore } from './todaySources'

const manifest: PluginManifest = { id: 'aa', name: '甲', version: '1.0.0', core: '^1.0.0', permissions: [], provides: {} }
const def = { key: 'pending', slot: 'need' as const, label: '甲的组', order: 40, queryKey: ['aa'], queryFn: async () => 1, select: () => ({ total: 0, items: [] }) }

afterEach(() => { todaySourceStore.removeOwner('aa') })

describe('今日来源', () => {
  it('不查清单，带上插件来源；dispose 后撤掉，同一插件同 key 不能重复注册', () => {
    const api = pluginApi(manifest, [], true)
    const d = api.todaySources.register(def)
    expect(todaySourceStore.list().map((s) => [s.plugin, s.key])).toEqual([['aa', 'pending']])
    expect(() => api.todaySources.register(def)).toThrow('今日来源 pending 重复注册')
    d.dispose()
    expect(todaySourceStore.list()).toEqual([])
  })
})
