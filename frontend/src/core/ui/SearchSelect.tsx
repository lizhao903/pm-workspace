// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { Fragment, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { cls } from './cls'
import { IconCheck, IconChevronDown, IconClose, IconSearch } from './icons'
import { matchOption } from './searchMatch'

/*
 * 可搜索的下拉选择，写法照原型 web-next/src/searchselect.tsx：替代选项很多的原生 select。
 * 单选、多选两种；输入即筛（matchOption）；可分组；当前值不在选项里（已删除、已停用）时照样显示；
 * 弹层挂到 body 上固定定位，不会被滚动容器裁掉；只渲染前 limit 条匹配项。
 * 键盘：触发按钮上按上下键打开；弹层里上下键移动、回车选中、Esc 关闭并回到触发按钮、Tab 关闭。
 *
 * 工具条筛选（chip 外观，有值时高亮）：
 *   <SearchSelect value={proj} onChange={setProj} noneLabel="全部项目" options={...} />
 * 表单里（field 外观，宽度撑满）：
 *   <Field label="项目" wrap={false}><SearchSelect variant="field" value={v} onChange={...} options={...} /></Field>
 * 多选（勾选不关弹层，回调整个新数组）：
 *   <SearchSelect multiple value={tools} onChange={setTools} placeholder="加工具" options={...} />
 */

export interface SearchOption<V extends string = string> {
  value: V
  /** 显示的名字，也参与搜索 */
  label: string
  /** 只用来搜、不显示的词：拼音、编号、别名 */
  keywords?: string
  /** 名字右边的灰字，也参与搜索 */
  hint?: string
  /** 分组名；选项要按分组排好序 */
  group?: string
  /** 名字前面的小图标、头像 */
  icon?: ReactNode
  /** 显示但不能选 */
  disabled?: boolean
}

interface SearchSelectBase<V extends string> {
  options: SearchOption<V>[]
  /** 没选时触发按钮上的字，默认「请选择」 */
  placeholder?: string
  /** 弹层搜索框的占位字，默认「搜索」 */
  searchPlaceholder?: string
  /** 一个选项都没有时的提示 */
  emptyText?: string
  /** 输入了但没匹配到时的提示 */
  noMatchText?: string
  /** 当前值不在 options 里时显示什么 */
  missingLabel?: (value: V) => string
  /** 最多渲染多少条匹配项，默认 50 */
  limit?: number
  /** chip：工具条筛选；field：表单输入框，宽度撑满；plain：没有边框底色，字号跟着外面（标题里的切换菜单）。默认 chip */
  variant?: 'chip' | 'field' | 'plain'
  /** chip 外观是否高亮；默认有值就高亮 */
  active?: boolean
  disabled?: boolean
  title?: string
  className?: string
  /** 弹层宽度（px）；默认取触发按钮宽度，至少 260，不超过视口 */
  menuWidth?: number
  /** 弹层和触发按钮左对齐还是右对齐 */
  align?: 'start' | 'end'
  /** 弹层底部的额外操作 */
  footer?: ReactNode
  'aria-label'?: string
}

export interface SingleSelectProps<V extends string = string> extends SearchSelectBase<V> {
  multiple?: false
  /** 当前值；'' 表示没选 */
  value: V | ''
  /** 选了就回调并关弹层；选 noneLabel 那一项回调 '' */
  onChange: (value: V | '') => void
  /** 列表最上面加一项值为 '' 的「全部 / 不选」，没输入时才显示 */
  noneLabel?: string
}

export interface MultiSelectProps<V extends string = string> extends SearchSelectBase<V> {
  multiple: true
  value: V[]
  onChange: (value: V[]) => void
}

export type SearchSelectProps<V extends string = string> = SingleSelectProps<V> | MultiSelectProps<V>

interface Entry<V extends string> { opt: SearchOption<V>; kind: 'opt' | 'none' | 'missing' }
interface Pos { left: number; width: number; top?: number; bottom?: number; maxH: number }

const defaultMissing = () => '已删除的选项'

