// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 视图层共用小原子。只依赖 tokens.css 变量与外壳层全局类名，不引任何第三方库。
import {
  useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState,
  type ButtonHTMLAttributes, type ComponentPropsWithRef, type ReactNode,
  type SelectHTMLAttributes, type TextareaHTMLAttributes,
} from 'react'
import { api } from '../lib/api'
import type { Category, Status } from '../lib/types'
import '../views.css'

/* ---------------------------------------------------------------- 常量 */

export const PRIORITIES = ['P0', 'P1', 'P2', 'P3'] as const
export type Priority = (typeof PRIORITIES)[number]

export const RELATIONS: Array<{ value: string; label: string }> = [
  { value: 'relates', label: '相关' },
  { value: 'blocks', label: '阻塞' },
  { value: 'duplicates', label: '重复' },
  { value: 'parent', label: '父级' },
  { value: 'references', label: '引用' },
]

/* ------------------------------------------------------------ 时间工具 */

const MIN = 60_000
const HOUR = 3_600_000
const DAY = 86_400_000

/** 本地时区的 YYYY-MM-DD，date input 与列表展示共用。 */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  const p = (n: number) => String(n).padStart(2, '0')
  return `${formatDate(iso)} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 自己算相对时间，不引 dayjs 之类的库。 */
export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return '—'
  const diff = Date.now() - t
  const abs = Math.abs(diff)
  const future = diff < 0
  const wrap = (s: string) => (future ? `${s}后` : `${s}前`)
  if (abs < MIN) return '刚刚'
  if (abs < HOUR) return wrap(`${Math.round(abs / MIN)} 分钟`)
  if (abs < DAY) return wrap(`${Math.round(abs / HOUR)} 小时`)
  if (abs < 30 * DAY) return wrap(`${Math.round(abs / DAY)} 天`)
  return formatDate(iso)
}

/**
 * due_at 是否落在当天末尾（本地 23:59）——即「整天」语义，展示时不必带时刻。
 * 判「是不是当天末尾」而不是判「是不是整点」：14:00 也是整点，
 * 但它是用户或 Agent 有意设的时刻，必须显示出来。
 */
export function isEndOfDay(iso: string | null | undefined): boolean {
  if (!iso) return false
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return false
  return d.getHours() === 23 && d.getMinutes() === 59
}

/**
 * 到期专用展示：整天只出日期，带具体时刻的出到分钟。
 * 不能直接用 formatDate——那样「明天 14:00」和「明天 23:59」在列表里长得一模一样，
 * 用户排一天的活看不出先后。创建/更新时间仍用 formatDate，显示到天是合理的。
 */
export function formatDue(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return isEndOfDay(iso) ? formatDate(iso) : formatDateTime(iso)
}

/** ISO → datetime-local 控件要的本地 `YYYY-MM-DDTHH:mm`（不带时区后缀）。 */
export function toDateTimeLocal(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const p = (n: number) => String(n).padStart(2, '0')
  return `${formatDate(iso)}T${p(d.getHours())}:${p(d.getMinutes())}`
}

/** datetime-local 的本地字符串 → ISO；空串表示清空到期。 */
export function fromDateTimeLocal(v: string): string | null {
  if (!v) return null
  const d = new Date(v) // 无时区后缀，按本地时区解析
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

/** 某一天的末尾 23:59:59（本地），「整天」语义的唯一写入口。 */
export function endOfDayIso(dateStr: string): string {
  return new Date(`${dateStr}T23:59:59`).toISOString()
}

/** 到期是否已逾期（只比日期，不比时分）。 */
export function isOverdue(due: string | null | undefined): boolean {
  if (!due) return false
  const d = new Date(due)
  if (Number.isNaN(d.getTime())) return false
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  return d.getTime() < today.getTime()
}

export function RelativeTime({ value, className = 'faint' }: { value: string | null | undefined; className?: string }) {
  return <span className={className} title={formatDateTime(value)}>{relativeTime(value)}</span>
}

/* ------------------------------------------------------------ 分类工具 */

export interface FlatCategory {
  category: Category
  depth: number
}

/** 把嵌套分类树拍平，depth 用于下拉选项缩进。 */
export function flattenCategories(nodes: Category[] | undefined, depth = 0, out: FlatCategory[] = []): FlatCategory[] {
  for (const n of nodes ?? []) {
    out.push({ category: n, depth })
    flattenCategories(n.children, depth + 1, out)
  }
  return out
}

/** 自己 + 全部子孙的 id，用于「改挂到」下拉排除非法目标。 */
export function collectSubtreeIds(node: Category, out: Set<string> = new Set()): Set<string> {
  out.add(node.id)
  for (const c of node.children ?? []) collectSubtreeIds(c, out)
  return out
}

export function findCategory(nodes: Category[] | undefined, id: string): Category | null {
  for (const n of nodes ?? []) {
    if (n.id === id) return n
    const hit = findCategory(n.children, id)
    if (hit) return hit
  }
  return null
}

// 分类树按类型缓存：抽屉与快速捕获会读非当前导航类型的分类，避免重复请求。
const treeCache = new Map<string, Category[]>()
const cacheSubs = new Set<() => void>()
let cacheVersion = 0

/** 分类发生写操作后调用，让所有 useCategoryTree 重新拉取。 */
export function invalidateCategoryTrees(): void {
  treeCache.clear()
  cacheVersion += 1
  for (const fn of cacheSubs) fn()
}

export function useCategoryTree(typeId: string | null | undefined): Category[] {
  const [tree, setTree] = useState<Category[]>([])
  const [version, setVersion] = useState(cacheVersion)

  useEffect(() => {
    const sub = () => setVersion(cacheVersion)
    cacheSubs.add(sub)
    return () => { cacheSubs.delete(sub) }
  }, [])

  useEffect(() => {
    if (!typeId) { setTree([]); return }
    const cached = treeCache.get(typeId)
    if (cached) { setTree(cached); return }
    let alive = true
    void api.categories(typeId, { tree: true, counts: true })
      .then((list) => { treeCache.set(typeId, list); if (alive) setTree(list) })
      .catch(() => { if (alive) setTree([]) })
    return () => { alive = false }
  }, [typeId, version])

  return tree
}

/* -------------------------------------------------------------- 表单原子 */

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'default' | 'primary' | 'ghost' | 'danger'
  small?: boolean
}

export function Button({ variant = 'default', small, className = '', type = 'button', ...rest }: ButtonProps) {
  const cls = ['btn', variant === 'default' ? '' : `btn-${variant}`, small ? 'btn-sm' : '', className]
    .filter(Boolean).join(' ')
  return <button type={type} className={cls} {...rest} />
}

export interface FieldProps {
  label: ReactNode
  htmlFor?: string
  error?: string | null
  hint?: ReactNode
  children: ReactNode
  className?: string
}

export function Field({ label, htmlFor, error, hint, children, className = '' }: FieldProps) {
  return (
    <div className={`field ${className}`.trim()}>
      <label className="field-label" htmlFor={htmlFor}>{label}</label>
      {children}
      {hint && !error ? <div className="faint v-field-hint">{hint}</div> : null}
      {error ? <div className="v-field-error">{error}</div> : null}
    </div>
  )
}

// 用 ComponentPropsWithRef，这样调用方可以直接传 ref（React 19 里 ref 就是普通 prop）
export interface TextInputProps extends Omit<ComponentPropsWithRef<'input'>, 'onChange'> {
  onValueChange?: (v: string) => void
}

export function TextInput({ onValueChange, className = '', ...rest }: TextInputProps) {
  return (
    <input
      className={`input ${className}`.trim()}
      onChange={(e) => onValueChange?.(e.target.value)}
      {...rest}
    />
  )
}

export interface TextAreaProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'onChange'> {
  onValueChange?: (v: string) => void
  /** 随内容自动增高，正文编辑用 */
  autoGrow?: boolean
}

export function TextArea({ onValueChange, autoGrow, className = '', value, ...rest }: TextAreaProps) {
  const ref = useRef<HTMLTextAreaElement | null>(null)
  useEffect(() => {
    const el = ref.current
    if (!autoGrow || !el) return
    el.style.height = 'auto'
    el.style.height = `${Math.max(el.scrollHeight, 72)}px`
  }, [autoGrow, value])
  return (
    <textarea
      ref={ref}
      value={value}
      className={`textarea ${className}`.trim()}
      onChange={(e) => onValueChange?.(e.target.value)}
      {...rest}
    />
  )
}

export interface SelectOption {
  value: string
  label: string
  disabled?: boolean
}

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'onChange'> {
  options?: SelectOption[]
  onValueChange?: (v: string) => void
}

export function Select({ options, onValueChange, className = '', children, ...rest }: SelectProps) {
  return (
    <select
      className={`select ${className}`.trim()}
      onChange={(e) => onValueChange?.(e.target.value)}
      {...rest}
    >
      {options
        ? options.map((o) => <option key={o.value} value={o.value} disabled={o.disabled}>{o.label}</option>)
        : children}
    </select>
  )
}

/* -------------------------------------------------------------- 状态展示 */

export function StatusPill({ status, fallback = '—' }: { status: Status | null | undefined; fallback?: string }) {
  if (!status) return <span className="status-pill muted">{fallback}</span>
  // 状态色是后端数据而非主题 token，只能走内联 style；底色用 color-mix 从同一个值推导。
  return (
    <span
      className="status-pill"
      style={{
        color: status.color,
        borderColor: `color-mix(in srgb, ${status.color} 45%, transparent)`,
        background: `color-mix(in srgb, ${status.color} 12%, transparent)`,
      }}
    >
      {status.label}
    </span>
  )
}

export function PriorityTag({ value }: { value: string }) {
  if (!value) return <span className="faint">—</span>
  return <span className={`priority priority-${value.toLowerCase()}`}>{value}</span>
}

/** 标签：描边 + # 前缀。和分类 chip 必须一眼能分开，别改成实底。 */
export function TagChip({ name, onRemove }: { name: string; onRemove?: () => void }) {
  return (
    <span className="tag v-tag-chip" title={`标签：${name}`}>
      <span className="faint" aria-hidden="true">#</span>{name}
      {onRemove ? (
        <button type="button" className="v-tag-x" aria-label={`移除标签 ${name}`} onClick={onRemove}>×</button>
      ) : null}
    </span>
  )
}

/**
 * 分类：色点 + 实底，和侧栏分类树的色点呼应。
 * 分类是「单选树形归属」，标签是「多选交叉维度」，两个正交维度不能共用同一种 chip 样式，
 * 否则同名的分类和标签并排渲染时会被当成重复数据。
 * 文字色固定用 --text 而不是分类色：分类色是用户自选的任意值，深色主题下拿来当前景色会掉对比度。
 */
export function CategoryChip({ name, color, path }: { name: string; color?: string; path?: string }) {
  return (
    <span
      className="v-cat-chip"
      title={`分类：${path || name}`}
      style={color ? {
        background: `color-mix(in srgb, ${color} 14%, transparent)`,
        borderColor: `color-mix(in srgb, ${color} 35%, transparent)`,
      } : undefined}
    >
      <ColorDot color={color || ''} size={6} />
      <span className="truncate">{name}</span>
    </span>
  )
}

/** 分类色点，颜色来自后端数据。 */
export function ColorDot({ color, size = 8 }: { color: string; size?: number }) {
  return (
    <span
      className="v-dot"
      style={{ background: color || 'var(--line-strong)', width: size, height: size }}
      aria-hidden="true"
    />
  )
}

/* ---------------------------------------------------------------- 弹层 */

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'

// 弹窗栈：只有最顶层的弹窗响应 Esc 与 Tab 陷阱，
// 否则分类管理器里弹删除确认时，一次 Esc 会把两层一起关掉。
const modalStack: symbol[] = []

export interface ModalProps {
  open: boolean
  title: ReactNode
  size?: 'sm' | 'md' | 'lg'
  onClose: () => void
  footer?: ReactNode
  children: ReactNode
}

export function Modal({ open, title, size = 'md', onClose, footer, children }: ModalProps) {
  const panelRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    const restore = document.activeElement as HTMLElement | null
    const token = Symbol('modal')
    modalStack.push(token)
    // 简版焦点陷阱：打开时把焦点收进弹窗，Tab 在弹窗内循环，关闭后还给触发元素。
    const first = panelRef.current?.querySelector<HTMLElement>(FOCUSABLE)
    first?.focus()

    const onKey = (e: KeyboardEvent) => {
      if (modalStack[modalStack.length - 1] !== token) return
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); return }
      if (e.key !== 'Tab' || !panelRef.current) return
      const items = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE))
      if (items.length === 0) return
      const head = items[0]
      const tail = items[items.length - 1]
      if (!e.shiftKey && document.activeElement === tail) { e.preventDefault(); head.focus() }
      if (e.shiftKey && document.activeElement === head) { e.preventDefault(); tail.focus() }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      const i = modalStack.indexOf(token)
      if (i >= 0) modalStack.splice(i, 1)
      restore?.focus?.()
    }
  }, [open, onClose])

  if (!open) return null
  const sizeCls = size === 'sm' ? 'modal-sm' : size === 'lg' ? 'modal-lg' : ''
  return (
    <div
      className="overlay"
      role="presentation"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className={`modal ${sizeCls}`.trim()} role="dialog" aria-modal="true" ref={panelRef}>
        <div className="modal-header">
          <span>{title}</span>
          <button type="button" className="btn btn-ghost btn-sm" aria-label="关闭" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-footer">{footer}</div> : null}
      </div>
    </div>
  )
}

export interface ConfirmDialogProps {
  open: boolean
  title: string
  confirmText?: string
  cancelText?: string
  danger?: boolean
  busy?: boolean
  /** 业务条件未满足时禁用确认按钮（区别于 busy 的「处理中」） */
  confirmDisabled?: boolean
  error?: string | null
  onConfirm: () => void
  onCancel: () => void
  children?: ReactNode
}

export function ConfirmDialog({
  open, title, confirmText = '确定', cancelText = '取消',
  danger, busy, confirmDisabled, error, onConfirm, onCancel, children,
}: ConfirmDialogProps) {
  return (
    <Modal
      open={open}
      title={title}
      size="sm"
      onClose={onCancel}
      footer={
        <>
          <Button onClick={onCancel} disabled={busy}>{cancelText}</Button>
          <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm} disabled={busy || confirmDisabled}>
            {busy ? '处理中…' : confirmText}
          </Button>
        </>
      }
    >
      {error ? <div className="error-banner">{error}</div> : null}
      {children}
    </Modal>
  )
}

export interface PopoverProps {
  trigger: ReactNode
  triggerClassName?: string
  title?: string
  align?: 'left' | 'right'
  width?: number
  disabled?: boolean
  children: (close: () => void) => ReactNode
}

interface PopStyle {
  left: number
  top?: number
  bottom?: number
  maxHeight: number
  width: number
}

const POP_DEFAULT_W = 160

/** 轻量下拉浮层：点外部或 Esc 关闭。Esc 走捕获阶段，保证不会顺带关掉外层弹窗。 */
export function Popover({
  trigger, triggerClassName = 'btn btn-sm', title, align = 'left', width, disabled, children,
}: PopoverProps) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<PopStyle | null>(null)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const btnRef = useRef<HTMLButtonElement | null>(null)
  const close = useCallback(() => setOpen(false), [])

  // 浮层用 fixed 定位并按触发器实际位置算坐标：
  // 行内动作、分类树这些都在滚动容器里，absolute 会被容器裁掉。
  useLayoutEffect(() => {
    if (!open || !btnRef.current) { setPos(null); return }
    const r = btnRef.current.getBoundingClientRect()
    const w = width ?? POP_DEFAULT_W
    const gapBelow = window.innerHeight - r.bottom - 12
    const gapAbove = r.top - 12
    const flipUp = gapBelow < 160 && gapAbove > gapBelow
    const left = align === 'right'
      ? Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8))
      : Math.max(8, Math.min(r.left, window.innerWidth - w - 8))
    setPos(flipUp
      ? { left, bottom: window.innerHeight - r.top + 4, maxHeight: Math.min(320, gapAbove), width: w }
      : { left, top: r.bottom + 4, maxHeight: Math.min(320, gapBelow), width: w })
  }, [open, align, width])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); setOpen(false) }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  return (
    <div className="v-pop-wrap" ref={wrapRef}>
      <button
        ref={btnRef}
        type="button"
        className={triggerClassName}
        title={title}
        disabled={disabled}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {trigger}
      </button>
      {open && pos ? (
        <div className="v-pop" style={pos}>
          {children(close)}
        </div>
      ) : null}
    </div>
  )
}

/* ------------------------------------------------------------ 分类选择器 */

export interface CategoryPickerProps {
  categories: Category[]
  value: string | null
  onChange: (id: string | null) => void
  /** 空值选项文案，「改挂到」场景会换成「根目录」 */
  emptyLabel?: string
  /** 需要排除的分类 id（如移动时排除自己与子孙） */
  excludeIds?: Set<string>
  disabled?: boolean
  id?: string
  className?: string
}

/** 从嵌套分类树渲染的层级下拉，抽屉与快速捕获共用。 */
export function CategoryPicker({
  categories, value, onChange, emptyLabel = '未分类', excludeIds, disabled, id, className = '',
}: CategoryPickerProps) {
  const flat = useMemo(() => flattenCategories(categories), [categories])
  return (
    <select
      id={id}
      className={`select ${className}`.trim()}
      disabled={disabled}
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)}
    >
      <option value="">{emptyLabel}</option>
      {flat
        .filter((n) => !excludeIds?.has(n.category.id))
        .map(({ category, depth }) => (
          <option key={category.id} value={category.id}>
            {`${'   '.repeat(depth)}${depth > 0 ? '└ ' : ''}${category.name}`}
          </option>
        ))}
    </select>
  )
}
