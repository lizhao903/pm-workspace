// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 产出物查看窗（DEV-08b 补，SPEC-tasks-5.40 到 5.44）：任务抽屉「产出物」、产出物视图里点条目标题打开。
// 写法跟邻居走：弹窗外形、Esc 和焦点同附件预览（core/ui/AttachmentPreview，抽屉里的预览都用弹窗，Esc 在捕获阶段拦下不关外层抽屉）；
// 文件的显示规则同项目文档目录的预览（plugins/projects/DocsDirFiles 的 DocFilePreview）：Markdown 渲染、文本等宽、
// 图片和 PDF 直接看、Office 用本机应用打开、二进制只说明。
// 读的都是按产出物 id 的接口（docs/api-contract.md「查看产出物」），不传路径。
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  artifactRawUrl, errorText, useArtifactBranch, useArtifactCommit, useArtifactFile, useOpenArtifact,
  type Artifact, type ArtifactChangedFile, type ArtifactCommit, type ArtifactFile,
} from '../../core/data'
import { Button, IconClose, Markdown, cls } from '../../core/ui'
import { focusables, restoreFocus, trapTab } from '../../core/ui/focus'
import { shortSha, type ParsedNote } from './artifactNote'
import { fileDelta, fileStatusLabel, sizeText, splitDiff, viewErrorText, type ArtifactViewKind } from './artifactView'
import { timeAgo } from './model'
import './artifactViewer.css'

