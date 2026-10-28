// 插件注册表。按插件清单加载模块放在 FE-00b，这里先只定内核模块和插件共用的描述结构。
import type { ComponentType } from 'react'

export type ModuleDef = {
  id: string
  label: string
  // 路由路径，不带前导斜杠
  path: string
  // 按需加载页面，返回的模块默认导出页面组件
  load: () => Promise<{ default: ComponentType }>
}

export * from './manifest'
export * from './semver'
