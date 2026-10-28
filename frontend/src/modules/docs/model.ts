// 文档页的视图模型（SPEC-library-0）：工作台文档（type=doc 的对象）和挂载目录里的文件都转成 Doc，
// 内容树、筛选、空状态文案都在这里算，纯函数，有单测。
import type { Category, LocalDir, LocalFileEntry, LocalFileList, WorkObject } from '../../core/data'

/** 工作目录：工作台文档，或者一个挂载的本地目录（dir:<LocalDir.id>） */
export type Workspace = 'builtin' | `dir:${string}`

export const BUILTIN: Workspace = 'builtin'
export const dirWs = (id: string): Workspace => `dir:${id}`
export const wsDirId = (ws: Workspace) => (ws === BUILTIN ? null : ws.slice(4))

/** 没挂分类的文档放在这个一级文件夹里，排在分类后面 */
export const UNCATEGORIZED = '__none'
export const UNCATEGORIZED_LABEL = '未分类'
/** 筛选 key：星标 */
export const STARRED = 'starred'
/** 按 Markdown 渲染的扩展名，其他按纯文本 */
const MD_EXT = new Set(['md', 'markdown'])

export interface Doc {
  id: string
  title: string
  /** 工作台文档有正文；本地文件打开时才读 */
  body?: string
  markdown: boolean
  /** 筛选用的 key：工作台文档是一级分类 id，本地文件是扩展名 */
  kind: string
  kindLabel: string
  updated: number
  meta: string[]
  /** 在树里的文件夹路径（显示名） */
  dirs: string[]
  tags: string[]
  /** undefined 表示不支持星标（本地文件） */
  starred?: boolean
  /** 本地文件的绝对路径，读内容用 */
  path?: string
  status?: string
}

