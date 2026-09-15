// 文件夹选择器。
//
// 浏览器拿不到本地绝对路径——File System Access API 只给 handle，webkitdirectory 只给相对名——
// 所以目录树由后端 /api/fs/* 提供，这里只负责渲染与选择。受控组件：value 是绝对路径，
// 空串表示未选。对话框输出目录、项目工作区这些场景共用同一个它。
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { api, ApiError } from '../lib/api'
import type { FsListing, FsShortcut } from '../lib/types'
import { Button, Modal } from './ui'
import '../folderpicker.css'

export interface FolderPickerProps {
  /** 当前选中的绝对路径，空串表示未选 */
  value: string
  onChange: (path: string) => void
  placeholder?: string
  /** 允许清空（对话框的输出目录可以不选，项目工作区也可以不设） */
  allowEmpty?: boolean
  disabled?: boolean
}

/* ---------------------------------------------------------------- 小工具 */

const MAX_SHOWN = 46

/** 长路径中间省略：头尾都是信息量最大的部分，中间几层目录名可以让 title 去兜。 */
function shorten(p: string): string {
  if (p.length <= MAX_SHOWN) return p
  return `${p.slice(0, 12)}…${p.slice(-(MAX_SHOWN - 13))}`
}

/** 面包屑分段，每段带可跳转的绝对路径。 */
function crumbs(path: string): Array<{ label: string; path: string }> {
  if (!path) return []
  const out = [{ label: '/', path: '/' }]
  let cur = ''
  for (const seg of path.split('/').filter(Boolean)) {
    cur += `/${seg}`
    out.push({ label: seg, path: cur })
  }
  return out
}

/**
 * 新建目录名的前端校验。后端也会拦，但不该让用户白跑一趟——
 * 网络往返回来才告诉他名字里不能有斜杠，是能省掉的等待。
 */
function nameError(name: string): string {
  if (!name) return '名字不能为空'
  if (name.includes('/')) return '名字里不能有 /'
  if (name.includes('..')) return '名字里不能有 ..'
  return ''
}

function errText(e: unknown): string {
  if (e instanceof ApiError) return e.message
  return e instanceof Error ? e.message : String(e)
}

/* ------------------------------------------------------------ 展开态浮层 */

interface BrowserProps {
  /** 打开时先落到这个目录；打不开就退回后端默认根目录 */
  start: string
  onConfirm: (path: string) => void
  onCancel: () => void
}

