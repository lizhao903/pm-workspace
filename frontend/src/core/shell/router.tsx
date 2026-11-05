import { createBrowserRouter } from 'react-router'
import type { ModuleDef } from '../plugin'
import { loadChunk } from './chunkLoad'
import { HomeRedirect } from './HomeRedirect'
import { ModuleRoute } from './ModuleRoute'
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
        { index: true, element: <HomeRedirect modules={modules} /> },
        ...modules.map((m) => ({
          path: m.path + '/*',
          lazy: async () => {
            // 分包没取到时先查是不是换了版本，没换就退避重试，重试成功不上报（loadChunk）
            const Page = (await loadChunk(m.load)).default
            return { Component: () => <ModuleRoute module={m} page={Page} home={'/' + (modules[0]?.path ?? '')} /> }
          },
        })),
        // 只在 dev 构建出现：设计变量对照页、基础组件演示页。build 时 import.meta.env.DEV 为 false，这段连同页面一起被摇掉
        ...(import.meta.env.DEV
          ? [
            { path: '_dev/tokens', lazy: async () => ({ Component: (await import('../ui/dev/TokensPage')).default }) },
            { path: '_dev/components', lazy: async () => ({ Component: (await import('../ui/dev/ComponentsPage')).default }) },
          ]
          : []),
        { path: '*', element: <Placeholder title="页面不存在" /> },
      ],
    },
  ])
}
