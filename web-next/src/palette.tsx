import { useEffect, useMemo, useRef, useState } from 'react'
import { cls } from './ui'

// 全局搜索 / 命令面板：⌘K 打开。条目由 App 拼好传进来，这里只管过滤、选择和执行

export interface PaletteItem {
  id: string
  group: string
  title: string
  sub?: string
  /** 额外参与搜索的词，不显示 */
  keywords?: string
  run: () => void
}

/** 没输入时只显示这几组，免得一打开就是一长串；「工作台」「原型」这类条目多的组只在输入后出现 */
const IDLE_GROUPS = ['操作', '跳转']
const MAX_PER_GROUP = 6

/** items 传函数时只在打开那一刻拼一次，面板开着时外面再怎么重渲染都不重拼、不重筛 */
export function CommandPalette({ items: source, onClose }: { items: PaletteItem[] | (() => PaletteItem[]); onClose: () => void }) {
  const [built] = useState(() => (typeof source === 'function' ? source() : null))
  const items = built ?? (source as PaletteItem[])
  const [q, setQ] = useState('')
  const [i, setI] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)
  const kw = q.trim().toLowerCase()

  const shown = useMemo(() => {
    const words = kw.split(/\s+/).filter(Boolean)
    const pool = kw ? items.filter((x) => words.every((w) => `${x.title} ${x.sub ?? ''} ${x.keywords ?? ''} ${x.group}`.toLowerCase().includes(w))) : items.filter((x) => IDLE_GROUPS.includes(x.group))
    // 标题开头就命中的排前面
    const ranked = kw ? [...pool].sort((a, b) => Number(!a.title.toLowerCase().startsWith(words[0])) - Number(!b.title.toLowerCase().startsWith(words[0]))) : pool
    const groups = [...new Set(ranked.map((x) => x.group))]
    return groups.flatMap((g) => ranked.filter((x) => x.group === g).slice(0, kw ? MAX_PER_GROUP : 20))
  }, [items, kw])

  useEffect(() => { setI(0) }, [kw])
  useEffect(() => { listRef.current?.querySelector('.pal-item.on')?.scrollIntoView({ block: 'nearest' }) }, [i])

  const run = (x: PaletteItem | undefined) => { if (!x) return; onClose(); x.run() }
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setI((n) => Math.min(shown.length - 1, n + 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setI((n) => Math.max(0, n - 1)) }
    else if (e.key === 'Enter') { e.preventDefault(); run(shown[i]) }
    else if (e.key === 'Escape') { e.preventDefault(); onClose() }
  }

  let lastGroup = ''
  return (
    <div className="pal-mask" onMouseDown={onClose}>
      <div className="pal" role="dialog" aria-label="搜索和命令" onMouseDown={(e) => e.stopPropagation()}>
        <div className="pal-input">
          <svg viewBox="0 0 16 16" width="16" height="16"><circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
          <input autoFocus value={q} placeholder="搜项目、任务、联系人、文档、会话，或者输入要做的事，比如「新建任务」" onChange={(e) => setQ(e.target.value)} onKeyDown={onKey} />
          <kbd>Esc</kbd>
        </div>
        <div className="pal-list" ref={listRef}>
          {shown.map((x, n) => {
            const head = x.group !== lastGroup
            lastGroup = x.group
            return (
              <div key={x.id}>
                {head && <div className="pal-group">{x.group}</div>}
                <button className={cls('pal-item', n === i && 'on')} onMouseEnter={() => setI(n)} onClick={() => run(x)}>
                  <span className="ellipsis pal-title">{x.title}</span>
                  {x.sub && <span className="ellipsis pal-sub">{x.sub}</span>}
                  {n === i && <span className="pal-enter">回车</span>}
                </button>
              </div>
            )
          })}
          {!shown.length && <div className="io-empty">没找到「{q}」相关的内容</div>}
        </div>
        <div className="pal-foot"><span><kbd>↑</kbd><kbd>↓</kbd> 选择</span><span><kbd>回车</kbd> 打开 / 执行</span><span><kbd>⌘K</kbd> 随时打开</span></div>
      </div>
    </div>
  )
}
