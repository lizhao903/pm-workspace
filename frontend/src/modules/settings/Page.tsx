// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { Navigate, useNavigate, useParams } from 'react-router'
import { Placeholder } from '../../core/shell/Placeholder'
import { PluginSettingsPage } from '../../core/shell/extensionHosts'
import { useSettingsSections } from '../../core/plugin'
import { openErrors, useConnectors, useIncidents, useUpdateStatus } from '../../core/data'
import { InSubnavHost, Subnav, type SubnavItem } from '../../core/ui'
import { ConnectorsSection } from './connectors/ConnectorsSection'
import { PluginsSection } from './plugins/PluginsSection'
import { ProvidersSection } from './providers/ProvidersSection'
import { WorkspacesSection } from './workspaces/WorkspacesSection'
import { EnumsSection } from './enums/EnumsSection'
import { AppearanceSection } from './appearance/AppearanceSection'
import { AgentsSection } from './agents/AgentsSection'
import { KbSection } from './kb/KbSection'
import { SkillsSection } from './skills/SkillsSection'
import { LocalFsSection } from './localfs/LocalFsSection'
import { IncidentsSection } from './incidents/IncidentsSection'
import { RunPresetsSection } from './runprompts/RunPresetsSection'
import { ExecutorsSection } from './executors/ExecutorsSection'
import { RunPermsSection } from './runperms/RunPermsSection'
import { RunnersSection } from './runners/RunnersSection'
import { UpdateSection } from './update/UpdateSection'

// 内核的设置分节，照原型 web-next/src/settings.tsx SECTIONS；内网域名是插件的分节，不在这里。
// 插件管理（CORE-09）原型里还没有，放在「工作台与模块」（CORE-10b）后面
const KERNEL: SubnavItem<string>[] = [
  { key: 'workspace', label: '工作台与模块', desc: '切换工作台、选功能模块' },
  { key: 'plugins', label: '插件', desc: '安装、启停、卸载功能插件' },
  { key: 'connectors', label: '连接器', desc: '对接外部工具' },
  { key: 'providers', label: '模型服务商', desc: 'API Key 与接口地址' },
  { key: 'executors', label: '执行器', desc: '本机 CLI 执行器配置' },
  { key: 'agents', label: 'Agent', desc: '工作助手' },
  // SPEC-settings-24：交给 Claude Code 时可选的执行要求
  { key: 'run-prompts', label: '角色', desc: '交给 Claude Code 的角色：执行要求、权限、输出要求' },
  // TSK-0499：后台执行放行什么（工作台 MCP、只读命令、写入档位、自定义白名单）
  { key: 'run-permissions', label: '执行权限', desc: '交给 Claude Code 后台执行时放行的工具和命令' },
  // TSK-0722：交给执行能选的执行器装没装、缺什么，DeepSeek 的集成检查
  { key: 'runners', label: '执行器', desc: 'Claude Code、DeepSeek、工作台 Agent 能不能用，集成检查' },
  { key: 'kbs', label: '知识库', desc: 'Agent 检索用的资料' },
  { key: 'skills', label: '技能', desc: '可复用的做事方法' },
  { key: 'enums', label: '枚举值', desc: '状态、优先级、分类等选项' },
  // FS-01：原型没有这一节，选目录能走到哪些地方
  { key: 'localfs', label: '本机目录', desc: '选目录时能浏览的范围' },
  { key: 'incidents', label: '运行异常', desc: '系统出的问题，可转研发任务' },
  { key: 'appearance', label: '外观', desc: '配色方案、菜单收起' },
  // SYS-UPD：原型没有这一节，把工作台更新到源码目录里的最新代码
  { key: 'update', label: '版本更新', desc: '更新到最新版本并重启' },
]

// 插件分节的路径：/settings/plugins/<插件 id>/<分节 key>，不同插件的 key 撞了也分得开
const pluginKey = (plugin: string, key: string) => `plugins/${plugin}/${key}`

export default function Page() {
  const navigate = useNavigate()
  const path = useParams()['*'] ?? ''
  // Agent 配置页在 agents/<id>、agents/new 下，二级菜单仍停在 Agent（AG-01b5）
  // 角色的编辑页在 run-prompts/<id>、run-prompts/new 下，二级菜单仍停在角色
  const active = path.startsWith('agents/') ? 'agents' : path.startsWith('run-prompts/') ? 'run-prompts' : path
  const sections = useSettingsSections()
  // 连接器异常的数量挂在二级菜单的红点上（SPEC-settings-1.3）
  const connErrors = (useConnectors().data ?? []).filter((c) => c.status === 'error').length
  // 运行异常的红点只算未处理的错误，警告不算（SPEC-settings-18.12），和运行异常页顶栏的「M 个是错误」对得上
  const incErrors = openErrors(useIncidents().data ?? []).length
  // 有版本差异时「版本更新」菜单项亮红点（SYS-UPD），进页面有绿色提示；没差异就不打扰
  const updateAvailable = useUpdateStatus(false).data?.available ? 1 : 0
  const alertOf = (k: string) => (k === 'connectors' ? connErrors : k === 'incidents' ? incErrors : k === 'update' ? updateAvailable : 0)
  const items: SubnavItem<string>[] = [
    ...KERNEL.map((k) => (alertOf(k.key) ? { ...k, alert: alertOf(k.key) } : k)),
    ...sections.map((s) => ({ key: pluginKey(s.plugin, s.key), label: s.label, desc: s.desc, group: s.group ?? '插件' })),
  ]
  const kernel = KERNEL.find((k) => k.key === active)
  const plugin = sections.find((s) => pluginKey(s.plugin, s.key) === active)
  // 没选或选的分节已经没了（插件停用）时回到第一节
  if (!kernel && !plugin) return <Navigate to={'/settings/' + KERNEL[0].key} replace />

  return (
    <>
      <InSubnavHost>
        <Subnav title="设置" items={items} active={active} onSelect={(k) => { void navigate('/settings/' + k) }} />
      </InSubnavHost>
      {plugin ? <PluginSettingsPage key={active} section={plugin} />
        : kernel!.key === 'plugins' ? <PluginsSection />
        : kernel!.key === 'providers' ? <ProvidersSection />
        : kernel!.key === 'connectors' ? <ConnectorsSection />
        : kernel!.key === 'workspace' ? <WorkspacesSection />
        : kernel!.key === 'enums' ? <EnumsSection />
        : kernel!.key === 'executors' ? <ExecutorsSection />
        : kernel!.key === 'agents' ? <AgentsSection />
        : kernel!.key === 'run-prompts' ? <RunPresetsSection />
        : kernel!.key === 'run-permissions' ? <RunPermsSection />
        : kernel!.key === 'runners' ? <RunnersSection />
        : kernel!.key === 'kbs' ? <KbSection />
        : kernel!.key === 'skills' ? <SkillsSection />
        : kernel!.key === 'localfs' ? <LocalFsSection />
        : kernel!.key === 'incidents' ? <IncidentsSection />
        : kernel!.key === 'appearance' ? <AppearanceSection />
        : kernel!.key === 'update' ? <UpdateSection /> : <Placeholder title={kernel!.label} />}
    </>
  )
}
