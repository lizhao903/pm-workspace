import type { ReactNode } from 'react'
import { Subnav, type SubnavItem } from './subnav'

// 设置分项从这里加：Section 加一个 key，SECTIONS 加一行，App 里按 key 渲染内容
export type Section = 'workspace' | 'connectors' | 'providers' | 'agents' | 'kbs' | 'skills' | 'enums' | 'incidents' | 'domains' | 'sop' | 'terminal' | 'appearance'

export const SECTIONS: { key: Section; label: string; desc: string }[] = [
  { key: 'workspace', label: '工作台与模块', desc: '切换工作台、选功能模块' },
  { key: 'connectors', label: '连接器', desc: '对接外部工具' },
  { key: 'providers', label: '模型服务商', desc: 'API Key 与接口地址' },
  { key: 'agents', label: 'Agent', desc: '工作助手' },
  { key: 'kbs', label: '知识库', desc: 'Agent 检索用的资料' },
  { key: 'skills', label: '技能', desc: '可复用的做事方法' },
  { key: 'enums', label: '枚举值', desc: '状态、优先级、分类等选项' },
  { key: 'incidents', label: '运行异常', desc: '系统出的问题，可转研发任务' },
  { key: 'domains', label: '内网域名', desc: '给本机服务配好记的域名' },
  // SOP-07：正式产品是 SOP 插件登记的设置分节（设置 > 插件 > SOP 编排）
  { key: 'sop', label: 'SOP 编排', desc: '同时调模型的步骤数' },
  // SPEC-settings-22：正式产品是终端插件登记的设置分节（/settings/plugins/terminal/terminal）
  { key: 'terminal', label: '终端', desc: 'Claude Code 启动命令' },
  { key: 'appearance', label: '外观', desc: '配色方案、菜单收起' },
]

export function SettingsNav({ active, onSelect, alerts, extra = [], children }: {
  active: string
  onSelect: (k: string) => void
  /** 分项 key -> 异常数，在分项名后面标红 */
  alerts: Partial<Record<Section, number>>
  extra?: SubnavItem<string>[]
  children?: ReactNode
}) {
  return (
    <Subnav title="设置" active={active} onSelect={onSelect}
      items={[...SECTIONS.map((s) => ({ ...s, alert: alerts[s.key] }) as SubnavItem<string>), ...extra]}>
      {children}
    </Subnav>
  )
}
