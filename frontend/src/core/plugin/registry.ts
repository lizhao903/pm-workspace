// 插件注册表（FE-00b）：按启用列表挑出能加载的插件，动态 import 入口并调 activate，收集它们注册的模块。
// 清单在构建时用 glob 读进来（只是数据），入口是懒加载的 glob，每个插件一个代码块，没启用的不会被请求。
import type { ModuleDef } from './index'
import type { Disposable, PluginEntry } from './api'
import { checkManifest, formatIssue, parseManifest, PLUGIN_API_VERSION, type PluginManifest } from './manifest'
import { enabledPlugins } from '../../plugins/enabled'

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

// 第一方插件都在 src/plugins/<id>/：plugin.json 是清单，index.ts 是入口。
// 规范里清单只有一份、放在 internal/plugins/<id>/plugin.json；后端带上第一个插件时把这里的清单 glob 换过去
export function discoverPlugins(): PluginSource[] {
  const manifests = import.meta.glob<unknown>('../../plugins/*/plugin.json', { eager: true, import: 'default' })
  const entries = import.meta.glob<{ default: PluginEntry }>('../../plugins/*/index.ts')
  const out = new Map<string, PluginSource>()
  for (const [path, m] of Object.entries(manifests)) out.set(dirId(path), { id: dirId(path), manifest: m })
  for (const [path, load] of Object.entries(entries)) {
    const id = dirId(path)
    out.set(id, { ...(out.get(id) ?? { id, manifest: undefined }), load })
  }
  return [...out.values()]
}

// 启用列表。CORE-04b 之后改成读 GET /api/plugins（经 core/api），拿已启用的插件和当前插件 API 版本
export async function fetchPluginState(): Promise<PluginState> {
  return { enabled: [...enabledPlugins], apiVersion: PLUGIN_API_VERSION }
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
    const own: ModuleDef[] = []
    const reasons: string[] = []
    try {
      const entry = (await byId.get(m.id)!.load!()).default
      entry.activate({
        id: m.id,
        manifest: m,
        modules: {
          register(def): Disposable {
            if (!(m.provides.modules ?? []).includes(def.id)) {
              const msg = `注册的模块 ${def.id} 不在清单 provides.modules 里`
              if (isDev) throw new Error(msg)
              reasons.push(msg)
              return { dispose() {} }
            }
            own.push(def)
            return {
              dispose() {
                const i = own.indexOf(def)
                if (i >= 0) own.splice(i, 1)
              },
            }
          },
        },
      })
    } catch (e) {
      console.error(`插件 ${m.id} 加载失败`, e)
      problems.push({ id: m.id, name: m.name, reasons: ['加载失败：' + (e as Error).message] })
      continue
    }
    if (reasons.length > 0) problems.push({ id: m.id, name: m.name, reasons })
    modules.push(...own.map((def) => ({ plugin: m, def })))
    plugins.push(m)
  }
  return { modules, plugins, problems }
}

let problems: PluginProblem[] = []

// 应用启动时调一次：加载插件，把插件模块接在内核模块后面
export async function initPlugins(kernel: readonly ModuleDef[]): Promise<ModuleDef[]> {
  const r = await loadPlugins()
  problems = r.problems
  return mergeModules(kernel, r.modules, problems)
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
