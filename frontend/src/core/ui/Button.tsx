// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import type { ComponentProps } from 'react'
import { cls } from './cls'

export type ButtonVariant = 'primary' | 'ghost' | 'outline' | 'danger' | 'danger-ghost'

/** 按钮：type 默认 button，免得放在表单里误提交 */
export function Button({ variant = 'ghost', size, className, type = 'button', ...rest }: ComponentProps<'button'> & {
  variant?: ButtonVariant
  size?: 'sm'
}) {
  return <button type={type} className={cls('btn', 'btn-' + variant, size === 'sm' && 'btn-sm', className)} {...rest} />
}

/** 只有图标的按钮：必须给 label，同时用作 aria-label 和悬停提示 */
export function IconButton({ label, size, className, type = 'button', title, ...rest }: Omit<ComponentProps<'button'>, 'aria-label'> & {
  label: string
  size?: 'sm'
}) {
  return (
    <button type={type} className={cls('icon-btn', size === 'sm' && 'icon-btn-sm', className)}
      aria-label={label} title={title ?? label} {...rest} />
  )
}
