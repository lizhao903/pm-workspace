// 项目插件（PJ-01a 起）：清单在后端 internal/plugins/projects/plugin.json，这里只有入口。
// 页面是全部项目列表加项目详情（PJ-01c），没有二级菜单
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
