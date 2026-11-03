// 项目详情的框架（SPEC-projects-2）：顶栏「项目 /」回列表、标志、名称、说明；标签条；各标签的右上按钮。
// 概览、设置（PJ-01c），干系人、任务、文档（PJ-01d），支持材料（PJ-03b），沟通（PJ-02b），附件（SPEC-projects-5），原型（PJ-04b），SOP（PR-10），Agent（PR-21）；其余标签按规格占位，由后续任务补
// 「附件」标签只在 IM 消息插件在跑时出现（消息和附件都来自它），标签上的数字是待决定的附件个数
// 插件登记的标签（core/plugin 的 projectTabs，视频插件的「商单」）按 after 插进标签条，内容由插件渲染
// 项目设置里勾掉的标签（props.tabs_hidden，SPEC-projects-13.19）不显示，标签按设置里排的顺序（props.tabs_order，SPEC-projects-13.20）；正停在被藏掉的标签上时回概览；标题里的项目名是切换项目的菜单（SPEC-projects-2.9）
import { Suspense, useEffect, useRef, useState } from 'react'
import { errorText, isApiError, isLiveProject, projectView, useProject } from '../../core/data'
import { useProjectTabs } from '../../core/plugin'
import { Button, EmptyState, ErrorState, LoadingState, PageTitle, cls } from '../../core/ui'
import { AgentsTab } from './AgentsTab'
import { AttachmentsTab, AttachmentsTabCount } from './AttachmentsTab'
import { CommsTab, CommsTabDot } from './CommsTab'
import { DocsTab } from './DocsTab'
import { MaterialsTab } from './MaterialsTab'
import { PrototypesTab, ProtoTabLight } from './PrototypesTab'
import { Overview } from './Overview'
import { Settings } from './Settings'
import { SopTab } from './SopTab'
import { StakeholdersTab } from './StakeholdersTab'
import { TasksTab } from './TasksTab'
import { TABS, hiddenTabsOf, orderTabs, tabsOrderOf, withPluginTabs, type ProjectTab } from './model'
import { ProjectSwitcher } from './ProjectSwitcher'
import { useProjectMessages } from './projectMessages'

