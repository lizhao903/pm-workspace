// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 全局样式必须在 import App 之前引入。
// App 组件树里传递导入的组件级样式（settings.css / agent.css 等）会跟着模块图
// 排在 App 之后——只有全局样式先落，组件样式才能正常覆盖它。
// 反过来写的话，组件样式会被打包到 index.css 前面，同权重规则全部输给通用类，
// 表现是「样式看着写了但不生效」，而且只有截图能发现（元素还在，Playwright 照样点得到）。
// 这个坑已经让两个组件各踩一次，别再调换顺序。
import './tokens.css'
import './index.css'
import './views.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { WorkspaceProvider } from './hooks/workspace'
import App from './App'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <WorkspaceProvider>
      <App />
    </WorkspaceProvider>
  </StrictMode>,
)
