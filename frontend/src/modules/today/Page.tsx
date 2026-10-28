// 今日（SPEC-today-1、TODAY-02）：今天要处理的事集中在一页。内核部分走 GET /api/today?type=task，
// 插件卡片走不带 type 的聚合（PluginCards）。只有完成圆圈在本页直接改数据，点任务在本页打开任务抽屉。
import { Suspense, useState, type CSSProperties } from 'react'
import { useNavigate } from 'react-router'
import {
  dueTodayCard, errorText, localDay, overdueCard, reviewCard, runningCard, schedulesToday, useAllObjects, useApprove,
  useDictItems, useObject, useObjectTypes, useSchedules, useSetStatus, useToday, type WorkObject,
} from '../../core/data'
import { Button, ErrorState, LoadingState, PageTitle, cls } from '../../core/ui'
import { ApproveDialog, REVIEW, TaskDrawer, doneKey, dueDay, timeAgo } from '../tasks'
import { LINE_SHOW, NEED_SHOW, TASK_SHOW, clock, dateText, dayRows, greet, hotLevels, pickHot } from './model'
import { PluginCards } from './PluginCards'
import './today.css'

// 优先级字典的 id（/api/dictionaries）
const PRIORITY_DICT = 'priority'
const TASKS = '/tasks'

