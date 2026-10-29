// 支持材料标签的纯函数（SPEC-projects-11）：路径补全、选文件时的目录前缀、标签拆分、筛选。
import { MATERIAL_KINDS, type MaterialKind, type ProjectMaterial, type WorkObject } from '../../core/data'

/** 没填路径时选文件放在项目目录的 materials 下（同原型 dirOf） */
export const DEFAULT_DIR = 'materials'

/** 输入框里路径的目录部分：「materials/a.md」→「materials」、「/x/y/」→「/x/y」；没填时默认 materials，只有文件名时为空串 */
export function dirOf(v: string): string {
  const t = v.trim()
  if (!t) return DEFAULT_DIR
  const i = t.lastIndexOf('/')
  if (i < 0) return ''
  return i === 0 ? '/' : t.slice(0, i)
}

/** 目录前缀拼上文件名 */
export const joinPath = (dir: string, name: string) => (!dir ? name : dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`)

/**
 * 存进去的绝对路径：绝对路径原样；相对路径拼上项目目录（契约要求前端拼好再传）。
 * 没设项目目录又填了相对路径时返回 null，界面提示填绝对路径；「~」开头的交给后端报错。
 */
export function resolvePath(v: string, root: string): string | null {
  const t = v.trim()
  if (!t || t.startsWith('/') || t.startsWith('~')) return t
  const r = root.trim().replace(/\/+$/, '')
  if (!r) return null
  return `${r}/${t.replace(/^(\.\/)+/, '')}`
}

/** 标签：中英文逗号分隔，去首尾空白、去空项、去重 */
export const splitTags = (s: string): string[] => [...new Set(s.split(/[,，]/).map((x) => x.trim()).filter(Boolean))]

/** 出现过的标签，按第一次出现的顺序 */
export const allTags = (rows: ProjectMaterial[]): string[] => [...new Set(rows.flatMap((m) => m.tags))]

export type MaterialFilter = { q: string; kind: MaterialKind | ''; tag: string }

/** 搜名称、值、标签，不区分大小写；种类、标签单选 */
export function matchMaterial(m: ProjectMaterial, f: MaterialFilter): boolean {
  if (f.kind && m.kind !== f.kind) return false
  if (f.tag && !m.tags.includes(f.tag)) return false
  const kw = f.q.trim().toLowerCase()
  return !kw || `${m.name} ${m.value} ${m.tags.join(' ')}`.toLowerCase().includes(kw)
}

/** 列表新加的在前；接口按添加先后返回 */
export const newestFirst = (rows: ProjectMaterial[]) => [...rows].reverse()

export const isPathKind = (k: MaterialKind) => k === 'file' || k === 'folder'

// ---- 概览「最近的文档和材料」（SPEC-projects-3.8） ----

/** 露几条 */
export const RECENT_PEEK = 5

type Recent = { key: string; tag: string; title: string; at: string }

/** 文档和支持材料合在一起按时间倒序；文档按更新时间，材料按加入时间（同原型 added_at） */
export function recentDocsAndMaterials(docs: readonly WorkObject[], mats: readonly ProjectMaterial[], n = RECENT_PEEK): Recent[] {
  const kind = (k: string) => MATERIAL_KINDS.find((x) => x.key === k)?.label ?? k
  return [
    ...docs.map((d) => ({ key: `d${d.id}`, tag: d.category_name || '文档', title: d.title || '未命名', at: d.updated_at })),
    ...mats.map((m) => ({ key: `m${m.id}`, tag: m.category || kind(m.kind), title: m.name || m.value, at: m.created_at })),
  ].sort((a, b) => b.at.localeCompare(a.at)).slice(0, n)
}
