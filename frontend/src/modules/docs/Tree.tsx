// 内容树（SPEC-library-1.1 到 1.11）：搜索框、按文件夹分组的文档树、底部切换工作目录。
// 写法照原型 web-next/src/library.tsx 的 LibraryTree。1000 篇也不平铺：文件夹默认收起，
// 一个文件夹里的文件先显示前 FILE_PAGE 条，其余点「再显示」。
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { LocalDir } from '../../core/data'
import { cls } from '../../core/ui'
import { ancestors, buildTree, BUILTIN, dirWs, emptyText, type Filter, type LibraryModel, type TreeDir, type Workspace } from './model'

const MAX_INDENT = 4
/** 一个文件夹先显示多少个文件 */
const FILE_PAGE = 100

const chevron = <svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true"><path d="m6 3.5 4.5 4.5L6 12.5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>
const fileIcon = <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M4 1.8h5.5L12.5 5v9.2H4Z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" /><path d="M9.3 2v3.2h3" fill="none" stroke="currentColor" strokeWidth="1.3" /></svg>
const folderIcon = <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M1.8 4.2c0-.6.4-1 1-1h3.4l1.5 1.6h5.5c.6 0 1 .4 1 1v6.9c0 .6-.4 1-1 1H2.8c-.6 0-1-.4-1-1Z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" /></svg>
/** 星标；on 为实心 */
export function StarIcon({ size, on = true }: { size: number; on?: boolean }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden="true">
      <path d="m8 1.8 1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.6l-3.8 2 .7-4.3-3.1-3 4.3-.6Z" fill={on ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={on ? 0 : 1.3} strokeLinejoin="round" />
    </svg>
  )
}