export function SearchSelect<V extends string = string>(props: SearchSelectProps<V>) {
  const {
    options, placeholder = '请选择', searchPlaceholder = '搜索', emptyText = '没有可选的选项', noMatchText = '没有匹配的选项',
    missingLabel = defaultMissing, limit = 50, variant = 'chip', disabled, title, className, menuWidth, align = 'start', footer,
  } = props
  const multiple = props.multiple === true
  const noneLabel = props.multiple ? undefined : props.noneLabel
  const selected: V[] = props.multiple ? props.value : props.value ? [props.value] : []
  // selected 每次渲染都是新数组，memo 依赖用拼好的字符串
  const selectedKey = selected.join('\u0001')

  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  /** 键盘高亮的行；-1 表示还没动过，跟着默认位置 */
  const [hi, setHi] = useState(-1)
  const [pos, setPos] = useState<Pos | null>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const id = useId()

  const byValue = useMemo(() => new Map(options.map((o) => [o.value, o])), [options])
  const matched = useMemo(() => (q.trim() ? options.filter((o) => matchOption(o, q)) : options), [options, q])

  const entries = useMemo(() => {
    const out: Entry<V>[] = []
    const sel = selectedKey ? (selectedKey.split('\u0001') as V[]) : []
    if (!q.trim()) {
      if (noneLabel !== undefined) out.push({ kind: 'none', opt: { value: '' as V, label: noneLabel } })
      for (const v of sel) if (!byValue.has(v)) out.push({ kind: 'missing', opt: { value: v, label: missingLabel(v) } })
    }
    for (const o of matched.slice(0, limit)) out.push({ kind: 'opt', opt: o })
    return out
  }, [matched, limit, q, noneLabel, byValue, selectedKey, missingLabel])

  const firstEnabled = (list: Entry<V>[], from = 0, step: 1 | -1 = 1) => {
    for (let i = from; i >= 0 && i < list.length; i += step) if (!list[i].opt.disabled) return i
    return -1
  }

  const place = () => {
    const r = btnRef.current?.getBoundingClientRect()
    if (!r) return
    const vw = window.innerWidth, vh = window.innerHeight
    const width = Math.min(menuWidth ?? Math.max(r.width, 260), vw - 16)
    const left = Math.max(8, Math.min(align === 'end' ? r.right - width : r.left, vw - width - 8))
    const below = vh - r.bottom - 12, above = r.top - 12
    const up = below < 240 && above > below
    const maxH = Math.max(160, Math.min(400, up ? above : below))
    setPos(up ? { left, width, bottom: vh - r.top + 4, maxH } : { left, width, top: r.bottom + 4, maxH })
  }

  // 没动过键盘时：没输入就停在当前值上，输入了就停在第一个能选的
  const curAt = q.trim() ? -1 : entries.findIndex((e) => (e.kind === 'none' ? selected.length === 0 : e.opt.value === selected[0]))
  const active = hi >= 0 && hi < entries.length ? hi : curAt >= 0 ? curAt : firstEnabled(entries)

  const show = () => {
    if (disabled) return
    place()
    setQ('')
    setHi(-1)
    setOpen(true)
  }
  const close = (refocus = true) => {
    setOpen(false)
    if (refocus) btnRef.current?.focus()
  }

  // 监听只在打开时挂一次，place 走 ref 拿最新的 props
  const placeRef = useRef(place)
  useLayoutEffect(() => { placeRef.current = place })
  useEffect(() => {
    if (!open) return
    inputRef.current?.focus()
    const off = (e: MouseEvent) => {
      const t = e.target as Node
      if (!btnRef.current?.contains(t) && !menuRef.current?.contains(t)) setOpen(false)
    }
    // 外面的容器滚动、窗口缩放时跟着按钮走；按钮滚出视口就关
    const follow = (e: Event) => {
      if (menuRef.current && e.target instanceof Node && menuRef.current.contains(e.target)) return
      const r = btnRef.current?.getBoundingClientRect()
      if (!r || r.bottom < 0 || r.top > window.innerHeight) { setOpen(false); return }
      placeRef.current()
    }
    window.addEventListener('mousedown', off)
    window.addEventListener('resize', follow)
    window.addEventListener('scroll', follow, true)
    return () => {
      window.removeEventListener('mousedown', off)
      window.removeEventListener('resize', follow)
      window.removeEventListener('scroll', follow, true)
    }
  }, [open])

  // 键盘移动时把高亮项滚进可视区（jsdom 没有 scrollIntoView）
  useLayoutEffect(() => {
    if (!open) return
    listRef.current?.querySelector<HTMLElement>(`[data-i="${active}"]`)?.scrollIntoView?.({ block: 'nearest' })
  }, [active, open])

  const pick = (e: Entry<V>) => {
    if (e.opt.disabled) return
    const v = e.opt.value
    if (props.multiple) {
      props.onChange(props.value.includes(v) ? props.value.filter((x) => x !== v) : [...props.value, v])
      return
    }
    close()
    if (v !== props.value) props.onChange(v)
  }

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const step = e.key === 'ArrowDown' ? 1 : -1
      const n = active < 0 ? firstEnabled(entries) : firstEnabled(entries, active + step, step)
      if (n >= 0) setHi(n)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const cur = entries[active]
      if (cur) pick(cur)
    } else if (e.key === 'Escape') {
      // 只关弹层，别让外层抽屉、弹窗跟着关
      e.preventDefault()
      e.stopPropagation()
      close()
    } else if (e.key === 'Tab') {
      close(false)
    }
  }

  const onQ = (v: string) => { setQ(v); setHi(-1) }

  const labelOf = (v: V) => byValue.get(v)?.label ?? missingLabel(v)
  const isMissing = selected.some((v) => !byValue.has(v))
  let text: string
  let empty = false
  if (multiple) {
    text = selected.length ? selected.map(labelOf).join('、') : placeholder
    empty = !selected.length
  } else if (selected.length) {
    text = labelOf(selected[0])
  } else {
    text = noneLabel ?? placeholder
    empty = noneLabel === undefined
  }
  const curIcon = !multiple && selected.length ? byValue.get(selected[0])?.icon : undefined
  const isActive = props.active ?? selected.length > 0

  const more = matched.length - Math.min(matched.length, limit)
  const listId = `${id}-list`

  return (
    <>
      <button ref={btnRef} type="button" disabled={disabled}
        className={cls('ss-trigger', variant === 'field' ? 'ss-field' : variant === 'plain' ? 'ss-plain' : 'chip chip-select', variant === 'chip' && isActive && 'chip-on', open && 'open', className)}
        title={title ?? (empty ? undefined : text)} aria-label={props['aria-label']}
        aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? listId : undefined}
        onClick={() => (open ? close() : show())}
        onKeyDown={(e) => { if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { e.preventDefault(); show() } }}>
        {curIcon}
        <span className={cls('ss-value ellipsis', empty && 'ss-placeholder', isMissing && 'ss-missing')}>{text}</span>
        {multiple && selected.length > 1 && <span className="ss-count">{selected.length}</span>}
        <IconChevronDown className="ss-chev" />
      </button>
      {open && pos && createPortal(
        <div className="menu ss-menu" ref={menuRef}
          style={{ left: pos.left, width: pos.width, top: pos.top, bottom: pos.bottom, maxHeight: pos.maxH }}>
          <div className="search search-sm ss-search">
            <IconSearch />
            <input ref={inputRef} value={q} placeholder={searchPlaceholder} onChange={(e) => onQ(e.target.value)} onKeyDown={onKey}
              role="combobox" aria-expanded aria-controls={listId} aria-autocomplete="list" aria-label={searchPlaceholder}
              aria-activedescendant={entries[active] ? `${id}-o${active}` : undefined} />
            {q && (
              <button type="button" className="search-clear" title="清空" aria-label="清空"
                onMouseDown={(e) => e.preventDefault()} onClick={() => onQ('')}>
                <IconClose size={10} />
              </button>
            )}
          </div>
          {multiple && selected.length > 0 && (
            <div className="ss-picked">
              <span>已选 {selected.length} 项</span>
              <button type="button" className="link" onMouseDown={(e) => e.preventDefault()} onClick={() => props.multiple && props.onChange([])}>清空</button>
            </div>
          )}
          <div className="ss-list" ref={listRef} role="listbox" id={listId} aria-multiselectable={multiple || undefined}>
            {entries.length === 0 && <div className="ss-empty">{q.trim() ? noMatchText : emptyText}</div>}
            {entries.map((e, i) => {
              const g = e.kind === 'opt' ? e.opt.group : undefined
              const prev = entries[i - 1]
              const showGroup = g && (prev?.kind !== 'opt' || prev.opt.group !== g)
              const on = e.kind === 'none' ? selected.length === 0 : selected.includes(e.opt.value)
              return (
                <Fragment key={`${e.kind}:${e.opt.value}`}>
                  {showGroup && <div className="menu-label ss-group" role="presentation">{g}</div>}
                  <div id={`${id}-o${i}`} data-i={i} role="option" aria-selected={on} aria-disabled={e.opt.disabled || undefined}
                    className={cls('menu-item ss-item', i === active && 'hi', on && 'on', e.opt.disabled && 'disabled', e.kind === 'missing' && 'ss-missing', e.kind === 'none' && 'ss-none')}
                    title={e.kind === 'missing' ? '当前值已不在可选列表里' : e.opt.hint ? `${e.opt.label} · ${e.opt.hint}` : e.opt.label}
                    onMouseDown={(ev) => ev.preventDefault()}
                    onMouseMove={() => { if (active !== i && !e.opt.disabled) setHi(i) }}
                    onClick={() => pick(e)}>
                    {multiple && <span className={cls('ss-box', on && 'on')}>{on && <IconCheck />}</span>}
                    {e.opt.icon}
                    <span className="ss-label ellipsis">{e.opt.label}</span>
                    {e.opt.hint && <span className="ss-hint ellipsis">{e.opt.hint}</span>}
                    {!multiple && on && <span className="ss-check"><IconCheck /></span>}
                  </div>
                </Fragment>
              )
            })}
            {more > 0 && <div className="ss-more">还有 {more} 条，继续输入筛选</div>}
          </div>
          {footer && <div className="ss-foot">{footer}</div>}
        </div>,
        document.body,
      )}
    </>
  )
}
