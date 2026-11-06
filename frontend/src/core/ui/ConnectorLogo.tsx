// 连接器标志（TSK-0725）：设置的连接器页、Agent 工具授权等所有显示连接器的地方共用。
// 顺序：用户自己换的图标（src，data URL）> 平台图标（logo 键，随前端打包）> 定义的底色加名称前两个字。
import type { CSSProperties } from 'react'
import { cls } from './cls'
import { LOGOS, logoUrl } from './connector-logos'
import './connectorLogo.css'

export type ConnectorLogoProps = {
  /** 名称，退回文字图标时取前两个字 */
  label: string
  /** 文字图标的底色，没有用灰 */
  color?: string
  /** 平台图标的键（定义的 logo 或按地址识别出的平台） */
  logo?: string
  /** 用户换的图标（data URL） */
  src?: string
  size?: number
  className?: string
}

export function ConnectorLogo({ label, color, logo, src, size = 40, className }: ConnectorLogoProps) {
  const base = { width: size, height: size, fontSize: size * 0.34, borderRadius: Math.max(4, Math.round(size / 4)) }
  if (src) return <img className={cls('cn-logo cn-logo-img', className)} style={base} src={src} alt="" aria-hidden="true" />
  const url = logoUrl(logo)
  if (url && logo) {
    return (
      <span className={cls('cn-logo cn-logo-brand', className)} style={{ ...base, '--c': LOGOS[logo].bg } as CSSProperties}
        data-logo={logo} aria-hidden="true">
        <img src={url} alt="" />
      </span>
    )
  }
  return <span className={cls('cn-logo', className)} style={{ ...base, '--c': color || 'var(--faint)' } as CSSProperties} aria-hidden="true">{label.slice(0, 2)}</span>
}
