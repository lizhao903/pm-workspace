// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 项目文档标签里的「文档目录」（TSK-0718，SPEC-projects-8.17 到 8.21）：项目设置里填的文档目录（Project.docs_dir）下认得的文件，
// 按真实层级显示成树（2026-11-11 起，正式产品 DocsDirTree.tsx、docsTree.ts）；点文件名在抽屉里预览，行尾「打开」用本机应用打开。
// 原型读不了本机目录：文件清单来自 projectdata.docsDirFiles 的演示数据，预览正文是演示文字，「打开」「在访达中显示」只提示正式产品的做法。
import { useMemo, useState } from 'react'
import type { DocDirFile } from './projectdata'
import { cls, timeAgo } from './ui'

/** 树的一行：文件夹（可展开）或文件 */
type Row = { t: 'dir'; path: string; name: string; depth: number; count: number; open: boolean } | { t: 'file'; file: DocDirFile; depth: number }
interface Dir { path: string; name: string; dirs: Dir[]; files: DocDirFile[]; count: number }

/** 扁平清单 → 目录树；文件夹在前、文件在后，各自按名字排，文件夹带子树文件数 */
function buildTree(files: DocDirFile[]): Dir {
  const root: Dir = { path: '', name: '', dirs: [], files: [], count: 0 }
  const index = new Map<string, Dir>([['', root]])
  const seen = new Set<string>()
  for (const f of files) {
    const parts = f.rel.replace(/\\/g, '/').split('/').filter((s) => s && s !== '.')
    if (!parts.length || seen.has(f.rel)) continue
    seen.add(f.rel)
    let node = root
    for (let i = 0; i < parts.length - 1; i++) {
      const path = parts.slice(0, i + 1).join('/')
      let d = index.get(path)
      if (!d) { d = { path, name: parts[i], dirs: [], files: [], count: 0 }; index.set(path, d); node.dirs.push(d) }
      node = d
    }
    node.files.push({ ...f, name: parts[parts.length - 1] })
  }
  const sort = (d: Dir) => {
    d.dirs.sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path))
    d.files.sort((a, b) => a.name.localeCompare(b.name) || a.rel.localeCompare(b.rel))
    d.count = d.files.length
    for (const c of d.dirs) { sort(c); d.count += c.count }
  }
  sort(root)
  return root
}
/** 默认第一层文件夹展开，更深的收起 */
const defaultOpen = (path: string) => !path.includes('/')
function flatten(root: Dir, isOpen: (p: string) => boolean): Row[] {
  const out: Row[] = []
  const walk = (n: Dir, depth: number) => {
    for (const d of n.dirs) { const open = isOpen(d.path); out.push({ t: 'dir', path: d.path, name: d.name, depth, count: d.count, open }); if (open) walk(d, depth + 1) }
    for (const f of n.files) out.push({ t: 'file', file: f, depth })
  }
  walk(root, 0)
  return out
}

/** 缩进最多 4 层，再深的文件夹用「…/」表示省略的上层 */
const MAX_INDENT = 4
const indent = (depth: number) => 8 + Math.min(depth, MAX_INDENT) * 14
/** 类型：扩展名大写，md 写 Markdown */
export const fileTypeLabel = (f: Pick<DocDirFile, 'ext'>) => (['md', 'markdown', 'mdx'].includes(f.ext) ? 'Markdown' : f.ext ? f.ext.toUpperCase() : '文件')
/** 来源：「文档目录」加文件所在子目录 */
const fileSourceLabel = (f: Pick<DocDirFile, 'rel'>) => { const i = f.rel.lastIndexOf('/'); return i > 0 ? `文档目录 / ${f.rel.slice(0, i)}` : '文档目录' }
/** 文档目录的绝对路径：相对路径接在项目目录后面 */
export const docsDirAbs = (dir: string, root: string) => (!dir ? '' : dir.startsWith('/') ? dir : root ? `${root.replace(/\/+$/, '')}/${dir}` : dir)

const chevron = <svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true"><path d="m6 3.5 4.5 4.5L6 12.5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>
const folderIcon = <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M1.8 4.2c0-.6.4-1 1-1h3.4l1.5 1.6h5.5c.6 0 1 .4 1 1v6.9c0 .6-.4 1-1 1H2.8c-.6 0-1-.4-1-1Z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" /></svg>
const fileIcon = <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M4 1.8h5.5L12.5 5v9.2H4Z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" /><path d="M9.3 2v3.2h3" fill="none" stroke="currentColor" strokeWidth="1.3" /></svg>

/** 原型没有本机：「打开」「在访达中显示」点了只在原地说明正式产品的做法 */
const NO_LOCAL = '原型读不了本机文件；正式产品用本机默认应用打开'

