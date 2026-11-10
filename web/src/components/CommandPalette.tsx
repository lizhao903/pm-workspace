// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// Cmd/Ctrl+K 命令面板：跳转 + 搜索对象 + 命令，三类结果共用一条上下键序列。
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { api } from '../lib/api'
import { useWorkspace, type FocusKind, type NavSelection, type ViewDescriptor } from '../hooks/workspace'
import type { Category, ViewMode, WorkObject } from '../lib/types'
import { modKey, toggleTheme } from './TopBar'
import { KIND_LABEL, isBlocked, runShortcut, useShortcuts } from '../views/ShortcutsPage'

interface Item {
  key: string
  group: string
  label: string
  hint?: string
  run: () => void
}

const VIEW_LABELS: { mode: ViewMode; label: string }[] = [
  { mode: 'list', label: '列表' },
  { mode: 'board', label: '看板' },
  { mode: 'table', label: '表格' },
  { mode: 'calendar', label: '日历' },
  { mode: 'timeline', label: '时间线' },
]

// 聚焦与标签现在是筛选条件而不是导航，侧栏已不再收录它们；
// 命令面板是唯一能快速到达这些视图的地方，入口一个都不能少。
const FOCUS_LABELS: { focus: FocusKind; label: string }[] = [
  { focus: 'inbox', label: '收件箱' },
  { focus: 'today', label: '今日' },
  { focus: 'week', label: '本周' },
  { focus: 'overdue', label: '逾期' },
  { focus: 'stalled', label: '停滞' },
  { focus: 'trash', label: '回收站' },
]

function flatten(cats: Category[], out: Category[] = []): Category[] {
  for (const c of cats) {
    out.push(c)
    if (c.children?.length) flatten(c.children, out)
  }
  return out
}

