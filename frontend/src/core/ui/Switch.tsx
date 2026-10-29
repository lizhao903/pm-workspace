// 开关（照原型 styles.css 的 .switch-line），样式从设置服务商抽屉的「启用」开关（providers.css .pv-switch）抽出来。
// 底下是 checkbox，role="switch"；children 是写在开关右边的文字
import type { ComponentProps, ReactNode } from 'react'
import { cls } from './cls'
import './switch.css'

export function Switch({ children, className, title, onCheckedChange, onChange, ...rest }: Omit<ComponentProps<'input'>, 'type' | 'role'> & {
  children?: ReactNode
  onCheckedChange?: (checked: boolean) => void
}) {
  return (
    <label className={cls('sw-line', className)} title={title}>
      <span className="sw-box">
        <input type="checkbox" role="switch" onChange={(e) => { onChange?.(e); onCheckedChange?.(e.target.checked) }} {...rest} />
        <span className="sw" aria-hidden="true" />
      </span>
      {children}
    </label>
  )
}
