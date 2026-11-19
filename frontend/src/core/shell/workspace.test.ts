// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { describe, expect, it } from 'vitest'
import { splitVideoModules, type PluginInfo, type Workspace } from '../data'
import type { ModuleDef } from '../plugin'
import { buildMenu, isGroupFolded } from './menu'
import {
  CATALOG_IDS, homeModule, missingPlugins, missingText, moduleIdOf, moduleKeyOf, pluginOfModule, pluginsForModules, resolveCurrent, workspaceMenuGroups,
} from './workspace'

const plugin = (id: string, over: Partial<PluginInfo> = {}) => ({ id, name: id === 'projects' ? '项目' : id, installed: false, running: false, ...over }) as PluginInfo
const mod = (id: string): ModuleDef => ({ id, label: id, path: id, load: async () => ({ default: () => null }) })

// 和 0023 的交易工作台一致
const trader = {
  id: 'ws_trader', name: '交易工作台', role: '交易员', home: 'markets',
  groups: [
    { id: 'g1', name: '', modules: ['today'], collapsed: false },
    { id: 'g2', name: '行情', modules: ['markets', 'monitor'], collapsed: false },
    { id: 'g3', name: '策略与执行', modules: ['strategy', 'trading'], collapsed: true },
    { id: 'g4', name: '资讯', modules: ['messages', 'library', 'browser'], collapsed: false },
    { id: 'g5', name: '工具', modules: ['tasks', 'sessions', 'terminal'], collapsed: false },
  ],
  modules: ['today', 'markets', 'monitor', 'strategy', 'trading', 'messages', 'library', 'browser', 'tasks', 'sessions', 'terminal'],
  plugins: ['markets', 'monitor', 'strategy', 'trading', 'im', 'browser', 'terminal'],
} as Workspace

describe('缺哪些插件', () => {
  it('交易工作台：0023 按模块 key 记的四个交易模块认成插件 trade，合成一行', () => {
    const m = missingPlugins(trader.plugins, [plugin('projects'), plugin('trade', { name: '交易套件', installed: true })])
    expect(m[0]).toEqual({ id: 'trade', name: '交易套件', state: 'disabled' })
    expect(missingText(m[0])).toBe('交易套件：已安装未启用')
    expect(m.map((x) => x.id)).toEqual(['trade', 'im', 'browser', 'terminal'])
  })

  it('视频、交易插件在跑时不算缺；后端插件列表里没有的才算尚未提供', () => {
    const list = [
      plugin('video', { installed: true, running: true, provides: { modules: ['videos'] } }),
      plugin('trade', { installed: true, running: true, provides: { modules: ['markets', 'monitor', 'strategy', 'trading'] } }),
    ]
    expect(missingPlugins(['videos', 'markets', 'monitor', 'strategy', 'trading', 'video', 'trade'], list)).toEqual([])
    expect(missingPlugins(['markets', 'browser'], []).map(missingText)).toEqual(['交易套件：尚未提供', '浏览器：尚未提供'])
  })

  it('清单里有的按装没装、在没在跑分；在跑的不算缺', () => {
    const list = [plugin('projects'), plugin('im', { name: 'IM', installed: true }), plugin('sop', { installed: true, running: true })]
    expect(missingPlugins(['projects', 'im', 'sop'], list).map((x) => [x.name, x.state])).toEqual([['项目', 'not-installed'], ['IM', 'disabled']])
    expect(missingPlugins([], list)).toEqual([])
  })
})

