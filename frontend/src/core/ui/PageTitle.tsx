import { useContext, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { TopbarContext } from './topbar'

/**
 * 页面标题：左边标题（可带上级、数量、图标）和说明，右边主要操作。
 * 外壳通过 TopbarContext 给了顶栏的位置就送进顶栏；没给（外壳还没有顶栏、单独演示）就原地渲染。
 * tabs 是放在标题右侧、同一行的标签条（项目详情，TSK-0718）：占说明的位置（有 tabs 时不显示说明），放不下时横向滚动。
 */
export function PageTitle({ children, parent, count, desc, actions, icon, tabs }: {
  children: ReactNode
  icon?: ReactNode
  parent?: ReactNode
  count?: ReactNode
  desc?: ReactNode
  actions?: ReactNode
  tabs?: ReactNode
}) {
  const el = useContext(TopbarContext)
  const body = (
    <>
      <div className="tb-title">
        {parent && <><span className="tb-parent ellipsis">{parent}</span><span className="tb-sep">/</span></>}
        {icon}
        <h1 className="tb-name ellipsis">{children}</h1>
        {count !== undefined && count !== null && <span className="list-count">{count}</span>}
      </div>
      {tabs && <div className="tb-tabs">{tabs}</div>}
      {desc && !tabs && <div className="tb-desc">{desc}</div>}
      <div className="spacer" />
      {actions && <div className="tb-actions">{actions}</div>}
    </>
  )
  if (el) return createPortal(body, el)
  return <div className="page-title">{body}</div>
}
