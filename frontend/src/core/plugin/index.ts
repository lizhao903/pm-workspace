// 内核模块和插件共用的模块描述、插件清单、插件入口和注册表。
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
export * from './api'
export * from './registry'
