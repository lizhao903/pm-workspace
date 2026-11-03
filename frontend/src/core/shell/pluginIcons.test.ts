import { describe, expect, it } from 'vitest'
import { bundledOwnerOf, iconsByModule, moduleIconKey, ownersByModule } from './pluginIcons'

const manifest = (id: string, modules: string[], icon?: unknown, icons?: Record<string, string>) => ({
  id, name: id, version: '1.0.0', core: '^1.0.0', provides: { modules }, permissions: [], ...(icon === undefined ? {} : { icon }), ...(icons ? { icons } : {}),
})

describe('插件模块的菜单图标', () => {
  it('按清单 icon 对上插件的每个模块；没写的、清单不合法的不算', () => {
    const m = iconsByModule([manifest('alpha', ['alpha', 'alpha_two'], 'folder'), manifest('beta', ['beta']), manifest('gamma', ['gamma'], 'Bad')])
    expect([...m]).toEqual([['alpha', 'folder'], ['alpha_two', 'folder']])
  })

  it('清单 icons 按模块给的优先，没给的模块用插件的 icon', () => {
    const m = iconsByModule([manifest('alpha', ['alpha', 'alpha_two', 'alpha_three'], 'folder', { alpha_two: 'pulse' }), manifest('beta', ['beta'], undefined, { beta: 'chart' })])
    expect([...m]).toEqual([['alpha', 'folder'], ['alpha_two', 'pulse'], ['alpha_three', 'folder'], ['beta', 'chart']])
  })

  it('交易四个模块的图标和原型一致：candles、pulse、chart、swap；视频用 video', () => {
    expect(['markets', 'monitor', 'strategy', 'trading', 'videos'].map(moduleIconKey)).toEqual(['candles', 'pulse', 'chart', 'swap', 'video'])
  })

  it('模块归哪个插件按清单 provides.modules', () => {
    expect([...ownersByModule([manifest('alpha', ['alpha', 'alpha_two']), manifest('beta', ['beta'])])]).toEqual([['alpha', 'alpha'], ['alpha_two', 'alpha'], ['beta', 'beta']])
    expect(['videos', 'markets', 'trading', 'messages', 'browser', 'nope'].map(bundledOwnerOf)).toEqual(['video', 'trade', 'trade', 'im', 'browser', undefined])
  })

  it('项目和 IM 消息用清单里的文件夹和消息图标', () => {
    expect(moduleIconKey('projects')).toBe('folder')
    expect(moduleIconKey('messages')).toBe('message')
    expect(moduleIconKey('browser')).toBe('globe')
    expect(moduleIconKey('hello')).toBeUndefined()
  })
})
