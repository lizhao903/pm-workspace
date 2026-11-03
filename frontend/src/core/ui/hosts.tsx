import { useContext, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { DrawerHostContext, SubnavHostContext } from './hostContext'

/** 把二级菜单送进外壳的二级菜单位置；外壳没给位置（单独演示）就原地渲染 */
export function InSubnavHost({ children }: { children: ReactNode }) {
  const el = useContext(SubnavHostContext)
  return el ? createPortal(children, el) : <>{children}</>
}

/** 把内容送进外壳的抽屉位置；外壳没给位置就原地渲染 */
export function InDrawerHost({ children }: { children: ReactNode }) {
  const el = useContext(DrawerHostContext)
  return el ? createPortal(children, el) : <>{children}</>
}
