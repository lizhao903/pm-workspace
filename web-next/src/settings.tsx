// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import type { ReactNode } from 'react'
import { Subnav, type SubnavItem } from './subnav'

// 设置分项从这里加：Section 加一个 key，SECTIONS 加一行，App 里按 key 渲染内容
export type Section = 'workspace' | 'plugins' | 'connectors' | 'providers' | 'executors' | 'agents' | 'run-prompts' | 'run-permissions' | 'runners'
  | 'kbs' | 'skills' | 'enums' | 'localfs' | 'incidents' | 'appearance' | 'update'
  | 'domains' | 'sop' | 'terminal' | 'worktrees' | 'jobs' | 'recording'

/** group 有值的是插件登记的设置分节，二级菜单里排在内核分节后面、按组名分开（正式产品 /settings/plugins/<插件>/<分节>） */
export const SECTIONS: { key: Section; label: string; desc: string; group?: string }[] = [
  { key: 'workspace', label: '工作台与模块', desc: '切换工作台、选功能模块' },
  // CORE-09：插件管理（正式产品 frontend/src/modules/settings/plugins/）
  { key: 'plugins', label: '插件', desc: '安装、启停、卸载功能插件' },
  { key: 'connectors', label: '连接器', desc: '对接外部工具' },
  { key: 'providers', label: '模型服务商', desc: 'API Key 与接口地址' },
  // 本机 CLI 执行器的路径、默认参数（正式产品 settings/executors/，SOP 的 Claude Code 节点按这里选执行器）
  { key: 'executors', label: '执行器', desc: '本机 CLI 执行器配置' },
  { key: 'agents', label: 'Agent', desc: '工作助手' },
  // SPEC-settings-24：交给 Claude Code 时可选的执行要求
  { key: 'run-prompts', label: '角色', desc: '交给 Claude Code 的角色：执行要求、权限、输出要求' },
  // SPEC-settings-26（TSK-0499）：后台执行放行什么
  { key: 'run-permissions', label: '执行权限', desc: '交给 Claude Code 后台执行时放行的工具和命令' },
  // SPEC-settings-27（TSK-0722）：交给执行能选的执行器装没装、缺什么，DeepSeek 的集成检查。
  // 正式产品这一项和上面的「执行器」同名，原型照搬（见 settings.md「原型和规格对不上的地方」）
  { key: 'runners', label: '执行器', desc: 'Claude Code、DeepSeek、工作台 Agent 能不能用，集成检查' },
  { key: 'kbs', label: '知识库', desc: 'Agent 检索用的资料' },
  { key: 'skills', label: '技能', desc: '可复用的做事方法' },
  { key: 'enums', label: '枚举值', desc: '状态、优先级、分类等选项' },
  // FS-01：选目录时能浏览到哪些地方
  { key: 'localfs', label: '本机目录', desc: '选目录时能浏览的范围' },
  { key: 'incidents', label: '运行异常', desc: '系统出的问题，可转研发任务' },
  { key: 'appearance', label: '外观', desc: '配色方案、菜单收起' },
  // SPEC-settings-23（SYS-UPD）：把工作台更新到源码目录里的最新代码
  { key: 'update', label: '版本更新', desc: '更新到最新版本并重启' },
  // 以下是插件登记的设置分节
  { key: 'domains', label: '内网域名', desc: '给本机服务配好记的域名', group: '插件' },
  // SOP-07：SOP 插件登记的设置分节
  { key: 'sop', label: 'SOP 编排', desc: '执行并发和流水线治理', group: '插件' },
  // SPEC-settings-22：终端插件登记的设置分节
  { key: 'terminal', label: '终端', desc: 'Claude Code 启动命令', group: '插件' },
  // SPEC-settings-25（AUTO-07）：项目插件登记的设置分节
  { key: 'worktrees', label: '工作区', desc: '需求工作区的端口范围、测试环境保留时长', group: '插件' },
  // 后台任务插件（jobs）：后台 Job 状态与最近一小时运行统计
  { key: 'jobs', label: '后台任务', desc: '后台 Job 状态与最近一小时运行统计', group: '插件' },
  // 录音转写插件（recording）：本机 whisper.cpp 转写设置
  { key: 'recording', label: '录音转写', desc: '本机 whisper.cpp 转写设置', group: '插件' },
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
