// 示例插件：注册一个功能模块、一条命令、一个设置分节和一张今日卡片。页面单独懒加载，打开才请求
import { lazy } from 'react'
import { definePlugin } from '../../core/plugin'
import { TodayCard } from './TodayCard'

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
    api.settings.register({
      key: 'hello',
      label: '示例插件',
      desc: '示例插件注册的设置分节',
      page: lazy(() => import('./SettingsPage')),
    })
    api.todayCards.register({
      key: 'hello_greeting',
      title: '示例插件',
      render: TodayCard,
    })
  },
})
