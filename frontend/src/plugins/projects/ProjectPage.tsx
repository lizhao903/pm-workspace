// 项目详情的框架（SPEC-projects-2）：顶栏「项目 /」回列表、标志、名称、说明；标签条；各标签的右上按钮。
// 概览、设置（PJ-01c），干系人、任务、文档（PJ-01d），支持材料（PJ-03b），沟通（PJ-02b），原型（PJ-04b）；其余标签按规格占位，由后续任务补
import { useEffect, useRef, useState } from 'react'
import { errorText, isApiError, isLiveProject, projectView, useProject } from '../../core/data'
import { Button, EmptyState, ErrorState, LoadingState, PageTitle, cls } from '../../core/ui'
import { ProjectMarkView } from './Mark'
import { CommsTab } from './CommsTab'
import { DocsTab } from './DocsTab'
import { MaterialsTab } from './MaterialsTab'
import { PrototypesTab, ProtoTabLight } from './PrototypesTab'
import { Overview } from './Overview'
import { Settings } from './Settings'
import { StakeholdersTab } from './StakeholdersTab'
import { TasksTab } from './TasksTab'
import { TABS, type ProjectTab } from './model'

export function ProjectPage({ id, tab, onTab, onAll }: {
  id: string
  tab: ProjectTab
  onTab: (t: ProjectTab) => void
  /** 回到项目列表 */
  onAll: () => void
}) {
  const q = useProject(id)
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
  const cur = TABS.find((t) => t.key === tab)!
  const actions = tab === 'overview' ? <Button variant="outline" onClick={() => onTab('settings')}>项目设置</Button>
    : tab === 'docs' ? <Button variant="primary" disabled={docAdding} onClick={() => setDocAdding(true)}>加文档</Button>
      : tab === 'materials' ? <Button variant="primary" disabled={matAdding} onClick={() => setMatAdding(true)}>加材料</Button>
        : tab === 'prototypes' ? <Button variant="primary" disabled={protoAdding} onClick={() => setProtoAdding(true)}>加原型</Button>
          : undefined

  return (
    <div className="pj-page" ref={ref}>
      <PageTitle parent={back} icon={<ProjectMarkView p={p} size={20} />} desc={p.desc || undefined} actions={actions}>{p.name}</PageTitle>
      <div className="pj-tabs" role="tablist" aria-label="项目标签">
        {TABS.map((t) => (
          <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} className={cls(tab === t.key && 'on')} onClick={() => { setDocAdding(false); setMatAdding(false); setProtoAdding(false); onTab(t.key) }}>
            {t.label}
            {t.key === 'prototypes' && <ProtoTabLight projectId={o.id} />}
          </button>
        ))}
      </div>
      <div role="tabpanel" aria-label={cur.label}>
        {tab === 'overview' && <Overview project={o} onTab={onTab} />}
        {tab === 'comms' && <CommsTab key={o.id} projectId={o.id} />}
        {tab === 'settings' && <Settings key={o.id} project={o} onDeleted={onAll} />}
        {tab === 'stakeholders' && <StakeholdersTab key={o.id} projectId={o.id} />}
        {tab === 'tasks' && <TasksTab key={o.id} projectId={o.id} />}
        {tab === 'docs' && <DocsTab key={o.id} projectId={o.id} adding={docAdding} onAdding={setDocAdding} />}
        {tab === 'materials' && <MaterialsTab key={o.id} projectId={o.id} root={p.root} adding={matAdding} onAdding={setMatAdding} />}
        {tab === 'prototypes' && <PrototypesTab key={o.id} projectId={o.id} projectName={p.name} root={p.root} adding={protoAdding} onAdding={setProtoAdding} />}
        {cur.todo && <EmptyState title={`「${cur.label}」还在开发中`} desc={cur.todo} />}
      </div>
    </div>
  )
}
