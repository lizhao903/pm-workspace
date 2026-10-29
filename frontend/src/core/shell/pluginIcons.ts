// 插件模块的菜单图标和所属插件：都按插件清单算。清单在构建时就打进来了（registry 的 discoverPlugins），
// 插件有没有启用不影响这两样，所以只算一次
import { discoverPlugins, parseManifest, type PluginManifest } from '../plugin'

function validManifests(manifests: readonly unknown[]): PluginManifest[] {
  const out: PluginManifest[] = []
  for (const raw of manifests) {
    const r = parseManifest(raw)
    if (r.ok) out.push(r.manifest)
  }
  return out
}

/** 模块 id 到图标 key：清单 icons 里按模块给的优先，没给的用插件的 icon */
export function iconsByModule(manifests: readonly unknown[]): Map<string, string> {
  const out = new Map<string, string>()
  for (const m of validManifests(manifests)) {
    for (const id of m.provides.modules ?? []) {
      const icon = m.icons?.[id] ?? m.icon
      if (icon && !out.has(id)) out.set(id, icon)
    }
  }
  return out
}

/** 模块 id 到提供它的插件 id，按清单 provides.modules */
export function ownersByModule(manifests: readonly unknown[]): Map<string, string> {
  const out = new Map<string, string>()
  for (const m of validManifests(manifests)) {
    for (const id of m.provides.modules ?? []) if (!out.has(id)) out.set(id, m.id)
  }
  return out
}

let icons: Map<string, string> | null = null
let owners: Map<string, string> | null = null
const manifests = () => discoverPlugins().map((s) => s.manifest)

export function moduleIconKey(moduleId: string): string | undefined {
  icons ??= iconsByModule(manifests())
  return icons.get(moduleId)
}

/** 构建时打进来的清单里，哪个插件提供这个模块 */
export function bundledOwnerOf(moduleId: string): string | undefined {
  owners ??= ownersByModule(manifests())
  return owners.get(moduleId)
}
