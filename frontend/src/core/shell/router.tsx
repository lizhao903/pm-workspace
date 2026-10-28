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
        { path: '*', element: <Placeholder title="页面不存在" /> },
      ],
    },
  ])
}