export function LibraryTree({ ws, model, filter, dirs, selected, onSelect, onSwitch, onAddFolder, onRemoveFolder, q, onQ, status, kicker, error, mode }: {
  ws: Workspace
  model: LibraryModel
  filter: Filter
  dirs: LocalDir[]
  selected: string | null
  onSelect: (id: string) => void
  onSwitch: (ws: Workspace) => void
  onAddFolder: () => void
  onRemoveFolder: (id: string) => void
  q: string
  onQ: (q: string) => void
  /** 加载中、出错时替换树的内容 */
  status: ReactNode
  /** 工作目录按钮上的小字补充，比如「跳过 N 个」 */
  kicker?: { text: string; title: string }
  error: string
  /** 手机上二选一：内容树还是阅读区 */
  mode: 'tree' | 'reader'
}) {
  // 记「展开了哪些」：默认都收起，只展开当前阅读文档所在的那条路径
  const [opened, setOpened] = useState<Set<string>>(() => new Set())
  // 哪些文件夹点过「再显示」，记显示到第几条
  const [shown, setShown] = useState<Map<string, number>>(() => new Map())
  const [menu, setMenu] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const tree = useMemo(() => buildTree(model.rows, model.folder ? undefined : model.order), [model.rows, model.folder, model.order])
  // 搜索时全部展开，否则命中的条目可能藏在收起的文件夹里
  const searching = !!filter.q.trim()

  const selDirs = model.docs.find((d) => d.id === selected)?.dirs
  const selPath = selDirs?.join('/') ?? ''
  const lastWs = useRef(ws)
  useEffect(() => {
    // 换了工作目录先全部收起；再把当前文档的各级父目录展开
    const reset = lastWs.current !== ws
    lastWs.current = ws
    const anc = selPath ? ancestors(selPath.split('/')) : []
    setOpened((s) => {
      const n = reset ? new Set<string>() : new Set(s)
      anc.forEach((x) => n.add(x))
      return n
    })
    if (reset) setShown(new Map())
  }, [ws, selPath])
  useEffect(() => {
    if (!menu) return
    const off = (e: MouseEvent) => { if (!menuRef.current?.contains(e.target as Node)) setMenu(false) }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(false) }
    window.addEventListener('mousedown', off)
    window.addEventListener('keydown', esc)
    return () => { window.removeEventListener('mousedown', off); window.removeEventListener('keydown', esc) }
  }, [menu])

  const toggle = (p: string) => setOpened((s) => {
    const n = new Set(s)
    if (n.has(p)) n.delete(p)
    else n.add(p)
    return n
  })
  // 缩进最多 4 层，再深的文件夹前面用「…/」表示省略的上层
  const indent = (depth: number) => 8 + Math.min(depth, MAX_INDENT) * 14

  const renderDir = (dir: TreeDir, depth: number): ReactNode => {
    // 当前阅读的文件在后面也照样显示出来，免得选中了却看不到
    const limit = shown.get(dir.path) ?? FILE_PAGE
    const selIdx = dir.files.findIndex((f) => f.id === selected)
    const visible = selIdx >= limit ? [...dir.files.slice(0, limit), dir.files[selIdx]] : dir.files.slice(0, limit)
    const rest = dir.files.length - visible.length
    return (
      <>
        {dir.dirs.map((d) => {
          const open = searching || opened.has(d.path)
          return (
            <div key={d.path} role="group">
              <button type="button" className="tree-row tree-dir" style={{ paddingLeft: indent(depth) }} onClick={() => toggle(d.path)}
                aria-expanded={open} title={depth > MAX_INDENT ? d.path : undefined}>
                <span className={cls('tree-chev', open && 'open')}>{chevron}</span>
                <span className="tree-icon">{folderIcon}</span>
                <span className="ellipsis tree-label">{depth > MAX_INDENT && <span className="tree-elide">…/</span>}{d.name}</span>
                <span className="tree-count">{d.count}</span>
              </button>
              {open && renderDir(d, depth + 1)}
            </div>
          )
        })}
        {visible.map((f) => (
          <button type="button" key={f.id} className={cls('tree-row tree-file', selected === f.id && 'sel')} style={{ paddingLeft: indent(depth) + 16 }}
            onClick={() => onSelect(f.id)} title={f.title} aria-current={selected === f.id || undefined}>
            <span className="tree-icon">{fileIcon}</span>
            <span className="ellipsis tree-label">{f.title}</span>
            {f.starred && <span className="lib-star" aria-label="星标"><StarIcon size={10} /></span>}
          </button>
        ))}
        {rest > 0 && (
          <button type="button" className="tree-row tree-more" style={{ paddingLeft: indent(depth) + 16 }}
            onClick={() => setShown((m) => new Map(m).set(dir.path, limit + FILE_PAGE))}>
            还有 {rest} 篇，再显示 {Math.min(rest, FILE_PAGE)} 篇
          </button>
        )}
      </>
    )
  }

  const pick = (w: Workspace) => { setMenu(false); onSwitch(w) }

  return (
    <nav className="lib-tree" data-lib={mode} aria-label="内容树">
      <div className="tree-head">
        <div className="search search-full search-sm">
          <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
          <input placeholder={model.folder ? '搜索文件名、路径' : '搜索标题、正文、标签'} aria-label="搜索" value={q}
            onChange={(e) => onQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape' && q) { e.preventDefault(); onQ('') } }} />
        </div>
      </div>
      <div className="tree" role="tree">
        {status ?? (model.rows.length === 0
          ? <div className="tree-empty">{emptyText(model, filter)}</div>
          : renderDir(tree, 0))}
      </div>

      <div className="ws-switch" ref={menuRef}>
        {menu && (
          <div className="menu menu-up" role="menu">
            <div className="menu-label">切换工作目录</div>
            <button type="button" role="menuitem" className={cls('menu-item', ws === BUILTIN && 'on')} onClick={() => pick(BUILTIN)}>
              <span className="tree-icon">{folderIcon}</span>
              <span className="ellipsis">工作台文档</span>
            </button>
            {dirs.map((d) => (
              <div key={d.id} className={cls('menu-item ws-item', ws === dirWs(d.id) && 'on')}>
                <button type="button" role="menuitem" className="ws-pick" onClick={() => pick(dirWs(d.id))} title={d.path}>
                  <span className="tree-icon">{folderIcon}</span>
                  <span className="ellipsis">{d.name}</span>
                </button>
                <button type="button" className="ws-remove" title="从列表移除，不动本地文件" aria-label={`移除 ${d.name}`}
                  onClick={() => { setMenu(false); onRemoveFolder(d.id) }}>
                  <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
                </button>
              </div>
            ))}
            <div className="menu-sep" />
            <button type="button" role="menuitem" className="menu-item" onClick={() => { setMenu(false); onAddFolder() }}>
              <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
              挂载本地目录…
            </button>
          </div>
        )}
        {error && <div className="subnav-error" role="alert">{error}</div>}
        <button type="button" className={cls('ws-btn', menu && 'open')} onClick={() => setMenu(!menu)} aria-haspopup="menu" aria-expanded={menu}>
          <span className="tree-icon">{folderIcon}</span>
          <span className="ws-btn-text">
            <span className="ws-btn-kicker" title={kicker?.title}>工作目录{kicker && ` · ${kicker.text}`}</span>
            <span className="ellipsis">{model.title}</span>
          </span>
          <svg className="ws-btn-chev" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="m4 10 4-4 4 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
      </div>
    </nav>
  )
}
