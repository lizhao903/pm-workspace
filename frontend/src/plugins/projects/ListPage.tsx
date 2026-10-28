// 项目列表（SPEC-projects-1）：卡片网格，可搜索、按状态筛选，按最近打开或名称排序；没筛选、没搜索时按状态分组。
// 状态是项目类型自己的状态集（/api/object-types），原型的「有原型在跑 / 有待回复」要等原型进程（PJ-04）和项目沟通（PJ-02）
import { useMemo, useState } from 'react'
import {
  PROJECT_TYPE, errorText, projectView, useAllObjects, useCreateProject, useObjectTypes, useProjects, type ProjectView,
} from '../../core/data'
import { Button, ErrorState, IconClose, IconSearch, LoadingState, PageTitle, Pill, cls } from '../../core/ui'
import { ProjectMarkView } from './Mark'
import { NEW_PROJECT_ICON } from './markIcons'
import { GROUP_PEEK, dirName, groupByStatus, loadRecent, matchQuery, nextColor, openTaskCounts, sortProjects, type Sort } from './model'

export function ListPage({ onOpen }: { onOpen: (id: string, tab?: 'settings') => void }) {
  const projects = useProjects()
  const types = useObjectTypes()
  const openTasks = useAllObjects({ type: ['task'], not_terminal: true })
  const create = useCreateProject()
  const [q, setQ] = useState('')
  const [status, setStatus] = useState('')
  const [sort, setSort] = useState<Sort>('recent')
  const [expanded, setExpanded] = useState<string[]>([])
  // 进列表时读一次；打开项目会离开列表页，回来再读
  const [recent] = useState(loadRecent)

  const statuses = useMemo(() => types.data?.find((t) => t.id === PROJECT_TYPE)?.statuses ?? [], [types.data])
  const all = useMemo(() => (projects.data?.data ?? []).map(projectView), [projects.data])
  const taskN = useMemo(() => openTaskCounts(openTasks.data?.data ?? []), [openTasks.data])
  const rows = useMemo(
    () => sortProjects(all.filter((p) => (!status || p.status === status) && matchQuery(p, q)), sort, recent),
    [all, status, q, sort, recent],
  )
  const statusN = (k: string) => all.filter((p) => p.status === k).length
  const statusOf = (k: string) => statuses.find((s) => s.key === k)

  const newProject = () => {
    if (create.isPending) return
    create.mutate(
      { title: '新项目', color: nextColor(all.length), mark: { text: '', icon: NEW_PROJECT_ICON } },
      { onSuccess: (o) => onOpen(o.id, 'settings') },
    )
  }
  const newBtn = (
    <Button variant="primary" onClick={newProject} disabled={create.isPending}>
      <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
      新建项目
    </Button>
  )
  const title = (
    <PageTitle parent="项目" count={projects.data ? all.length : undefined} desc="按状态分组；点卡片打开项目" actions={newBtn}>全部项目</PageTitle>
  )

  const card = (p: ProjectView) => {
    const n = taskN.get(p.id) ?? 0
    const st = statusOf(p.status)
    const dir = dirName(p.root)
    return (
      <button key={p.id} type="button" className="pj-card" title={p.name} onClick={() => onOpen(p.id)}>
        <span className="pj-card-head"><ProjectMarkView p={p} size={28} /><b className="pj-card-name">{p.name}</b></span>
        <span className="pj-card-desc">{p.desc || <span className="faint">没有说明</span>}</span>
        <span className="pj-card-meta">
          {st && status === '' && q.trim() !== '' && <Pill label={st.label} color={st.color} />}
          <span>{openTasks.data ? (n ? `${n} 个未完成任务` : '没有未完成任务') : '任务数加载中'}</span>
          <span className="pj-mono ellipsis" title={p.root || undefined}>{dir || '未设目录'}</span>
        </span>
      </button>
    )
  }

  let body
  if (projects.isPending) body = <LoadingState />
  else if (projects.isError && !projects.data) {
    body = <ErrorState title="项目没加载出来" error={errorText(projects.error)} onRetry={() => void projects.refetch()} />
  } else if (!all.length) {
    body = (
      <div className="empty">
        <div className="empty-title">还没有项目</div>
        <div className="empty-desc">把一个产品相关的沟通、干系人、任务、文档和原型串到一起</div>
        <Button variant="primary" onClick={newProject} disabled={create.isPending}>新建第一个项目</Button>
      </div>
    )
  } else if (!rows.length) {
    body = (
      <div className="empty">
        <div className="empty-title">没有匹配的项目</div>
        <div className="empty-desc">换个关键词，或清掉状态筛选</div>
      </div>
    )
  } else if (!status && !q.trim()) {
    body = (
      <div className="pj-groups">
        {groupByStatus(rows, statuses).map((g) => {
          const open = expanded.includes(g.key)
          return (
            <section key={g.key} className="pj-group" aria-label={g.label}>
              <div className="pj-sec-head">
                <h2 className="pj-sec-title">{g.label}<span className="pj-hint">{g.items.length} 个</span></h2>
                {g.items.length > GROUP_PEEK && (
                  <Button size="sm" onClick={() => setExpanded(open ? expanded.filter((x) => x !== g.key) : [...expanded, g.key])}>
                    {open ? '收起' : `显示全部 ${g.items.length} 个`}
                  </Button>
                )}
              </div>
              <div className="pj-grid">{(open ? g.items : g.items.slice(0, GROUP_PEEK)).map(card)}</div>
            </section>
          )
        })}
      </div>
    )
  } else {
    body = <div className="pj-grid">{rows.map(card)}</div>
  }

  return (
    <div className="pj-page">
      {title}
      {create.isError && <div className="pj-err" role="alert">项目没建成：{errorText(create.error)}</div>}
      {all.length > 0 && (
        <div className="pj-toolbar">
          <div className="search">
            <IconSearch />
            <input type="search" placeholder="搜项目名、说明、目录" aria-label="搜索项目" value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Escape' && q) { e.preventDefault(); setQ('') } }} />
            {q && <button type="button" className="search-clear" aria-label="清空" title="清空" onClick={() => setQ('')}><IconClose size={10} /></button>}
          </div>
          <div className="pj-seg" role="group" aria-label="状态">
            <button type="button" className={cls(!status && 'on')} aria-pressed={!status} onClick={() => setStatus('')}>
              全部<span className="seg-n">{all.length}</span>
            </button>
            {statuses.map((s) => (
              <button key={s.key} type="button" className={cls(status === s.key && 'on')} aria-pressed={status === s.key} onClick={() => setStatus(s.key)}>
                {s.label}<span className="seg-n">{statusN(s.key)}</span>
              </button>
            ))}
          </div>
          <div className="spacer" />
          <label className="pj-sort">
            排序
            <select value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
              <option value="recent">最近打开</option>
              <option value="name">名称</option>
            </select>
          </label>
        </div>
      )}
      {body}
    </div>
  )
}
