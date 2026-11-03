// 终端插件（TERM-01b）：清单在后端 internal/plugins/terminal/plugin.json，这里只有入口。
// 页面是多标签、每标签最多 2x2 的真终端，每格一个后端 pty 会话；没有二级菜单，也没有顶栏。
// 另外给会话头部登记「终端」入口（SPEC-sessions-1.35），在对话右边展开同一套终端；
// 给任务「交给 Claude Code」登记终端入口（切换到终端），设置里有一节「终端」配启动命令
import { lazy } from 'react'
import { definePlugin } from '../../core/plugin'
import { IconTerminal } from './IconTerminal'

export default definePlugin({
  activate(api) {
    api.modules.register({
      id: 'terminal',
      label: '终端',
      path: 'terminal',
      load: () => import('./Page'),
    })
    api.sessionTools.register({
      key: 'terminal',
      label: '终端',
      icon: IconTerminal,
      order: 10,
      page: '/terminal',
      hint: ({ workdir }) => `在对话旁边打开终端，目录：${workdir || '没设工作目录，用终端的默认目录'}`,
      panel: lazy(() => import('./SessionPanel')),
    })
    // 任务「交给 Claude Code」选「切换到终端」：在这里新开标签执行启动命令，开好后去终端页（内核 0048）
    api.terminalLauncher.register({
      page: '/terminal',
      launch: async (req) => (await import('./store')).launchClaudeTab(req),
    })
    // 设置 > 插件 > 终端：Claude Code 启动命令
    api.settings.register({
      key: 'terminal',
      label: '终端',
      desc: 'Claude Code 启动命令',
      page: lazy(() => import('./Settings')),
    })
  },
})
