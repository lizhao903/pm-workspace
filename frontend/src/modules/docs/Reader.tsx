// 阅读区（SPEC-library-1.15 到 1.24）：工具条（类型、路径、目录下拉、字号、复制、星标）、标题、元信息、标签、正文、右侧目录。
// 写法照原型 library.tsx 的 LibraryReader。本地文件打开时才读内容（/api/fs/read）。
// 工作台文档多「编辑」「修订」（SPEC-library-1.41、1.47）；本地文件只读，没有这两个。
// 归到项目的工作台文档，工具条上显示所属项目，点了去项目的文档标签（SPEC-library-1.52，C-04）。
import { useEffect, useMemo, useRef, useState } from 'react'
import { errorText, isApiError, useLocalFile, type LocalFile } from '../../core/data'
import { Button, cls, Markdown, mdHeadings, Tag } from '../../core/ui'
import { charCount, timeAgo, type Doc, type LibraryModel } from './model'
import { DocRevisions } from './Revisions'
import { StarIcon } from './Tree'

type FontSize = 'sm' | 'md' | 'lg'
const SIZE_KEY = 'pmw-reader-size'
const SIZE_LABEL: Record<FontSize, string> = { sm: '小', md: '中', lg: '大' }
/** 标题 id 的前缀，免得和页面上别的 id 撞 */
const HEAD_ID = 'doc-h'
// 工作台文档来源的显示名（任务来源见契约「任务来源」）；空的老数据不显示，不认识的原样显示
const DOC_SOURCE: Record<string, string> = {
  manual: '手动', import: '导入', im: 'IM 消息', webhook: 'Webhook', schedule: '定时', incident: '运行异常', agent: 'Agent', mcp: 'MCP 回写',
}

function readSize(): FontSize {
  try {
    const v = localStorage.getItem(SIZE_KEY)
    return v === 'sm' || v === 'lg' ? v : 'md'
  } catch {
    return 'md'
  }
}

/** 本地文件读不到时说清原因 */
function fileError(e: unknown): string {
  if (isApiError(e) && e.status === 403) return `不能读这个文件：${e.message}`
  if (isApiError(e, 'not_found')) return '文件已经不在了，点顶栏的刷新重新读一遍目录'
  return `读取失败：${errorText(e)}`
}

