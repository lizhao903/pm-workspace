// 内置浏览器插件（BR-01b）：清单在后端 internal/plugins/browser/plugin.json，这里只有入口。
// 页面是多标签浏览器，标签存后端（BR-01a）；没有二级菜单，也没有顶栏。
// 另外给会话头部登记「浏览器」入口（SPEC-sessions-1.36），在对话右边展开同一套标签，带上会话里出现过的链接
import { lazy } from 'react'
import { definePlugin } from '../../core/plugin'
import { IconGlobe } from './icons'

export default definePlugin({
  activate(api) {
    api.modules.register({
      id: 'browser',
      label: '浏览器',
      path: 'browser',
      load: () => import('./Page'),
    })
    api.sessionTools.register({
      key: 'browser',
      label: '浏览器',
      icon: IconGlobe,
      order: 20,
      page: '/browser',
      hint: ({ links }) => `在对话旁边打开浏览器${links.length ? `，会话里出现过 ${links.length} 个链接` : ''}`,
      panel: lazy(() => import('./SessionPanel')),
    })
  },
})
