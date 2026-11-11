// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 插件注册表（FE-00b）：按启用列表挑出能加载的插件，动态 import 入口并调 activate，收集它们注册的模块。
// 清单在构建时用 glob 读进来（只是数据），入口是懒加载的 glob，每个插件一个代码块，没启用的不会被请求。
// CORE-02b 起 activate 拿到完整的 PluginApi，注册按插件 id 记账，deactivatePlugin 一次撤掉。
import type { ModuleDef } from './index'
import type { PluginApi, PluginEntry } from './api'
import { commandRegistry, disposeCommandsOf, type ShellApi } from './commands'
import {
  CORE_OWNER, disposeExtensionsOf, moduleRegistry, moduleStore, notImplemented, objectTypeRegistry, registerCoreModules,
  settingsRegistry, sopNodeRegistry, todayCardRegistry,
} from './extensions'
import * as data from '../data'
import { todaySourceRegistry, todaySourceStore } from './todaySources'
import { projectTabRegistry, projectTabStore } from './projectTabs'
import { objectSectionRegistry, objectSectionStore } from './objectSections'
import { sessionToolRegistry, sessionToolStore } from './sessionTools'
import { terminalLauncherRegistry, terminalLauncherStore } from './terminalLaunch'
import { sessionSourceRegistry, sessionSourceStore } from './sessionSources'
import { shellStatusRegistry, shellStatusStore } from './shellStatus'
import { checkManifest, formatIssue, parseManifest, PLUGIN_API_VERSION, type PluginManifest } from './manifest'
import { enabledPlugins } from '../../plugins/enabled'
import { requestList } from '../api'

// 一个可装的插件：目录名、清单原文、入口加载函数
export type PluginSource = {
  id: string
  manifest: unknown
  load?: () => Promise<{ default: PluginEntry }>
}

// 没加载的插件和原因，界面上提示用
export type PluginProblem = { id: string; name?: string; reasons: string[] }

// 启用了哪些插件（按菜单顺序）和当前插件 API 版本
export type PluginState = {
  enabled: string[]
  apiVersion: string
}

export type Resolved = { ok: PluginManifest[]; problems: PluginProblem[] }

// 插件注册的一个模块，带上是哪个插件注册的
export type PluginModule = { plugin: PluginManifest; def: ModuleDef }

export type LoadResult = {
  modules: PluginModule[]
  plugins: PluginManifest[]
  problems: PluginProblem[]
}

function dirId(path: string): string {
  return /\/plugins\/([^/]+)\//.exec(path)?.[1] ?? path
}

// 第一方插件的入口都在 src/plugins/<id>/index.ts。清单只有一份：有后端的插件放在 internal/plugins/<id>/plugin.json，
// 只有前端的（示例 hello）放在 src/plugins/<id>/plugin.json，两处都读，同一个 id 以后端那份为准
export function discoverPlugins(): PluginSource[] {
  const manifests = {
    ...import.meta.glob<unknown>('../../plugins/*/plugin.json', { eager: true, import: 'default' }),
    ...import.meta.glob<unknown>('../../../../internal/plugins/*/plugin.json', { eager: true, import: 'default' }),
  }
  const entries = import.meta.glob<{ default: PluginEntry }>('../../plugins/*/index.ts')
  const out = new Map<string, PluginSource>()
  for (const [path, m] of Object.entries(manifests)) out.set(dirId(path), { id: dirId(path), manifest: m })
  for (const [path, load] of Object.entries(entries)) {
    const id = dirId(path)
    out.set(id, { ...(out.get(id) ?? { id, manifest: undefined }), load })
  }
  return [...out.values()]
}

// 启用列表读 GET /api/plugins：后端在跑（running）的插件按后端顺序；后端没有记录的插件
// （后端还没编译进来的，例如示例 hello）按本地 enabled.ts 接在后面。后端有记录就以后端为准。
// 最多等 timeoutMs；超时或读不到时抛错，loadPlugins 收下后只显示内核模块，并在插件提示里写原因
export async function fetchPluginState(timeoutMs = 3000): Promise<PluginState> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  let rows: unknown[]
  try {
    rows = (await requestList<unknown>('/api/plugins', { signal: ctl.signal })).data
  } catch (e) {
    if (ctl.signal.aborted) throw new Error(`${timeoutMs / 1000} 秒内没有返回，只显示内核模块`)
    throw new Error(`${(e as Error).message}，只显示内核模块`)
  } finally {
    clearTimeout(timer)
  }
  const known = new Set<string>()
  const enabled: string[] = []
  for (const r of rows) {
    if (!r || typeof r !== 'object' || typeof (r as { id?: unknown }).id !== 'string') continue
    const { id, running } = r as { id: string; running?: unknown }
    known.add(id)
    if (running === true) enabled.push(id)
  }
  for (const id of enabledPlugins) if (!known.has(id)) enabled.push(id)
  return { enabled, apiVersion: PLUGIN_API_VERSION }
}