export function ProjectPage({ id, tab, onTab, onAll, onSwitch }: {
  id: string
  /** 项目自己的标签，或插件登记的标签 key */
  tab: ProjectTab | string
  /** query 是带到地址上的参数（如 s=<会话 id> 在 Agent 标签里就地打开会话） */
  onTab: (t: ProjectTab | string, query?: string) => void
  /** 回到项目列表 */
  onAll: () => void
  /** 标题里的菜单切到别的项目（停在同一个标签） */
  onSwitch?: (id: string) => void
}) {
  const q = useProject(id)
  const pluginTabs = useProjectTabs()
  const { noIm, imRunning } = useProjectMessages(id)
  const ref = useRef<HTMLDivElement>(null)
  // 文档标签「加文档」的内联表单
  const [docAdding, setDocAdding] = useState(false)
  // 支持材料标签「加材料」的内联表单
  const [matAdding, setMatAdding] = useState(false)
  // 原型标签「加原型」的内联表单
  const [protoAdding, setProtoAdding] = useState(false)
  // 切换标签时滚回顶部（SPEC-projects-2.3）：滚动的是外壳的内容区
  useEffect(() => {
    const box = ref.current?.closest('.shell-content')
    if (box) box.scrollTop = 0
  }, [tab])
  // 停在这个项目藏掉的标签上（改了设置、从别的项目切过来）时回概览
  const hidden = hiddenTabsOf(q.data)
  const onHidden = hidden.includes(tab)
  useEffect(() => { if (onHidden) onTab('overview') }, [onHidden, onTab])

  const back = <button type="button" className="pj-back" title="回到项目列表" onClick={onAll}>项目</button>
  const gone = (q.isError && isApiError(q.error) && q.error.code === 'not_found') || (q.data && !isLiveProject(q.data))
  if (gone) {
    return (
      <div className="pj-page">
        <PageTitle parent={back}>项目不存在</PageTitle>
        <EmptyState title="这个项目不存在或已删除" action={<Button variant="primary" onClick={onAll}>回到项目列表</Button>} />
      </div>
    )
  }
  if (q.isPending) return <div className="pj-page"><PageTitle parent={back}>项目</PageTitle><LoadingState /></div>
  if (q.isError && !q.data) {
    return (
      <div className="pj-page">
        <PageTitle parent={back}>项目</PageTitle>
        <ErrorState title="项目没加载出来" error={errorText(q.error)} onRetry={() => void q.refetch()} />
      </div>
    )
  }
  const o = q.data!
  const p = projectView(o)
  // 附件标签：IM 插件没在跑（或插件列表还没回来、读不出来）时不显示；正停在这个标签上时照样显示，内容里提示去插件管理
  const tabs = orderTabs(withPluginTabs(pluginTabs), tabsOrderOf(o)).filter((t) => !hidden.includes(t.key))
    .filter((t) => t.key !== 'attachments' || tab === 'attachments' || (imRunning && !noIm))
  const cur = tabs.find((t) => t.key === tab) ?? TABS[0]
  const plug = pluginTabs.find((t) => t.key === tab)
  const actions = tab === 'overview' ? <Button variant="outline" onClick={() => onTab('settings')}>项目设置</Button>
    : tab === 'docs' ? <Button variant="primary" disabled={docAdding} onClick={() => setDocAdding(true)}>加文档</Button>
      : tab === 'materials' ? <Button variant="primary" disabled={matAdding} onClick={() => setMatAdding(true)}>加材料</Button>
        : tab === 'prototypes' ? <Button variant="primary" disabled={protoAdding} onClick={() => setProtoAdding(true)}>加原型</Button>
          : undefined

  return (
    <div className="pj-page" ref={ref}>
      <PageTitle parent={back} desc={p.desc || undefined} actions={actions}>
        {onSwitch ? <ProjectSwitcher current={o.id} name={p.name} onSwitch={onSwitch} /> : p.name}
      </PageTitle>
      <div className="pj-tabs" role="tablist" aria-label="项目标签">
        {tabs.map((t) => (
          <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} className={cls(tab === t.key && 'on')} onClick={() => { setDocAdding(false); setMatAdding(false); setProtoAdding(false); onTab(t.key) }}>
            {t.label}
            {t.key === 'comms' && <CommsTabDot projectId={o.id} />}
            {t.key === 'attachments' && <AttachmentsTabCount projectId={o.id} />}
            {t.key === 'prototypes' && <ProtoTabLight projectId={o.id} />}
            {t.badge && <t.badge projectId={o.id} />}
          </button>
        ))}
      </div>
      <div role="tabpanel" aria-label={cur.label}>
        {tab === 'overview' && <Overview project={o} onTab={onTab} />}
        {tab === 'comms' && <CommsTab key={o.id} projectId={o.id} onAttachments={() => onTab('attachments')} />}
        {tab === 'attachments' && <AttachmentsTab key={o.id} projectId={o.id} />}
        {tab === 'settings' && <Settings key={o.id} project={o} onDeleted={onAll} />}
        {tab === 'stakeholders' && <StakeholdersTab key={o.id} projectId={o.id} />}
        {tab === 'tasks' && <TasksTab key={o.id} projectId={o.id} />}
        {tab === 'sop' && <SopTab key={o.id} project={o} />}
        {tab === 'agents' && <AgentsTab key={o.id} project={o} />}
        {tab === 'docs' && <DocsTab key={o.id} projectId={o.id} adding={docAdding} onAdding={setDocAdding} />}
        {tab === 'materials' && <MaterialsTab key={o.id} projectId={o.id} root={p.root} adding={matAdding} onAdding={setMatAdding} />}
        {tab === 'prototypes' && <PrototypesTab key={o.id} projectId={o.id} projectName={p.name} root={p.root} adding={protoAdding} onAdding={setProtoAdding} />}
        {plug && <Suspense fallback={<LoadingState />}><plug.page key={o.id} projectId={o.id} /></Suspense>}
        {cur.todo && <EmptyState title={`「${cur.label}」还在开发中`} desc={cur.todo} />}
      </div>
    </div>
  )
}