describe('模块和插件', () => {
  it('需要的插件按清单 provides.modules 推：内核模块不要插件，IM 消息要 im，视频要 video，交易四个模块都要 trade', () => {
    expect(pluginsForModules(['today', 'tasks', 'library', 'messages', 'projects', 'sessions', 'contacts', 'projects'])).toEqual(['im', 'projects'])
    expect(pluginsForModules(['videos', 'markets', 'monitor', 'strategy', 'trading', 'browser'])).toEqual(['video', 'trade', 'browser'])
    expect(pluginOfModule('markets', [plugin('quotes', { provides: { modules: ['markets'] } })])).toBe('quotes')
    expect(pluginOfModule('today')).toBeNull()
  })

  it('宽基监控是插件 etf 的模块 etf，盯盘 monitor 仍归交易插件 trade（ETF-01b）', () => {
    expect(pluginOfModule('etf')).toBe('etf')
    expect(pluginOfModule('monitor')).toBe('trade')
    expect(pluginsForModules(['markets', 'monitor', 'etf'])).toEqual(['trade', 'etf'])
    expect(CATALOG_IDS.has('etf')).toBe(true)
  })

  it('后端的 library、sessions 对应前端的文档、会话', () => {
    expect(moduleIdOf('library')).toBe('docs')
    expect(moduleIdOf('sessions')).toBe('conversations')
    expect(moduleKeyOf('docs')).toBe('library')
    expect(moduleIdOf('projects')).toBe('projects')
  })

  it('默认模块的插件没在跑时落到第一个能打开的', () => {
    expect(homeModule(trader, ['today', 'tasks'].map(mod))?.id).toBe('today')
    expect(homeModule(trader, ['tasks', 'markets'].map(mod))?.id).toBe('markets')
  })

  it('记的工作台没了落到列表第一个', () => {
    const list = [{ id: 'a' }, { id: 'b' }]
    expect(resolveCurrent(list, 'b')?.id).toBe('b')
    expect(resolveCurrent(list, 'gone')?.id).toBe('a')
    expect(resolveCurrent(undefined, 'a')).toBeUndefined()
  })
})

describe('按工作台出菜单', () => {
  it('分组和顺序照工作台；缺插件的模块不出现；目录里的模块不进「未分组」，目录外的插件模块进', () => {
    const live = ['today', 'tasks', 'docs', 'contacts', 'conversations', 'settings', 'hello'].map(mod)
    const m = buildMenu(live, workspaceMenuGroups(trader), CATALOG_IDS)
    expect(m.groups.map((g) => [g.name, g.items.map((x) => x.id)])).toEqual([
      ['', ['today']],
      ['资讯', ['docs']],
      ['工具', ['tasks', 'conversations']],
      ['未分组', ['hello']],
    ])
    expect(m.groups.map((g) => g.id).slice(0, 3)).toEqual(['ws_trader:g1', 'ws_trader:g4', 'ws_trader:g5'])
    expect(m.foot.map((x) => x.id)).toEqual(['settings'])
  })

  it('默认折叠的组本地点一次就展开，没设的点一次折起', () => {
    const g = { id: 'ws:g3', name: '策略', collapsed: true }
    expect(isGroupFolded(g, [])).toBe(true)
    expect(isGroupFolded(g, ['ws:g3'])).toBe(false)
    expect(isGroupFolded({ id: 'x', name: '工作' }, ['x'])).toBe(true)
    expect(isGroupFolded({ id: 'x', name: '' , collapsed: true }, [])).toBe(false)
  })
})

describe('视频拆成三个模块（SPEC-videos-0.1）', () => {
  const grp = (name: string, modules: string[]) => ({ name, modules })
  it('目录里有做视频、素材收集、发布与数据，都要 video 插件', () => {
    expect(['videos', 'video_clips', 'video_publish'].every((k) => CATALOG_IDS.has(k))).toBe(true)
    expect(pluginsForModules(['videos', 'video_clips', 'video_publish'])).toEqual(['video'])
  })

  it('视频创作工作台：素材收集、做视频放创作，发布与数据放发布与互动最前面', () => {
    const old = [grp('', ['today']), grp('创作', ['videos', 'library', 'sessions']), grp('发布与互动', ['tasks', 'messages']), grp('合作', ['contacts', 'projects'])]
    expect(splitVideoModules(old).map((g) => g.modules)).toEqual([
      ['today'], ['video_clips', 'videos', 'library', 'sessions'], ['video_publish', 'tasks', 'messages'], ['contacts', 'projects'],
    ])
  })

  it('没有发布与互动分组的（全部模块）：三个排在原来视频的位置', () => {
    expect(splitVideoModules([grp('工作', ['projects']), grp('视频', ['videos'])]).map((g) => g.modules)).toEqual([['projects'], ['video_clips', 'videos', 'video_publish']])
  })

  it('已经是拆分后的配置、没开视频的不动；关掉其中一个的照用户的来', () => {
    const split = [grp('创作', ['videos', 'library']), grp('发布', ['video_publish'])]
    expect(splitVideoModules(split)).toBe(split)
    const none = [grp('工作', ['projects'])]
    expect(splitVideoModules(none)).toBe(none)
    const clipsOnly = [grp('', ['video_clips'])]
    expect(splitVideoModules(clipsOnly)).toBe(clipsOnly)
  })
})
