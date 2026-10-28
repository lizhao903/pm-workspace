import { createBrowserRouter, Navigate } from 'react-router'
import type { ModuleDef } from '../plugin'
import { Placeholder } from './Placeholder'
import { RouteError } from './RouteError'
import { Shell } from './Shell'

export function createAppRouter(modules: ModuleDef[]) {
  return createBrowserRouter([
    {
      path: '/',
      element: <Shell modules={modules} />,
      errorElement: <RouteError />,
      children: [
        { index: true, element: <Navigate to={'/' + (modules[0]?.path ?? '')} replace /> },
        ...modules.map((m) => ({
          path: m.path + '/*',
          lazy: async () => ({ Component: (await m.load()).default }),
        })),
        // 只在 dev 构建出现：设计变量对照页。build 时 import.meta.env.DEV 为 false，这段连同页面一起被摇掉
        ...(import.meta.env.DEV
          ? [{ path: '_dev/tokens', lazy: async () => ({ Component: (await import('../ui/dev/TokensPage')).default }) }]
          : []),
        { path: '*', element: <Placeholder title="页面不存在" /> },
      ],
    },
  ])
}
