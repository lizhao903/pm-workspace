// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { cls, IconSearch } from '../ui'
import { filterPalette, modKey, type PaletteItem } from './palette'

const SEARCH_DELAY = 150

/**
 * 命令面板：Cmd/Ctrl+K 打开。条目由外壳在打开那一刻拼好传进来，这里只管过滤、选择和执行。
 * search 是动态数据源（插件 provide 的），有输入时停顿一下再查，结果接在静态条目后面。
 */
export function CommandPalette({ items, search, onClose }: {
  items: readonly PaletteItem[]
  search?: (q: string) => Promise<PaletteItem[]>
  onClose: () => void
}) {
  const [q, setQ] = useState('')
  const [i, setI] = useState(0)
  const [found, setFound] = useState<{ q: string; items: PaletteItem[] }>({ q: '', items: [] })
  const listRef = useRef<HTMLDivElement>(null)
  const kw = q.trim()

  useEffect(() => {
    if (!search || !kw) return
    let live = true
    const t = window.setTimeout(() => {
      search(kw).then((xs) => { if (live) setFound({ q: kw, items: xs }) }, (e) => {
        console.warn('命令面板数据源出错', e)
        if (live) setFound({ q: kw, items: [] })
      })
    }, SEARCH_DELAY)
    return () => { live = false; window.clearTimeout(t) }
  }, [search, kw])

  const shown = useMemo(() => {
    const base = filterPalette(items, kw)
    return kw && found.q === kw ? [...base, ...found.items] : base
  }, [items, kw, found])

  // 数据源还没回来：先不说「没找到」
  const searching = !!search && !!kw && found.q !== kw
  const cur = Math.min(i, Math.max(0, shown.length - 1))
  useEffect(() => { listRef.current?.querySelector('.pal-item.on')?.scrollIntoView?.({ block: 'nearest' }) }, [cur])

  // 关掉后焦点回到打开前的地方
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null
    return () => { prev?.focus?.() }
  }, [])

  const run = (x: PaletteItem | undefined) => {
    if (!x) return
    onClose()
    x.run()
  }
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setI(Math.min(shown.length - 1, cur + 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setI(Math.max(0, cur - 1)) }
    else if (e.key === 'Enter') { e.preventDefault(); run(shown[cur]) }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose() }
    else if (e.key === 'Tab') e.preventDefault()
  }

  return createPortal(
    <div className="pal-mask" onMouseDown={onClose}>
      <div className="pal" role="dialog" aria-modal="true" aria-label="搜索和命令" onMouseDown={(e) => e.stopPropagation()}>
        <div className="pal-input">
          <IconSearch size={16} />
          <input autoFocus value={q} aria-label="搜索和命令" placeholder="搜任务、联系人、功能模块，或者输入要做的事，比如「深色」"
            role="combobox" aria-expanded="true" aria-controls="pal-list" aria-activedescendant={shown[cur] ? 'pal-' + shown[cur].id : undefined}
            onChange={(e) => { setQ(e.target.value); setI(0) }} onKeyDown={onKey} />
          <kbd>Esc</kbd>
        </div>
        <div className="pal-list" id="pal-list" role="listbox" aria-label="结果" ref={listRef}>
          {shown.map((x, n) => (
            <div key={x.id} role="presentation">
              {x.group !== shown[n - 1]?.group && <div className="pal-group" role="presentation">{x.group}</div>}
              <button type="button" id={'pal-' + x.id} role="option" aria-selected={n === cur} tabIndex={-1}
                className={cls('pal-item', n === cur && 'on')} onMouseEnter={() => setI(n)} onClick={() => run(x)}>
                <span className="ellipsis pal-title">{x.title}</span>
                {x.sub && <span className="ellipsis pal-sub">{x.sub}</span>}
                {n === cur && <span className="pal-enter">回车</span>}
              </button>
            </div>
          ))}
          {!shown.length && <div className="pal-empty">{searching ? '正在搜…' : `没找到「${kw}」相关的内容`}</div>}
        </div>
        <div className="pal-foot">
          <span><kbd>↑</kbd><kbd>↓</kbd> 选择</span>
          <span><kbd>回车</kbd> 打开 / 执行</span>
          <span><kbd>{modKey()}K</kbd> 随时打开</span>
        </div>
      </div>
    </div>,
    document.body,
  )
}
