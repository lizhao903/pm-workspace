// 扩展点的注册表（CORE-02b）：每条注册记下是哪个插件的，停用时按插件 id 一起撤掉。
// 外壳和页面用 use* 订阅，插件停用、注册撤掉后设置分节、今日卡片、菜单跟着消失。
import { useMemo, useSyncExternalStore, type ComponentType, type LazyExoticComponent } from 'react'
import type {
  Disposable, ObjectTypeRegistry, ObjectTypeView, SettingsRegistry, SettingsSectionDef, TodayCardRegistry, TodayCardView,
} from './api'
import type { ModuleDef } from './index'
import type { PluginManifest } from './manifest'

// 内核自己注册用的所有者 id，是内核保留字，插件不会用到
export const CORE_OWNER = 'core'

type Entry<T> = { owner: string; def: T }

// 按所有者记账的列表。快照只在变化时换新数组，useSyncExternalStore 拿到的引用是稳定的
export class OwnedStore<T> {
  private entries: Entry<T>[] = []
  private snap: readonly T[] = []
  private subs = new Set<() => void>()

  add(owner: string, def: T): Disposable {
    const e = { owner, def }
    this.entries.push(e)
    this.changed()
    return { dispose: () => this.remove((x) => x === e) }
  }

  removeOwner(owner: string): T[] {
    return this.remove((x) => x.owner === owner)
  }

  find(pred: (def: T) => boolean): Entry<T> | undefined {
    return this.entries.find((e) => pred(e.def))
  }

  ofOwner(owner: string): T[] {
    return this.entries.filter((e) => e.owner === owner).map((e) => e.def)
  }

  list = (): readonly T[] => this.snap

  subscribe = (fn: () => void): (() => void) => {
    this.subs.add(fn)
    return () => this.subs.delete(fn)
  }

  private remove(pred: (e: Entry<T>) => boolean): T[] {
    const gone = this.entries.filter(pred)
    if (gone.length === 0) return []
    this.entries = this.entries.filter((e) => !gone.includes(e))
    this.changed()
    return gone.map((e) => e.def)
  }

  private changed() {
    this.snap = this.entries.map((e) => e.def)
    for (const fn of [...this.subs]) fn()
  }
}

// 设置分节、今日卡片带上来自哪个插件，界面上要写来源
export type PluginSettingsSection = SettingsSectionDef & { plugin: string; pluginName: string }
export type PluginTodayCard = TodayCardView & { plugin: string }
export type PluginObjectTypeView = ObjectTypeView & { plugin: string }

export const moduleStore = new OwnedStore<ModuleDef>()
export const settingsStore = new OwnedStore<PluginSettingsSection>()
export const todayCardStore = new OwnedStore<PluginTodayCard>()
export const objectTypeStore = new OwnedStore<PluginObjectTypeView>()

// 启动后被撤掉的插件模块：路由是启动时建好的，菜单和页面靠它判断这个模块还在不在
const retired = new Set<string>()
let retiredSnap: ReadonlySet<string> = new Set()
const retiredSubs = new Set<() => void>()

function setRetired(ids: readonly string[], on: boolean) {
  let changed = false
  for (const id of ids) {
    if (on === retired.has(id)) continue
    if (on) retired.add(id)
    else retired.delete(id)
    changed = true
  }
  if (!changed) return
  retiredSnap = new Set(retired)
  for (const fn of [...retiredSubs]) fn()
}

// 撤掉的模块 id 只在没有别的注册还占着时才算撤掉
function retireUnowned(ids: readonly string[]) {
  setRetired(ids.filter((id) => !moduleStore.find((m) => m.id === id)), true)
}

const subscribeRetired = (fn: () => void) => {
  retiredSubs.add(fn)
  return () => retiredSubs.delete(fn)
}

export function retiredModules(): ReadonlySet<string> {
  return retiredSnap
}

export function useRetiredModules(): ReadonlySet<string> {
  return useSyncExternalStore(subscribeRetired, retiredModules)
}

// 菜单上还在的模块：内核模块一直在，插件模块撤掉后去掉
export function useActiveModules(modules: readonly ModuleDef[]): ModuleDef[] {
  const gone = useRetiredModules()
  return useMemo(() => modules.filter((m) => m.core || !gone.has(m.id)), [modules, gone])
}

// 内核模块：标 core，不能停用
export function defineCoreModule(def: Omit<ModuleDef, 'core'>): ModuleDef {
  return { ...def, core: true }
}

// 内核模块进同一张模块注册表；没标 core 的不收，免得插件模块混进来
export function registerCoreModules(defs: readonly ModuleDef[]) {
  for (const d of defs) {
    if (!d.core) throw new Error(`内核模块 ${d.id} 没有标 core`)
    if (!moduleStore.find((x) => x.id === d.id)) moduleStore.add(CORE_OWNER, d)
  }
}

// 插件注册时的检查上下文：不在清单里的 id，开发环境抛错，生产环境拒绝并把原因记进 reasons
type Ctx = { owner: string; manifest: PluginManifest; reasons: string[]; strict: boolean }

function reject(ctx: Ctx, msg: string): Disposable {
  if (ctx.strict) throw new Error(msg)
  ctx.reasons.push(msg)
  return { dispose() {} }
}

export function moduleRegistry(ctx: Ctx) {
  return {
    register(def: ModuleDef): Disposable {
      if (!(ctx.manifest.provides.modules ?? []).includes(def.id)) return reject(ctx, `注册的模块 ${def.id} 不在清单 provides.modules 里`)
      if (def.core) return reject(ctx, `插件模块 ${def.id} 不能标 core`)
      const d = moduleStore.add(ctx.owner, def)
      setRetired([def.id], false)
      return {
        dispose() {
          d.dispose()
          retireUnowned([def.id])
        },
      }
    },
  }
}

