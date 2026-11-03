import { useState } from 'react'
import type { Task } from './taskdata'
import { isOpenTask, localDay } from './taskdata'
import { PriorityTag } from './tasks'
import { useEnumView } from './enumdata'
import { PageTitle } from './topbar'
import { ApproveConfirm } from './devloop'
import { cls, timeAgo } from './ui'

// 今日：今天要处理的事集中在一页。数据都是 App 从各模块收过来的，点一条就跳到能处理它的地方

export interface TodayItem {
  id: string
  /** 分组标签：SOP、Agent、IM 消息… */
  kind: string
  tone: 'danger' | 'warn' | 'info'
  title: string
  sub: string
  at?: string
  action: string
  onClick: () => void
}
export interface TodayLine { id: string; title: string; sub: string; href?: string; onClick?: () => void }

/** 每组需要处理的事露几条，今天的任务露几条，自动执行、正在运行各露几条 */
const NEED_SHOW = 3
const TASK_SHOW = 8
const LINE_SHOW = 5
const TONE_RANK = { danger: 0, warn: 1, info: 2 }
/** 组内排序：异常在前，同级按时间新的在前，没时间的放最后 */
const byUrgency = (a: TodayItem, b: TodayItem) => TONE_RANK[a.tone] - TONE_RANK[b.tone] || (b.at ?? '').localeCompare(a.at ?? '')

function greet() {
  const h = new Date().getHours()
  return h < 6 ? '夜深了' : h < 11 ? '早上好' : h < 13 ? '中午好' : h < 18 ? '下午好' : '晚上好'
}

