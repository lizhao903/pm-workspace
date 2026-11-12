// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 项目列表（SPEC-projects-1）：卡片网格，可搜索、按「有原型在跑 / 有待回复 / 其他」筛选（ALIGN-05），按最近打开或名称排序；
// 没筛选、没搜索时按这三段分组。原型数、绑定的会话来自项目汇总（/api/projects/summary），待回复数按会话对上待处理消息。
// 项目类型自己的状态（筹备中、已暂停……）不再分组，常态「进行中」以外的在卡片上标一个小标签
import { useMemo, useState } from 'react'
import {
  EMPTY_STAT, PROJECT_TYPE, errorText, projectStats, projectView, useAllObjects, useCreateProject, useObjectTypes, usePendingImMessages,
  usePlugins, useProjectSummary, useProjects, type ProjectView,
} from '../../core/data'
import { Button, ErrorState, IconClose, IconSearch, LoadingState, PageTitle, Pill, cls } from '../../core/ui'
import { IM_PLUGIN } from './commsModel'
import { ProjectMarkView } from './Mark'
import { NEW_PROJECT_ICON } from './markIcons'
import {
  ACTIVITY_GROUPS, GROUP_PEEK, NEW_PROJECT_NAME, activityOf, dirName, groupByActivity, loadRecent, markFresh, matchQuery, nextColor, openTaskCounts,
  showStatusTag, sortProjects,
  type Activity, type Sort,
} from './model'

export function ListPage({ onOpen }: { onOpen: (id: string, tab?: 'settings') => void }) {
  const projects = useProjects()
  const types = useObjectTypes()
  const openTasks = useAllObjects({ type: ['task'], not_terminal: true })
  const summary = useProjectSummary()
  const plugins = usePlugins()
  // IM 插件没在跑时消息接口 404，不发请求，待回复都按 0；插件列表取不到时照常去取
  const imOn = plugins.isError || !!plugins.data?.find((p) => p.id === IM_PLUGIN)?.running
  const pending = usePendingImMessages(imOn)
  const create = useCreateProject()
  const [q, setQ] = useState('')
  const [filter, setFilter] = useState<Activity>('')
  const [sort, setSort] = useState<Sort>('recent')
  const [expanded, setExpanded] = useState<string[]>([])
  // 进列表时读一次；打开项目会离开列表页，回来再读
  const [recent] = useState(loadRecent)

  const statuses = useMemo(() => types.data?.find((t) => t.id === PROJECT_TYPE)?.statuses ?? [], [types.data])
  const all = useMemo(() => (projects.data?.data ?? []).map(projectView), [projects.data])
  const taskN = useMemo(() => openTaskCounts(openTasks.data?.data ?? []), [openTasks.data])
  const stats = useMemo(() => projectStats(summary.data ?? [], pending.data ?? []), [summary.data, pending.data])
  const stat = (p: ProjectView) => stats.get(p.id) ?? EMPTY_STAT
  const groupOf = (p: ProjectView) => activityOf(stats.get(p.id))
  const rows = sortProjects(all.filter((p) => (!filter || groupOf(p) === filter) && matchQuery(p, q)), sort, recent)
  // 数字是全部项目里的个数，不受搜索影响（SPEC-projects-1.5）
  const groupN = (k: Activity) => all.filter((p) => groupOf(p) === k).length
  const statusOf = (k: string) => statuses.find((s) => s.key === k)

  const newProject = () => {
    if (create.isPending) return
    create.mutate(
      { title: NEW_PROJECT_NAME, color: nextColor(all.length), mark: { text: '', icon: NEW_PROJECT_ICON } },
      // 记成刚新建：名称没改就离开设置时问要不要删（C-05）
      { onSuccess: (o) => { markFresh(o.id); onOpen(o.id, 'settings') } },
    )
  }
  const newBtn = (
    <Button variant="primary" onClick={newProject} disabled={create.isPending}>
      <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
      新建项目
    </Button>
  )
  const title = (
    <PageTitle parent="项目" count={projects.data ? all.length : undefined} desc="有原型在跑、有待回复的排在前面；点卡片打开项目" actions={newBtn}>全部项目</PageTitle>
  )

  const card = (p: ProjectView) => {
    const n = taskN.get(p.id) ?? 0
    const s = stat(p)
    const st = showStatusTag(p.status) ? statusOf(p.status) : undefined
    const dir = dirName(p.root)
    return (
      <button key={p.id} type="button" className="pj-card" title={p.name} onClick={() => onOpen(p.id)}>
        <span className="pj-card-head">
          <ProjectMarkView p={p} size={28} /><b className="pj-card-name">{p.name}</b>
          {st && <Pill label={st.label} color={st.color} className="pj-card-status" />}
        </span>
        <span className="pj-card-desc">{p.desc || <span className="faint">没有说明</span>}</span>
        <span className="pj-card-meta">
          {s.protoTotal > 0 && (
            <span className={cls(s.protoRunning > 0 && 'pj-ok')}>
              <span className={cls('pj-proto-light', s.protoRunning > 0 && 'pj-pl-running')} />原型 {s.protoRunning}/{s.protoTotal}
            </span>
          )}
          {s.pending > 0 && <span className="pj-warn">{s.pending} 条待回复</span>}
          <span>{openTasks.data ? (n ? `${n} 个未完成任务` : '没有未完成任务') : '任务数加载中'}</span>
          <span className="pj-card-dir pj-mono ellipsis" title={p.root || undefined}>{dir || '未设目录'}</span>
        </span>
      </button>
    )
  }

  let body
  // 分组要等汇总和待处理消息，不然先全落在「其他」再跳
  if (projects.isPending || summary.isPending || (imOn && pending.isPending)) body = <LoadingState />
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
  } else if (!filter && !q.trim()) {
    body = (
      <div className="pj-groups">
        {groupByActivity(rows, groupOf).map((g) => {
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
      {summary.isError && (
        <div className="pj-err" role="alert">
          原型和沟通的统计没取到，分组先按没有算：{errorText(summary.error)}
          <Button size="sm" onClick={() => void summary.refetch()}>重试</Button>
        </div>
      )}
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
            <button type="button" className={cls(!filter && 'on')} aria-pressed={!filter} onClick={() => setFilter('')}>
              全部<span className="seg-n">{all.length}</span>
            </button>
            {ACTIVITY_GROUPS.map((g) => (
              <button key={g.key} type="button" className={cls(filter === g.key && 'on')} aria-pressed={filter === g.key} onClick={() => setFilter(g.key)}>
                {g.label}<span className="seg-n">{groupN(g.key)}</span>
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
