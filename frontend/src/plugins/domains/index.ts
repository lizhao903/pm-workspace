// 内网域名插件（DOM-01b）：清单在后端 internal/plugins/domains/plugin.json，这里只有入口。
// 只登记一个设置分节「内网域名」（插件 API 2.2），路径 /settings/plugins/domains/domains；页面打开才加载
import { lazy } from 'react'
import { definePlugin } from '../../core/plugin'

export default definePlugin({
  activate(api) {
    api.settings.register({
      key: 'domains',
      label: '内网域名',
      desc: '给本机跑的服务配好记的域名',
      page: lazy(() => import('./Section')),
    })
  },
})
