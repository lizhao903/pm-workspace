// 一级菜单的分组、侧栏收起和分组折叠的本地记忆。
// 分组以后来自工作台配置（CORE-10），这之前先用这里的默认分组；没进任何组的模块（插件）放进「未分组」。
import type { ModuleDef } from '../plugin'

export type MenuGroupDef = { id: string; name: string; modules: string[] }
export type MenuGroup = { id: string; name: string; items: ModuleDef[] }

export const DEFAULT_GROUPS: readonly MenuGroupDef[] = [
  { id: 'home', name: '', modules: ['today'] },
  { id: 'work', name: '工作', modules: ['tasks', 'docs'] },
  { id: 'talk', name: '沟通', modules: ['contacts', 'conversations'] },
]

// 放在侧栏底部的模块
export const FOOT_MODULES: readonly string[] = ['settings']

export const UNGROUPED_ID = 'ungrouped'

export function buildMenu(modules: readonly ModuleDef[], groups: readonly MenuGroupDef[] = DEFAULT_GROUPS) {
  const byId = new Map(modules.map((m) => [m.id, m]))
  const used = new Set<string>(FOOT_MODULES)
  const out: MenuGroup[] = []
  for (const g of groups) {
    const items: ModuleDef[] = []
    for (const id of g.modules) {
      const m = byId.get(id)
      if (!m || used.has(id)) continue
      used.add(id)
      items.push(m)
    }
    if (items.length) out.push({ id: g.id, name: g.name, items })
  }
  const rest = modules.filter((m) => !used.has(m.id))
  if (rest.length) out.push({ id: UNGROUPED_ID, name: '未分组', items: rest })
  const foot = FOOT_MODULES.map((id) => byId.get(id)).filter((m): m is ModuleDef => !!m)
  return { groups: out, foot }
}

// 本地记忆：侧栏收起、哪些分组折叠了。原型用 pmw-next-side，这里按本工程的 pmw- 前缀另起键
const SIDE_KEY = 'pmw-side'
const FOLD_KEY = 'pmw-side-folded'

export function readCollapsed(): boolean {
  try { return localStorage.getItem(SIDE_KEY) === 'collapsed' } catch { return false }
}

export function writeCollapsed(v: boolean) {
  try { localStorage.setItem(SIDE_KEY, v ? 'collapsed' : 'open') } catch { /* 拿不到存储就只在本次会话生效 */ }
}

export function readFolded(): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(FOLD_KEY) ?? '[]')
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch { return [] }
}

export function writeFolded(ids: readonly string[]) {
  try { localStorage.setItem(FOLD_KEY, JSON.stringify(ids)) } catch { /* 同上 */ }
}

export function toggleId(ids: readonly string[], id: string): string[] {
  return ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]
}
