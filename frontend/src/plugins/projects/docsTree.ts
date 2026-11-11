// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 项目文档标签里「文档目录」的目录树模型（纯函数，有单测）：把 GET /api/objects/{id}/docs-dir/files
// 回来的扁平文件清单（rel 相对文档目录）按 / 分层。文件夹在前、文件在后，各自按名字排；文件夹带子树文件数。
// 默认只展开第一层文件夹（顶层文件总可见），更深的收起，点文件夹展开（SPEC-projects-8.17、8.21）。
// 后端只回认得的文件、不回目录项，所以清单里没有的空文件夹不会出现在树上。
import type { LocalFileEntry } from '../../core/data'

/** 树的一行：文件夹（可展开）或文件（点名称预览） */
export type DocsTreeRow =
  | { t: 'dir'; path: string; name: string; depth: number; count: number; open: boolean }
  | { t: 'file'; file: LocalFileEntry; depth: number }

/** 目录节点：path 相对文档目录、/ 分隔；count 是子树里的文件数（构建时算好） */
export interface DocsTreeDir {
  path: string
  name: string
  dirs: DocsTreeDir[]
  files: LocalFileEntry[]
  count: number
}

/** 把 rel 拆成目录/文件名，兼容 Windows 的反斜杠；空段和 . 丢掉 */
function segments(rel: string): string[] {
  return rel.replace(/\\/g, '/').split('/').filter((s) => s && s !== '.')
}

/** 文件夹在前、文件在后，各自按名字排（同名的按完整相对路径兜底，顺序稳定） */
function sortDir(d: DocsTreeDir) {
  d.dirs.sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path))
  d.files.sort((a, b) => a.name.localeCompare(b.name) || a.rel.localeCompare(b.rel))
  let count = d.files.length
  for (const c of d.dirs) {
    sortDir(c)
    count += c.count
  }
  d.count = count
}

/**
 * 扁平文件清单 → 目录树。path 为空的根节点不带行，只当遍历入口。
 * 重复的 rel 只留第一份；rel 全是分隔符这类拆不出文件名的跳过。
 */
export function buildDocsTree(files: LocalFileEntry[]): DocsTreeDir {
  const root: DocsTreeDir = { path: '', name: '', dirs: [], files: [], count: 0 }
  const index = new Map<string, DocsTreeDir>([['', root]])
  const seen = new Set<string>()
  for (const f of files) {
    const parts = segments(f.rel)
    if (!parts.length || seen.has(f.rel)) continue
    seen.add(f.rel)
    let node = root
    for (let i = 0; i < parts.length - 1; i++) {
      const path = parts.slice(0, i + 1).join('/')
      let d = index.get(path)
      if (!d) {
        d = { path, name: parts[i], dirs: [], files: [], count: 0 }
        index.set(path, d)
        node.dirs.push(d)
      }
      node = d
    }
    // 名字以 rel 为准（后端 name 就是最后一段，这里再对一次，树上的层级和文件清单一致）
    node.files.push({ ...f, name: parts[parts.length - 1] })
  }
  sortDir(root)
  return root
}

/** 默认展开规则：第一层文件夹（path 里没有 /）展开，更深的收起；顶层文件不受影响 */
export const defaultOpen = (path: string) => !path.includes('/')

/** 按「哪些文件夹展开」摊平成可见的行；文件夹收起时它的子树不出现 */
export function flattenDocsTree(root: DocsTreeDir, isOpen: (path: string) => boolean): DocsTreeRow[] {
  const out: DocsTreeRow[] = []
  const walk = (node: DocsTreeDir, depth: number) => {
    for (const d of node.dirs) {
      const open = isOpen(d.path)
      out.push({ t: 'dir', path: d.path, name: d.name, depth, count: d.count, open })
      if (open) walk(d, depth + 1)
    }
    for (const f of node.files) out.push({ t: 'file', file: f, depth })
  }
  walk(root, 0)
  return out
}
