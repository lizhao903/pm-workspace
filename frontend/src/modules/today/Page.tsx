// 今日（SPEC-today-1、TODAY-02）：今天要处理的事集中在一页。内核部分走 GET /api/today?type=task，
// 插件卡片走不带 type 的聚合（PluginCards）。只有完成圆圈在本页直接改数据，点任务在本页打开任务抽屉。
// ALIGN-08 起「需要你处理」按来源分组：任务待验收、插件贡献的组（IM 消息）、连接异常；「正在运行」先列插件贡献的（运行中的原型）。
import { Suspense, useState, type CSSProperties } from 'react'
import { useNavigate } from 'react-router'
import {
  dueTodayCard, errorText, localDay, overdueCard, reviewCard, runningCard, schedulesToday, useAllObjects, useApprove,
  useConnectors, useDictItems, useObject, useObjectTypes, useProgress, useSchedules, useSetStatus, useToday, type WorkObject,
} from '../../core/data'
import { TODAY_ORDER, useTodaySourceData, useTodaySources, type TodayItem } from '../../core/plugin'
import { Button, ErrorState, LoadingState, PageTitle, cls } from '../../core/ui'
import { ApproveDialog, REVIEW, TaskDrawer, doneKey, dueDay, timeAgo } from '../tasks'
import {
  LINE_SHOW, NEED_SHOW, TASK_SHOW, clock, connectorNeeds, dateText, dayRows, greet, hotLevels, lastReview, needGroups, pickHot, reviewSub,
} from './model'
import { PluginCards } from './PluginCards'
import './today.css'

// 优先级字典的 id（/api/dictionaries）
const PRIORITY_DICT = 'priority'
const TASKS = '/tasks'
const PROJECTS = '/projects'

/** 「需要你处理」的一条（SPEC-today-1.5）：圆点、标题、说明、相对时间、动作 */
function NeedRow({ item: it, now, onGo }: { item: TodayItem; now: Date; onGo: (it: TodayItem) => void }) {
  return (
    <button type="button" className="today-need" onClick={() => onGo(it)}>
      <span className={cls('today-dot', `td-${it.tone}`)} />
      <span className="today-need-text">
        <span className="ellipsis today-need-title">{it.title}</span>
        {it.sub && <span className="ellipsis today-need-sub">{it.sub}</span>}
      </span>
      {it.at && <span className="today-at">{timeAgo(it.at, now)}</span>}
      {it.action && <span className="today-go">{it.action}</span>}
    </button>
  )
}

