// IM 消息插件（IM-02b 起）：清单在后端 internal/plugins/im/plugin.json，这里只有入口。
// 模块 key 是 messages（工作台和菜单按它认，见 core/shell/workspace.ts）；页面是收件箱加消息抽屉，没有二级菜单
import { definePlugin } from '../../core/plugin'

export default definePlugin({
  activate(api) {
    api.modules.register({
      id: 'messages',
      label: 'IM 消息',
      path: 'messages',
      load: () => import('./Page'),
    })
  },
})