export function settingsRegistry(ctx: Ctx): SettingsRegistry {
  return {
    register(def) {
      if (!(ctx.manifest.provides.settings ?? []).includes(def.key)) return reject(ctx, `注册的设置分节 ${def.key} 不在清单 provides.settings 里`)
      if (settingsStore.find((s) => s.plugin === ctx.owner && s.key === def.key)) return reject(ctx, `设置分节 ${def.key} 重复注册`)
      return settingsStore.add(ctx.owner, { ...def, plugin: ctx.owner, pluginName: ctx.manifest.name })
    },
  }
}

export function todayCardRegistry(ctx: Ctx): TodayCardRegistry {
  return {
    register(def) {
      if (!(ctx.manifest.provides.today_cards ?? []).includes(def.key)) return reject(ctx, `注册的今日卡片 ${def.key} 不在清单 provides.today_cards 里`)
      if (todayCardStore.find((c) => c.key === def.key)) return reject(ctx, `今日卡片 ${def.key} 重复注册`)
      return todayCardStore.add(ctx.owner, { ...(def as unknown as TodayCardView), plugin: ctx.owner })
    },
  }
}

export function objectTypeRegistry(ctx: Ctx): ObjectTypeRegistry {
  return {
    register(def) {
      const own = [...(ctx.manifest.provides.object_types ?? []), ...(ctx.manifest.adopts?.object_types ?? [])]
      if (!own.includes(def.typeId)) return reject(ctx, `注册的对象类型 ${def.typeId} 不在清单 provides.object_types 或 adopts.object_types 里`)
      const had = objectTypeStore.find((v) => v.typeId === def.typeId)
      if (had) return reject(ctx, `对象类型 ${def.typeId} 的渲染器已被插件 ${had.owner} 注册`)
      return objectTypeStore.add(ctx.owner, { ...def, plugin: ctx.owner })
    },
  }
}

// 还没实现的扩展点：调用任何方法都抛出明确的错误，activate 里用到时插件加载失败并写明原因
export function notImplemented<T extends object>(name: string, section: string): T {
  return new Proxy({} as T, {
    get(_, prop) {
      // 不当 thenable，免得被 await、Promise.resolve 误判
      if (typeof prop === 'symbol' || prop === 'then') return undefined
      return () => {
        throw new Error(`插件 API 的 ${name}.${prop} 还没实现（docs/plugin-api.md ${section}）`)
      }
    },
  })
}

// 撤掉一个插件在这几张表里的全部注册
export function disposeExtensionsOf(owner: string) {
  retireUnowned(moduleStore.removeOwner(owner).map((m) => m.id))
  settingsStore.removeOwner(owner)
  todayCardStore.removeOwner(owner)
  objectTypeStore.removeOwner(owner)
}

export function useSettingsSections(): readonly PluginSettingsSection[] {
  return useSyncExternalStore(settingsStore.subscribe, settingsStore.list)
}

// 按 order 排，同 order 按注册顺序
export function sortCards(cards: readonly PluginTodayCard[]): PluginTodayCard[] {
  return cards.map((c, i) => [c, i] as const).sort((a, b) => (a[0].order ?? 100) - (b[0].order ?? 100) || a[1] - b[1]).map(([c]) => c)
}

export function useTodayCards(): readonly PluginTodayCard[] {
  return useSyncExternalStore(todayCardStore.subscribe, todayCardStore.list)
}

export function objectTypeView(typeId: string): PluginObjectTypeView | undefined {
  return objectTypeStore.find((v) => v.typeId === typeId)?.def
}

export function useObjectTypeView(typeId: string): PluginObjectTypeView | undefined {
  const list = useSyncExternalStore(objectTypeStore.subscribe, objectTypeStore.list)
  return list.find((v) => v.typeId === typeId)
}

// ---- 打开对象（PJ-01d）：内核模块登记某类对象的详情抽屉，插件和别的模块按类型拿，不用 import 模块内部 ----

export type ObjectDrawerProps = {
  /** null 表示新建 */
  objectId: string | null
  /** 新建时预填的字段，比如项目里新建的任务带上 project_id */
  init?: { project_id?: string }
  onClose: () => void
}

/** 列表上点完成圆圈、对象在待验收时的确认：确认后等于验收通过 */
export type ObjectApproveProps = {
  objectId: string
  /** 确认弹窗里点「打开」 */
  onOpen: () => void
  onClose: () => void
}

export type ObjectDrawerDef = {
  typeId: string
  drawer: LazyExoticComponent<ComponentType<ObjectDrawerProps>>
  approve?: LazyExoticComponent<ComponentType<ObjectApproveProps>>
}

export const objectDrawerStore = new OwnedStore<ObjectDrawerDef>()

/** 内核模块登记；同一类型只收第一个 */
export function registerCoreObjectDrawer(def: ObjectDrawerDef): Disposable {
  if (objectDrawerStore.find((d) => d.typeId === def.typeId)) return { dispose() {} }
  return objectDrawerStore.add(CORE_OWNER, def)
}

export function useObjectDrawer(typeId: string): ObjectDrawerDef | undefined {
  const list = useSyncExternalStore(objectDrawerStore.subscribe, objectDrawerStore.list)
  return list.find((d) => d.typeId === typeId)
}
