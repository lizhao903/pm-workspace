// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 文档标签里「文档目录」的文件预览与错误文案（TSK-0718，SPEC-projects-8.17 起）：项目设置里填的文档目录（props.docs_dir），
// 列出目录下认得的文件（GET /api/objects/{id}/docs-dir/files，规则同挂载目录），按目录层级显示成树（DocsDirTree.tsx）。
// 点文件名在抽屉里预览：文本读 /api/fs/read（md 按 Markdown 渲染），PDF、图片走 /api/fs/raw，Office 等不预览、用本机应用打开；都能在访达中显示。
// 预览写法照「文档」阅读区的本地文件（modules/docs/Reader.tsx），这里只做抽屉里能看的那一份。
import { useState } from 'react'
import {
  errorText, isApiError, localRawUrl, useLocalFile, useOpenLocalFile, type LocalFileEntry,
} from '../../core/data'
import { Button, Drawer, Markdown } from '../../core/ui'
import { ago } from './model'

const MD_EXT = new Set(['md', 'markdown', 'mdx'])

/** 类型列：扩展名大写，md 写 Markdown */
export const fileTypeLabel = (f: Pick<LocalFileEntry, 'ext'>) => {
  const e = f.ext.replace(/^\./, '').toLowerCase()
  if (MD_EXT.has(e)) return 'Markdown'
  return e ? e.toUpperCase() : '文件'
}

/** 来源列：「文档目录」加文件所在的子目录（相对文档目录），在目录根上就只写「文档目录」 */
export const fileSourceLabel = (f: Pick<LocalFileEntry, 'rel'>) => {
  const i = f.rel.lastIndexOf('/')
  return i > 0 ? `文档目录 / ${f.rel.slice(0, i)}` : '文档目录'
}

/** 文档目录读不出来时说清原因（越界、不存在、没设、相对路径没项目目录） */
export function docsDirError(e: unknown, dir: string): string {
  if (isApiError(e) && e.status === 403) return `文档目录「${dir}」不能读：${e.message}`
  if (isApiError(e, 'not_found')) return `文档目录「${dir}」不存在，去设置里改一个`
  return `文档目录「${dir}」读不出来：${errorText(e)}`
}

const fileError = (e: unknown) => {
  if (isApiError(e) && e.status === 403) return `不能读这个文件：${e.message}`
  if (isApiError(e, 'not_found')) return '文件已经不在了，刷新一下文档目录'
  return `读取失败：${errorText(e)}`
}

/** 本机打开、在访达中显示；失败的提示在 err */
function useOpener(path: string) {
  const opener = useOpenLocalFile()
  const [err, setErr] = useState('')
  const open = (reveal: boolean) => {
    setErr('')
    opener.mutate({ path, reveal }, { onError: (e) => setErr(`${reveal ? '显示' : '打开'}失败：${errorText(e)}`) })
  }
  return { open, err, pending: opener.isPending }
}

/** 预览抽屉 */
export function DocFilePreview({ file, onClose }: { file: LocalFileEntry; onClose: () => void }) {
  const kind = file.kind ?? 'text'
  const text = useLocalFile(kind === 'text' ? file.path : null)
  const loaded = text.data && text.data.path === file.path ? text.data : undefined
  const op = useOpener(file.path)
  let content
  if (kind === 'pdf') content = <iframe className="pj-docfile-pdf" src={localRawUrl(file.path)} title={`预览 ${file.name}`} />
  else if (kind === 'image') content = <img className="pj-docfile-img" src={localRawUrl(file.path)} alt={file.name} />
  else if (kind === 'office') {
    content = (
      <div className="pj-block-empty">
        {fileTypeLabel(file)} 文件不能在这里预览，用本机应用打开查看。
        <div className="pj-act-row"><Button variant="primary" size="sm" disabled={op.pending} onClick={() => op.open(false)}>用本机应用打开</Button></div>
      </div>
    )
  } else if (text.isError) {
    content = <div className="pj-err" role="alert">{fileError(text.error)} <Button size="sm" onClick={() => void text.refetch()}>重试</Button></div>
  } else if (!loaded) content = <div className="pj-block-empty">正在读取</div>
  else if (loaded.binary) content = <div className="pj-block-empty">这是二进制文件，不显示内容</div>
  else {
    content = (
      <>
        {MD_EXT.has(file.ext.replace(/^\./, '').toLowerCase())
          ? <Markdown source={loaded.content} top={2} empty="这个文件是空的" />
          : <pre className="md plain-text">{loaded.content}</pre>}
        {loaded.truncated && <div className="pj-muted">文件太大，只显示开头 {Math.round(loaded.limit / 1024)} KB</div>}
      </>
    )
  }
  return (
    <Drawer open onClose={onClose} aria-label={`预览 ${file.name}`} kicker={fileSourceLabel(file)}
      headActions={<>
        {kind !== 'office' && <Button size="sm" variant="ghost" disabled={op.pending} onClick={() => op.open(false)}>用本机应用打开</Button>}
        <Button size="sm" variant="ghost" disabled={op.pending} onClick={() => op.open(true)}>在访达中显示</Button>
      </>}>
      <h2 className="pj-docfile-title">{file.name}</h2>
      <div className="pj-muted pj-docfile-meta"><code>{file.path}</code> · {ago(file.modified)}</div>
      {op.err && <div className="pj-err" role="alert">{op.err}</div>}
      <div className="pj-docfile-body">{content}</div>
    </Drawer>
  )
}
