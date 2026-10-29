// 插件入口和插件 API（docs/plugin-api.md 2.0）。CORE-02b 接通功能模块、设置分节、今日卡片、命令面板命令、
// 对象类型渲染器五个扩展点，SOP-03b 接通 SOP 节点；数据迁移、连接器、技能和 Agent 工具、事件订阅只有类型，调用时抛「还没实现」
import type { ComponentType, LazyExoticComponent } from 'react'
import type { WorkObject } from '../api/types'
import type * as DataLayer from '../data'
import type { CommandRegistry, ShellApi } from './commands'
import type { ModuleDef } from './index'
import type { PluginManifest } from './manifest'
import type { TodaySourceRegistry } from './todaySources'

export interface Disposable {
  dispose(): void
}

// 2.1 功能模块
export interface ModuleRegistry {
  // def.id 必须在清单 provides.modules 里；插件模块不能标 core
  register(def: ModuleDef): Disposable
}

// 2.2 设置分节
export interface SettingsSectionDef {
  // = provides.settings 里的一项
  key: string
  label: string
  desc?: string
  // 设置二级菜单里的分组，默认「插件」
  group?: string
  page: LazyExoticComponent<ComponentType>
}
export interface SettingsRegistry {
  register(def: SettingsSectionDef): Disposable
}

// 2.3 对象类型（前端只注册渲染器）
export interface ObjectTypeView {
  // = provides.object_types 或 adopts.object_types 里的一项
  typeId: string
  // 详情抽屉；不给就用内核的通用详情
  detail?: LazyExoticComponent<ComponentType<{ objectId: string }>>
  // 列表行的副标题、角标
  summary?: (o: WorkObject) => { sub?: string; badges?: string[] }
}
export interface ObjectTypeRegistry {
  register(def: ObjectTypeView): Disposable
}

// 2.4 数据迁移（只读）
export interface MigrationStep {
  plugin: string
  file: string
  checksum: string
  applied_at?: string
}
export interface MigrationInfo {
  // 本插件已应用和待应用的迁移，来自 GET /api/admin/migrations?plugin=<id>
  list(): Promise<MigrationStep[]>
}

// 2.5 连接器
export interface ConnectorView {
  // = provides.connectors 里的一项
  tool: string
  label: string
  color: string
  category: 'im' | 'media' | 'market' | 'dev' | 'other'
  desc: string
  // 凭证字段标 secret，前端只显示脱敏提示
  fields: { key: string; label: string; kind: 'text' | 'secret' | 'select'; placeholder?: string }[]
}
export interface ConnectorRegistry {
  register(def: ConnectorView): Disposable
}

// 2.6 技能、Agent 工具
export interface AgentToolView {
  // = provides.agent_tools 里的一项
  name: string
  label: string
  // 「确认」模式下给用户看的调用预览；不给就显示参数 JSON
  preview?: ComponentType<{ args: unknown }>
}
export interface AgentRegistry {
  registerToolView(def: AgentToolView): Disposable
  // 技能只在后端定义；前端注册图标和分组，技能列表从后端读
  registerSkillView(def: { id: string; icon: string; group?: string }): Disposable
}

// 2.7 SOP 节点：只管编辑器里怎么显示；有没有这种节点、分组、必填项以后端 GET /api/sop/node-types 为准
export interface SopNodeView {
  // = provides.sop_nodes 里的一项
  kind: string
  label: string
  group: string
  desc: string
  color: string
  fields: {
    key: string
    label: string
    type: 'text' | 'textarea' | 'select' | 'multi' | 'number' | 'code'
    required?: boolean
    default?: string
    hint?: string
    // 编辑器渲染时调；可以读数据层缓存，缓存变了编辑器会重新调
    options?: () => { value: string; label: string }[]
  }[]
}
export interface SopNodeRegistry {
  register(def: SopNodeView): Disposable
}

// 2.8 今日卡片。data 来自今日聚合接口（TODAY-01）里这张卡的那一份；
// 聚合接口还没有这张卡的数据（只有前端的插件、接口还没接上）时是 undefined
export interface TodayCardView<T = unknown> {
  // = provides.today_cards 里的一项
  key: string
  title: string
  // 越小越靠前，默认 100
  order?: number
  render: ComponentType<{ data: T | undefined }>
}
export interface TodayCardRegistry {
  register<T>(def: TodayCardView<T>): Disposable
}

// 2.10 事件订阅
export interface EventRegistry {
  on<T = unknown>(type: string, handler: (payload: T) => void): Disposable
}

// 内核的数据访问层（CORE-03a），插件只能通过它读写数据
export type DataClient = typeof DataLayer

export interface PluginApi {
  readonly id: string
  readonly manifest: PluginManifest
  modules: ModuleRegistry // 2.1
  settings: SettingsRegistry // 2.2
  objectTypes: ObjectTypeRegistry // 2.3
  migrations: MigrationInfo // 2.4（未实现）
  connectors: ConnectorRegistry // 2.5（未实现）
  agent: AgentRegistry // 2.6（未实现）
  sopNodes: SopNodeRegistry // 2.7
  todayCards: TodayCardRegistry // 2.8
  // 今日「需要你处理」「正在运行」的来源（ALIGN-08）
  todaySources: TodaySourceRegistry
  commands: CommandRegistry // 2.9
  events: EventRegistry // 2.10（未实现）
  data: DataClient
  // 外壳能力；现在只有跳转
  shell: ShellApi
}

export interface PluginEntry {
  // 启用时调用。只注册，不发请求；数据在页面里按需取
  activate(api: PluginApi): void
  // 停用时调用。注册过的东西内核按插件 id 统一撤掉，这里只清插件自己的其它资源
  deactivate?(): void
}

export function definePlugin(entry: PluginEntry): PluginEntry {
  return entry
}
