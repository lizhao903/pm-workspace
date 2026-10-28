import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { CONTENT_CATEGORIES, type ContentCategory, type ContentItem } from './data'
import { isMarkdown, type LocalFolder } from './localdir'
import { Star, cls, timeAgo } from './ui'
import { useEnumView } from './enumdata'

// 内容页三块：左边二级菜单是当前工作目录的内容树，底部切换工作目录；
// 顶栏放目录名和筛选；右边阅读区。工作台自带的内容也算一个工作目录，分类就是它的一级文件夹

/** 工作目录：工作台文档，或者一个选进来的本地目录 */
export type Workspace = 'builtin' | `dir:${string}`

// 默认显示名；页面上实际显示的名字和顺序由 useCategoryModel 按「文档分类」枚举换掉
const categoryLabel = (k: ContentCategory) => CONTENT_CATEGORIES.find((c) => c.key === k)?.label ?? k
const charCount = (s: string) => s.replace(/[#>*`\-\s]/g, '').length
const fileSize = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`)

/* ---------- 轻量 Markdown ---------- */

// 只认正文里实际用到的几种写法；直接产出 React 元素，不走 innerHTML，正文里写什么都不会被当成标签执行

function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean).map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**')) return <strong key={i}>{part.slice(2, -2)}</strong>
    if (part.startsWith('`') && part.endsWith('`')) return <code key={i}>{part.slice(1, -1)}</code>
    return part
  })
}

interface Heading { id: string; level: number; text: string }

function renderMarkdown(src: string): { nodes: ReactNode[]; headings: Heading[] } {
  const lines = src.split('\n')
  const nodes: ReactNode[] = []
  const headings: Heading[] = []
  let i = 0
  const k = () => `b${nodes.length}`
  while (i < lines.length) {
    const line = lines[i]
    if (line.startsWith('```')) {
      const buf: string[] = []
      i += 1
      while (i < lines.length && !lines[i].startsWith('```')) { buf.push(lines[i]); i += 1 }
      i += 1
      nodes.push(<pre key={k()}><code>{buf.join('\n')}</code></pre>)
      continue
    }
    const h = /^(#{1,3})\s+(.*)$/.exec(line)
    if (h) {
      const id = `h${headings.length}`
      headings.push({ id, level: h[1].length, text: h[2] })
      const Tag = (['h2', 'h3', 'h4'] as const)[h[1].length - 1]
      nodes.push(<Tag key={k()} id={id}>{inline(h[2])}</Tag>)
      i += 1
      continue
    }
    const collect = (re: RegExp) => {
      const buf: string[] = []
      while (i < lines.length && re.test(lines[i])) { buf.push(lines[i].replace(re, '')); i += 1 }
      return buf
    }
    if (/^-\s+/.test(line)) { nodes.push(<ul key={k()}>{collect(/^-\s+/).map((t, j) => <li key={j}>{inline(t)}</li>)}</ul>); continue }
    if (/^\d+\.\s+/.test(line)) { nodes.push(<ol key={k()}>{collect(/^\d+\.\s+/).map((t, j) => <li key={j}>{inline(t)}</li>)}</ol>); continue }
    if (/^>\s?/.test(line)) { nodes.push(<blockquote key={k()}>{collect(/^>\s?/).map((t, j) => <p key={j}>{inline(t)}</p>)}</blockquote>); continue }
    if (!line.trim()) { i += 1; continue }
    // 连续的普通行合成一段
    const buf: string[] = []
    while (i < lines.length && lines[i].trim() && !/^(#{1,3}\s|-\s|\d+\.\s|>|```)/.test(lines[i])) { buf.push(lines[i]); i += 1 }
    nodes.push(<p key={k()}>{inline(buf.join(' '))}</p>)
  }
  return { nodes, headings }
}

/* ---------- 数据：工作台文档和本地文件都转成 Doc ---------- */

export interface Doc {
  id: string
  title: string
  body: string
  markdown: boolean
  /** 筛选用的 key：工作台文档是分类，本地文件是扩展名 */
  kind: string
  kindLabel: string
  updated: number
  meta: string[]
  /** 在树里的文件夹路径 */
  dirs: string[]
  tags: string[]
  starred?: boolean
}

const fromItem = (i: ContentItem): Doc => ({
  id: i.id, title: i.title, body: i.body, markdown: true, kind: i.category, kindLabel: categoryLabel(i.category),
  updated: new Date(i.updated_at).getTime(), meta: [i.source], dirs: [categoryLabel(i.category)], tags: i.tags, starred: i.starred,
})

const fromFolder = (f: LocalFolder): Doc[] => f.files.map((file) => ({
  id: `${f.id}:${file.path}`, title: file.name, body: file.text, markdown: isMarkdown(file.ext),
  kind: file.ext, kindLabel: file.ext.toUpperCase(), updated: file.modified,
  meta: [`${f.name}/${file.path}`, fileSize(file.size)], dirs: file.path.split('/').slice(0, -1), tags: [],
}))

export interface LibraryModel {
  folder: LocalFolder | null
  title: string
  docs: Doc[]
  /** 顶栏筛选项；「全部」由界面自己加 */
  kinds: { key: string; label: string; count: number }[]
  rows: Doc[]
  /** 内容树一级文件夹的顺序（显示名）；本地目录不用 */
  order?: string[]
}

export function libraryModel(ws: Workspace, items: ContentItem[], folders: LocalFolder[], kind: string, q: string): LibraryModel {
  const folder = ws === 'builtin' ? null : folders.find((f) => `dir:${f.id}` === ws) ?? null
  const docs = folder ? fromFolder(folder) : items.map(fromItem).sort((a, b) => b.updated - a.updated)
  const count = (k: string) => docs.filter((d) => d.kind === k).length
  // 工作台固定列出全部分类（空的也列，说明有这一类），本地目录只列实际出现的扩展名
  const kinds = folder
    ? [...new Set(docs.map((d) => d.kind))].sort().map((k) => ({ key: k, label: k.toUpperCase(), count: count(k) }))
    : [{ key: 'starred', label: '星标', count: docs.filter((d) => d.starred).length },
      ...CONTENT_CATEGORIES.map((c) => ({ key: c.key as string, label: c.label, count: count(c.key) }))]
  const kw = q.trim().toLowerCase()
  const rows = docs.filter((d) => (!kind || (kind === 'starred' ? d.starred : d.kind === kind))
    && (!kw || [d.title, d.body, d.dirs.join('/'), ...d.tags].some((v) => v.toLowerCase().includes(kw))))
  return { folder, title: folder ? folder.name : '工作台文档', docs, kinds, rows }
}

/** libraryModel 由 App 直接调用，拿不到枚举 context；组件里再按枚举换一遍分类显示名和顺序。
 *  停用的分类在没有文档时不再列出，有文档的照常显示 */
function useCategoryModel(model: LibraryModel): LibraryModel {
  const e = useEnumView('content_category')
  return useMemo(() => {
    if (model.folder) return model
    const fix = (d: Doc): Doc => ({ ...d, kindLabel: e.label(d.kind), dirs: [e.label(d.kind)] })
    const count = (k: string) => model.docs.filter((d) => d.kind === k).length
    const known = e.items.map((i) => i.key)
    const extra = [...new Set(model.docs.map((d) => d.kind))].filter((k) => !known.includes(k))
    const kinds = [
      ...model.kinds.filter((k) => k.key === 'starred'),
      ...e.items.filter((i) => i.enabled || count(i.key) > 0).map((i) => ({ key: i.key, label: i.label, count: count(i.key) })),
      ...extra.map((k) => ({ key: k, label: k, count: count(k) })),
    ]
    return { ...model, docs: model.docs.map(fix), rows: model.rows.map(fix), kinds, order: [...e.items.map((i) => i.label), ...extra] }
  }, [model, e])
}

/* ---------- 顶栏：目录名 + 筛选 ---------- */

export function LibraryBar({ model, kind, onKind, onRefresh }: {
  model: LibraryModel
  kind: string
  onKind: (k: string) => void
  onRefresh: (folderId: string) => void
}) {
  model = useCategoryModel(model)
  const { folder } = model
  return (
    <div className="lib-bar">
      <div className="lib-bar-title">
        <span className="ellipsis" title={folder ? `${folder.name}，读取于 ${timeAgo(new Date(folder.read_at).toISOString())}` : undefined}>{model.title}</span>
        {folder?.handle && (
          <button className="icon-btn icon-btn-sm" onClick={() => onRefresh(folder.id)} title="目录里的文件有改动时重新读一遍">
            <svg viewBox="0 0 16 16" width="13" height="13"><path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5v2.8h-2.8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </button>
        )}
      </div>
      {model.kinds.length > 1 && (
        <div className="filter-row" role="group" aria-label={folder ? '按文件类型筛选' : '按分类筛选'}>
          <button className={cls('fchip', !kind && 'on')} onClick={() => onKind('')}>全部<span className="seg-n">{model.docs.length}</span></button>
          {model.kinds.map((k) => (
            <button key={k.key} className={cls('fchip', kind === k.key && 'on')} onClick={() => onKind(kind === k.key ? '' : k.key)}>
              {k.label}<span className="seg-n">{k.count}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/* ---------- 二级菜单：内容树 + 底部切换工作目录 ---------- */

interface TreeDir { name: string; path: string; dirs: TreeDir[]; files: Doc[]; count: number }

function buildTree(rows: Doc[], order?: string[]): TreeDir {
  const root: TreeDir = { name: '', path: '', dirs: [], files: [], count: 0 }
  for (const d of rows) {
    let node = root
    node.count += 1
    for (const seg of d.dirs) {
      let next = node.dirs.find((x) => x.name === seg)
      if (!next) { next = { name: seg, path: node.path ? `${node.path}/${seg}` : seg, dirs: [], files: [], count: 0 }; node.dirs.push(next) }
      next.count += 1
      node = next
    }
    node.files.push(d)
  }
  // 工作台的一级文件夹按分类表的顺序，其余按名字
  const sort = (n: TreeDir, depth: number) => {
    n.dirs.sort((a, b) => (depth === 0 && order ? order.indexOf(a.name) - order.indexOf(b.name) : a.name.localeCompare(b.name)))
    n.dirs.forEach((x) => sort(x, depth + 1))
  }
  sort(root, 0)
  return root
}

const MAX_INDENT = 4
const chevron = <svg viewBox="0 0 16 16" width="10" height="10"><path d="m6 3.5 4.5 4.5L6 12.5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>
const fileIcon = <svg viewBox="0 0 16 16" width="13" height="13"><path d="M4 1.8h5.5L12.5 5v9.2H4Z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" /><path d="M9.3 2v3.2h3" fill="none" stroke="currentColor" strokeWidth="1.3" /></svg>
const folderIcon = <svg viewBox="0 0 16 16" width="13" height="13"><path d="M1.8 4.2c0-.6.4-1 1-1h3.4l1.5 1.6h5.5c.6 0 1 .4 1 1v6.9c0 .6-.4 1-1 1H2.8c-.6 0-1-.4-1-1Z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" /></svg>

export function LibraryTree({ ws, model, items, folders, selected, onSelect, onSwitch, onAddFolder, onRemoveFolder, q, onQ, adding, error }: {
  ws: Workspace
  model: LibraryModel
  items: ContentItem[]
  folders: LocalFolder[]
  selected: string | null
  onSelect: (id: string) => void
  onSwitch: (ws: Workspace) => void
  onAddFolder: () => void
  onRemoveFolder: (id: string) => void
  q: string
  onQ: (q: string) => void
  adding: boolean
  error: string
}) {
  // 记「展开了哪些」：默认都收起，只展开当前阅读文档所在的那条路径
  const [opened, setOpened] = useState<Set<string>>(new Set())
  const [menu, setMenu] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  model = useCategoryModel(model)
  const tree = useMemo(() => buildTree(model.rows, model.folder ? undefined : model.order), [model.rows, model.folder, model.order])
  // 搜索时全部展开，否则命中的条目可能藏在收起的文件夹里
  const searching = !!q.trim()

  const selDirs = model.docs.find((d) => d.id === selected)?.dirs
  const selPath = selDirs?.join('/') ?? ''
  const lastWs = useRef(ws)
  useEffect(() => {
    // 换了工作目录先全部收起；再把当前文档的各级父目录展开
    const reset = lastWs.current !== ws
    lastWs.current = ws
    const anc = selPath ? selPath.split('/').map((_, i, xs) => xs.slice(0, i + 1).join('/')) : []
    setOpened((s) => { const n = reset ? new Set<string>() : new Set(s); anc.forEach((x) => n.add(x)); return n })
  }, [ws, selPath])
  useEffect(() => {
    if (!menu) return
    const off = (e: MouseEvent) => { if (!menuRef.current?.contains(e.target as Node)) setMenu(false) }
    window.addEventListener('mousedown', off)
    return () => window.removeEventListener('mousedown', off)
  }, [menu])

  const toggle = (p: string) => setOpened((s) => { const n = new Set(s); if (n.has(p)) n.delete(p); else n.add(p); return n })
  // 缩进最多 4 层，再深的文件夹前面用「…/」表示省略的上层
  const indent = (depth: number) => 8 + Math.min(depth, MAX_INDENT) * 14

  const renderDir = (dir: TreeDir, depth: number): ReactNode => (
    <>
      {dir.dirs.map((d) => {
        const open = searching || opened.has(d.path)
        return (
          <div key={d.path} role="group">
            <button className="tree-row tree-dir" style={{ paddingLeft: indent(depth) }} onClick={() => toggle(d.path)} aria-expanded={open} title={depth > MAX_INDENT ? d.path : undefined}>
              <span className={cls('tree-chev', open && 'open')}>{chevron}</span>
              <span className="tree-icon">{folderIcon}</span>
              <span className="ellipsis tree-label">{depth > MAX_INDENT && <span className="tree-elide">…/</span>}{d.name}</span>
              <span className="tree-count">{d.count}</span>
            </button>
            {open && renderDir(d, depth + 1)}
          </div>
        )
      })}
      {dir.files.map((f) => (
        <button key={f.id} className={cls('tree-row tree-file', selected === f.id && 'sel')} style={{ paddingLeft: indent(depth) + 16 }} onClick={() => onSelect(f.id)} title={f.title}>
          <span className="tree-icon">{fileIcon}</span>
          <span className="ellipsis tree-label">{f.title}</span>
          {f.starred && <span className="lib-star" aria-label="星标"><svg viewBox="0 0 16 16" width="10" height="10"><path d="m8 1.8 1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.6l-3.8 2 .7-4.3-3.1-3 4.3-.6Z" fill="currentColor" /></svg></span>}
        </button>
      ))}
    </>
  )

  const pick = (w: Workspace) => { setMenu(false); onSwitch(w) }

  return (
    <nav className="subnav tree-nav">
      <div className="tree-head">
        <div className="search search-full search-sm">
          <svg viewBox="0 0 16 16" width="13" height="13"><circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
          <input placeholder={model.folder ? '搜索文件名、路径、正文' : '搜索标题、正文、标签'} value={q} onChange={(e) => onQ(e.target.value)} />
        </div>
      </div>
      <div className="tree" role="tree">
        {model.rows.length === 0
          ? <div className="tree-empty">{q.trim() ? '没有匹配的内容' : model.folder ? '这个目录下没有可读的文本文件' : '这个分类下还没有内容'}</div>
          : renderDir(tree, 0)}
      </div>

      <div className="ws-switch" ref={menuRef}>
        {menu && (
          <div className="menu menu-up" role="menu">
            <div className="menu-label">切换工作目录</div>
            <button className={cls('menu-item', ws === 'builtin' && 'on')} onClick={() => pick('builtin')}>
              <span className="tree-icon">{folderIcon}</span>
              <span className="ellipsis">工作台文档</span>
            </button>
            {folders.map((f) => (
              <div key={f.id} className={cls('menu-item ws-item', ws === `dir:${f.id}` && 'on')}>
                <button className="ws-pick" onClick={() => pick(`dir:${f.id}`)} title={f.handle ? f.name : `${f.name}（只读快照，看新改动需重新选择）`}>
                  <span className="tree-icon">{folderIcon}</span>
                  <span className="ellipsis">{f.name}</span>
                </button>
                <button className="ws-remove" title="从列表移除，不动本地文件" onClick={() => onRemoveFolder(f.id)}>
                  <svg viewBox="0 0 16 16" width="11" height="11"><path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
                </button>
              </div>
            ))}
            <div className="menu-sep" />
            <button className="menu-item" disabled={adding} onClick={() => { setMenu(false); onAddFolder() }}>
              <svg viewBox="0 0 16 16" width="13" height="13"><path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
              {adding ? '正在读取…' : '选择本地目录…'}
            </button>
          </div>
        )}
        {error && <div className="subnav-error">{error}</div>}
        <button className={cls('ws-btn', menu && 'open')} onClick={() => setMenu(!menu)} aria-haspopup="menu" aria-expanded={menu}>
          <span className="tree-icon">{folderIcon}</span>
          <span className="ws-btn-text">
            <span className="ws-btn-kicker" title={model.folder?.skipped ? `跳过了 ${model.folder.skipped} 个非文本或过大的文件` : undefined}>工作目录{model.folder && model.folder.skipped > 0 && ` · 跳过 ${model.folder.skipped} 个`}</span>
            <span className="ellipsis">{adding ? '正在读取…' : model.title}</span>
          </span>
          <svg className="ws-btn-chev" viewBox="0 0 16 16" width="12" height="12"><path d="m4 10 4-4 4 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
      </div>
    </nav>
  )
}

/* ---------- 阅读区 ---------- */

type FontSize = 'sm' | 'md' | 'lg'

export function LibraryReader({ model, selected, onSelect, onStar }: {
  model: LibraryModel
  selected: string | null
  onSelect: (id: string | null) => void
  onStar: (id: string) => void
}) {
  model = useCategoryModel(model)
  const { rows, folder } = model
  const [size, setSize] = useState<FontSize>(() => {
    try { return (localStorage.getItem('pmw-next-reader-size') as FontSize) || 'md' } catch { return 'md' }
  })
  const [copied, setCopied] = useState(false)
  const [tocOpen, setTocOpen] = useState(false)
  const readerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    try { localStorage.setItem('pmw-next-reader-size', size) } catch { /* 拿不到存储就只在本次会话生效 */ }
  }, [size])

  // 当前选中的不在筛选结果里（换了目录或筛选）就落到第一条；宽屏下右侧不留空，手机上留在内容树
  const current = rows.find((r) => r.id === selected) ?? null
  useEffect(() => {
    if (!current && rows.length && window.matchMedia('(min-width: 761px)').matches) onSelect(rows[0].id)
  }, [current, rows, onSelect])
  useEffect(() => { readerRef.current?.scrollTo({ top: 0 }); setCopied(false); setTocOpen(false) }, [current?.id])
  const jump = (id: string) => { document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); setTocOpen(false) }

  const md = useMemo(() => (current?.markdown ? renderMarkdown(current.body) : null), [current])
  const headings = md?.headings ?? []

  const copy = () => {
    if (!current) return
    navigator.clipboard?.writeText(folder ? current.body : `${current.title}\n\n${current.body}`)
      .then(() => setCopied(true), () => setCopied(false))
  }

  return (
    <div className="lib-reader" ref={readerRef}>
      {!current ? (
        <div className="lib-reader-empty">{rows.length ? '从左侧选一条内容查看' : '没有可查看的内容'}</div>
      ) : (
        <div className="reader-grid">
          <article className={`reader reader-${size}`}>
            <button className="btn btn-ghost reader-back" onClick={() => onSelect(null)}>
              <svg viewBox="0 0 16 16" width="13" height="13"><path d="M10 3 5 8l5 5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
              返回目录
            </button>
            <div className="reader-toolbar">
              <span className="lib-cat">{current.kindLabel}</span>
              {current.dirs.length > 0 && folder && <span className="reader-crumb ellipsis">{current.dirs.join(' / ')}</span>}
              <span className="spacer" />
              {/* 阅读区窄、右侧目录被收起时，目录改成这里的下拉 */}
              {headings.length > 1 && (
                <div className="menu-wrap toc-menu">
                  <button className="act" onClick={() => setTocOpen(!tocOpen)}>目录</button>
                  {tocOpen && (
                    <div className="menu">
                      {headings.map((h) => (
                        <button key={h.id} className={`menu-item toc-l${h.level}`} onClick={() => jump(h.id)}>{h.text}</button>
                      ))}
                    </div>
                  )}
                </div>
              )}
              <div className="seg seg-sm" title="正文字号">
                {(['sm', 'md', 'lg'] as FontSize[]).map((s) => (
                  <button key={s} className={cls(size === s && 'on')} onClick={() => setSize(s)}>{{ sm: '小', md: '中', lg: '大' }[s]}</button>
                ))}
              </div>
              <button className="act" onClick={copy}>{copied ? '已复制' : '复制全文'}</button>
              {current.starred !== undefined && <Star on={current.starred} onClick={() => onStar(current.id)} />}
            </div>
            <h1 className="reader-title">{current.title}</h1>
            <div className="reader-meta">
              {current.meta.map((m) => <span key={m} className="reader-meta-item">{m}</span>)}
              <span>{folder ? '修改于' : '更新于'} {timeAgo(new Date(current.updated).toISOString())}</span>
              <span>{charCount(current.body)} 字</span>
            </div>
            {current.tags.length > 0 && <div className="tags reader-tags">{current.tags.map((t) => <span key={t} className="tag">{t}</span>)}</div>}
            {md ? <div className="md">{md.nodes}</div> : <pre className="md plain-text">{current.body}</pre>}
          </article>
          {headings.length > 1 && (
            <aside className="toc">
              <div className="toc-title">目录</div>
              {headings.map((h) => (
                <button key={h.id} className={`toc-item toc-l${h.level}`} onClick={() => jump(h.id)}>
                  {h.text}
                </button>
              ))}
            </aside>
          )}
        </div>
      )}
    </div>
  )
}
