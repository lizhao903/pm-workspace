// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 内容树（SPEC-library-1.1 到 1.11）：搜索框、按文件夹分组的文档树、底部切换工作目录。
// 写法照原型 web-next/src/library.tsx 的 LibraryTree。几千上万个文件也不卡：文件夹默认收起，
// 展开的树摊成一行行（每行 30px），行数多时只渲染滚动到的那一段（虚拟滚动），搜索时全部展开也一样。
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { LocalDir } from '../../core/data'
import { cls } from '../../core/ui'
import { ancestors, buildTree, BUILTIN, dirWs, emptyText, flattenTree, type Doc, type Filter, type LibraryModel, type TreeRow as Row, type Workspace } from './model'

const MAX_INDENT = 4
/** 每行的高度，和 docs.css 的 .tree-row 一致 */
const ROW_H = 30
/** 行数超过这么多才虚拟滚动；少的时候全渲染，简单 */
const VIRTUAL_MIN = 200
/** 可见区上下多渲染的行数 */
const OVERSCAN = 12

/** 文件图标按种类：文本、PDF、图片、Office */
function KindIcon({ kind }: { kind?: Doc['fileKind'] }) {
  if (kind === 'image') {
    return <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><rect x="2" y="3" width="12" height="10" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1.3" /><circle cx="6" cy="6.6" r="1.2" fill="currentColor" /><path d="m3 12 3.5-3.5 2.5 2.5 1.8-1.8L13.5 12" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" /></svg>
  }
  if (kind === 'pdf' || kind === 'office') {
    return (
      <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M4 1.8h5.5L12.5 5v9.2H4Z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" /><path d="M9.3 2v3.2h3" fill="none" stroke="currentColor" strokeWidth="1.3" />
        {kind === 'pdf' ? <path d="M5.8 11.5h4.4M5.8 9h4.4" stroke="currentColor" strokeWidth="1.1" /> : <rect x="5.6" y="8" width="4.8" height="4" fill="none" stroke="currentColor" strokeWidth="1.1" />}
      </svg>
    )
  }
  return fileIcon
}

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

