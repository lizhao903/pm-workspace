import { describe, expect, it } from 'vitest'
import { iconsByModule, moduleIconKey } from './pluginIcons'

const manifest = (id: string, modules: string[], icon?: unknown) => ({
  id, name: id, version: '1.0.0', core: '^1.0.0', provides: { modules }, permissions: [], ...(icon === undefined ? {} : { icon }),
})

describe('插件模块的菜单图标', () => {
  it('按清单 icon 对上插件的每个模块；没写的、清单不合法的不算', () => {
    const m = iconsByModule([manifest('alpha', ['alpha', 'alpha_two'], 'folder'), manifest('beta', ['beta']), manifest('gamma', ['gamma'], 'Bad')])
    expect([...m]).toEqual([['alpha', 'folder'], ['alpha_two', 'folder']])
  })

  it('项目和 IM 消息用清单里的文件夹和消息图标', () => {
    expect(moduleIconKey('projects')).toBe('folder')
    expect(moduleIconKey('messages')).toBe('message')
    expect(moduleIconKey('hello')).toBeUndefined()
  })
})
