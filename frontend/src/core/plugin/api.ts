// 插件入口和插件 API（docs/plugin-api.md 2.0）。已实现功能模块（FE-00b）和命令面板命令（CORE-02a），其余注册接口在 CORE-02b
import type { CommandRegistry } from './commands'
import type { ModuleDef } from './index'
import type { PluginManifest } from './manifest'

export interface Disposable {
  dispose(): void
}

export interface ModuleRegistry {
  // def.id 必须在清单 provides.modules 里
  register(def: ModuleDef): Disposable
}

export interface PluginApi {
  readonly id: string
  readonly manifest: PluginManifest
  modules: ModuleRegistry
  commands: CommandRegistry
}

export interface PluginEntry {
  // 启用时调用。只注册，不发请求；数据在页面里按需取
  activate(api: PluginApi): void
  // 停用时调用，只清插件自己的资源
  deactivate?(): void
}

export function definePlugin(entry: PluginEntry): PluginEntry {
  return entry
}