export function LibraryTree({ ws, model, filter, dirs, selected, onSelect, onSwitch, onAddFolder, onRemoveFolder, q, onQ, status, kicker, error, mode, defaultWs = BUILTIN, onSetDefault, pageError, onRetryPage }: {
  ws: Workspace
  /** 默认工作目录：进文档模块时停在这里（SPEC-library-1.53）；菜单里标「默认」，没设时是工作台文档 */
  defaultWs?: Workspace
  onSetDefault?: (ws: Workspace) => void
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
  /** 本地目录后面的页没拉到：前面的照常显示，底下给重试 */
  pageError?: string
  onRetryPage?: () => void
}) {
  // 记「展开了哪些」：默认都收起，只展开当前阅读文档所在的那条路径
  const [opened, setOpened] = useState<Set<string>>(() => new Set())
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

  const rows = useMemo(() => flattenTree(tree, (p) => searching || opened.has(p)), [tree, searching, opened])

  // 虚拟滚动：记滚动位置和可见高度，只渲染这一段；jsdom 里量不到高度时按 800px 算
  const scroller = useRef<HTMLDivElement>(null)
  const [view, setView] = useState({ top: 0, height: 0 })
  const measure = useCallback(() => {
    const el = scroller.current
    if (el) setView((v) => (v.top === el.scrollTop && v.height === el.clientHeight ? v : { top: el.scrollTop, height: el.clientHeight }))
  }, [])
  useLayoutEffect(() => {
    measure()
    const el = scroller.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [measure])
  const virtual = rows.length > VIRTUAL_MIN
  const height = view.height || 800
  const from = virtual ? Math.max(0, Math.floor(view.top / ROW_H) - OVERSCAN) : 0
  const to = virtual ? Math.min(rows.length, Math.ceil((view.top + height) / ROW_H) + OVERSCAN) : rows.length

  // 换了选中的文件（从地址进来、别处跳过来）时，它不在可见区就滚过去；点树里看得见的那条不动
  const selIdx = selected ? rows.findIndex((r) => r.t === 'file' && r.f.id === selected) : -1
  const lastSel = useRef<string | null>(null)
  useEffect(() => {
    const el = scroller.current
    if (!el || selIdx < 0 || lastSel.current === selected) return
    lastSel.current = selected
    const y = selIdx * ROW_H
    if (y < el.scrollTop || y + ROW_H > el.scrollTop + el.clientHeight) el.scrollTop = Math.max(0, y - el.clientHeight / 3)
  }, [selIdx, selected])

  const renderRow = (r: Row): ReactNode => {
    if (r.t === 'dir') {
      const { d, depth, open } = r
      return (
        <button type="button" key={`d:${d.path}`} className="tree-row tree-dir" style={{ paddingLeft: indent(depth) }} onClick={() => toggle(d.path)}
          aria-expanded={open} title={depth > MAX_INDENT ? d.path : undefined}>
          <span className={cls('tree-chev', open && 'open')}>{chevron}</span>
          <span className="tree-icon">{folderIcon}</span>
          <span className="ellipsis tree-label">{depth > MAX_INDENT && <span className="tree-elide">…/</span>}{d.name}</span>
          <span className="tree-count">{d.count}</span>
        </button>
      )
    }
    const { f, depth } = r
    return (
      <button type="button" key={f.id} className={cls('tree-row tree-file', selected === f.id && 'sel')} style={{ paddingLeft: indent(depth) + 16 }}
        onClick={() => onSelect(f.id)} title={f.title} aria-current={selected === f.id || undefined} data-kind={f.fileKind}>
        <span className="tree-icon">{f.fileKind ? <KindIcon kind={f.fileKind} /> : fileIcon}</span>
        <span className="ellipsis tree-label">{f.title}</span>
        {f.starred && <span className="lib-star" aria-label="星标"><StarIcon size={10} /></span>}
      </button>
    )
  }

  const body = virtual ? (
    <div style={{ height: rows.length * ROW_H, position: 'relative' }}>
      <div style={{ position: 'absolute', top: from * ROW_H, left: 0, right: 0 }}>{rows.slice(from, to).map(renderRow)}</div>
    </div>
  ) : rows.map(renderRow)

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
      <div className="tree" role="tree" ref={scroller} onScroll={measure}>
        {status ?? (model.rows.length === 0
          ? <div className="tree-empty">{emptyText(model, filter)}</div>
          : body)}
        {!status && pageError && (
          <div className="tree-empty tree-error" role="alert">
            <div>{pageError}</div>
            {onRetryPage && <button type="button" className="act" onClick={onRetryPage}>重试</button>}
          </div>
        )}
      </div>

      <div className="ws-switch" ref={menuRef}>
        {menu && (
          <div className="menu menu-up" role="menu">
            <div className="menu-label">切换工作目录</div>
            <button type="button" role="menuitem" className={cls('menu-item', ws === BUILTIN && 'on')} onClick={() => pick(BUILTIN)}>
              <span className="tree-icon">{folderIcon}</span>
              <span className="ellipsis">工作台文档</span>
              {onSetDefault && defaultWs === BUILTIN && dirs.length > 0 && <span className="ws-default">默认</span>}
            </button>
            {dirs.map((d) => (
              <div key={d.id} className={cls('menu-item ws-item', ws === dirWs(d.id) && 'on')}>
                <button type="button" role="menuitem" className="ws-pick" onClick={() => pick(dirWs(d.id))} title={d.path}>
                  <span className="tree-icon">{folderIcon}</span>
                  <span className="ellipsis">{d.name}</span>
                  {defaultWs === dirWs(d.id) && <span className="ws-default">默认</span>}
                </button>
                {onSetDefault && (
                  <button type="button" className={cls('ws-pin', defaultWs === dirWs(d.id) && 'on')}
                    title={defaultWs === dirWs(d.id) ? '取消默认：进文档时回到工作台文档' : '设为默认：之后进文档就停在这个目录'}
                    aria-label={defaultWs === dirWs(d.id) ? `取消默认 ${d.name}` : `设为默认 ${d.name}`}
                    onClick={() => onSetDefault(defaultWs === dirWs(d.id) ? BUILTIN : dirWs(d.id))}>
                    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M8 2.5l1.7 3.5 3.8.5-2.8 2.6.7 3.8L8 11.1l-3.4 1.8.7-3.8L2.5 6.5l3.8-.5Z" fill={defaultWs === dirWs(d.id) ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" /></svg>
                  </button>
                )}
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
