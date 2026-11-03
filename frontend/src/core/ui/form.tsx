import { useCallback, useEffect, useLayoutEffect, useState, type ComponentProps, type ReactNode, type Ref } from 'react'
import { cls } from './cls'

/**
 * 表单项：标题 + 控件 + 提示或错误。默认用 <label> 包住控件，点标题就聚焦；
 * 控件本身是按钮或一组按钮（SearchSelect、分段选择）时传 wrap={false}，外层换成 <div>。
 */
export function Field({ label, required, hint, error, wrap = true, className, children }: {
  label: ReactNode
  required?: boolean
  hint?: ReactNode
  error?: ReactNode
  wrap?: boolean
  className?: string
  children: ReactNode
}) {
  const body = (
    <>
      <span className="field-label">{label}{required && <em aria-hidden="true">*</em>}</span>
      {children}
      {error ? <span className="field-err">{error}</span> : hint ? <span className="field-hint-line">{hint}</span> : null}
    </>
  )
  return wrap ? <label className={cls('field', className)}>{body}</label> : <div className={cls('field', className)}>{body}</div>
}

/** 单行输入；invalid 时红框并带 aria-invalid */
export function Input({ invalid, className, ...rest }: ComponentProps<'input'> & { invalid?: boolean }) {
  return <input className={cls('input', invalid && 'bad', className)} aria-invalid={invalid || undefined} {...rest} />
}

/**
 * 多行输入。autoGrow 时高度随内容撑开、不出内部滚动条（粘贴长文也跟着长），rows 是最小高度；
 * 宽度变了（抽屉拉宽、窗口缩放）重新量一次
 */
export function Textarea({ invalid, className, rows = 4, autoGrow, ref, ...rest }: ComponentProps<'textarea'> & {
  invalid?: boolean
  autoGrow?: boolean
}) {
  const [el, setEl] = useState<HTMLTextAreaElement | null>(null)
  useAutoGrow(autoGrow ? el : null, rest.value)
  const setRef = useCallback((x: HTMLTextAreaElement | null) => {
    setEl(x)
    assignRef(ref, x)
  }, [ref])
  return (
    <textarea ref={setRef} rows={rows} className={cls('textarea', autoGrow && 'grow', invalid && 'bad', className)}
      aria-invalid={invalid || undefined} {...rest}
      onInput={(e) => { rest.onInput?.(e); if (autoGrow) fitHeight(e.currentTarget) }} />
  )
}

function assignRef<T>(ref: Ref<T> | undefined, v: T | null) {
  if (typeof ref === 'function') ref(v)
  else if (ref) ref.current = v
}

/** 最近的会滚动的祖先：量高度时先把高度设回 auto，内容会短一下，滚动位置要还原，不然输入时抽屉会跳 */
function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const y = getComputedStyle(p).overflowY
    if (y === 'auto' || y === 'scroll') return p
  }
  return null
}

/** 把高度设成正好装下内容：auto 时的高度就是 rows 那么高，scrollHeight 取内容和 rows 里大的那个 */
function fitHeight(el: HTMLTextAreaElement) {
  const box = scrollParent(el)
  const top = box?.scrollTop
  el.style.height = 'auto'
  const cs = getComputedStyle(el)
  const extra = cs.boxSizing === 'border-box'
    ? (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0)
    : -((parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0))
  el.style.height = `${el.scrollHeight + extra}px`
  if (box && top !== undefined) box.scrollTop = top
}

/** el 给了就跟着内容量高度；值变了（打字、粘贴、外面改了值）、宽度变了（折行变了）都重新量 */
function useAutoGrow(el: HTMLTextAreaElement | null, value: unknown) {
  useLayoutEffect(() => {
    if (el) fitHeight(el)
  }, [el, value])
  useEffect(() => {
    if (!el || typeof ResizeObserver === 'undefined') return
    let w = el.clientWidth
    const ro = new ResizeObserver(() => {
      if (el.clientWidth === w) return
      w = el.clientWidth
      fitHeight(el)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [el])
}

export interface SelectOption {
  value: string
  label: string
  disabled?: boolean
}

/** 原生下拉，选项少（十个以内）时用；选项多、要搜索的用 SearchSelect */
export function Select({ options, invalid, className, onValueChange, onChange, ...rest }: Omit<ComponentProps<'select'>, 'children'> & {
  options: SelectOption[]
  invalid?: boolean
  /** 直接拿到新值，省得每处都写 e.target.value */
  onValueChange?: (value: string) => void
}) {
  return (
    <select className={cls('select', invalid && 'bad', className)} aria-invalid={invalid || undefined}
      onChange={(e) => { onChange?.(e); onValueChange?.(e.target.value) }} {...rest}>
      {options.map((o) => <option key={o.value} value={o.value} disabled={o.disabled}>{o.label}</option>)}
    </select>
  )
}

/** 复选框，文字写在 children 里 */
export function Checkbox({ children, className, onCheckedChange, onChange, ...rest }: Omit<ComponentProps<'input'>, 'type'> & {
  children?: ReactNode
  onCheckedChange?: (checked: boolean) => void
}) {
  return (
    <label className={cls('check', className)}>
      <input type="checkbox" onChange={(e) => { onChange?.(e); onCheckedChange?.(e.target.checked) }} {...rest} />
      {children}
    </label>
  )
}