// 按启用列表挑插件：清单不合法、id 和目录名不符、依赖没启用或版本不符、成环的都不加载。
// 一个插件被拦下后，依赖它的插件也跟着拦下，所以反复检查到不再变化
export function resolvePlugins(sources: readonly PluginSource[], state: PluginState): Resolved {
  const byId = new Map(sources.map((s) => [s.id, s]))
  const problems: PluginProblem[] = []
  const active = new Map<string, PluginManifest>()
  for (const id of new Set(state.enabled)) {
    const src = byId.get(id)
    if (!src) {
      problems.push({ id, reasons: ['没有这个插件'] })
      continue
    }
    if (src.manifest === undefined) {
      problems.push({ id, reasons: ['缺少清单 plugin.json'] })
      continue
    }
    const r = parseManifest(src.manifest)
    if (!r.ok) {
      problems.push({ id, reasons: r.issues.map((i) => '清单 ' + formatIssue(i)) })
      continue
    }
    const reasons: string[] = []
    if (r.manifest.id !== id) reasons.push(`清单 id 是 ${r.manifest.id}，和目录名 ${id} 不一致`)
    if (!src.load) reasons.push('缺少入口 index.ts')
    if (reasons.length > 0) problems.push({ id, name: r.manifest.name, reasons })
    else active.set(id, r.manifest)
  }

  for (let changed = true; changed; ) {
    changed = false
    const env = { apiVersion: state.apiVersion, plugins: [...active.values()] }
    for (const m of [...active.values()]) {
      const issues = checkManifest(m, env)
      if (issues.length === 0) continue
      const reasons = issues.map((i) => {
        const dep = i.field.startsWith('depends.') ? i.field.slice('depends.'.length) : ''
        if (dep && !active.has(dep) && byId.has(dep)) return `${i.field} 依赖的插件没有启用或没能加载`
        return formatIssue(i)
      })
      problems.push({ id: m.id, name: m.name, reasons })
      active.delete(m.id)
      changed = true
    }
  }
  // 保持启用列表的顺序，菜单按它排
  const ok = state.enabled.filter((id, i) => state.enabled.indexOf(id) === i && active.has(id)).map((id) => active.get(id)!)
  return { ok, problems }
}

const isDev = import.meta.env.DEV

// 加载并激活插件。任何一步出错只影响这个插件，记进 problems，不让整个应用起不来
export async function loadPlugins(
  sources: readonly PluginSource[] = discoverPlugins(),
  state?: PluginState,
): Promise<LoadResult> {
  let st = state
  const problems: PluginProblem[] = []
  if (!st) {
    try {
      st = await fetchPluginState()
    } catch (e) {
      return { modules: [], plugins: [], problems: [{ id: '插件列表', reasons: ['读取失败：' + (e as Error).message] }] }
    }
  }
  const { ok, problems: blocked } = resolvePlugins(sources, st)
  problems.push(...blocked)
  const byId = new Map(sources.map((s) => [s.id, s]))
  const modules: PluginModule[] = []
  const plugins: PluginManifest[] = []

  for (const m of ok) {
    const reasons: string[] = []
    // 上一次加载留下的注册先撤掉，同一个插件不会注册两份
    disposeAll(m.id)
    try {
      const entry = (await byId.get(m.id)!.load!()).default
      entry.activate(pluginApi(m, reasons, isDev))
      entries.set(m.id, entry)
      manifests.set(m.id, m)
    } catch (e) {
      disposeAll(m.id)
      console.error(`插件 ${m.id} 加载失败`, e)
      problems.push({ id: m.id, name: m.name, reasons: ['加载失败：' + (e as Error).message] })
      continue
    }
    if (reasons.length > 0) problems.push({ id: m.id, name: m.name, reasons })
    modules.push(...moduleStore.ofOwner(m.id).map((def) => ({ plugin: m, def })))
    plugins.push(m)
  }
  return { modules, plugins, problems }
}

// 给一个插件的 API。没实现的扩展点用到就抛错，插件按加载失败处理
export function pluginApi(m: PluginManifest, reasons: string[], strict: boolean): PluginApi {
  const ctx = { owner: m.id, manifest: m, reasons, strict }
  return {
    id: m.id,
    manifest: m,
    modules: moduleRegistry(ctx),
    settings: settingsRegistry(ctx),
    objectTypes: objectTypeRegistry(ctx),
    migrations: notImplemented('migrations', '2.4'),
    connectors: notImplemented('connectors', '2.5'),
    agent: notImplemented('agent', '2.6'),
    sopNodes: sopNodeRegistry(ctx),
    todayCards: todayCardRegistry(ctx),
    todaySources: todaySourceRegistry(m.id),
    projectTabs: projectTabRegistry(m.id),
    objectSections: objectSectionRegistry(m.id),
    shellStatus: shellStatusRegistry(m.id),
    sessionTools: sessionToolRegistry(m.id),
    sessionSources: sessionSourceRegistry(m.id),
    terminalLauncher: terminalLauncherRegistry(m.id),
    commands: commandRegistry(m.id, m.provides, reasons, strict),
    events: notImplemented('events', '2.10'),
    data,
    shell: shellProxy,
  }
}

