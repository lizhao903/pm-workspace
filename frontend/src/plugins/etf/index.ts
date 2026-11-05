// 宽基监控插件（ETF-01b）：清单在后端 internal/plugins/etf/plugin.json，这里只有入口。
// 模块 key 是 etf（「盯盘」monitor 归交易插件 trade，不抢）；页面见 Page.tsx，规格 SPEC-etf
import { definePlugin } from '../../core/plugin'

export default definePlugin({
  activate(api) {
    api.modules.register({ id: 'etf', label: '宽基监控', path: 'etf', load: () => import('./Page') })
  },
})