export function LibraryReader({ model, current, statusLabel, catName, onBack, onStar, starring, onEdit, projectOf, onProject }: {
  model: LibraryModel
  current: Doc | null
  /** 工作台文档的状态显示名，从对象类型读 */
  statusLabel: (key: string) => string
  /** 分类 id 的显示名，修订记录用 */
  catName: (id: string) => string
  onBack: () => void
  onStar: (doc: Doc) => void
  starring: boolean
  onEdit: (doc: Doc) => void
  /** 项目当前的名字、还在不在（进了回收站就不在） */
  projectOf: (id: string) => { name: string; live: boolean }
  onProject: (id: string) => void
}) {
  const { rows, folder } = model
  const [size, setSize] = useState<FontSize>(readSize)
  // 「已复制」和目录下拉只对当时那篇有效，换文档自然复原（SPEC-library-1.24）
  const [copiedOf, setCopiedOf] = useState<{ id: string; ok: boolean } | null>(null)
  const [tocOf, setTocOf] = useState<string | null>(null)
  const [revOf, setRevOf] = useState<string | null>(null)
  const id = current?.id ?? ''
  const copied = copiedOf?.id === id ? (copiedOf.ok ? 'ok' : 'fail') : ''
  const tocOpen = tocOf === id
  const revOpen = revOf === id
  const setCopied = (ok: boolean) => setCopiedOf({ id, ok })
  const setTocOpen = (open: boolean) => setTocOf(open ? id : null)
  const readerRef = useRef<HTMLDivElement>(null)
  const file = useLocalFile(current?.path ?? null)
  // keepPreviousData 下换文件的一瞬间还是上一个文件的内容，按路径对上才用
  const loaded: LocalFile | undefined = file.data && file.data.path === current?.path ? file.data : undefined

  useEffect(() => {
    try { localStorage.setItem(SIZE_KEY, size) } catch { /* 拿不到存储就只在本次会话生效 */ }
  }, [size])
  useEffect(() => { readerRef.current?.scrollTo?.({ top: 0 }) }, [id])

  const body = current?.path ? loaded?.content : current?.body
  const markdown = !!current?.markdown && !loaded?.binary
  const headings = useMemo(() => (markdown && body ? mdHeadings(body, HEAD_ID) : []), [markdown, body])
  const jump = (id: string) => { document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); setTocOpen(false) }

  const copy = () => {
    if (!current || body === undefined) return
    const text = folder ? body : `${current.title}\n\n${body}`
    if (!navigator.clipboard) { setCopied(false); return }
    navigator.clipboard.writeText(text).then(() => setCopied(true), () => setCopied(false))
  }

  if (!current) {
    return (
      <div className="lib-reader" ref={readerRef}>
        <div className="lib-reader-empty">{rows.length ? '从左侧选一条内容查看' : '没有可查看的内容'}</div>
      </div>
    )
  }

  const updated = current.path && loaded ? new Date(loaded.modified).getTime() : current.updated
  let content
  if (current.path && !loaded) {
    content = file.isError
      ? <div className="lib-file-note lib-file-err" role="alert">{fileError(file.error)} <Button size="sm" onClick={() => void file.refetch()}>重试</Button></div>
      : <div className="lib-file-note">正在读取…</div>
  } else if (loaded?.binary) {
    content = <div className="lib-file-note">这是二进制文件，不显示内容</div>
  } else if (markdown) {
    content = <Markdown source={body ?? ''} top={2} headingIds={HEAD_ID} empty="这篇还没有正文" />
  } else {
    content = <pre className="md plain-text">{body}</pre>
  }

  return (
    <div className="lib-reader" ref={readerRef}>
      <div className="reader-grid">
        <article className={`reader reader-${size}`} aria-label={current.title}>
          <Button variant="ghost" className="reader-back" onClick={onBack}>
            <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M10 3 5 8l5 5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
            返回目录
          </Button>
          <div className="reader-toolbar">
            <span className="lib-cat">{current.kindLabel}</span>
            {current.status && <span className="lib-cat">{statusLabel(current.status)}</span>}
            {current.project && <ProjectChip project={current.project} of={projectOf} onOpen={onProject} />}
            {current.dirs.length > 0 && (folder || current.dirs.length > 1) && (
              <span className="reader-crumb ellipsis" title={current.dirs.join(' / ')}>{current.dirs.join(' / ')}</span>
            )}
            <span className="spacer" />
            {/* 阅读区窄、右侧目录被收起时，目录改成这里的下拉 */}
            {headings.length > 1 && (
              <div className="menu-wrap toc-menu">
                <button type="button" className="act" aria-expanded={tocOpen} onClick={() => setTocOpen(!tocOpen)}>目录</button>
                {tocOpen && (
                  <div className="menu">
                    {headings.map((h) => (
                      <button type="button" key={h.id} className={`menu-item toc-l${h.level}`} onClick={() => jump(h.id)}>{h.text}</button>
                    ))}
                  </div>
                )}
              </div>
            )}
            <div className="seg seg-sm" role="radiogroup" aria-label="正文字号">
              {(['sm', 'md', 'lg'] as FontSize[]).map((s) => (
                <button type="button" key={s} role="radio" aria-checked={size === s} className={cls(size === s && 'on')} onClick={() => setSize(s)}>{SIZE_LABEL[s]}</button>
              ))}
            </div>
            <button type="button" className="act" onClick={copy} disabled={body === undefined}>
              {copied === 'ok' ? '已复制' : copied === 'fail' ? '复制失败' : '复制全文'}
            </button>
            {current.starred !== undefined && (
              <button type="button" className={cls('star-btn', current.starred && 'on')} onClick={() => onStar(current)} disabled={starring}
                aria-pressed={current.starred} aria-label={current.starred ? '取消星标' : '加星标'} title={current.starred ? '取消星标' : '加星标'}>
                <StarIcon size={15} on={current.starred} />
              </button>
            )}
            {!current.path && (
              <>
                <button type="button" className="act" aria-expanded={revOpen} onClick={() => setRevOf(revOpen ? null : id)}>修订</button>
                <button type="button" className="act" onClick={() => onEdit(current)}>编辑</button>
              </>
            )}
          </div>
          <h1 className="reader-title">{current.title}</h1>
          <div className="reader-meta">
            {/* 本地文件的 meta 是路径和大小；工作台文档的是来源 key，换成显示名 */}
            {(current.path ? current.meta : current.meta.map((m) => DOC_SOURCE[m] ?? m)).filter(Boolean)
              .map((m) => <span key={m} className="reader-meta-item">{m}</span>)}
            <span>{folder ? '修改于' : '更新于'} {timeAgo(updated)}</span>
            {body !== undefined && !loaded?.binary && <span>{charCount(body)} 字</span>}
          </div>
          {current.tags.length > 0 && <div className="tags reader-tags">{current.tags.map((t) => <Tag key={t}>{t}</Tag>)}</div>}
          {loaded?.truncated && <div className="lib-file-note">文件超过 {Math.round(loaded.limit / 1024 / 1024)} MB，只显示开头</div>}
          <div className="reader-body">{content}</div>
          {revOpen && !current.path && <DocRevisions id={current.id} catName={catName} statusLabel={statusLabel} />}
        </article>
        {headings.length > 1 && (
          <aside className="toc" aria-label="标题导航">
            <div className="toc-title">目录</div>
            {headings.map((h) => (
              <button type="button" key={h.id} className={`toc-item toc-l${h.level}`} onClick={() => jump(h.id)}>{h.text}</button>
            ))}
          </aside>
        )}
      </div>
    </div>
  )
}

/** 所属项目：项目还在就是按钮，去项目的文档标签；不在了显示原名并注明 */
function ProjectChip({ project, of, onOpen }: {
  project: { id: string; name: string }
  of: (id: string) => { name: string; live: boolean }
  onOpen: (id: string) => void
}) {
  const p = of(project.id)
  const name = p.name || project.name || '已删除的项目'
  if (!p.live) return <span className="lib-cat lib-proj lib-proj-gone" title="所属项目已经不在了">{name}（已删除）</span>
  return (
    <button type="button" className="lib-cat lib-proj" onClick={() => onOpen(project.id)} title={`去项目「${name}」的文档`}>
      <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true"><path d="M2 4.5c0-.6.4-1 1-1h3l1.3 1.4H13c.6 0 1 .4 1 1V12c0 .6-.4 1-1 1H3c-.6 0-1-.4-1-1Z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" /></svg>
      {name}
    </button>
  )
}