// 已激活的插件入口，停用时调它的 deactivate；清单留着给后启用的插件查依赖
const entries = new Map<string, PluginEntry>()
const manifests = new Map<string, PluginManifest>()

function disposeAll(owner: string) {
  disposeCommandsOf(owner)
  disposeExtensionsOf(owner)
  todaySourceStore.removeOwner(owner)
  projectTabStore.removeOwner(owner)
  objectSectionStore.removeOwner(owner)
  shellStatusStore.removeOwner(owner)
  sessionToolStore.removeOwner(owner)
  sessionSourceStore.removeOwner(owner)
  terminalLauncherStore.removeOwner(owner)
}

// 停用插件（docs/plugin-api.md 4.3 的前端部分）：撤掉它的全部注册，再调 deactivate。
// 菜单、设置分节、今日卡片、命令跟着消失；停在它页面上的会被路由送回默认模块。内核模块不能停用
export function deactivatePlugin(id: string): boolean {
  if (id === CORE_OWNER || moduleStore.find((d) => !!d.core && d.id === id)) throw new Error(`${id} 是内核模块，不能停用`)
  const entry = entries.get(id)
  if (!entry) return false
  entries.delete(id)
  manifests.delete(id)
  disposeAll(id)
  try {
    entry.deactivate?.()
  } catch (e) {
    console.error(`插件 ${id} 停用时出错`, e)
  }
  return true
}

export function activePlugins(): string[] {
  return [...entries.keys()]
}

export type ActivateResult =
  | { ok: true; reload: boolean }
  | { ok: false; reasons: string[] }

// 启用插件（docs/plugin-api.md 4.2 的前端部分，插件管理页在后端启用成功后调）：查清单和依赖，加载入口调 activate。
// 路由和菜单的模块列表是启动时定的：启动时就有路由的模块（启动时启用、后来停用又启用的）直接回到菜单；
// 启动时没有的要整页重新加载，这时 reload 为 true。已经在跑的不重复加载；只有后端没有前端入口的直接算成功
export async function activatePlugin(id: string, sources: readonly PluginSource[] = discoverPlugins()): Promise<ActivateResult> {
  if (entries.has(id)) return { ok: true, reload: false }
  const src = sources.find((s) => s.id === id)
  if (!src || src.manifest === undefined) return { ok: true, reload: false }
  const r = parseManifest(src.manifest)
  if (!r.ok) return { ok: false, reasons: r.issues.map((i) => '清单 ' + formatIssue(i)) }
  if (!src.load) return { ok: true, reload: false }
  const m = r.manifest
  const issues = checkManifest(m, { apiVersion: PLUGIN_API_VERSION, plugins: [...manifests.values()] })
  if (issues.length > 0) return { ok: false, reasons: issues.map(formatIssue) }
  const reasons: string[] = []
  disposeAll(id)
  try {
    const entry = (await src.load()).default
    entry.activate(pluginApi(m, reasons, isDev))
    entries.set(id, entry)
    manifests.set(id, m)
  } catch (e) {
    disposeAll(id)
    console.error(`插件 ${id} 加载失败`, e)
    return { ok: false, reasons: ['加载失败：' + (e as Error).message] }
  }
  problems = problems.filter((p) => p.id !== id)
  const reload = moduleStore.ofOwner(id).some((d) => !routed.has(d.id))
  return { ok: true, reload }
}

// 外壳能力。插件在启动时就拿到 api.shell，那时外壳还没渲染，所以经这一层转给外壳挂上来的实现
let shellHost: ShellApi | null = null

export function setShellHost(host: ShellApi | null) {
  shellHost = host
}

const shellProxy: ShellApi = {
  navigate(to) {
    if (!shellHost) throw new Error('外壳还没挂上，不能跳转')
    shellHost.navigate(to)
  },
}

let problems: PluginProblem[] = []
// 启动时建了路由的模块 id
let routed = new Set<string>()

// 应用启动时调一次：加载插件，把插件模块接在内核模块后面
export async function initPlugins(kernel: readonly ModuleDef[]): Promise<ModuleDef[]> {
  registerCoreModules(kernel)
  const r = await loadPlugins()
  problems = r.problems
  const list = mergeModules(kernel, r.modules, problems)
  routed = new Set(list.map((d) => d.id))
  return list
}

// 模块 id 或路径和已有的撞了的不要，免得一个菜单项盖掉另一个；撞了的记进 out
export function mergeModules(kernel: readonly ModuleDef[], add: readonly PluginModule[], out: PluginProblem[]): ModuleDef[] {
  const list = [...kernel]
  for (const { plugin, def } of add) {
    const clash = list.find((d) => d.id === def.id || d.path === def.path)
    if (clash) {
      out.push({ id: plugin.id, name: plugin.name, reasons: [`模块 ${def.id} 和已有的模块 ${clash.id} 冲突，没有加进菜单`] })
      continue
    }
    list.push(def)
  }
  return list
}

// 启动时没加载的插件，外壳拿来提示
export function pluginProblems(): readonly PluginProblem[] {
  return problems
}
