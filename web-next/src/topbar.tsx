// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { createContext, useContext, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

// 页面的标题、说明和主要操作统一放在顶栏这一行：左边标题 + 说明，右边按钮；下面整块都是内容
// 页面里写 <PageTitle>，内容会被送进 App 顶栏留的位置
export const TopbarContext = createContext<HTMLElement | null>(null)

export function PageTitle({ children, parent, count, desc, actions, icon }: {
  children: ReactNode
  icon?: ReactNode
  parent?: ReactNode
  count?: ReactNode
  desc?: ReactNode
  actions?: ReactNode
}) {
  const el = useContext(TopbarContext)
  if (!el) return null
  return createPortal(
    <>
      <div className="tb-title">
        {parent && <><span className="tb-parent ellipsis">{parent}</span><span className="tb-sep">/</span></>}
        {icon}
        <span className="tb-name ellipsis">{children}</span>
        {count !== undefined && count !== null && <span className="list-count">{count}</span>}
      </div>
      {desc && <div className="tb-desc ellipsis">{desc}</div>}
      <div className="spacer" />
      {actions && <div className="tb-actions">{actions}</div>}
    </>,
    el,
  )
}
