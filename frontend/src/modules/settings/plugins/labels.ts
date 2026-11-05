// 插件管理页的文字：权限的人话说明和风险级别（docs/plugin-api.md 3.1）、扩展点分组名（1.5）、状态
import type { PluginInfo } from '../../../core/data'

export type Risk = 'normal' | 'high' | 'highest'

const PERMISSION_TEXT: Record<string, { text: string; risk: Risk }> = {
  'fs:read:project': { text: '读项目根目录下的文件', risk: 'normal' },
  'fs:write:project': { text: '写项目根目录下的文件', risk: 'normal' },
  'fs:read:attachments': { text: '读数据目录下的附件', risk: 'normal' },
  'fs:write:attachments': { text: '写数据目录下的附件', risk: 'normal' },
  'fs:read:any': { text: '读本机任意路径', risk: 'high' },
  'fs:write:any': { text: '写本机任意路径', risk: 'high' },
  'fs:read:registered': { text: '只读你在插件里逐个登记的本机目录', risk: 'normal' },
  'network:localhost': { text: '访问 127.0.0.1 和本机域名', risk: 'normal' },
  'network:im': { text: '访问 IM 平台的接口', risk: 'normal' },
  'network:media-platforms': { text: '访问视频平台', risk: 'normal' },
  'network:market-data': { text: '访问行情源', risk: 'normal' },
  'network:exchanges': { text: '访问交易所的交易接口', risk: 'high' },
  'network:any': { text: '访问任意外网地址', risk: 'high' },
  'process:spawn': { text: '起子进程（原型、终端）', risk: 'high' },
  'trade:live': { text: '实盘下单', risk: 'highest' },
}

export function permissionInfo(p: string): { text: string; risk: Risk } {
  const known = PERMISSION_TEXT[p]
  if (known) return known
  if (p.startsWith('secrets:')) return { text: `取凭证保险箱里「${p.slice('secrets:'.length)}」范围的凭证`, risk: 'normal' }
  return { text: '内核不认识的权限', risk: 'high' }
}

export const RISK_LABEL: Record<Risk, string> = { normal: '普通', high: '高风险', highest: '最高风险' }

// 清单 provides 的分组，顺序照 plugin-api.md 1.5
export const PROVIDES_LABEL: Record<string, string> = {
  modules: '功能模块',
  settings: '设置分节',
  object_types: '对象类型',
  connectors: '连接器',
  skills: '技能',
  agent_tools: 'Agent 工具',
  sop_nodes: 'SOP 节点',
  today_cards: '今日卡片',
  commands: '命令面板命令',
  search: '搜索',
  schedule_actions: '定时任务动作',
}

export function providedGroups(p: PluginInfo): { key: string; label: string; items: string[] }[] {
  const keys = [...Object.keys(PROVIDES_LABEL), ...Object.keys(p.provides ?? {}).filter((k) => !(k in PROVIDES_LABEL))]
  return keys
    .map((key) => ({ key, label: PROVIDES_LABEL[key] ?? key, items: p.provides?.[key] ?? [] }))
    .filter((g) => g.items.length > 0)
}

export type PluginStatus = 'running' | 'stalled' | 'disabled' | 'available'

/** 已启用但没在跑：有待应用的迁移，启动时没起 */
export function pluginStatus(p: PluginInfo): PluginStatus {
  if (!p.installed) return 'available'
  if (!p.enabled) return 'disabled'
  return p.running ? 'running' : 'stalled'
}

export const STATUS_VIEW: Record<PluginStatus, { label: string; color: string }> = {
  running: { label: '已启用', color: 'var(--ok)' },
  stalled: { label: '已启用，没在运行', color: 'var(--warn)' },
  disabled: { label: '已停用', color: 'var(--faint)' },
  available: { label: '未安装', color: 'var(--faint)' },
}

export function nameOf(id: string, list: readonly PluginInfo[]): string {
  return list.find((p) => p.id === id)?.name ?? id
}

/** 「甲」「乙」 */
export const quoteNames = (names: readonly string[]) => names.map((n) => `「${n}」`).join('')