export default function CommandPalette() {
  const {
    commandPaletteOpen, setCommandPaletteOpen,
    types, typeById, tags, categories, activeType,
    setNav, applyView, select, setViewMode, setQuickCaptureOpen, setCategoryManagerOpen,
    selected,
  } = useWorkspace()
  const { items: shortcuts } = useShortcuts()

  const [q, setQ] = useState('')
  const [active, setActive] = useState(0)
  const [remote, setRemote] = useState<WorkObject[]>([])
  const [searching, setSearching] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // 每次打开都从干净状态开始，免得上次的查询词干扰
  useEffect(() => {
    if (!commandPaletteOpen) return
    setQ(''); setActive(0); setRemote([]); setSearching(false)
    const t = setTimeout(() => inputRef.current?.focus(), 0)
    return () => clearTimeout(t)
  }, [commandPaletteOpen])

  // 2 字以上才打后端，300ms 防抖
  useEffect(() => {
    if (!commandPaletteOpen) return
    const term = q.trim()
    if (term.length < 2) { setRemote([]); setSearching(false); return }
    setSearching(true)
    let dropped = false
    const t = setTimeout(() => {
      api.objects({ q: term, limit: 8 })
        .then((r) => { if (!dropped) setRemote(r.items) })
        .catch(() => { if (!dropped) setRemote([]) })
        .finally(() => { if (!dropped) setSearching(false) })
    }, 300)
    return () => { dropped = true; clearTimeout(t) }
  }, [q, commandPaletteOpen])

  const close = () => setCommandPaletteOpen(false)
  const runNav = (n: NavSelection) => { setNav(n); close() }
  // 聚焦/标签走 applyView：它同时把作用域重置成「全部类型」，聚焦才有跨类型语义
  const runView = (v: ViewDescriptor) => { applyView(v); close() }

  // 快捷入口的内跳目标是 ViewDescriptor（作用域 + 筛选），所以走 applyView 而不是 setNav
  const runCtx = { selected, applyView, setQuickCaptureOpen, setCategoryManagerOpen }

  const items = useMemo<Item[]>(() => {
    const term = q.trim().toLowerCase()
    const hit = (s: string) => !term || s.toLowerCase().includes(term)

    const nav: Item[] = []
    for (const t of types) {
      if (hit(t.plural) || hit(t.name)) {
        nav.push({ key: `type:${t.id}`, group: '跳转', label: t.plural || t.name, hint: '工作对象', run: () => runNav({ kind: 'type', typeId: t.id }) })
      }
    }
    for (const f of FOCUS_LABELS) {
      if (hit(f.label)) {
        nav.push({ key: `focus:${f.focus}`, group: '跳转', label: f.label, hint: '聚焦筛选 · 全部类型', run: () => runView({ focus: f.focus }) })
      }
    }
    for (const c of flatten(categories)) {
      if (hit(c.name) || hit(c.path ?? '')) {
        nav.push({
          key: `cat:${c.id}`,
          group: '跳转',
          label: c.name,
          hint: `${activeType?.plural ?? '分类'} · ${c.total_count ?? 0}`,
          run: () => runNav({ kind: 'type', typeId: c.type_id, categoryId: c.id, subtree: true }),
        })
      }
    }
    for (const tag of tags.slice(0, 20)) {
      // 也匹配带 # 的写法：侧栏不再列标签之后，打个 # 浏览全部标签是最自然的动作
      if (hit(tag.name) || hit(`#${tag.name}`)) {
        nav.push({ key: `tag:${tag.id}`, group: '跳转', label: `#${tag.name}`, hint: '标签筛选', run: () => runView({ tags: [tag.name] }) })
      }
    }

    const results: Item[] = remote.map((o) => ({
      key: `obj:${o.id}`,
      group: '工作对象',
      label: o.title,
      hint: `${o.ref} · ${typeById[o.type_id]?.name ?? o.type_id}`,
      run: () => { select(o.id); close() },
    }))

    // 快捷入口按使用频率倒序：用得多的自然浮上来
    const scItems: Item[] = [...shortcuts]
      .sort((a, b) => b.use_count - a.use_count || a.sort_order - b.sort_order)
      .filter((sc) => hit(sc.label) || hit(sc.description) || hit(sc.url))
      .slice(0, 8)
      .map((sc) => ({
        key: `sc:${sc.id}`,
        group: '快捷入口',
        label: sc.label || '未命名',
        hint: isBlocked(sc, selected) ? '需先选中对象' : KIND_LABEL[sc.target_kind],
        run: () => {
          if (runShortcut(sc, runCtx)) close()
        },
      }))

    const cmds: Item[] = []
    for (const t of types) {
      const label = `新建${t.name}`
      if (hit(label)) {
        cmds.push({
          key: `new:${t.id}`,
          group: '命令',
          label,
          hint: '快速捕获',
          // 快速捕获自己读当前导航取默认类型，所以先切导航再开
          run: () => { setNav({ kind: 'type', typeId: t.id }); setQuickCaptureOpen(true); close() },
        })
      }
    }
    if (hit('管理分类')) cmds.push({ key: 'cmd:cat', group: '命令', label: '管理分类', run: () => { setCategoryManagerOpen(true); close() } })
    if (hit('切换主题')) cmds.push({ key: 'cmd:theme', group: '命令', label: '切换主题', hint: '浅色 / 深色', run: () => { toggleTheme(); close() } })
    for (const v of VIEW_LABELS) {
      const label = `切换视图：${v.label}`
      if (hit(label) || hit(v.label)) {
        cmds.push({ key: `view:${v.mode}`, group: '命令', label, hint: `${VIEW_LABELS.indexOf(v) + 1}`, run: () => { setViewMode(v.mode); close() } })
      }
    }

    if (hit('快捷访问')) {
      cmds.push({ key: 'cmd:shortcuts', group: '命令', label: '快捷访问', hint: '独立页面', run: () => runNav({ kind: 'page', page: 'shortcuts' }) })
    }

    return [...nav.slice(0, 12), ...scItems, ...results, ...cmds]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, types, categories, tags, remote, typeById, activeType, shortcuts, selected])

  useEffect(() => { setActive(0) }, [q])

  useEffect(() => {
    if (!commandPaletteOpen) return
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [active, commandPaletteOpen, items.length])

  if (!commandPaletteOpen) return null

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => (items.length ? (i + 1) % items.length : 0)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => (items.length ? (i - 1 + items.length) % items.length : 0)) }
    else if (e.key === 'Enter') { e.preventDefault(); items[active]?.run() }
    else if (e.key === 'Escape') { e.preventDefault(); close() }
  }

  let lastGroup = ''

  return (
    <div className="overlay cmdk-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) close() }}>
      <div className="cmdk" role="dialog" aria-modal="true" aria-label="命令面板">
        <input
          ref={inputRef}
          className="cmdk-input"
          value={q}
          placeholder="跳转、搜索工作对象，或执行命令…"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="cmdk-list" ref={listRef}>
          {items.length === 0 && (
            <div className="empty-state">{searching ? '搜索中…' : '没有匹配项'}</div>
          )}
          {items.map((it, i) => {
            const head = it.group !== lastGroup ? it.group : ''
            lastGroup = it.group
            return (
              <div key={it.key}>
                {head && <div className="cmdk-group">{head}</div>}
                <button
                  type="button"
                  className={`cmdk-item${i === active ? ' cmdk-item-active' : ''}`}
                  data-active={i === active}
                  onMouseMove={() => setActive(i)}
                  onClick={() => it.run()}
                >
                  <span className="truncate">{it.label}</span>
                  {it.hint && <span className="cmdk-item-hint truncate">{it.hint}</span>}
                </button>
              </div>
            )
          })}
          {searching && items.length > 0 && <div className="cmdk-group">搜索中…</div>}
        </div>
        <div className="cmdk-foot">
          <span><span className="kbd">↑</span> <span className="kbd">↓</span> 选择</span>
          <span><span className="kbd">Enter</span> 执行</span>
          <span><span className="kbd">Esc</span> 关闭</span>
          <span className="status-push">{modKey} K</span>
        </div>
      </div>
    </div>
  )
}
