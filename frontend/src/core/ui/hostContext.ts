import { createContext } from 'react'

/** 外壳留给二级菜单的位置：侧栏右边、顶栏左边的一整栏 */
export const SubnavHostContext = createContext<HTMLElement | null>(null)
/** 外壳留给停靠式抽屉的位置：内容区右边；宽屏和内容并排，1100px 以下浮在内容上面 */
export const DrawerHostContext = createContext<HTMLElement | null>(null)
