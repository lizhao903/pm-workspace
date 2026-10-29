// 内置浏览器插件（BR-01b）：清单在后端 internal/plugins/browser/plugin.json，这里只有入口。
// 页面是多标签浏览器，标签存后端（BR-01a）；没有二级菜单，也没有顶栏
import { definePlugin } from '../../core/plugin'

export default definePlugin({
  activate(api) {
    api.modules.register({
      id: 'browser',
      label: '浏览器',
      path: 'browser',
      load: () => import('./Page'),
    })
  },
})