export function TodayPage({ needs, tasks, schedules, running, more, onOpenTask, onDoneTask, onApproveTask, onAllTasks, onAllSchedules, onAllRunning }: {
  needs: TodayItem[]
  tasks: Task[]
  schedules: TodayLine[]
  running: TodayLine[]
  /** 分组名 -> 「查看全部」跳到能批量处理的地方；没给的组不显示入口 */
  more?: Partial<Record<string, () => void>>
  onOpenTask: (id: string) => void
  onDoneTask: (id: string) => void
  /** 待验收的任务点完成圆圈：确认后等于验收通过 */
  onApproveTask?: (id: string) => void
  /** due：带上「逾期」筛选打开任务页 */
  onAllTasks: (view?: 'due') => void
  onAllSchedules?: () => void
  onAllRunning?: () => void
}) {
  const statusEnum = useEnumView('task_status')
  const [ask, setAsk] = useState<Task | null>(null)
  const t = localDay()
  const open = tasks.filter((x) => isOpenTask(x.status))
  const overdue = open.filter((x) => x.due && x.due < t).sort((a, b) => a.due!.localeCompare(b.due!))
  const dueToday = open.filter((x) => x.due === t)
  const hot = open.filter((x) => !overdue.includes(x) && !dueToday.includes(x) && (x.priority === 'P0' || (x.priority === 'P1' && x.status === 'doing')))
  const groups = [...new Set(needs.map((n) => n.kind))].map((g) => ({ g, items: needs.filter((n) => n.kind === g).sort(byUrgency) }))
  // 逾期（截止早的在前）、今天截止、进行中的高优先级合起来只露前几条
  const dayTasks = [...overdue.map((x) => [x, '逾期'] as const), ...dueToday.map((x) => [x, '今天'] as const), ...hot.map((x) => [x, x.status === 'doing' ? statusEnum.label('doing') : undefined] as const)]
  const restTasks = dayTasks.length - TASK_SHOW
  const date = new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' })

  const taskRow = (x: Task, tag?: string) => (
    <div key={x.id} className="today-task" onClick={() => onOpenTask(x.id)}>
      <button className="task-check" title={x.status === 'review' ? '验收通过' : `标为${statusEnum.label('done')}`} onClick={(e) => { e.stopPropagation(); if (x.status === 'review') setAsk(x); else onDoneTask(x.id) }} />
      <PriorityTag p={x.priority} />
      <span className="ellipsis today-task-title">{x.title}</span>
      {tag && <span className={cls('today-due', tag === '逾期' && 'bad')}>{tag}</span>}
      <span className="task-ref">{x.ref}</span>
    </div>
  )

  return (
    <div className="page page-fill today-page">
      <PageTitle desc={`${greet()}，${date}`}>今日</PageTitle>
      <div className="today-sum">
        <div className={cls('today-num', needs.length > 0 && 'warn')}><b>{needs.length}</b><span>件事等你处理</span></div>
        <div className={cls('today-num', overdue.length > 0 && 'bad')}><b>{overdue.length}</b><span>个任务逾期</span></div>
        <div className="today-num"><b>{dueToday.length}</b><span>个任务今天截止</span></div>
        <div className="today-num"><b>{schedules.length}</b><span>个定时任务今天会跑</span></div>
        <div className="today-num ok"><b>{running.length}</b><span>个在运行</span></div>
      </div>

      <div className="today-grid">
        <section className="hook-sec today-needs">
          <div className="field-group-title">需要你处理<span className="field-hint">按来源分组，点一条直接去处理</span></div>
          {needs.length ? groups.map(({ g, items }) => (
            <div key={g} className="today-group">
              <div className="today-group-head">
                <div className="ability-group-name">{g}<span className="seg-n"> {items.length}</span></div>
                {/* 任务待验收不多也给入口：去任务列表一起验收 */}
                {(items.length > NEED_SHOW || g === '任务待验收') && more?.[g] && <button className="act act-quiet today-more" onClick={more[g]}>{items.length > NEED_SHOW ? `查看全部 ${items.length} 条` : '查看全部'}</button>}
              </div>
              {items.slice(0, NEED_SHOW).map((n) => (
                <button key={n.id} className="today-need" onClick={n.onClick}>
                  <span className={cls('today-dot', `td-${n.tone}`)} />
                  <span className="mount-text"><span className="ellipsis today-need-title">{n.title}</span><span className="list-sub ellipsis">{n.sub}</span></span>
                  {n.at && <span className="run-muted today-at">{timeAgo(n.at)}</span>}
                  <span className="today-go">{n.action}</span>
                </button>
              ))}
            </div>
          )) : <div className="today-clear">都处理完了</div>}
        </section>

        <div className="today-side">
          <section className="hook-sec">
            <div className="mount-head">
              <div className="field-group-title">今天的任务<span className="field-hint">逾期、今天截止、{statusEnum.label('doing')}的高优先级</span></div>
              <button className="act act-quiet" onClick={() => onAllTasks()}>全部任务</button>
            </div>
            {dayTasks.length ? (
              <div className="today-tasks">
                {dayTasks.slice(0, TASK_SHOW).map(([x, tag]) => taskRow(x, tag))}
                {restTasks > 0 && <button className="today-rest" onClick={() => onAllTasks(overdue.length ? 'due' : undefined)}>还有 {restTasks} 条，去任务</button>}
              </div>
            ) : <div className="today-clear">今天没有要赶的任务</div>}
          </section>

          <section className="hook-sec">
            <div className="mount-head">
              <div className="field-group-title">今天还会自动执行</div>
              {schedules.length > LINE_SHOW && onAllSchedules && <button className="act act-quiet" onClick={onAllSchedules}>全部 {schedules.length} 个</button>}
            </div>
            {schedules.length ? schedules.slice(0, LINE_SHOW).map((s) => (
              <button key={s.id} className="today-line" onClick={s.onClick}><span className="today-time">{s.sub}</span><span className="ellipsis">{s.title}</span></button>
            )) : <div className="mount-empty">今天没有定时任务</div>}
          </section>

          <section className="hook-sec">
            <div className="mount-head">
              <div className="field-group-title">正在运行</div>
              {running.length > LINE_SHOW && onAllRunning && <button className="act act-quiet" onClick={onAllRunning}>全部 {running.length} 个</button>}
            </div>
            {running.length ? running.slice(0, LINE_SHOW).map((r) => (
              r.href
                ? <a key={r.id} className="today-line" href={r.href} target="_blank" rel="noreferrer"><span className="proto-light pl-running" /><span className="ellipsis">{r.title}</span><span className="list-sub">{r.sub}</span></a>
                : <button key={r.id} className="today-line" onClick={r.onClick}><span className="proto-light pl-starting" /><span className="ellipsis">{r.title}</span><span className="list-sub">{r.sub}</span></button>
            )) : <div className="mount-empty">没有在运行的原型或流程</div>}
          </section>
        </div>
      </div>
      {ask && (
        <ApproveConfirm task={ask} onClose={() => setAsk(null)} onOpen={() => { setAsk(null); onOpenTask(ask.id) }}
          onApprove={() => { setAsk(null); if (onApproveTask) onApproveTask(ask.id); else onDoneTask(ask.id) }} />
      )}
    </div>
  )
}
