import type { ComponentType } from 'react'

// 四个模块的 id、名字和页面；说明照原型 web-next/src/workspacedata.ts MODULES
export const TRADE_MODULES: readonly { id: string; label: string; desc: string; load: () => Promise<{ default: ComponentType }> }[] = [
  { id: 'markets', label: '行情', desc: '数币、A 股、港股、美股的看盘和期权 T 型报价', load: () => import('./MarketsPage') },
  { id: 'monitor', label: '盯盘', desc: '盯盘墙、价格与异动提醒、市场时段', load: () => import('./MonitorPage') },
  { id: 'strategy', label: '策略', desc: '策略编辑、回测和参数扫描', load: () => import('./StrategyPage') },
  { id: 'trading', label: '交易', desc: '账户、持仓、委托、策略运行和风控', load: () => import('./TradingPage') },
]
