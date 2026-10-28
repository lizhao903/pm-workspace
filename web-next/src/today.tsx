import type { Task } from './taskdata'
import { isOpenTask } from './taskdata'
import { PriorityTag } from './tasks'
import { useEnumView } from './enumdata'
import { PageTitle } from './topbar'
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

const today = () => new Date().toISOString().slice(0, 10)
function greet() {
  const h = new Date().getHours()
  return h < 6 ? '夜深了' : h < 11 ? '早上好' : h < 13 ? '中午好' : h < 18 ? '下午好' : '晚上好'
}

export function TodayPage({ needs, tasks, schedules, running, onOpenTask, onDoneTask, onAllTasks }: {
  needs: TodayItem[]
  tasks: Task[]
  schedules: TodayLine[]
  running: TodayLine[]
  onOpenTask: (id: string) => void
  onDoneTask: (id: string) => void
  onAllTasks: () => void
}) {
  const statusEnum = useEnumView('task_status')
  const t = today()
  const open = tasks.filter((x) => isOpenTask(x.status))
  const overdue = open.filter((x) => x.due && x.due < t)
  const dueToday = open.filter((x) => x.due === t)
  const hot = open.filter((x) => !overdue.includes(x) && !dueToday.includes(x) && (x.priority === 'P0' || (x.priority === 'P1' && x.status === 'doing')))
  const groups = [...new Set(needs.map((n) => n.kind))]
  const date = new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' })

  const taskRow = (x: Task, tag?: string) => (
    <div key={x.id} className="today-task" onClick={() => onOpenTask(x.id)}>
      <button className="task-check" title={`标为${statusEnum.label('done')}`} onClick={(e) => { e.stopPropagation(); onDoneTask(x.id) }} />
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
          {needs.length ? groups.map((g) => (
            <div key={g} className="today-group">
              <div className="ability-group-name">{g}<span className="seg-n"> {needs.filter((n) => n.kind === g).length}</span></div>
              {needs.filter((n) => n.kind === g).map((n) => (
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
              <button className="act act-quiet" onClick={onAllTasks}>全部任务</button>
            </div>
            {overdue.length + dueToday.length + hot.length ? (
              <div className="today-tasks">
                {overdue.map((x) => taskRow(x, '逾期'))}
                {dueToday.map((x) => taskRow(x, '今天'))}
                {hot.map((x) => taskRow(x, x.status === 'doing' ? statusEnum.label('doing') : undefined))}
              </div>
            ) : <div className="today-clear">今天没有要赶的任务</div>}
          </section>

          <section className="hook-sec">
            <div className="field-group-title">今天还会自动执行</div>
            {schedules.length ? schedules.map((s) => (
              <button key={s.id} className="today-line" onClick={s.onClick}><span className="today-time">{s.sub}</span><span className="ellipsis">{s.title}</span></button>
            )) : <div className="mount-empty">今天没有定时任务</div>}
          </section>

          <section className="hook-sec">
            <div className="field-group-title">正在运行</div>
            {running.length ? running.map((r) => (
              r.href
                ? <a key={r.id} className="today-line" href={r.href} target="_blank" rel="noreferrer"><span className="proto-light pl-running" /><span className="ellipsis">{r.title}</span><span className="list-sub">{r.sub}</span></a>
                : <button key={r.id} className="today-line" onClick={r.onClick}><span className="proto-light pl-starting" /><span className="ellipsis">{r.title}</span><span className="list-sub">{r.sub}</span></button>
            )) : <div className="mount-empty">没有在运行的原型或流程</div>}
          </section>
        </div>
      </div>
    </div>
  )
}
