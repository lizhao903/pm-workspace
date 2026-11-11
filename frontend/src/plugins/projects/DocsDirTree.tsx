// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 项目文档标签里「文档目录」的树（SPEC-projects-8.17、8.21，2026-11-11 起；模型在 docsTree.ts）。
// 文件夹可展开收起，默认展开第一层；文件点名称在抽屉里预览（DocFilePreview），行尾「打开」用本机默认应用打开。
// 只列后端认得、且已经拉到的文件，空文件夹不出现（清单里没有目录项）。
import { useMemo, useState } from 'react'
import { errorText, useOpenLocalFile, type LocalFileEntry } from '../../core/data'
import { Button, cls } from '../../core/ui'
import { buildDocsTree, defaultOpen, flattenDocsTree } from './docsTree'
import { fileTypeLabel } from './DocsDirFiles'
import { ago } from './model'

/** 缩进最多 4 层，再深的文件夹用「…/」表示省略的上层（同「文档」模块的内容树） */
const MAX_INDENT = 4
const indent = (depth: number) => 8 + Math.min(depth, MAX_INDENT) * 14

const chevron = <svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true"><path d="m6 3.5 4.5 4.5L6 12.5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>
const folderIcon = <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M1.8 4.2c0-.6.4-1 1-1h3.4l1.5 1.6h5.5c.6 0 1 .4 1 1v6.9c0 .6-.4 1-1 1H2.8c-.6 0-1-.4-1-1Z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" /></svg>
const fileIcon = <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M4 1.8h5.5L12.5 5v9.2H4Z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" /><path d="M9.3 2v3.2h3" fill="none" stroke="currentColor" strokeWidth="1.3" /></svg>

/** 文档目录的树：files 是清单里认得的文件，path 是文档目录（原样，悬停看完整路径） */
export function DocsDirTree({ files, path, onPreview }: {
  files: LocalFileEntry[]
  /** 文档目录（项目设置里填的原样，可能是相对路径） */
  path: string
  onPreview: (f: LocalFileEntry) => void
}) {
  const root = useMemo(() => buildDocsTree(files), [files])
  // 只记被点过的文件夹：没点过的按默认规则（第一层展开，更深收起）；清单刷新后展开状态还在
  const [overrides, setOverrides] = useState<Record<string, boolean>>({})
  const rows = useMemo(() => flattenDocsTree(root, (p) => overrides[p] ?? defaultOpen(p)), [root, overrides])
  const toggle = (p: string) => setOverrides((m) => ({ ...m, [p]: !(m[p] ?? defaultOpen(p)) }))

  return (
    <section className="pj-docsdir" aria-label="文档目录">
      <div className="pj-sec-head">
        <h3 className="pj-sec-title">文档目录</h3>
        <span className="pj-muted pj-tree-path" title={path}>{path}</span>
      </div>
      <div className="pj-tree" role="tree" aria-label="文档目录文件">
        {rows.map((r) => r.t === 'dir'
          ? (
            <button key={`d:${r.path}`} type="button" className="pj-tree-row pj-tree-dir" style={{ paddingLeft: indent(r.depth) }}
              aria-expanded={r.open} title={r.depth > MAX_INDENT ? r.path : undefined} onClick={() => toggle(r.path)}>
              <span className={cls('pj-tree-chev', r.open && 'open')}>{chevron}</span>
              <span className="pj-tree-icon">{folderIcon}</span>
              <span className="pj-tree-name ellipsis">{r.depth > MAX_INDENT && <span className="pj-tree-elide">…/</span>}{r.name}</span>
              <span className="pj-tree-count">{r.count}</span>
            </button>
          )
          : <FileRow key={`f:${r.file.path}`} file={r.file} depth={r.depth} onPreview={() => onPreview(r.file)} />)}
      </div>
    </section>
  )
}

/** 树里的文件行：名称点开预览，行尾用本机默认应用打开；打开失败的提示在行尾红字 */
function FileRow({ file, depth, onPreview }: { file: LocalFileEntry; depth: number; onPreview: () => void }) {
  const opener = useOpenLocalFile()
  const [err, setErr] = useState('')
  const open = () => {
    setErr('')
    opener.mutate({ path: file.path, reveal: false }, { onError: (e) => setErr(`打开失败：${errorText(e)}`) })
  }
  return (
    <div className="pj-tree-row pj-tree-file" style={{ paddingLeft: indent(depth) + 16 }}>
      <span className="pj-tree-icon">{fileIcon}</span>
      <button type="button" className="pj-link pj-tree-name" title={`在工作台里预览 ${file.rel}`} onClick={onPreview}>{file.name}</button>
      <span className="pj-tree-meta" title={file.path}>{fileTypeLabel(file)} · {ago(file.modified)}</span>
      <Button size="sm" disabled={opener.isPending} title="用本机默认应用打开" onClick={open}>打开</Button>
      {err && <span className="pj-err" role="alert">{err}</span>}
    </div>
  )
}
