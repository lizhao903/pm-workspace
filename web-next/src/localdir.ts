// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 读本地目录：Chrome / Edge 走 showDirectoryPicker，能保留句柄、原地重新读取；
// 其他浏览器退到 <input webkitdirectory>，只能拿到当次选择的快照，刷新要重新选
// 全部文档：文本读进内存（单个最多 1MB），PDF、图片给一个本页有效的对象地址用来预览，Office 等只记文件信息；
// 不再限 1000 个文件，走查超过 20 万项、或比根目录深 32 层以上才停（和正式产品后端同一套保护）。关掉页面就没了，不落库

/** 文件种类：text 读正文，pdf、image 原样预览，office 不预览（给文件信息和「用本机应用打开」） */
export type FileKind = 'text' | 'pdf' | 'image' | 'office'

export interface LocalFile {
  /** 相对目录根的路径，含文件名 */
  path: string
  name: string
  ext: string
  kind: FileKind
  size: number
  modified: number
  /** 文本才有；超过 1MB 只读开头 */
  text: string
  truncated?: boolean
  /** PDF、图片的对象地址（URL.createObjectURL），本页有效 */
  url?: string
}

export interface LocalFolder {
  id: string
  name: string
  files: LocalFile[]
  /** 扩展名不认得跳过的文件数（压缩包、程序、脚本等） */
  skipped: number
  /** 触到保护没列全：visited 是走查项数到了 20 万，depth 是有子目录太深 */
  truncated?: 'visited' | 'depth'
  read_at: number
  /** 只有 showDirectoryPicker 拿得到，有它才能重新读取 */
  handle?: DirHandle
}

// lib.dom 里这几个接口还不全，只声明用到的部分
interface FileHandle { kind: 'file'; name: string; getFile(): Promise<File> }
export interface DirHandle {
  kind: 'directory'
  name: string
  values(): AsyncIterable<FileHandle | DirHandle>
  isSameEntry?(other: DirHandle): Promise<boolean>
}
declare global {
  interface Window { showDirectoryPicker?: (opts?: { mode?: 'read' }) => Promise<DirHandle> }
}

export const TEXT_EXT = ['md', 'markdown', 'txt', 'text', 'log', 'csv', 'json', 'yaml', 'yml', 'toml', 'xml', 'html', 'sql',
  'htm', 'jsonl', 'ndjson', 'tsv', 'mmd', 'rst', 'ini', 'conf', 'cfg']
export const PDF_EXT = ['pdf']
export const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif']
export const OFFICE_EXT = ['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'key', 'pages', 'numbers', 'odt', 'ods', 'odp', 'rtf', 'epub']
export const kindOf = (ext: string): FileKind | null =>
  TEXT_EXT.includes(ext) ? 'text' : PDF_EXT.includes(ext) ? 'pdf' : IMAGE_EXT.includes(ext) ? 'image' : OFFICE_EXT.includes(ext) ? 'office' : null
/** 文本一次最多读这么多，超出只读开头（和后端 /api/fs/read 一样 1MB） */
const MAX_TEXT = 1024 * 1024
export const MAX_VISITED = 200000
export const MAX_DEPTH = 32
// 依赖和版本库目录里的文本没人想看，一进去就是几千个文件
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.venv', '__pycache__'])

export const extOf = (name: string) => {
  const i = name.lastIndexOf('.')
  return i > 0 ? name.slice(i + 1).toLowerCase() : ''
}
export const isMarkdown = (ext: string) => ext === 'md' || ext === 'markdown'

let seq = 0
const newId = () => `dir${Date.now().toString(36)}${(seq += 1)}`

async function collect(entries: { path: string; file: File }[]) {
  const files: LocalFile[] = []
  let skipped = 0
  for (const { path, file } of entries) {
    const ext = extOf(file.name)
    const kind = kindOf(ext)
    if (!kind) { skipped += 1; continue }
    const base = { path, name: file.name, ext, kind, size: file.size, modified: file.lastModified, text: '' }
    if (kind === 'text') files.push({ ...base, text: await file.slice(0, MAX_TEXT).text(), truncated: file.size > MAX_TEXT })
    else if (kind === 'pdf' || kind === 'image') files.push({ ...base, url: URL.createObjectURL(file) })
    else files.push(base)
  }
  files.sort((a, b) => a.path.localeCompare(b.path))
  return { files, skipped }
}

type Walk = { out: { path: string; file: File }[]; visited: number; truncated?: 'visited' | 'depth' }

async function walk(dir: DirHandle, prefix = '', st: Walk = { out: [], visited: 0 }, depth = 0): Promise<Walk> {
  for await (const entry of dir.values()) {
    if (st.visited >= MAX_VISITED) { st.truncated = 'visited'; return st }
    st.visited += 1
    if (entry.name.startsWith('.')) continue
    const path = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.kind === 'directory') {
      if (SKIP_DIRS.has(entry.name)) continue
      if (depth + 1 > MAX_DEPTH) { st.truncated ??= 'depth'; continue }
      await walk(entry, path, st, depth + 1)
    } else {
      st.out.push({ path, file: await entry.getFile() })
    }
  }
  return st
}

export async function readHandle(handle: DirHandle, id = newId()): Promise<LocalFolder> {
  const st = await walk(handle)
  const { files, skipped } = await collect(st.out)
  return { id, name: handle.name, files, skipped, truncated: st.truncated, read_at: Date.now(), handle }
}

function pickWithInput(): Promise<LocalFolder | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.webkitdirectory = true
    input.multiple = true
    input.addEventListener('cancel', () => resolve(null))
    input.addEventListener('change', () => {
      const list = Array.from(input.files ?? [])
      if (!list.length) { resolve(null); return }
      // webkitRelativePath 形如「根目录名/子目录/文件」，第一段就是目录名
      const root = list[0].webkitRelativePath.split('/')[0] || '本地目录'
      const entries = list
        .map((file) => ({ path: file.webkitRelativePath.split('/').slice(1).join('/'), file }))
        .filter(({ path }) => !path.split('/').some((seg, i, all) => seg.startsWith('.') || (i < all.length - 1 && SKIP_DIRS.has(seg))))
      collect(entries).then(({ files, skipped }) => resolve({ id: newId(), name: root, files, skipped, read_at: Date.now() }), reject)
    })
    input.click()
  })
}

/** 用户取消返回 null */
export async function pickFolder(): Promise<LocalFolder | null> {
  if (!window.showDirectoryPicker) return pickWithInput()
  try {
    return await readHandle(await window.showDirectoryPicker({ mode: 'read' }))
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') return null
    throw e
  }
}
