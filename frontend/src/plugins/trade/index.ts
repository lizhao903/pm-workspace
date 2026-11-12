// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 交易套件插件（TRD-01a 起）：清单在后端 internal/plugins/trade/plugin.json，这里只有入口。
// 一个插件四个模块，key 同工作台目录（core/shell/workspace.ts）；行情、盯盘、策略、交易四个页面都已接后端
import { definePlugin } from '../../core/plugin'
import { TRADE_MODULES } from './modules'

export default definePlugin({
  activate(api) {
    for (const m of TRADE_MODULES) api.modules.register({ id: m.id, label: m.label, path: m.id, load: m.load })
  },
})
