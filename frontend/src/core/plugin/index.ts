// 内核模块和插件共用的模块描述、插件清单、插件入口和注册表。
import type { ComponentType } from 'react'

export type ModuleDef = {
  id: string
  label: string
  // 路由路径，不带前导斜杠
  path: string
  // 按需加载页面，返回的模块默认导出页面组件
  load: () => Promise<{ default: ComponentType }>
  // 内核模块（今日、任务、文档、联系人、会话、设置）：不能停用，界面上没有停用入口
  core?: boolean
}

export * from './manifest'
export * from './semver'
export * from './api'
export * from './commands'
export * from './registry'
export * from './extensions'
export * from './todaySources'
export * from './projectTabs'
export * from './objectSections'
export * from './sessionTools'
export * from './terminalLaunch'
export * from './sessionSources'