export function ArtifactViewer({ a, p, kind, onClose }: {
  a: Artifact; p: ParsedNote; kind: ArtifactViewKind; onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [prev] = useState(() => document.activeElement)
  const closeFn = useRef(onClose)
  useEffect(() => { closeFn.current = onClose })
  useEffect(() => {
    ref.current?.focus()
    // 捕获阶段拦下，外层任务抽屉的 Esc 收不到
    const onKey = (e: KeyboardEvent) => {
      const el = ref.current
      if (!el) return
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        closeFn.current()
      } else if (e.key === 'Tab') {
        trapTab(el, e)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      restoreFocus(prev)
    }
  }, [prev])

  const title = kind === 'file' ? (a.rel_path || a.path) : kind === 'commit' ? (p.text || a.title || `提交 ${shortSha(p.sha ?? '')}`) : (p.branch ?? a.title)
  const kindLabel = kind === 'file' ? '文件' : kind === 'commit' ? '提交' : '分支'

  return createPortal(
    // 弹窗挂在 body 上，但 React 事件照样沿组件树冒泡：点击在这里截住，免得触发外层行的展开、选中
    <div className="dialog-scrim art-pv-scrim" onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div ref={ref} className="art-pv" role="dialog" aria-modal="true" aria-label={`查看${kindLabel} ${title}`} tabIndex={-1}
        onFocus={() => { if (ref.current && !focusables(ref.current).length) ref.current.focus() }}>
        <div className="art-pv-head">
          <span className="art-pv-kind" data-kind={kind}>{kindLabel}</span>
          <span className="art-pv-title"><b className="ellipsis" title={a.path || title}>{title}</b></span>
          <span className="spacer" />
          {a.url && <a className="btn btn-ghost btn-sm" href={a.url} target="_blank" rel="noopener noreferrer" title={a.url}>打开链接</a>}
          <button type="button" className="icon-btn" aria-label="关闭查看" title="关闭 (Esc)" onClick={onClose}><IconClose /></button>
        </div>
        <div className="art-pv-body">
          {kind === 'file' && <FileView a={a} />}
          {kind === 'commit' && <CommitView id={a.id} />}
          {kind === 'branch' && <BranchView id={a.id} />}
        </div>
      </div>
    </div>,
    document.body,
  )
}

function Problem({ children, onRetry }: { children: ReactNode; onRetry?: () => void }) {
  return (
    <div className="art-pv-empty" role="alert">
      <div>{children}</div>
      {onRetry && <Button size="sm" onClick={onRetry}>重试</Button>}
    </div>
  )
}

// --- 文件 ---

/** 用本机应用打开、在访达中显示；失败的提示写在 err */
function useOpener(id: string) {
  const m = useOpenArtifact()
  const [err, setErr] = useState('')
  const open = (reveal: boolean) => {
    setErr('')
    m.mutate({ id, reveal }, { onError: (e) => setErr(`${reveal ? '显示' : '打开'}失败：${errorText(e)}`) })
  }
  return { open, err, pending: m.isPending }
}

// 后端「打开」只认文档种类（文本、PDF、图片、Office），源码这类只给「在访达中显示」
const OPENABLE = new Set(['markdown', 'html', 'image', 'pdf', 'office'])

function FileView({ a }: { a: Artifact }) {
  const q = useArtifactFile(a.id)
  const op = useOpener(a.id)
  if (q.isPending) return <div className="art-pv-empty">正在读取</div>
  if (q.isError) return <Problem onRetry={() => void q.refetch()}>{viewErrorText(q.error)}</Problem>
  const f = q.data
  return (
    <div className="art-pv-file">
      <div className="art-pv-meta">
        <code className="ellipsis" title={f.path}>{f.path}</code>
        <span>{sizeText(f.size)}</span>
        <span>修改于 {timeAgo(f.modified)}</span>
        <span className="spacer" />
        {OPENABLE.has(f.preview) && <Button size="sm" variant="ghost" disabled={op.pending} onClick={() => op.open(false)}>用本机应用打开</Button>}
        <Button size="sm" variant="ghost" disabled={op.pending} onClick={() => op.open(true)}>在访达中显示</Button>
      </div>
      {op.err && <div className="art-pv-err" role="alert">{op.err}</div>}
      {f.truncated && <div className="art-pv-note">文件超过 {Math.round(f.limit / 1024)} KB，只显示开头</div>}
      <FileBody f={f} id={a.id} onOpen={() => op.open(false)} opening={op.pending} />
    </div>
  )
}

function FileBody({ f, id, onOpen, opening }: { f: ArtifactFile; id: string; onOpen: () => void; opening: boolean }) {
  const [source, setSource] = useState(false)
  const [broken, setBroken] = useState(false)
  switch (f.preview) {
    case 'markdown':
      return <div className="art-pv-doc"><Markdown source={f.content} top={2} empty="这个文件是空的" /></div>
    case 'text':
      return <pre className="art-pv-code">{f.content || '这个文件是空的'}</pre>
    case 'html':
      return (
        <>
          <div className="art-pv-tabs seg seg-sm" role="radiogroup" aria-label="HTML 看法">
            <button type="button" role="radio" aria-checked={!source} className={cls(!source && 'on')} onClick={() => setSource(false)}>页面</button>
            <button type="button" role="radio" aria-checked={source} className={cls(source && 'on')} onClick={() => setSource(true)}>源码</button>
            <a className="art-pv-newtab" href={artifactRawUrl(id)} target="_blank" rel="noopener noreferrer">新窗口打开</a>
          </div>
          {source
            ? <pre className="art-pv-code">{f.content}</pre>
            : (
              <>
                <div className="art-pv-note">只显示页面，不运行脚本；外链和相对路径的图片、样式加载不了，要完整效果用本机应用打开</div>
                {/* sandbox 不带 allow-scripts：后端的 CSP 也是 sandbox，两头都不跑脚本 */}
                <iframe className="art-pv-frame" sandbox="" src={artifactRawUrl(id)} title={`页面 ${f.name}`} />
              </>
            )}
        </>
      )
    case 'image':
      return broken
        ? <div className="art-pv-empty">图片显示不出来，可能不是它扩展名说的格式；用本机应用打开看看</div>
        : <div className="art-pv-img"><img src={artifactRawUrl(id)} alt={f.name} onError={() => setBroken(true)} /></div>
    case 'pdf':
      return <iframe className="art-pv-frame" src={artifactRawUrl(id)} title={`预览 ${f.name}`} />
    case 'office':
      return (
        <div className="art-pv-empty">
          <div>{f.ext.toUpperCase()} 文件不能在这里预览，用本机应用打开查看</div>
          <Button variant="primary" size="sm" disabled={opening} onClick={onOpen}>用本机应用打开</Button>
        </div>
      )
    case 'binary':
      return <div className="art-pv-empty">这是二进制文件（{sizeText(f.size)}），不显示内容；可以在访达中显示</div>
  }
}

// --- 提交 ---

function FileList({ files, truncated, onPick }: { files: ArtifactChangedFile[]; truncated: boolean; onPick?: (path: string) => void }) {
  if (!files.length) return <div className="art-pv-note">没有改动文件</div>
  return (
    <>
      <ul className="art-pv-files" aria-label="改动文件">
        {files.map((f) => (
          <li key={f.path} data-status={f.status}>
            <span className="art-pv-st" title={fileStatusLabel(f.status)}>{f.status}</span>
            {onPick
              ? <button type="button" className="art-pv-fname ellipsis" title={f.old_path ? `${f.old_path} → ${f.path}` : f.path} onClick={() => onPick(f.path)}>{f.old_path ? `${f.old_path} → ${f.path}` : f.path}</button>
              : <span className="art-pv-fname ellipsis" title={f.path}>{f.old_path ? `${f.old_path} → ${f.path}` : f.path}</span>}
            <span className="art-pv-delta">{fileDelta(f)}</span>
          </li>
        ))}
      </ul>
      {truncated && <div className="art-pv-note">改动文件太多，只列了前 {files.length} 个</div>}
    </>
  )
}

function CommitBody({ c }: { c: ArtifactCommit }) {
  const chunks = splitDiff(c.diff)
  const box = useRef<HTMLDivElement>(null)
  const jump = (path: string) => {
    const i = chunks.findIndex((x) => x.path === path)
    box.current?.querySelector(`[data-diff-index="${i}"]`)?.scrollIntoView?.({ block: 'start', behavior: 'smooth' })
  }
  return (
    <div className="art-pv-commit" ref={box}>
      <div className="art-pv-cmeta">
        <span className="art-sha" title={c.sha}>{shortSha(c.sha)}</span>
        <span>{c.author}</span>
        <span title={new Date(c.authored_at).toLocaleString('zh-CN')}>{timeAgo(c.authored_at)}</span>
        <code className="ellipsis" title={c.repo}>{c.repo}</code>
      </div>
      <h3 className="art-pv-subject">{c.subject}</h3>
      {c.body && <pre className="art-pv-msg">{c.body}</pre>}
      <FileList files={c.files} truncated={c.files_truncated} onPick={jump} />
      {c.truncated && <div className="art-pv-note">改动太大，diff 只显示开头 {Math.round(c.limit / 1024)} KB</div>}
      <div className="art-pv-diff" aria-label="改动内容">
        {chunks.map((d, i) => (
          <pre key={i} className="art-pv-chunk" data-diff-index={i}>
            {d.lines.map((l, j) => <span key={j} className={`dl dl-${l.kind}`}>{l.text}{'\n'}</span>)}
          </pre>
        ))}
        {!chunks.length && <div className="art-pv-note">这次提交没有文本改动</div>}
      </div>
    </div>
  )
}

function CommitView({ id, sha }: { id: string; sha?: string }) {
  const q = useArtifactCommit(id, sha)
  if (q.isPending) return <div className="art-pv-empty">正在读取提交</div>
  if (q.isError) return <Problem onRetry={() => void q.refetch()}>{viewErrorText(q.error)}</Problem>
  return <CommitBody c={q.data} />
}

// --- 分支 ---

function BranchView({ id }: { id: string }) {
  const q = useArtifactBranch(id)
  const [sha, setSha] = useState('')
  if (sha) {
    return (
      <div className="art-pv-stack">
        <div className="art-pv-back"><Button size="sm" variant="ghost" onClick={() => setSha('')}>返回分支</Button></div>
        <CommitView id={id} sha={sha} />
      </div>
    )
  }
  if (q.isPending) return <div className="art-pv-empty">正在读取分支</div>
  if (q.isError) return <Problem onRetry={() => void q.refetch()}>{viewErrorText(q.error)}</Problem>
  const b = q.data
  return (
    <div className="art-pv-commit">
      <div className="art-pv-cmeta">
        <span>相对 <b>{b.base}</b>：多 {b.ahead} 个提交{b.behind > 0 && `，落后 ${b.behind} 个`}</span>
        <code className="ellipsis" title={b.repo}>{b.repo}</code>
      </div>
      {b.ref === `refs/remotes/origin/${b.branch}` && <div className="art-pv-note">本地没有这个分支，看的是 origin/{b.branch}</div>}
      <h3 className="art-pv-h">提交</h3>
      {!b.commits.length
        ? <div className="art-pv-note">{b.branch === b.base ? '这就是主分支，没有可对比的提交' : `没有 ${b.base} 上没有的提交（可能已经合并）`}</div>
        : (
          <ul className="art-pv-commits" aria-label="分支提交">
            {b.commits.map((c) => (
              <li key={c.sha}>
                <span className="art-sha" title={c.sha}>{shortSha(c.sha)}</span>
                <button type="button" className="art-pv-fname ellipsis" title="看这次提交的改动" onClick={() => setSha(c.sha)}>{c.subject}</button>
                <span className="art-pv-by">{c.author} · {timeAgo(c.authored_at)}</span>
              </li>
            ))}
          </ul>
        )}
      {b.commits_truncated && <div className="art-pv-note">只列了最近 {b.commits.length} 个提交</div>}
      <h3 className="art-pv-h">改动文件（相对分叉点）</h3>
      <FileList files={b.files} truncated={b.files_truncated} />
    </div>
  )
}
