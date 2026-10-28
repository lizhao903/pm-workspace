// 示例插件：只注册一个功能模块。页面单独懒加载，打开菜单才请求
import { definePlugin } from '../../core/plugin'

export default definePlugin({
  activate(api) {
    api.modules.register({
      id: 'hello',
      label: '示例插件',
      path: 'hello',
      load: () => import('./Page'),
    })
  },
})