/** 任务待验收的一条（SPEC-today-1.25）：说明和时间取这条任务最近一次提交验收的进展 */
function ReviewRow({ task: t, project, now, onOpen }: { task: WorkObject; project?: string; now: Date; onOpen: (id: string) => void }) {
  const prog = useProgress(t.id)
  const last = lastReview(prog.data)
  return (
    <NeedRow now={now} onGo={() => onOpen(t.id)} item={{
      id: t.id, tone: 'warn', title: `${t.ref} ${t.title}`, action: '去验收',
      sub: prog.isPending ? project ?? '' : reviewSub(last, project), at: last?.created_at ?? t.updated_at,
    }} />
  )
}

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
  const sources = useTodaySourceData(useTodaySources())
  const connectors = useConnectors()

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
  const needSrc = sources.filter((x) => x.def.slot === 'need')
  const runSrc = sources.filter((x) => x.def.slot === 'running').sort((a, b) => a.def.order - b.def.order)
  const conn = connectorNeeds(connectors.data ?? [])
  const groups = needGroups([
    { key: 'review', label: '任务待验收', order: TODAY_ORDER.review, total: review?.total ?? 0, items: [], more: `${TASKS}?status=${REVIEW}`, moreAlways: true },
    ...needSrc.map((x) => ({
      key: `${x.def.plugin}:${x.def.key}`, label: x.def.label, order: x.def.order, total: x.total, items: x.items, more: x.def.more,
      error: x.error, retry: x.refetch,
    })),
    {
      key: 'connection', label: '连接异常', order: TODAY_ORDER.connection, total: conn.length, items: conn, more: '/settings/connectors',
      error: connectors.isError, retry: () => void connectors.refetch(),
    },
  ])
  const needN = groups.reduce((n, g) => n + g.total, 0)
  // 正在运行：先插件贡献的（运行中的原型），再是任务执行；汇总数字是全量
  const runItems = runSrc.flatMap((x) => x.items)
  const runMiss = runSrc.filter((x) => x.error)
  const runN = runSrc.reduce((n, x) => n + x.total, 0) + (running?.total ?? 0)
  const runLines = [...runItems.map((r) => ({ item: r })), ...(running?.items ?? []).map((r) => ({ run: r }))].slice(0, LINE_SHOW)
  const go = (it: TodayItem) => {
    if (it.href) window.open(it.href, '_blank', 'noopener')
    else if (it.to) void navigate(it.to)
  }
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
            <div className="today-num ok"><b>{runN}</b><span>个在运行</span></div>
          </div>

          <div className="today-grid">
            <section className="today-sec" aria-label="需要你处理">
              <div className="today-title">需要你处理<span className="today-hint">按来源分组，点一条直接去处理</span></div>
              {groups.length ? groups.map((g) => (
                <div key={g.key} className="today-group" data-group={g.key}>
                  <div className="today-group-head">
                    <div className="today-group-name">{g.label}{g.total > 0 && <span className="today-group-n"> {g.total}</span>}</div>
                    {/* 任务待验收不多也给入口：去任务列表带上待验收筛选；其余组超过 3 条才有 */}
                    {g.more && (g.moreAlways || g.total > NEED_SHOW) && (
                      <button type="button" className="today-link today-more" onClick={() => void navigate(g.more!)}>
                        {g.total > NEED_SHOW ? `查看全部 ${g.total} 条` : '查看全部'}
                      </button>
                    )}
                  </div>
                  {g.error ? (
                    <div className="today-miss" role="alert">这部分没取到<Button size="sm" onClick={g.retry}>重试</Button></div>
                  ) : g.key === 'review' ? reviewItems.slice(0, NEED_SHOW).map((t) => (
                    <ReviewRow key={t.id} task={t} project={projName(t.project_id)} now={now} onOpen={setOpenId} />
                  )) : g.items.slice(0, NEED_SHOW).map((it) => <NeedRow key={it.id} item={it} now={now} onGo={go} />)}
                </div>
              )) : <div className="today-clear">都处理完了</div>}
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
                <div className="today-head">
                  <div className="today-title">正在运行</div>
                  {runN > LINE_SHOW && runItems.length > 0 && (
                    <button type="button" className="today-link" onClick={() => void navigate(PROJECTS)}>全部 {runN} 个</button>
                  )}
                </div>
                {runMiss.map((x) => (
                  <div key={x.def.key} className="today-miss" role="alert">{x.def.label}没取到<Button size="sm" onClick={x.refetch}>重试</Button></div>
                ))}
                {runLines.length ? runLines.map((l) => 'item' in l ? (
                  <a key={l.item.id} className="today-line" href={l.item.href} target="_blank" rel="noreferrer">
                    <span className={cls('today-light', l.item.tone !== 'ok' && 'wait')} />
                    <span className="ellipsis">{l.item.title}</span>
                    <span className="today-line-sub">{l.item.sub}</span>
                  </a>
                ) : (
                  <button key={l.run.id} type="button" className="today-line" onClick={() => setOpenId(l.run.object_id)}>
                    <span className={cls('today-light', l.run.status !== 'running' && 'wait')} />
                    <span className="ellipsis">{l.run.object_ref} {l.run.object_title}</span>
                    <span className="today-line-sub">{l.run.status === 'running' ? '执行中' : '排队中'}</span>
                  </button>
                )) : !runMiss.length && <div className="today-empty">没有在运行的原型或流程</div>}
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
