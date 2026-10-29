// 插件模块的菜单图标：模块 id 到所属插件清单里的 icon。清单在构建时就打进来了（registry 的 discoverPlugins），
// 插件有没有启用不影响图标，所以只算一次
import { discoverPlugins, parseManifest, type PluginManifest } from '../plugin'

export function iconsByModule(manifests: readonly unknown[]): Map<string, string> {
  const out = new Map<string, string>()
  for (const raw of manifests) {
    const r = parseManifest(raw)
    if (!r.ok || !r.manifest.icon) continue
    const m: PluginManifest = r.manifest
    for (const id of m.provides.modules ?? []) if (!out.has(id)) out.set(id, m.icon!)
  }
  return out
}

let cache: Map<string, string> | null = null

export function moduleIconKey(moduleId: string): string | undefined {
  cache ??= iconsByModule(discoverPlugins().map((s) => s.manifest))
  return cache.get(moduleId)
}
