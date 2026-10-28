// 示例插件：注册一个功能模块和一条命令。页面单独懒加载，打开菜单才请求
import { definePlugin } from '../../core/plugin'

export default definePlugin({
  activate(api) {
    api.modules.register({
      id: 'hello',
      label: '示例插件',
      path: 'hello',
      load: () => import('./Page'),
    })
    api.commands.register({
      id: 'hello.open',
      group: '操作',
      title: '打开示例插件',
      sub: '示例插件注册的命令',
      keywords: 'hello demo 示例 插件',
      run: ({ shell }) => shell.navigate('/hello'),
    })
  },
})