export const charCount = (s: string) => s.replace(/[#>*`\-\s]/g, '').length
export const fileSize = (n: number) =>
  n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`

export function timeAgo(ms: number, now = Date.now()): string {
  const m = Math.round((now - ms) / 60000)
  if (m < 1) return '刚刚'
  if (m < 60) return `${m} 分钟前`
  if (m < 1440) return `${Math.floor(m / 60)} 小时前`
  if (m < 2880) return '昨天'
  return `${Math.floor(m / 1440)} 天前`
}

/** 分类树摊平成 id 到「各级名字、一级分类 id」的表 */
export type CategoryIndex = Map<string, { names: string[]; top: string; name: string }>

export function indexCategories(tree: Category[]): CategoryIndex {
  const out: CategoryIndex = new Map()
  const walk = (cs: Category[], names: string[], top: string | null) => {
    for (const c of cs) {
      const path = [...names, c.name]
      out.set(c.id, { names: path, top: top ?? c.id, name: c.name })
      if (c.children?.length) walk(c.children, path, top ?? c.id)
    }
  }
  walk(tree, [], null)
  return out
}

export function fromObject(o: WorkObject, cats: CategoryIndex, starred: boolean): Doc {
  const c = o.category_id ? cats.get(o.category_id) : undefined
  // 分类树里没有（刚删、刚建还没刷到）就用对象自带的分类名，放一级
  const names = c?.names ?? (o.category_id && o.category_name ? [o.category_name] : [UNCATEGORIZED_LABEL])
  const kind = c?.top ?? (o.category_id ?? UNCATEGORIZED)
  return {
    id: o.id, title: o.title, body: o.body, markdown: true, kind, kindLabel: c?.name ?? o.category_name ?? UNCATEGORIZED_LABEL,
    updated: new Date(o.updated_at).getTime(), meta: o.source ? [o.source] : [], dirs: names, tags: o.tags ?? [],
    starred, status: o.status,
  }
}

export const isMarkdown = (ext: string) => MD_EXT.has(ext.toLowerCase())

export function fromLocalFile(dir: LocalDir, f: LocalFileEntry): Doc {
  return {
    id: `${dir.id}:${f.rel}`, title: f.name, markdown: isMarkdown(f.ext), kind: f.ext, kindLabel: (f.ext || '无扩展名').toUpperCase(),
    updated: new Date(f.modified).getTime(), meta: [`${dir.name}/${f.rel}`, fileSize(f.size)],
    dirs: f.rel.split('/').slice(0, -1), tags: [], path: f.path,
  }
}

export interface Kind { key: string; label: string; count: number }

export interface Filter {
  kind: string
  tags: string[]
  q: string
}

export interface LibraryModel {
  folder: LocalDir | null
  title: string
  docs: Doc[]
  /** 顶栏筛选项；「全部」由界面自己加 */
  kinds: Kind[]
  rows: Doc[]
  kind: string
  /** 一级文件夹的顺序（显示名）；本地目录不用 */
  order?: string[]
}

/** 关键词匹配用的小写文本，按 Doc 缓存，1000 篇每敲一个字不用重新拼 */
const hay = new WeakMap<Doc, string>()
function haystack(d: Doc) {
  let h = hay.get(d)
  if (h === undefined) {
    h = [d.title, d.body ?? '', d.dirs.join('/'), d.path ?? '', ...d.tags].join('\n').toLowerCase()
    hay.set(d, h)
  }
  return h
}

/** 筛选和搜索：kind 单选，标签全部都要有（和后端 tag 参数一样是 AND），关键词按空格切词每个都要命中 */
export function filterDocs(docs: Doc[], f: Filter): Doc[] {
  const words = f.q.trim().toLowerCase().split(/\s+/).filter(Boolean)
  return docs.filter((d) => (!f.kind || (f.kind === STARRED ? d.starred : d.kind === f.kind))
    && f.tags.every((t) => d.tags.includes(t))
    && (!words.length || words.every((w) => haystack(d).includes(w))))
}

/** 工作台文档：星标 + 每个一级分类（空的也列，数量取分类树的 total_count）+ 未分类（有才列） */
export function builtinModel(objects: WorkObject[], tree: Category[], f: Filter, starredOf: (o: WorkObject) => boolean): LibraryModel {
  const cats = indexCategories(tree)
  const docs = objects.map((o) => fromObject(o, cats, starredOf(o))).sort((a, b) => b.updated - a.updated)
  const count = (k: string) => docs.filter((d) => d.kind === k).length
  const known = new Set(tree.map((c) => c.id))
  // 分类树里没有的一级 key（分类刚删、或对象上的分类不在树里），照常列出来，免得筛不到
  const extra = [...new Set(docs.map((d) => d.kind))].filter((k) => k !== UNCATEGORIZED && !known.has(k))
  const sorted = [...tree].sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name))
  const kinds: Kind[] = [
    { key: STARRED, label: '星标', count: docs.filter((d) => d.starred).length },
    ...sorted.map((c) => ({ key: c.id, label: c.name, count: c.total_count ?? count(c.id) })),
    ...extra.map((k) => ({ key: k, label: docs.find((d) => d.kind === k)?.dirs[0] ?? k, count: count(k) })),
  ]
  const none = count(UNCATEGORIZED)
  if (none) kinds.push({ key: UNCATEGORIZED, label: UNCATEGORIZED_LABEL, count: none })
  const order = [...sorted.map((c) => c.name), ...extra.map((k) => kinds.find((x) => x.key === k)?.label ?? k), UNCATEGORIZED_LABEL]
  return { folder: null, title: '工作台文档', docs, kinds, rows: filterDocs(docs, f), kind: f.kind, order }
}

/** 本地目录：实际出现过的扩展名，按字母序；文件按清单顺序（rel 排序） */
export function folderModel(dir: LocalDir, list: LocalFileList | undefined, f: Filter): LibraryModel {
  const docs = (list?.files ?? []).map((x) => fromLocalFile(dir, x))
  const kinds = [...new Set(docs.map((d) => d.kind))].sort()
    .map((k) => ({ key: k, label: (k || '无扩展名').toUpperCase(), count: docs.filter((d) => d.kind === k).length }))
  return { folder: dir, title: dir.name, docs, kinds, rows: filterDocs(docs, { ...f, tags: [] }), kind: f.kind }
}

/** 内容树为空时说清是哪种空：搜不到、一篇都没有、这个分类下没有、筛选后没有 */
export function emptyText(model: LibraryModel, f: Filter): string {
  if (f.q.trim()) return '没有匹配的内容'
  if (!model.docs.length) return model.folder ? '这个目录下没有可读的文本文件' : '还没有文档'
  if (model.kind === STARRED && !f.tags.length) return '还没有加星标的文档'
  if (model.kind && !model.folder && !f.tags.length) return '这个分类下还没有内容'
  return '没有符合筛选的内容'
}

export interface TreeDir { name: string; path: string; dirs: TreeDir[]; files: Doc[]; count: number }

export function buildTree(rows: Doc[], order?: string[]): TreeDir {
  const root: TreeDir = { name: '', path: '', dirs: [], files: [], count: 0 }
  const index = new Map<string, TreeDir>()
  for (const d of rows) {
    let node = root
    node.count += 1
    for (const seg of d.dirs) {
      const path = node.path ? `${node.path}/${seg}` : seg
      let next = index.get(path)
      if (!next) {
        next = { name: seg, path, dirs: [], files: [], count: 0 }
        index.set(path, next)
        node.dirs.push(next)
      }
      next.count += 1
      node = next
    }
    node.files.push(d)
  }
  // 工作台的一级文件夹按分类顺序，其余按名字
  const rank = (name: string) => { const i = order?.indexOf(name) ?? -1; return i < 0 ? Number.MAX_SAFE_INTEGER : i }
  const sort = (n: TreeDir, depth: number) => {
    n.dirs.sort((a, b) => (depth === 0 && order ? rank(a.name) - rank(b.name) || a.name.localeCompare(b.name) : a.name.localeCompare(b.name)))
    n.dirs.forEach((x) => sort(x, depth + 1))
  }
  sort(root, 0)
  return root
}

/** 一个文件夹的各级父路径，含自己：a/b/c 得到 a、a/b、a/b/c */
export const ancestors = (dirs: string[]) => dirs.map((_, i) => dirs.slice(0, i + 1).join('/'))
