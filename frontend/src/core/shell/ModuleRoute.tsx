import type { ComponentType } from 'react'
import { Navigate } from 'react-router'
import { useRetiredModules, type ModuleDef } from '../plugin'

// 路由是启动时建好的；插件停用后它的页面不再显示，送回默认模块（docs/plugin-api.md 4.3）。内核模块不会被撤掉
export function ModuleRoute({ module, page: Page, home }: { module: ModuleDef; page: ComponentType; home: string }) {
  const gone = useRetiredModules()
  if (!module.core && gone.has(module.id)) return <Navigate to={home} replace />
  return <Page />
}