function FolderBrowser({ start, onConfirm, onCancel }: BrowserProps) {
  const optId = useId()
  const [shortcuts, setShortcuts] = useState<FsShortcut[]>([])
  const [listing, setListing] = useState<FsListing | null>(null)
  const [loading, setLoading] = useState(true)
  // err 是「这一次点错了」：就地显示后端原文，不弹全局横幅。
  const [err, setErr] = useState('')
  // down 是「目录服务整个没起来」：一次都没成功过，只能给空态。
  const [down, setDown] = useState(false)
  const [cursor, setCursor] = useState(-1)
  // null 表示没在新建；空串表示输入框已展开但还没打字。
  const [newName, setNewName] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  const listRef = useRef<HTMLDivElement | null>(null)
  const nameRef = useRef<HTMLInputElement | null>(null)
  const everLoaded = useRef(false)

  // 后端只开放沙箱内的几个根（主目录 / /Volumes / /tmp 之类），根之上的路径一律拒。
  // 面包屑却会把 / 和 /Users 这些祖先段都拼出来，点了必报错。所以记下「哪些路径进得去」：
  // 成功列过的、见过的 parent、快捷入口给的，都算；parent 为空的那个就是一个根，根以下全放行。
  const [reach, setReach] = useState<ReadonlySet<string>>(() => new Set())
  const [roots, setRoots] = useState<string[]>([])
  const note = useCallback((paths: string[], root?: string) => {
    setReach((prev) => {
      const next = new Set(prev)
      for (const p of paths) if (p) next.add(p)
      return next
    })
    if (root) setRoots((prev) => (prev.includes(root) ? prev : [...prev, root]))
  }, [])
  const noteListing = useCallback((l: FsListing) => {
    note([l.path, l.parent], l.parent ? undefined : l.path)
  }, [note])
  const canVisit = (p: string) =>
    reach.has(p) || roots.some((r) => p === r || p.startsWith(`${r}/`))

  const load = useCallback(async (path?: string) => {
    setLoading(true)
    setErr('')
    try {
      const l = await api.fsBrowse(path)
      everLoaded.current = true
      noteListing(l)
      setDown(false)
      setListing(l)
      setCursor(-1)
      setNewName(null)
    } catch (e) {
      // 已经成功浏览过，说明后端在，只是这个路径不让进——保留原列表，就地报错。
      if (everLoaded.current) setErr(errText(e))
      else setDown(true)
    } finally {
      setLoading(false)
    }
  }, [noteListing])

  useEffect(() => {
    void (async () => {
      // 快捷入口失败不该拖住主列表，各自独立。
      api.fsShortcuts()
        .then((list) => { note(list.map((sc) => sc.path)); setShortcuts(list) })
        .catch(() => setShortcuts([]))
      if (start) {
        try {
          const l = await api.fsBrowse(start)
          everLoaded.current = true
          noteListing(l)
          setListing(l)
          setLoading(false)
          return
        } catch { /* 记着的目录可能已经被删了或不让看，退回默认根目录 */ }
      }
      await load()
    })()
  }, [start, load, noteListing, note])

  // 只认目录：后端按约定只返回子目录，这里再挡一层，免得将来多返回文件时列表串味。
  const entries = (listing?.entries ?? []).filter((e) => e.is_dir)
  const active = cursor >= 0 && cursor < entries.length ? entries[cursor] : null
  // 不可写的目录能高亮（要能往下走），但不能当作选中目标。
  const picked = active?.writable ? active : null
  const targetPath = picked ? picked.path : (listing?.path ?? '')
  const canPick = picked ? true : !!listing?.writable
  const nameErr = newName === null ? '' : nameError(newName.trim())

  // Modal 打开时会把焦点收进第一个可聚焦元素（左侧快捷入口），但方向键要作用在目录列表上，
  // 而父组件的 effect 总在子组件之后跑，只能等它那一帧过完再把焦点抢回来。
  useEffect(() => {
    const t = requestAnimationFrame(() => listRef.current?.focus())
    return () => cancelAnimationFrame(t)
  }, [listing])

  useEffect(() => {
    if (cursor < 0) return
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${cursor}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [cursor])

  useEffect(() => {
    if (newName === '') nameRef.current?.focus()
  }, [newName])

  // 键盘要从两头堵：
  // 1) Esc 必须在捕获阶段截住。这个浮层会开在 Agent 对话框里，而对话框自己也用 Esc 收起，
  //    它的处理挂在 React 树上（比 document 早），冒泡上去就是一次 Esc 关两层。
  //    截住之后 Modal 自带的 Esc 也到不了，所以关闭动作由这里自己发。
  // 2) 其余单键在冒泡到 window 之前掐掉：App 把 c / j / k / g 之类当全局快捷键，
  //    浮层开着的时候按这些键不该在背后动工作台。Tab 留给 Modal 的焦点陷阱。
  useEffect(() => {
    const onCapture = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      if (newName !== null) setNewName(null)
      else onCancel()
    }
    const onBubble = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Tab' || e.metaKey || e.ctrlKey || e.altKey) return
      e.stopPropagation()
    }
    document.addEventListener('keydown', onCapture, true)
    document.addEventListener('keydown', onBubble)
    return () => {
      document.removeEventListener('keydown', onCapture, true)
      document.removeEventListener('keydown', onBubble)
    }
  }, [newName, onCancel])

  const mkdir = useCallback(async () => {
    const name = (newName ?? '').trim()
    if (!listing || nameError(name)) return
    setCreating(true)
    setErr('')
    try {
      const l = await api.fsMkdir(listing.path, name)
      noteListing(l)
      const made = l.entries.find((e) => e.name === name)
      setNewName(null)
      // 建完直接进去：用户新建目录就是为了用它，再让他点一次没有意义。
      if (made) await load(made.path)
      else { setListing(l); setCursor(-1) }
    } catch (e) {
      setErr(errText(e))
    } finally {
      setCreating(false)
    }
  }, [newName, listing, load, noteListing])

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const tag = (e.target as HTMLElement).tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA') return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setCursor((c) => Math.min(entries.length - 1, c + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setCursor((c) => Math.max(0, c - 1))
    } else if (e.key === 'Enter') {
      // 焦点在按钮上时 Enter 归按钮，别把快捷入口按不动了。
      if (tag === 'BUTTON' || !active) return
      e.preventDefault()
      void load(active.path)
    } else if (e.key === 'Backspace') {
      e.preventDefault()
      if (listing?.parent) void load(listing.parent)
    }
  }

  return (
    <Modal
      open
      title="选择文件夹"
      size="lg"
      onClose={onCancel}
      footer={
        <div className="fp-foot">
          <div className="fp-foot-row">
            <span className="fp-foot-label">将选择</span>
            <span className="fp-foot-path mono truncate" title={targetPath}>{targetPath || '—'}</span>
          </div>

          {listing && !canPick ? (
            <div className="fp-foot-warn">这个目录不可写，选了也写不进东西。换一个，或在可写的目录里新建一个。</div>
          ) : null}

          {newName !== null ? (
            <div className="fp-foot-row">
              <input
                ref={nameRef}
                className="input fp-new"
                placeholder="新文件夹名"
                spellCheck={false}
                value={newName}
                aria-label="新文件夹名"
                aria-invalid={!!nameErr && !!newName || undefined}
                onChange={(ev) => setNewName(ev.target.value)}
                // Esc 归上面那个捕获监听：新建输入框开着时它先关输入框，不关整个浮层。
                onKeyDown={(ev) => { if (ev.key === 'Enter') { ev.preventDefault(); void mkdir() } }}
              />
              <Button small variant="primary" disabled={creating || !!nameErr} onClick={() => void mkdir()}>
                {creating ? '创建中…' : '创建'}
              </Button>
              <Button small onClick={() => setNewName(null)}>取消</Button>
              {newName && nameErr ? <span className="fp-foot-warn">{nameErr}</span> : null}
            </div>
          ) : null}

          <div className="fp-foot-row fp-foot-acts">
            <Button
              small
              disabled={!listing?.writable || newName !== null}
              title={listing && !listing.writable ? '该目录不可写，不能在这里新建' : undefined}
              onClick={() => setNewName('')}
            >
              新建文件夹
            </Button>
            <span className="fp-foot-push" />
            <Button small onClick={onCancel}>取消</Button>
            <Button
              small
              variant="primary"
              disabled={!canPick || !targetPath}
              title={canPick ? undefined : '该目录不可写'}
              onClick={() => onConfirm(targetPath)}
            >
              {picked ? `选择「${picked.name}」` : '选择此目录'}
            </Button>
          </div>
        </div>
      }
    >
      <div className="fp-browser" onKeyDown={onKeyDown}>
        <div className="fp-bar">
          <Button small disabled={!listing?.parent} onClick={() => void load(listing?.parent)}>上一级</Button>
          <nav className="fp-crumbs" aria-label="路径">
            {crumbs(listing?.path ?? '').map((c, i, all) => {
              const last = i === all.length - 1
              return (
                <span key={c.path} className="fp-crumb-wrap">
                  {/* 分隔符放在每段之前，且跳过第 1 段——根那一段本身就是 /，
                      不然开头会印成「/ / Users」，看着像渲染坏了。 */}
                  {i > 1 ? <span className="fp-sep" aria-hidden="true">/</span> : null}
                  {!last && canVisit(c.path) ? (
                    <button type="button" className="fp-crumb" onClick={() => void load(c.path)}>{c.label}</button>
                  ) : (
                    <span
                      className={`fp-crumb ${last ? 'fp-crumb-cur' : 'fp-crumb-off'}`}
                      title={last ? undefined : '这一级不在可浏览范围内'}
                    >
                      {c.label}
                    </span>
                  )}
                </span>
              )
            })}
          </nav>
        </div>

        {err ? <div className="fp-err" role="alert">{err}</div> : null}

        <div className="fp-panes">
          <aside className="fp-side">
            {shortcuts.map((s) => (
              <button
                key={s.path}
                type="button"
                className={`fp-sc${s.path === listing?.path ? ' fp-sc-on' : ''}`}
                title={s.path}
                onClick={() => void load(s.path)}
              >
                {s.label}
              </button>
            ))}
            {shortcuts.length === 0 ? <span className="faint fp-side-empty">无快捷入口</span> : null}
          </aside>

          <div
            ref={listRef}
            className="fp-list"
            role="listbox"
            tabIndex={0}
            aria-label="子目录"
            aria-activedescendant={active ? `${optId}-${cursor}` : undefined}
          >
            {loading ? (
              <div className="fp-sk">
                {[0, 1, 2, 3, 4, 5].map((i) => <div key={i} className="skeleton fp-sk-row" />)}
              </div>
            ) : down ? (
              <div className="empty-state">
                <span>目录服务未就绪</span>
                <span className="faint">后端的 /api/fs 还没起来，等它上线后再打开这里。</span>
                <Button small onClick={() => void load()}>重试</Button>
              </div>
            ) : entries.length === 0 ? (
              <div className="empty-state">这个目录里没有子目录</div>
            ) : (
              entries.map((e, i) => (
                <div
                  key={e.path}
                  id={`${optId}-${i}`}
                  data-idx={i}
                  role="option"
                  aria-selected={i === cursor}
                  aria-disabled={!e.writable || undefined}
                  title={e.writable ? e.path : `${e.path}（该目录不可写）`}
                  className={[
                    'fp-row',
                    i === cursor ? 'fp-row-on' : '',
                    e.writable ? '' : 'fp-row-ro',
                  ].filter(Boolean).join(' ')}
                  onClick={() => setCursor(i)}
                  onDoubleClick={() => void load(e.path)}
                >
                  <span className="fp-row-icon" aria-hidden="true" />
                  <span className="fp-row-name truncate">{e.name}</span>
                  {/* 不可写的照样列出来并且能进去（/ 和 /Users 本来就不可写，但必须能穿过），
                      只是不给选。让用户点进去才发现不能用，是最差的体验。 */}
                  {e.writable ? null : <span className="fp-row-ro-tag">只读</span>}
                </div>
              ))
            )}
          </div>
        </div>

        <div className="fp-tips faint">
          双击进入 · 上下键选择 · Enter 进入 · Backspace 上一级 · Esc 关闭
        </div>
      </div>
    </Modal>
  )
}

/* ------------------------------------------------------------ 收起态入口 */

export default function FolderPicker({
  value, onChange, placeholder = '未选择目录', allowEmpty, disabled,
}: FolderPickerProps) {
  const [open, setOpen] = useState(false)

  return (
    <span className="fp">
      <button
        type="button"
        className="fp-field"
        disabled={disabled}
        aria-haspopup="dialog"
        title={value || placeholder}
        onClick={() => setOpen(true)}
      >
        {value
          ? <span className="fp-field-path">{shorten(value)}</span>
          : <span className="fp-field-empty">{placeholder}</span>}
      </button>
      <Button small disabled={disabled} onClick={() => setOpen(true)}>选择</Button>
      {allowEmpty && value ? (
        <button
          type="button"
          className="fp-clear"
          aria-label="清除目录"
          title="清除目录"
          disabled={disabled}
          onClick={() => onChange('')}
        >
          ×
        </button>
      ) : null}
      {open ? (
        <FolderBrowser
          start={value}
          onCancel={() => setOpen(false)}
          onConfirm={(p) => { setOpen(false); onChange(p) }}
        />
      ) : null}
    </span>
  )
}
