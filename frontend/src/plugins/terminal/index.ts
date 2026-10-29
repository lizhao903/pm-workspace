// 终端插件（TERM-01b）：清单在后端 internal/plugins/terminal/plugin.json，这里只有入口。
// 页面是多标签、每标签最多 2x2 的真终端，每格一个后端 pty 会话；没有二级菜单，也没有顶栏
import { definePlugin } from '../../core/plugin'

export default definePlugin({
  activate(api) {
    api.modules.register({
      id: 'terminal',
      label: '终端',
      path: 'terminal',
      load: () => import('./Page'),
    })
  },
})
