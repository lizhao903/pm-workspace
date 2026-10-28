// 读本地目录：Chrome / Edge 走 showDirectoryPicker，能保留句柄、原地重新读取；
// 其他浏览器退到 <input webkitdirectory>，只能拿到当次选择的快照，刷新要重新选
// 只读文本文件，内容全部读进内存；关掉页面就没了，不落库

export interface LocalFile {
  /** 相对目录根的路径，含文件名 */
  path: string
  name: string
  ext: string
  size: number
  modified: number
  text: string
}

export interface LocalFolder {
  id: string
  name: string
  files: LocalFile[]
  /** 因为太大、太多或不是文本跳过的文件数 */
  skipped: number
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

export const TEXT_EXT = ['md', 'markdown', 'txt', 'text', 'log', 'csv', 'json', 'yaml', 'yml', 'toml', 'xml', 'html', 'sql']
const MAX_FILE = 2 * 1024 * 1024
const MAX_FILES = 1000
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
    if (!TEXT_EXT.includes(ext) || file.size > MAX_FILE || files.length >= MAX_FILES) { skipped += 1; continue }
    files.push({ path, name: file.name, ext, size: file.size, modified: file.lastModified, text: await file.text() })
  }
  files.sort((a, b) => a.path.localeCompare(b.path))
  return { files, skipped }
}

async function walk(dir: DirHandle, prefix = '', out: { path: string; file: File }[] = []) {
  for await (const entry of dir.values()) {
    if (entry.name.startsWith('.')) continue
    const path = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.kind === 'directory') {
      if (!SKIP_DIRS.has(entry.name)) await walk(entry, path, out)
    } else {
      out.push({ path, file: await entry.getFile() })
    }
  }
  return out
}

export async function readHandle(handle: DirHandle, id = newId()): Promise<LocalFolder> {
  const { files, skipped } = await collect(await walk(handle))
  return { id, name: handle.name, files, skipped, read_at: Date.now(), handle }
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
