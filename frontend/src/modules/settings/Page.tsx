import { Navigate, useNavigate, useParams } from 'react-router'
import { Placeholder } from '../../core/shell/Placeholder'
import { PluginSettingsPage } from '../../core/shell/extensionHosts'
import { useSettingsSections } from '../../core/plugin'
import { InSubnavHost, Subnav, type SubnavItem } from '../../core/ui'

// 内核的设置分节，照原型 web-next/src/settings.tsx SECTIONS；内网域名是插件的分节，不在这里。
// 内容还没做，点进去是占位页
const KERNEL: SubnavItem<string>[] = [
  { key: 'workspace', label: '工作台与模块', desc: '切换工作台、选功能模块' },
  { key: 'connectors', label: '连接器', desc: '对接外部工具' },
  { key: 'providers', label: '模型服务商', desc: 'API Key 与接口地址' },
  { key: 'agents', label: 'Agent', desc: '工作助手' },
  { key: 'kbs', label: '知识库', desc: 'Agent 检索用的资料' },
  { key: 'skills', label: '技能', desc: '可复用的做事方法' },
  { key: 'enums', label: '枚举值', desc: '状态、优先级、分类等选项' },
  { key: 'incidents', label: '运行异常', desc: '系统出的问题，可转研发任务' },
  { key: 'appearance', label: '外观', desc: '配色方案、菜单收起' },
]

// 插件分节的路径：/settings/plugins/<插件 id>/<分节 key>，不同插件的 key 撞了也分得开
const pluginKey = (plugin: string, key: string) => `plugins/${plugin}/${key}`

export default function Page() {
  const navigate = useNavigate()
  const active = useParams()['*'] ?? ''
  const sections = useSettingsSections()
  const items: SubnavItem<string>[] = [
    ...KERNEL,
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
      {plugin ? <PluginSettingsPage key={active} section={plugin} /> : <Placeholder title={kernel!.label} />}
    </>
  )
}
