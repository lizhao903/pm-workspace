// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { describe, expect, it } from 'vitest'
import { discoverPlugins, loadPlugins, PLUGIN_API_VERSION, type PluginManifest } from '../../core/plugin'
import { buildMenu } from '../../core/shell/menu'
import { enabledPlugins } from '../enabled'

describe('项目插件', () => {
  it('清单读后端那一份，入口在前端', () => {
    const p = discoverPlugins().find((s) => s.id === 'projects')
    expect(p).toBeDefined()
    expect((p!.manifest as PluginManifest).name).toBe('项目')
    expect(typeof p!.load).toBe('function')
  })

  it('有后端记录，不进本地回退列表', () => {
    expect(enabledPlugins).not.toContain('projects')
  })

  it('启用后注册出「项目」模块，放在「工作」组', async () => {
    const r = await loadPlugins(discoverPlugins(), { enabled: ['projects'], apiVersion: PLUGIN_API_VERSION })
    expect(r.problems).toEqual([])
    expect(r.modules.map((m) => m.def)).toMatchObject([{ id: 'projects', label: '项目', path: 'projects' }])
    const work = buildMenu(r.modules.map((m) => m.def)).groups.find((g) => g.id === 'work')
    expect(work?.items.map((m) => m.id)).toEqual(['projects'])
  })

  it('没启用时不加载', async () => {
    const r = await loadPlugins(discoverPlugins(), { enabled: [], apiVersion: PLUGIN_API_VERSION })
    expect(r.modules).toEqual([])
  })
})

describe('今日「正在运行」的原型行', () => {
  it('外部启动的也列出来，端口后面注明；本插件起的只写端口', async () => {
    const { todayProtoItem } = await import('./index')
    expect(todayProtoItem('一人之下控制台', { id: 'pt_1', name: '原型站点', port: 7778, status: 'external' })).toEqual({
      id: 'pt_1', tone: 'ok', title: '一人之下控制台 / 原型站点', sub: ':7778 · 外部启动', href: 'http://127.0.0.1:7778',
    })
    expect(todayProtoItem('甲', { id: 'pt_2', name: '看板', port: 8101, status: 'running' }).sub).toBe(':8101')
  })
})