export default function Page() {
  const navigate = useNavigate()
  const types = useObjectTypes()
  const prios = useDictItems(PRIORITY_DICT)
  const today = useToday('task')
  const schedules = useSchedules()
  const projects = useAllObjects({ type: ['project'], sort: 'title' })
  const levels = hotLevels(prios.data ?? [])
  const hotQ = useAllObjects({ type: ['task'], priority: levels.filter((x): x is string => !!x), not_terminal: true }, { enabled: !!levels[0] })
  const setStatus = useSetStatus()
  const approve = useApprove()

  // 打开的任务：先在页面已有的数据里找，找不到（点的是运行中的执行）再单独取
  const [openId, setOpenId] = useState<string | null>(null)
  const [approving, setApproving] = useState<WorkObject | null>(null)
  // 点了完成、还在等后端和刷新的任务先藏起来；失败了放回来并提示
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set())
  const [doneErr, setDoneErr] = useState('')

  const statuses = types.data?.find((t) => t.id === 'task')?.statuses ?? []
  const label = (k: string) => statuses.find((s) => s.key === k)?.label ?? k
  // 「现在」取页面打开那一刻，聚合每次重新取到后跟着往前走；渲染里不直接 new Date()
  const [opened] = useState(() => Date.now())
  const now = new Date(Math.max(opened, today.dataUpdatedAt))
  const day = localDay(now)

  const review = reviewCard(today.data)
  const overdue = overdueCard(today.data)
  const due = dueTodayCard(today.data)
  const running = runningCard(today.data)
  const hot = pickHot(hotQ.data?.data ?? [], levels, day, dueDay)
  const rows = dayRows(overdue?.items ?? [], due?.items ?? [], hot, label('doing'), hidden)
  // 逾期、今天到期每张最多给 50 条，剩余条数按 total 算
  const restTasks = (overdue?.total ?? 0) + (due?.total ?? 0) + hot.length - hidden.size - Math.min(rows.length, TASK_SHOW)
  const reviewItems = (review?.items ?? []).filter((t) => !hidden.has(t.id))
  const needN = review?.total ?? 0
  const todaySch = schedulesToday(schedules.data ?? [], now)
  const projName = (id: string | null) => (id ? projects.data?.data.find((p) => p.id === id)?.title : undefined)

  const known = [...reviewItems, ...rows.map((r) => r.task)]
  const fetched = useObject(openId && !known.some((t) => t.id === openId) ? openId : null)
  const openTask = openId ? known.find((t) => t.id === openId) ?? fetched.data ?? null : null

  const hide = (id: string, on: boolean) => setHidden((s) => {
    const next = new Set(s)
    if (on) next.add(id)
    else next.delete(id)
    return next
  })
  // 完成圆圈：待验收的先确认，其余直接标完成
  const markDone = async (t: WorkObject) => {
    if (t.status === REVIEW) { approve.reset(); setApproving(t); return }
    const done = doneKey(statuses)
    if (!done || hidden.has(t.id)) return
    setDoneErr('')
    hide(t.id, true)
    try {
      // 成功时失效规则已经把今日重新取完，这一行自然不在了
      await setStatus.mutateAsync({ id: t.id, status: done })
    } catch (e) {
      setDoneErr(`${t.ref} 没改成：${errorText(e)}`)
    } finally {
      hide(t.id, false)
    }
  }
  const doApprove = (t: WorkObject) => {
    const done = doneKey(statuses)
    if (done) approve.mutate({ id: t.id, status: done }, { onSuccess: () => setApproving(null) })
  }

  if (today.isError) {
    // 聚合失败整页报错，不显示成「都处理完了」
    return (
      <div className="today-page">
        <PageTitle desc={`${greet(now.getHours())}，${dateText(now)}`}>今日</PageTitle>
        <ErrorState title="今日没加载出来" error={today.error} onRetry={() => void today.refetch()} />
      </div>
    )
  }
  // 内核部分还在取时，标题和只有前端的插件卡片先出来
  const loading = today.isPending || types.isPending

  const doneTip = `标为${label(doneKey(statuses) ?? 'done')}`
  const prioOf = (k: string) => prios.data?.find((p) => p.key === k)

  const taskRow = ({ task: t, tag, bad }: { task: WorkObject; tag?: string; bad?: boolean }) => {
    const pr = prioOf(t.priority)
    const tip = t.status === REVIEW ? '验收通过' : doneTip
    return (
      <div key={t.id} className="today-task" role="button" tabIndex={0} aria-label={`${t.ref} ${t.title}`}
        onClick={() => setOpenId(t.id)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpenId(t.id) } }}>
        <button type="button" className="today-check" title={tip} aria-label={`${tip}：${t.ref}`}
          onClick={(e) => { e.stopPropagation(); void markDone(t) }}
          onKeyDown={(e) => e.stopPropagation()} />
        {t.priority && (
          <span className="today-prio" title={pr?.label} style={{ '--c': pr?.color || 'var(--faint)' } as CSSProperties}>{t.priority}</span>
        )}
        <span className="ellipsis today-task-title">{t.title}</span>
        {tag && <span className={cls('today-due', bad && 'bad')}>{tag}</span>}
        <span className="today-ref">{t.ref}</span>
      </div>
    )
  }

  return (
    <div className="today-page">
      <PageTitle desc={`${greet(now.getHours())}，${dateText(now)}`}>今日</PageTitle>
      {loading ? <LoadingState /> : (
        <>
          <div className="today-sum">
            <div className={cls('today-num', needN > 0 && 'warn')}><b>{needN}</b><span>件事等你处理</span></div>
            <div className={cls('today-num', (overdue?.total ?? 0) > 0 && 'bad')}><b>{overdue?.total ?? 0}</b><span>个任务逾期</span></div>
            <div className="today-num"><b>{due?.total ?? 0}</b><span>个任务今天截止</span></div>
            <div className="today-num"><b>{schedules.isError ? '-' : todaySch.length}</b><span>个定时任务今天会跑</span></div>
            <div className="today-num ok"><b>{running?.total ?? 0}</b><span>个在运行</span></div>
          </div>

          <div className="today-grid">
            <section className="today-sec" aria-label="需要你处理">
              <div className="today-title">需要你处理<span className="today-hint">按来源分组，点一条直接去处理</span></div>
              {needN > 0 ? (
                <div className="today-group">
                  <div className="today-group-head">
                    <div className="today-group-name">任务待验收<span className="today-group-n"> {needN}</span></div>
                    {/* 任务待验收不多也给入口：去任务列表带上待验收筛选 */}
                    <button type="button" className="today-link today-more" onClick={() => void navigate(`${TASKS}?status=${REVIEW}`)}>
                      {needN > NEED_SHOW ? `查看全部 ${needN} 条` : '查看全部'}
                    </button>
                  </div>
                  {reviewItems.slice(0, NEED_SHOW).map((t) => {
                    const pn = projName(t.project_id)
                    return (
                      <button key={t.id} type="button" className="today-need" onClick={() => setOpenId(t.id)}>
                        <span className="today-dot td-warn" />
                        <span className="today-need-text">
                          <span className="ellipsis today-need-title">{t.ref} {t.title}</span>
                          <span className="ellipsis today-need-sub">{pn ? `等你验收 · ${pn}` : '等你验收'}</span>
                        </span>
                        <span className="today-at">{timeAgo(t.updated_at, now)}</span>
                        <span className="today-go">去验收</span>
                      </button>
                    )
                  })}
                </div>
              ) : <div className="today-clear">都处理完了</div>}
            </section>

            <div className="today-side">
              <section className="today-sec" aria-label="今天的任务">
                <div className="today-head">
                  <div className="today-title">今天的任务<span className="today-hint">逾期、今天截止、{label('doing')}的高优先级</span></div>
                  <button type="button" className="today-link" onClick={() => void navigate(TASKS)}>全部任务</button>
                </div>
                {doneErr && <div className="today-err" role="alert">{doneErr}</div>}
                {hotQ.isError && (
                  <div className="today-miss" role="alert">
                    高优先级任务这部分没取到<Button size="sm" onClick={() => void hotQ.refetch()}>重试</Button>
                  </div>
                )}
                {rows.length ? (
                  <div className="today-tasks">
                    {rows.slice(0, TASK_SHOW).map(taskRow)}
                    {restTasks > 0 && (
                      <button type="button" className="today-rest" onClick={() => void navigate((overdue?.total ?? 0) > 0 ? `${TASKS}/overdue` : TASKS)}>
                        还有 {restTasks} 条，去任务
                      </button>
                    )}
                  </div>
                ) : <div className="today-clear">今天没有要赶的任务</div>}
              </section>

              <section className="today-sec" aria-label="今天还会自动执行">
                <div className="today-head"><div className="today-title">今天还会自动执行</div></div>
                {schedules.isError ? (
                  <div className="today-miss" role="alert">
                    这部分没取到<Button size="sm" onClick={() => void schedules.refetch()}>重试</Button>
                  </div>
                ) : todaySch.length ? todaySch.slice(0, LINE_SHOW).map((s) => (
                  <div key={s.id} className="today-line"><span className="today-time">{clock(s.next_run_at!)}</span><span className="ellipsis">{s.name}</span></div>
                )) : <div className="today-empty">今天没有定时任务</div>}
              </section>

              <section className="today-sec" aria-label="正在运行">
                <div className="today-head"><div className="today-title">正在运行</div></div>
                {running?.items.length ? running.items.slice(0, LINE_SHOW).map((r) => (
                  <button key={r.id} type="button" className="today-line" onClick={() => setOpenId(r.object_id)}>
                    <span className={cls('today-light', r.status !== 'running' && 'wait')} />
                    <span className="ellipsis">{r.object_ref} {r.object_title}</span>
                    <span className="today-line-sub">{r.status === 'running' ? '执行中' : '排队中'}</span>
                  </button>
                )) : <div className="today-empty">没有在运行的原型或流程</div>}
              </section>
            </div>
          </div>
        </>
      )}

      <PluginCards />

      <Suspense fallback={null}>
        {openTask && (
          <TaskDrawer
            key={openTask.id}
            task={openTask}
            statuses={statuses}
            priorities={prios.data ?? []}
            projects={projects.data?.data ?? []}
            onClose={() => setOpenId(null)}
            onCreated={(t) => setOpenId(t.id)}
          />
        )}
        {approving && (
          <ApproveDialog task={approving} busy={approve.isPending}
            error={approve.isError ? approve.error.message : undefined}
            onCancel={() => setApproving(null)}
            onOpen={() => { setOpenId(approving.id); setApproving(null) }}
            onApprove={() => doApprove(approving)} />
        )}
      </Suspense>
    </div>
  )
}
