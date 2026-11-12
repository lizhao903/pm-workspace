// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 定时任务列表（SPEC-tasks-7）：动作类型筛选、搜索、启用的按下次执行排、停用的沉到底部默认收起，行尾开关立刻启停。
// SchedulesView 管列表、定时任务抽屉和从执行记录打开的任务抽屉；/tasks/schedules?open=<id> 直接打开某一条，
// ?project=<项目 id> 按项目筛，再带 new=1 是从项目详情「新建定时任务」进来：打开新建抽屉、预填所属项目。
import { useState } from 'react'
import { useSearchParams } from 'react-router'
import {
  errorText, isApiError, useLastScheduleRuns, useObject, usePatchSchedule, useSchedules, useSopFlows, useVideoPlatforms, useVideoPublishes,
  type DictItem, type ObjectStatus, type Schedule, type ScheduleRun, type WorkObject,
} from '../../core/data'
import { Button, EmptyState, ErrorState, IconClose, IconSearch, ListSegHead, LoadingState, PageTitle, SearchSelect, cls } from '../../core/ui'
import { timeAgo } from './model'
import { ScheduleDrawer } from './ScheduleDrawer'
import { ACTION_KINDS, actionLabel, actionText, describeRule, fullRule, isPluginAction, matchSchedule, nextCellText, publishIdOf, type ActionNames } from './scheduleModel'
import { TaskDrawer } from './TaskDrawer'
import './schedules.css'

// 列表「上次」一列多久重取一次（调度器到点执行不发事件）
const LAST_RUN_POLL_MS = 60_000

type Opened = { kind: 'schedule'; id: string; fallback?: Schedule } | { kind: 'new' }

export function SchedulesView({ statuses, priorities, projects }: {
  /** 打开建出来的任务时给任务抽屉用 */
  statuses: ObjectStatus[]
  priorities: DictItem[]
  projects: WorkObject[]
}) {
  const [params] = useSearchParams()
  const list = useSchedules()
  const linkProject = params.get('project') ?? ''
  const [opened, setOpened] = useState<Opened | null>(() => {
    const id = params.get('open')
    return id ? { kind: 'schedule', id } : params.get('new') ? { kind: 'new' } : null
  })
  // 从执行记录打开的任务；关掉后回到原来的定时任务抽屉
  const [taskId, setTaskId] = useState<string | null>(null)

  const rows = list.data ?? []
  const sel = opened?.kind === 'schedule' ? opened.id : null
  const openSchedule = opened?.kind === 'schedule' ? rows.find((s) => s.id === opened.id) ?? opened.fallback ?? null : null

  return (
    <>
      <SchedulesPage schedules={rows} loading={list.isPending} error={list.isError ? list.error : undefined}
        onRetry={() => void list.refetch()} selected={sel} projects={projects} initProject={linkProject}
        onOpen={(id) => setOpened({ kind: 'schedule', id })} onNew={() => setOpened({ kind: 'new' })} />
      {!taskId && opened?.kind === 'new' && (
        <ScheduleDrawer key="new" schedule={null} projects={projects} initProjectId={linkProject} onClose={() => setOpened(null)}
          onCreated={(s) => setOpened({ kind: 'schedule', id: s.id, fallback: s })} />
      )}
      {!taskId && openSchedule && (
        // 换一条就重新挂载，表单从这条的值重新开始
        <ScheduleDrawer key={openSchedule.id} schedule={openSchedule} projects={projects} onClose={() => setOpened(null)}
          onCreated={() => undefined} onOpenTask={setTaskId} />
      )}
      {/* ?open= 指向的定时任务不在列表里 */}
      {!taskId && sel && !openSchedule && list.isSuccess && (
        <NotFoundBar onClose={() => setOpened(null)} />
      )}
      {taskId && (
        <TaskById id={taskId} statuses={statuses} priorities={priorities} projects={projects} onClose={() => setTaskId(null)} />
      )}
    </>
  )
}

function NotFoundBar({ onClose }: { onClose: () => void }) {
  return (
    <div className="sched-alert field-err" role="alert">
      要打开的定时任务不存在，可能已经删了
      <Button size="sm" onClick={onClose}>知道了</Button>
    </div>
  )
}

