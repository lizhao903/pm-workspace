// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 一级菜单的分组、侧栏收起和分组折叠的本地记忆。
// 分组来自当前工作台（CORE-10b，见 workspace.ts）；后端取不到工作台时用这里的默认分组。
// 没进任何组的模块放进「未分组」，传了 hide 的除外（工作台目录里的模块在不在菜单由工作台决定）。
import type { ModuleDef } from '../plugin'

export type MenuGroupDef = { id: string; name: string; modules: string[]; collapsed?: boolean }
export type MenuGroup = { id: string; name: string; items: ModuleDef[]; collapsed?: boolean }

export const DEFAULT_GROUPS: readonly MenuGroupDef[] = [
  { id: 'home', name: '', modules: ['today'] },
  { id: 'work', name: '工作', modules: ['projects', 'tasks', 'docs'] },
  { id: 'talk', name: '沟通', modules: ['contacts', 'conversations', 'runs'] },
]

// 放在侧栏底部的模块
export const FOOT_MODULES: readonly string[] = ['settings']

export const UNGROUPED_ID = 'ungrouped'

export function buildMenu(modules: readonly ModuleDef[], groups: readonly MenuGroupDef[] = DEFAULT_GROUPS, hide?: ReadonlySet<string>) {
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
    if (items.length) out.push({ id: g.id, name: g.name, items, ...(g.collapsed && { collapsed: true }) })
  }
  const rest = modules.filter((m) => !used.has(m.id) && !hide?.has(m.id))
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

/** 分组是否折着：工作台里设了默认折叠的，本地点过一次就反过来；没标题的组不折叠 */
export const isGroupFolded = (g: { id: string; name: string; collapsed?: boolean }, flipped: readonly string[]) =>
  !!g.name && !!g.collapsed !== flipped.includes(g.id)

export function toggleId(ids: readonly string[], id: string): string[] {
  return ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]
}
