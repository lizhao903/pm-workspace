import type { ComponentProps, ReactNode } from 'react'
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

export function Textarea({ invalid, className, rows = 4, ...rest }: ComponentProps<'textarea'> & { invalid?: boolean }) {
  return <textarea rows={rows} className={cls('textarea', invalid && 'bad', className)} aria-invalid={invalid || undefined} {...rest} />
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
