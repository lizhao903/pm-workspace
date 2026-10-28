// 项目插件（PJ-01a 起）：清单在后端 internal/plugins/projects/plugin.json，这里只有入口。
// 现在只注册一个空页面，项目列表和详情从 PJ-01b 起补
import { definePlugin } from '../../core/plugin'

export default definePlugin({
  activate(api) {
    api.modules.register({
      id: 'projects',
      label: '项目',
      path: 'projects',
      load: () => import('./Page'),
    })
  },
})