/** 文档目录的树 */
export function DocsDirTree({ files, path, onPreview }: { files: DocDirFile[]; path: string; onPreview: (f: DocDirFile) => void }) {
  const root = useMemo(() => buildTree(files), [files])
  const [overrides, setOverrides] = useState<Record<string, boolean>>({})
  const rows = useMemo(() => flatten(root, (p) => overrides[p] ?? defaultOpen(p)), [root, overrides])
  const toggle = (p: string) => setOverrides((m) => ({ ...m, [p]: !(m[p] ?? defaultOpen(p)) }))
  const [note, setNote] = useState('')
  return (
    <section className="pj-docsdir" aria-label="文档目录">
      <div className="pj-sec-head"><span className="field-group-title">文档目录</span><span className="list-sub pj-tree-path ellipsis" title={path}>{path}</span></div>
      <div className="pj-tree" role="tree" aria-label="文档目录文件">
        {rows.map((r) => r.t === 'dir' ? (
          <button key={`d:${r.path}`} className="pj-tree-row pj-tree-dir" style={{ paddingLeft: indent(r.depth) }} aria-expanded={r.open} title={r.depth > MAX_INDENT ? r.path : undefined} onClick={() => toggle(r.path)}>
            <span className={cls('pj-tree-chev', r.open && 'open')}>{chevron}</span>
            <span className="pj-tree-icon">{folderIcon}</span>
            <span className="pj-tree-name ellipsis">{r.depth > MAX_INDENT && <span className="list-sub">…/</span>}{r.name}</span>
            <span className="pj-tree-count">{r.count}</span>
          </button>
        ) : (
          <div key={`f:${r.file.rel}`} className="pj-tree-row pj-tree-file" style={{ paddingLeft: indent(r.depth) + 16 }}>
            <span className="pj-tree-icon">{fileIcon}</span>
            <button className="link-btn pj-tree-name ellipsis" title={`在工作台里预览 ${r.file.rel}`} onClick={() => onPreview(r.file)}>{r.file.name}</button>
            <span className="pj-tree-meta">{fileTypeLabel(r.file)} · {timeAgo(r.file.modified)}</span>
            <button className="act act-quiet" title="用本机默认应用打开" onClick={() => setNote(`${r.file.name}：${NO_LOCAL}`)}>打开</button>
          </div>
        ))}
      </div>
      {note && <div className="list-sub pj-docsdir-note">{note}</div>}
    </section>
  )
}

/** 预览抽屉：文本按内容显示（原型是演示文字），PDF、图片内嵌（原型给占位），Office 不预览 */
export function DocFilePreview({ file, dir, onClose }: { file: DocDirFile; dir: string; onClose: () => void }) {
  const [note, setNote] = useState('')
  const say = (reveal: boolean) => setNote(reveal ? '原型读不了本机文件；正式产品在访达中选中这个文件' : NO_LOCAL)
  let body
  if (file.kind === 'office') body = <div className="mount-empty">{fileTypeLabel(file)} 文件不能在这里预览，用本机应用打开查看。<div className="act-row"><button className="act act-primary" onClick={() => say(false)}>用本机应用打开</button></div></div>
  else if (file.kind === 'pdf' || file.kind === 'image') body = <div className="pj-docfile-ph">{file.kind === 'pdf' ? 'PDF 内嵌预览' : '图片预览'}（原型没有文件内容，正式产品直接显示 {file.name}）</div>
  else body = <pre className="pj-docfile-text">{`# ${file.name.replace(/\.[^.]+$/, '')}\n\n（原型读不了本机文件，这里是演示正文。正式产品读 ${file.rel} 的内容，md 按 Markdown 渲染，超过 1MB 只显示开头。）`}</pre>
  return (
    <div className="pj-docfile-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <aside className="drawer pj-docfile" aria-label={`预览 ${file.name}`} onKeyDown={(e) => { if (e.key === 'Escape') onClose() }}>
        <div className="drawer-head">
          <span className="drawer-kicker">{fileSourceLabel(file)}</span>
          <div className="spacer" />
          {file.kind !== 'office' && <button className="act act-quiet" onClick={() => say(false)}>用本机应用打开</button>}
          <button className="act act-quiet" onClick={() => say(true)}>在访达中显示</button>
          <button className="icon-btn" onClick={onClose} title="关闭 (Esc)" autoFocus>
            <svg viewBox="0 0 16 16" width="14" height="14"><path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
          </button>
        </div>
        <div className="drawer-body">
          <h2 className="pj-docfile-title">{file.name}</h2>
          <div className="list-sub pj-docfile-meta"><code>{dir.replace(/\/+$/, '')}/{file.rel}</code> · {timeAgo(file.modified)}</div>
          {note && <div className="list-sub">{note}</div>}
          {body}
        </div>
      </aside>
    </div>
  )
}