/** 按编号取任务再开任务抽屉；任务被彻底删掉时给一句话。Webhook 页的推送记录也用它 */
export function TaskById({ id, statuses, priorities, projects, onClose, back = '回到定时任务' }: {
  id: string
  statuses: ObjectStatus[]
  priorities: DictItem[]
  projects: WorkObject[]
  onClose: () => void
  /** 任务打不开时的返回按钮 */
  back?: string
}) {
  const q = useObject(id)
  if (q.data) {
    return <TaskDrawer key={id} task={q.data} statuses={statuses} priorities={priorities} projects={projects} onClose={onClose} onCreated={() => undefined} />
  }
  if (q.isError) {
    return (
      <div className="sched-alert field-err" role="alert">
        {isApiError(q.error, 'not_found') ? '这条任务已经删掉了' : `任务没打开：${errorText(q.error)}`}
        <Button size="sm" onClick={onClose}>{back}</Button>
      </div>
    )
  }
  return null
}

// 项目筛选里「不属于项目」的值，和任务列表一致
const NO_PROJECT = '-'

export function SchedulesPage({ schedules, loading, error, onRetry, selected, onOpen, onNew, projects = [], initProject = '', now: nowProp }: {
  schedules: Schedule[]
  /** type=project 的对象：项目筛选和名称旁的项目标签 */
  projects?: readonly { id: string; title: string }[]
  /** 进来时的项目筛选（?project=） */
  initProject?: string
  loading?: boolean
  error?: unknown
  onRetry?: () => void
  selected: string | null
  onOpen: (id: string) => void
  onNew: () => void
  /** 测试里固定「现在」 */
  now?: Date
}) {
  const [opened] = useState(() => new Date())
  const now = nowProp ?? opened
  const [q, setQ] = useState('')
  // 内核三种加上列表里出现的插件动作
  const [kind, setKind] = useState('')
  const [proj, setProj] = useState(initProject)
  const projName = (id: string) => projects.find((p) => p.id === id)?.title
  // 停用的沉到底部，默认收起
  const [offOpen, setOffOpen] = useState(false)
  const [toggleErr, setToggleErr] = useState('')
  const toggle = usePatchSchedule()
  const last = useLastScheduleRuns(schedules.map((s) => s.id), LAST_RUN_POLL_MS)
  // 有视频发布动作时才取发布记录，拿标题显示；视频插件没启用时取不到，显示编号
  const hasPub = schedules.some((s) => !!publishIdOf(s.action))
  const pubs = useVideoPublishes({ enabled: hasPub })
  const plats = useVideoPlatforms({ enabled: hasPub })
  const platLabel = (k: string) => plats.data?.find((x) => x.key === k)?.label ?? k
  // 有 SOP 动作时取流程名（TSK-0463）；SOP 插件没启用时取不到，显示编号
  const hasSop = schedules.some((s) => s.action.kind === 'sop')
  const flows = useSopFlows({ enabled: hasSop })
  const names: ActionNames = {
    ...(pubs.data ? { publishes: Object.fromEntries(pubs.data.map((p) => [p.id, `${platLabel(p.platform)} · ${p.title || '未填标题'}`])) } : {}),
    ...(flows.data ? { flows: Object.fromEntries(flows.data.map((f) => [f.id, f.name])) } : {}),
  }
  const kinds = [...ACTION_KINDS as string[], ...new Set(schedules.map((s) => s.action.kind as string).filter(isPluginAction))]

  const kw = q.trim()
  // 后端已按下次执行排好（早的在前，不再执行的在后），这里只筛不排
  const inProj = (s: Schedule) => !proj || (proj === NO_PROJECT ? !s.project_id : s.project_id === proj)
  const hit = schedules.filter((s) => (!kind || s.action.kind === kind) && inProj(s) && matchSchedule(s, kw, names))
  const on = hit.filter((s) => s.enabled)
  const off = hit.filter((s) => !s.enabled)
  const offShown = offOpen || !!kw

  const setEnabled = (s: Schedule, enabled: boolean) => {
    setToggleErr('')
    toggle.mutate({ id: s.id, patch: { enabled } }, {
      onError: (e) => setToggleErr(`「${s.name}」没能${enabled ? '启用' : '停用'}：${errorText(e)}`),
    })
  }

  const row = (s: Schedule) => {
    const lr = last[s.id]
    // 请求在路上时开关先翻过去，失败就弹回原状
    const pending = toggle.isPending && toggle.variables?.id === s.id
    const enabled = pending ? !!toggle.variables?.patch.enabled : s.enabled
    return (
      <div key={s.id} role="button" tabIndex={0} aria-label={s.name}
        className={cls('sched-row', selected === s.id && 'sel', !s.enabled && 'is-off')}
        onClick={() => onOpen(s.id)}
        onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onOpen(s.id) } }}>
        <span className="task-main"><span className="task-title"><span className="ellipsis" title={s.name}>{s.name}</span>
          {s.project_id && <span className="src-tag src-proj" title={projName(s.project_id)}>{projName(s.project_id) ?? '已删除的项目'}</span>}
        </span></span>
        <span className="run-muted ellipsis">{describeRule(fullRule(s.rule, now))}</span>
        <span className="sched-action">
          <span className={`sched-kind sk-${s.action.kind}`}>{actionLabel(s.action.kind)}</span>
          <span className="ellipsis run-muted" title={actionText(s.action, names)}>{actionText(s.action, names)}</span>
        </span>
        <span className={cls('run-muted', s.enabled && s.next_run_at && 'sched-next')}>{nextCellText(s, lr, now)}</span>
        <LastCell run={lr} now={now} />
        <span onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
          <label className="switch-line" title={enabled ? '停用' : '启用'}>
            <input type="checkbox" aria-label={`启用「${s.name}」`} checked={enabled} disabled={pending}
              onChange={(e) => setEnabled(s, e.target.checked)} />
            <span className="switch" aria-hidden="true" />
          </label>
        </span>
      </div>
    )
  }

  let body
  if (error) body = <ErrorState title="定时任务加载失败" error={error} onRetry={onRetry} />
  else if (loading) body = <LoadingState />
  else if (!schedules.length) {
    body = <EmptyState title="还没有定时任务" desc="比如每周一 9 点建一条「整理周会议程」，或者每周五让周报助手写周报" />
  } else if (!hit.length) {
    body = <EmptyState title="没有匹配的定时任务" desc="换个筛选条件试试" />
  } else {
    body = (
      <div className="task-table">
        <div className="sched-row task-th" aria-hidden="true"><span>名称</span><span>什么时候</span><span>做什么</span><span>下次执行</span><span>上次</span><span>启用</span></div>
        {on.map(row)}
        {off.length > 0 && (
          <div role="group" aria-label="已停用">
            {/* 搜索时停用的也展开，免得命中的藏在收起的段里 */}
            <ListSegHead label="已停用" n={off.length} open={offShown} onToggle={() => setOffOpen(!offOpen)} />
            {offShown && off.map(row)}
          </div>
        )}
      </div>
    )
  }

  const ready = !loading && !error
  return (
    <div className="tasks-page">
      <PageTitle parent="任务" count={ready ? schedules.length : undefined}
        desc="到点自动建任务、提醒你、执行 SOP，或者让 Agent 去做；它建的任务来源标为「定时」"
        actions={<Button variant="primary" onClick={onNew}>新建定时任务</Button>}>
        定时任务
      </PageTitle>
      {ready && schedules.length > 0 && (
        <div className="toolbar">
          <div className="seg" role="group" aria-label="动作类型">
            {['', ...kinds].map((k) => (
              <button key={k} type="button" className={cls(kind === k && 'on')} aria-pressed={kind === k} onClick={() => setKind(k)}>
                {k ? actionLabel(k) : '全部'}
                <span className="seg-n">{k ? schedules.filter((s) => s.action.kind === k).length : schedules.length}</span>
              </button>
            ))}
          </div>
          <SearchSelect value={proj} onChange={setProj} noneLabel="全部项目" placeholder="全部项目" searchPlaceholder="搜项目" aria-label="项目"
            options={[...projects.map((p) => ({ value: p.id, label: p.title })), { value: NO_PROJECT, label: '不属于项目' }]}
            missingLabel={() => '已删除的项目'} />
          <span className="spacer" />
          <div className="search">
            <IconSearch />
            <input type="search" placeholder="搜索名称、规则、要做的事" aria-label="搜索定时任务" value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Escape' && q) { e.preventDefault(); setQ('') } }} />
            {q && <button type="button" className="search-clear" aria-label="清空" title="清空" onClick={() => setQ('')}><IconClose size={10} /></button>}
          </div>
        </div>
      )}
      {toggleErr && <div className="field-err sched-alert" role="alert">{toggleErr}</div>}
      {body}
    </div>
  )
}

/** 「上次」：N 天前，失败的红字加「失败」，悬停显示结果；没执行过「还没执行过」；没取到留空 */
function LastCell({ run, now }: { run: ScheduleRun | null | undefined; now: Date }) {
  if (run === undefined) return <span className="run-muted" />
  if (!run) return <span className="run-muted">还没执行过</span>
  const bad = run.status !== 'ok' && run.status !== 'running'
  return (
    <span className={cls('run-muted ellipsis', bad && 'danger-text')} title={run.text}>
      {timeAgo(run.at, now)}{bad ? ' 失败' : run.status === 'running' ? ' 执行中' : ''}
    </span>
  )
}
