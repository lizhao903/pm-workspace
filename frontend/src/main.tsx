import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from 'react-router'
import { queryClient, startEventStream } from './core/data'
import { createAppRouter } from './core/shell/router'
import { watchStaleBuild } from './core/shell/staleBuild'
import { coreModules } from './modules'

// 服务换了新构建后旧页面的分包加载失败，先看是不是有新版本再刷新
watchStaleBuild()
const router = createAppRouter(coreModules)
// 订阅后端事件流，按事件刷新缓存；断开时各处退回轮询（CORE-07c）
startEventStream(queryClient)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
)
