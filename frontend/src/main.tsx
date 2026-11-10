// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from 'react-router'
import { queryClient, startEventStream } from './core/data'
import { createAppRouter } from './core/shell/router'
import { setReloadTarget, watchStaleBuild } from './core/shell/staleBuild'
import { watchErrors } from './core/shell/errorReport'
import { coreModules } from './modules'

// 服务换了新构建后旧页面的分包加载失败，先看是不是有新版本再刷新
watchStaleBuild()
// 全局未捕获的异常、没人处理的 Promise 记成运行异常，同一个错误一次会话只报一次（INC-01b）
watchErrors()
const router = createAppRouter(coreModules)
// 换版本自动刷新时直接打开正在去的页面，不回到点之前的那页
setReloadTarget(() => {
  const to = router.state.navigation.location
  return to ? to.pathname + to.search + to.hash : null
})
// 订阅后端事件流，按事件刷新缓存；断开时各处退回轮询（CORE-07c）
startEventStream(queryClient)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
)
