import { useEffect, useMemo, useRef, useState } from 'react'
import { PageTitle } from './topbar'
import { IM_CHANNELS, type Message } from './data'
import { Subnav } from './subnav'
import {
  FIELD_LABEL, HOOK_BASE, getPath, mapFields, passFilter,
  type Delivery, type Ingest, type Json, type Priority, type Task, type TaskStatus, type Webhook, isOpenTask, localDay,
} from './taskdata'
import { GrowArea, cls, timeAgo } from './ui'
import { SearchSelect } from './searchselect'
import { useEnumView } from './enumdata'
import { ApproveConfirm, ArtifactsBlock, DevFields, ProgressBlock, ReviewBar, RunDialog, RunsBlock, isDevTask, type DevLoop } from './devloop'
import { runStatus, type Governance, type RunAction, type Sop, type SopRun } from './sopflow'
import { TaskSopBlock } from './tasksop'
import { TaskPipelineBlock, taskRuns, waitOf } from './taskpipeline'
import { TaskReminders, type ReminderForm } from './taskreminders'
import { TaskWorktreeBlock } from './worktree'
import type { Schedule } from './scheduledata'
import { buildPrompt, projectContext } from './handoff'
import { threadTaskBody } from './msggroup'
import type { Project } from './projectdata'
import { StageBoard } from './taskstage'

/** 任务页的二级菜单 key */
/** schedule：定时任务建出来的任务；schedules：定时任务本身的管理页；due：逾期未完成；hooks：Webhook 列表 */
export type TaskView = 'all' | 'due' | 'board' | 'manual' | 'im' | 'webhook' | 'schedule' | 'incident' | 'schedules' | 'hooks' | `hook:${string}`

const channelLabel = (k: string) => IM_CHANNELS.find((c) => c.key === k)?.label ?? k
// 「今天」按本地日期；addDays、weekEnd 只做日历日加减，用 UTC 解析不受时区影响
const today = () => localDay()
const addDays = (d: string, n: number) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10) }
/** 本周最后一天（周日） */
const weekEnd = (d: string) => addDays(d, (7 - new Date(`${d}T00:00:00Z`).getUTCDay()) % 7)
const isOverdue = (t: Task) => !!t.due && t.due < today() && isOpenTask(t.status)
/** 每个 Webhook 最近一次推送 */
const lastDeliveries = (deliveries: Delivery[]) => {
  const m = new Map<string, Delivery>()
  for (const d of deliveries) { const p = m.get(d.hook_id); if (!p || d.at > p.at) m.set(d.hook_id, d) }
  return m
}

const PAGE = 30
const searchIcon = <svg viewBox="0 0 16 16" width="14" height="14"><circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
const segChevron = <svg viewBox="0 0 16 16" width="10" height="10"><path d="m6 3.5 4.5 4.5L6 12.5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>

/** 列表分段的段标题：可折叠，带数量 */
export function ListSegHead({ label, n, open, onToggle, tone }: { label: string; n: number; open: boolean; onToggle: () => void; tone?: 'danger' }) {
  return (
    <button className={cls('list-seg-head', tone === 'danger' && 'danger-text')} onClick={onToggle} aria-expanded={open}>
      <span className={cls('tree-chev', open && 'open')}>{segChevron}</span>
      <span>{label}</span>
      <span className="seg-n">{n}</span>
    </button>
  )
}
/** 段尾「这一段还有 N 条」 */
export function ListSegMore({ n, onMore, text }: { n: number; onMore: () => void; text?: string }) {
  if (n <= 0) return null
  return <button className="list-seg-more" onClick={onMore}>{text ?? `这一段还有 ${n} 条`}</button>
}

function Pill({ label, color }: { label: string; color: string }) {
  return <span className="pill" style={{ '--c': color } as React.CSSProperties}><span className="pill-dot" />{label}</span>
}
// 优先级、任务状态的显示名和颜色读设置里的枚举（task_priority / task_status），数据里存的 key 不变
export function PriorityTag({ p }: { p: Priority }) {
  const e = useEnumView('task_priority')
  return <span className="prio" style={{ '--c': e.color(p), whiteSpace: 'nowrap' } as React.CSSProperties} title={e.item(p)?.desc || undefined}>{e.label(p)}</span>
}
export function TaskStatusPill({ s }: { s: TaskStatus }) {
  const e = useEnumView('task_status')
  return <Pill label={e.label(s)} color={e.color(s)} />
}

export function SourceTag({ task, hooks }: { task: Task; hooks: Webhook[] }) {
  const s = task.source
  if (s.kind === 'im') return <span className="src-tag src-im" title={s.text}>{channelLabel(s.channel)} · {s.sender}</span>
  if (s.kind === 'webhook') return <span className="src-tag src-hook">Webhook · {hooks.find((h) => h.id === s.hook_id)?.name ?? '已删除'}</span>
  if (s.kind === 'schedule') return <span className="src-tag src-sched">定时 · {s.name}</span>
  if (s.kind === 'incident') return <span className="src-tag src-inc" title={s.title}>异常 · {s.title}</span>
  return <span className="src-tag">人工</span>
}

export function TasksNav({ tasks, hooks, deliveries, view, onSelect, onNewHook }: {
  tasks: Task[]; hooks: Webhook[]; deliveries: Delivery[]; view: TaskView
  onSelect: (v: TaskView) => void; onNewHook: () => void
}) {
  // 最近一次推送失败的 Webhook 标红：多半是对方改了字段，映射没跟上
  const last = useMemo(() => lastDeliveries(deliveries), [deliveries])
  const failing = (h: Webhook) => (last.get(h.id)?.result === 'failed' ? 1 : 0)
  const failN = hooks.filter(failing).length
  const dueN = tasks.filter(isOverdue).length
  // 菜单只放最近推送过的几个 Webhook，完整列表在「Webhook 接入」里
  const recent = hooks.filter((h) => last.has(h.id)).sort((a, b) => last.get(b.id)!.at.localeCompare(last.get(a.id)!.at)).slice(0, 5)
  const active: TaskView = view.startsWith('hook:') && view !== 'hook:new' && !recent.some((h) => view === `hook:${h.id}`) ? 'hooks' : view
  return (
    <Subnav title="任务" active={active} onSelect={onSelect} items={[
      { key: 'all' as TaskView, label: '全部任务', group: '视图' },
      { key: 'due' as TaskView, label: '逾期', desc: dueN ? `${dueN} 条过了截止日还没完成` : '没有逾期的任务', alert: dueN, group: '视图' },
      { key: 'board' as TaskView, label: '阶段看板', desc: '按阶段分列，按提出人看进度', group: '视图' },
      { key: 'manual' as TaskView, label: '人工创建', group: '来源' },
      { key: 'im' as TaskView, label: 'IM 消息', group: '来源' },
      { key: 'webhook' as TaskView, label: 'Webhook', group: '来源' },
      { key: 'schedule' as TaskView, label: '定时', group: '来源' },
      { key: 'incident' as TaskView, label: '运行异常', group: '来源' },
      { key: 'schedules' as TaskView, label: '定时任务', desc: '到点自动建任务、跑 SOP、叫 Agent', group: '自动化' },
      { key: 'hooks' as TaskView, label: 'Webhook 接入', desc: `${hooks.length} 个${failN ? `，${failN} 个最近推送失败` : ''}`, alert: failN, group: '自动化' },
      ...recent.map((h) => ({ key: `hook:${h.id}` as TaskView, label: h.name, desc: `${timeAgo(last.get(h.id)!.at)}推送${h.enabled ? '' : ' · 已停用'}`, alert: failing(h), group: '最近推送' })),
    ]}>
      <button className="subnav-new" onClick={onNewHook}>
        <svg viewBox="0 0 16 16" width="13" height="13"><path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
        新建 Webhook
      </button>
    </Subnav>
  )
}

/* ---------- 列表 ---------- */

type StatusFilter = 'open' | TaskStatus | 'all'
type ListView = Exclude<TaskView, `hook:${string}` | 'schedules'>

/** 按截止分段：逾期 / 今天 / 本周 / 以后 / 无截止；已完成、已取消的单独一段放最后 */
type DueSeg = 'overdue' | 'today' | 'week' | 'later' | 'none' | 'closed'
const DUE_SEGS: { key: DueSeg; label: string }[] = [
  { key: 'overdue', label: '逾期' }, { key: 'today', label: '今天' }, { key: 'week', label: '本周' },
  { key: 'later', label: '以后' }, { key: 'none', label: '无截止' }, { key: 'closed', label: '已结束' },
]
const dueSeg = (t: Task, now: string, end: string): DueSeg => (!isOpenTask(t.status) ? 'closed'
  : !t.due ? 'none' : t.due < now ? 'overdue' : t.due === now ? 'today' : t.due <= end ? 'week' : 'later')

export function TasksPage(props: {
  tasks: Task[]; hooks: Webhook[]; projects: { id: string; name: string }[]; view: ListView; selected: string | null
  onOpen: (id: string) => void; onNew: () => void; onStatus: (id: string, s: TaskStatus) => void
  /** 待验收的任务点完成圆圈：确认后等于验收通过 */
  onApprove?: (id: string) => void
  /** Webhook 列表页（view = hooks）用：推送记录、打开某个 Webhook、新建 */
  deliveries?: Delivery[]; onOpenHook?: (id: string) => void; onNewHook?: () => void
  /** 阶段看板（view = board）卡片上改阶段（SPEC-tasks-11） */
  onStage?: (id: string, stage: string) => void
  /** 看板上点卡片：打开任务抽屉并停在「流水线」标签（AUTO-12，SPEC-tasks-11.15）；不给时同 onOpen */
  onOpenBoard?: (id: string) => void
}) {
  if (props.view === 'board') return <StageBoard tasks={props.tasks} selected={props.selected} onOpen={props.onOpenBoard ?? props.onOpen} onStage={(id, s) => props.onStage?.(id, s)} />
  if (props.view === 'hooks') return <WebhooksPage hooks={props.hooks} deliveries={props.deliveries} tasks={props.tasks} onOpen={props.onOpenHook} onNew={props.onNewHook} />
  return <TaskList {...props} view={props.view} />
}

function TaskList({ tasks, hooks, projects, view, selected, onOpen, onNew, onStatus, onApprove }: {
  tasks: Task[]; hooks: Webhook[]; projects: { id: string; name: string }[]; view: Exclude<ListView, 'hooks' | 'board'>; selected: string | null
  onOpen: (id: string) => void; onNew: () => void; onStatus: (id: string, s: TaskStatus) => void; onApprove?: (id: string) => void
}) {
  const statusEnum = useEnumView('task_status')
  const prioEnum = useEnumView('task_priority')
  const [st, setSt] = useState<StatusFilter>('open')
  const [prio, setPrio] = useState('')
  const [proj, setProj] = useState('')
  const [q, setQ] = useState('')
  const [closed, setClosed] = useState<Set<DueSeg>>(new Set())
  const [more, setMore] = useState<Partial<Record<DueSeg, number>>>({})
  const [ask, setAsk] = useState<Task | null>(null)
  const kw = q.trim().toLowerCase()
  // 换了筛选，各段重新只露前 30 条
  useEffect(() => { setMore({}) }, [view, st, prio, proj, kw])
  const now = today()
  const end = weekEnd(now)
  const base = tasks.filter((t) => (view === 'all' || (view === 'due' ? isOverdue(t) : t.source.kind === view)) && (!proj || (proj === '-' ? !t.project_id : t.project_id === proj)))
  const match = (t: Task, s: StatusFilter) => s === 'all' || (s === 'open' ? isOpenTask(t.status) : t.status === s)
  const rows = base
    .filter((t) => match(t, st) && (!prio || t.priority === prio) && (!kw || [t.title, t.desc, t.ref, t.assignee].some((v) => v.toLowerCase().includes(kw))))
    .sort((a, b) => a.priority.localeCompare(b.priority) || (a.due ?? '9').localeCompare(b.due ?? '9'))
  const segs = DUE_SEGS.map((s) => ({ ...s, xs: rows.filter((t) => dueSeg(t, now, end) === s.key) })).filter((s) => s.xs.length)
  const projName = (id: string) => projects.find((x) => x.id === id)?.name
  const title = { all: '全部任务', due: '逾期任务', manual: '人工创建的任务', im: 'IM 消息转的任务', webhook: 'Webhook 转的任务', schedule: '定时任务建的任务', incident: '运行异常转的研发任务' }[view]
  const sub = {
    all: '人工创建、IM 消息转来、Webhook 推来的任务都在这里，按截止日分段',
    due: '过了截止日还没完成的任务，最早到期的在前',
    manual: '自己手动建的任务',
    im: '在 IM 消息里点「转任务」建的，能回看原消息',
    webhook: '外部系统推到接收地址后按映射规则自动建的，能回看原始推送',
    schedule: '定时任务到点自动建的，规则在「定时任务」里改',
    incident: '从「设置 / 运行异常」转过来的，带着异常详情；做完回去把异常标为已解决',
  }[view]
  // 状态在设置里可以加很多个：seg 只放前 5 个，其余收进「更多状态」
  const statusItems = statusEnum.items.filter((i) => i.key !== 'cancelled')
  const statusHead = statusItems.slice(0, 5)
  const statusRest = statusItems.slice(5)
  const toggle = (k: DueSeg) => setClosed((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n })

  const row = (t: Task) => {
    const overdue = isOverdue(t)
    return (
      <div key={t.id} className={cls('task-row', selected === t.id && 'sel', t.status === 'done' && 'is-done')} onClick={() => onOpen(t.id)}>
        <button className={cls('task-check', t.status === 'done' && 'on')} title={t.status === 'done' ? `标为${statusEnum.label('todo')}` : t.status === 'review' ? '验收通过' : `标为${statusEnum.label('done')}`}
          onClick={(e) => { e.stopPropagation(); if (t.status === 'review') setAsk(t); else onStatus(t.id, t.status === 'done' ? 'todo' : 'done') }}>
          {t.status === 'done' && <svg viewBox="0 0 16 16" width="10" height="10"><path d="m3.5 8.5 3 3 6-7" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>}
        </button>
        <span className="task-main">
          <span className="task-title"><span className="task-ref">{t.ref}</span><span className="ellipsis">{t.title}</span></span>
          <span className="task-meta"><SourceTag task={t} hooks={hooks} />{t.project_id && <span className="src-tag src-proj" title={projName(t.project_id)}>{projName(t.project_id) ?? '已删除的项目'}</span>}{!t.project_id && t.project_removed && <span className="src-tag src-proj" title={`原属项目「${t.project_removed}」`}>原属项目已删除</span>}<span>{timeAgo(t.created_at)}创建</span></span>
        </span>
        <span><PriorityTag p={t.priority} /></span>
        <span className="ellipsis run-muted">{t.assignee || '未分配'}</span>
        <span className={cls('run-muted', overdue && 'danger-text')}>{t.due ? (t.due === now ? '今天' : t.due.slice(5)) : '-'}{overdue ? ' 逾期' : ''}</span>
        <span><TaskStatusPill s={t.status} /></span>
      </div>
    )
  }

  return (
    <div className="page page-fill">
      <PageTitle parent="任务" count={rows.length} desc={sub} actions={
        <button className="btn btn-primary" onClick={onNew}>
          <svg viewBox="0 0 16 16" width="12" height="12"><path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
          新建任务
        </button>
      }>{title}</PageTitle>
      <div className="toolbar">
        <div className="seg">
          {([['open', '未完成'], ...statusHead.map((i) => [i.key, i.label]), ['all', '全部']] as [StatusFilter, string][]).map(([k, l]) => (
            <button key={k} className={cls(st === k && 'on')} onClick={() => setSt(k)}>{l}<span className="seg-n">{base.filter((t) => match(t, k)).length}</span></button>
          ))}
        </div>
        {statusRest.length > 0 && (
          <SearchSelect value={statusRest.some((i) => i.key === st) ? st : ''} placeholder="更多状态" searchPlaceholder="搜状态"
            options={statusRest.map((i) => ({ value: i.key, label: i.label, hint: `${base.filter((t) => t.status === i.key).length}` }))}
            onChange={(v) => setSt(v ? (v as TaskStatus) : 'open')} />
        )}
        <div className="chip chip-select">
          <select value={prio} onChange={(e) => setPrio(e.target.value)}>
            <option value="">全部优先级</option>
            {prioEnum.items.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
          </select>
        </div>
        <SearchSelect value={proj} onChange={setProj} noneLabel="全部项目" searchPlaceholder="搜项目"
          options={[...projects.map((x) => ({ value: x.id, label: x.name })), { value: '-', label: '不属于项目' }]}
          missingLabel={() => '已删除的项目'} />
        <span className="spacer" />
        <div className="search">
          {searchIcon}
          <input placeholder="搜索标题、编号、负责人" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>
      {rows.length === 0 ? (
        // 搜索、优先级、项目筛空了；只是状态筛空了（视图里有任务）；视图里一条都没有，三种分开说
        kw || prio || proj ? (
          <div className="empty">
            <div className="empty-title">没有匹配的任务</div>
            <div className="list-sub">换个筛选条件试试</div>
          </div>
        ) : base.length ? (
          <div className="empty">
            <div className="empty-title">没有符合条件的任务</div>
            <div className="list-sub">{st === 'open' ? `这里的 ${base.length} 条都已结束` : `没有处于「${statusEnum.label(st)}」的任务`}</div>
            <button className="btn btn-ghost" onClick={() => setSt(st === 'open' ? 'all' : 'open')}>{st === 'open' ? '看全部' : '切回「未完成」'}</button>
          </div>
        ) : (
          <div className="empty">
            <div className="empty-title">{view === 'due' ? '没有逾期的任务' : '这里还没有任务'}</div>
            <div className="list-sub">{{
              due: '截止日都还没到，或者已经做完了',
              im: '在 IM 消息里点「转任务」',
              webhook: '在「Webhook 接入」里建一个 Webhook，把地址填到外部系统里',
              schedule: '定时任务到点会建在这里',
              incident: '在「设置 / 运行异常」里转任务',
            }[view as string] ?? '点右上角新建一个'}</div>
          </div>
        )
      ) : (
        <div className="task-table">
          <div className="task-row task-th"><span /><span>任务</span><span>优先级</span><span>负责人</span><span>截止</span><span>状态</span></div>
          {segs.map((s) => {
            const open = !closed.has(s.key)
            const n = PAGE + (more[s.key] ?? 0)
            return (
              <div key={s.key} role="group" aria-label={s.label}>
                <ListSegHead label={s.label} n={s.xs.length} open={open} onToggle={() => toggle(s.key)} tone={s.key === 'overdue' ? 'danger' : undefined} />
                {open && s.xs.slice(0, n).map(row)}
                {open && <ListSegMore n={s.xs.length - n} onMore={() => setMore((m) => ({ ...m, [s.key]: (m[s.key] ?? 0) + 100 }))} />}
              </div>
            )
          })}
        </div>
      )}
      {ask && (
        <ApproveConfirm task={ask} onClose={() => setAsk(null)} onOpen={() => { setAsk(null); onOpen(ask.id) }}
          onApprove={() => { setAsk(null); if (onApprove) onApprove(ask.id); else onStatus(ask.id, 'done') }} />
      )}
    </div>
  )
}

/* ---------- Webhook 列表 ---------- */

type HookFilter = '' | 'failed' | 'off'

function WebhooksPage({ hooks, deliveries, tasks, onOpen, onNew }: {
  hooks: Webhook[]; deliveries?: Delivery[]; tasks: Task[]
  onOpen?: (id: string) => void; onNew?: () => void
}) {
  const [q, setQ] = useState('')
  const [f, setF] = useState<HookFilter>('')
  // 没拿到推送记录时推送相关的列显示「-」，不当成「没收到推送」
  const known = deliveries !== undefined
  const last = useMemo(() => lastDeliveries(deliveries ?? []), [deliveries])
  const pushes = useMemo(() => {
    const m = new Map<string, number>()
    for (const d of deliveries ?? []) m.set(d.hook_id, (m.get(d.hook_id) ?? 0) + 1)
    return m
  }, [deliveries])
  const made = useMemo(() => {
    const m = new Map<string, number>()
    for (const t of tasks) if (t.source.kind === 'webhook') m.set(t.source.hook_id, (m.get(t.source.hook_id) ?? 0) + 1)
    return m
  }, [tasks])
  const failed = (h: Webhook) => last.get(h.id)?.result === 'failed'
  const pass = (h: Webhook, k: HookFilter) => !k || (k === 'failed' ? failed(h) : !h.enabled)
  const kw = q.trim().toLowerCase()
  // 最近失败的在前，其余按最近推送时间
  const rows = hooks.filter((h) => pass(h, f) && (!kw || `${h.name} ${h.token}`.toLowerCase().includes(kw)))
    .sort((a, b) => Number(failed(b)) - Number(failed(a)) || Number(b.enabled) - Number(a.enabled) || (last.get(b.id)?.at ?? '').localeCompare(last.get(a.id)?.at ?? '') || a.name.localeCompare(b.name))
  return (
    <div className="page page-fill">
      <PageTitle parent="任务" count={hooks.length} desc="外部系统往接收地址 POST 一段 JSON，按映射规则自动建任务；最近推送失败的排在前面"
        actions={onNew && <button className="btn btn-primary" onClick={onNew}>新建 Webhook</button>}>Webhook 接入</PageTitle>
      <div className="toolbar">
        <div className="seg">
          {([['', '全部'], ...(known ? [['failed', '最近失败']] : []), ['off', '已停用']] as [HookFilter, string][]).map(([k, l]) => (
            <button key={k} className={cls(f === k && 'on')} onClick={() => setF(k)}>{l}<span className="seg-n">{hooks.filter((h) => pass(h, k)).length}</span></button>
          ))}
        </div>
        <span className="spacer" />
        <div className="search">
          {searchIcon}
          <input placeholder="搜索名称、地址" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>
      {!rows.length ? (
        <div className="empty">
          <div className="empty-title">{kw || f ? '没有匹配的 Webhook' : '还没有 Webhook'}</div>
          <div className="list-sub">{kw || f ? '换个筛选条件试试' : '建一个 Webhook，把接收地址填到 Sentry、表单、工单系统里，推过来的事件自动变成任务'}</div>
        </div>
      ) : (
        <div className="task-table">
          <div className="sched-row task-th"><span>名称</span><span>接收地址</span><span>最近推送</span><span>推送时间</span><span>建了任务</span><span>启用</span></div>
          {rows.map((h) => {
            const d = last.get(h.id)
            const t = d?.task_id ? tasks.find((k) => k.id === d.task_id) : undefined
            return (
              <div key={h.id} className={cls('sched-row', !h.enabled && 'is-off', !onOpen && 'is-static')} onClick={onOpen && (() => onOpen(h.id))}>
                <span className="task-main"><span className="task-title"><span className="ellipsis" title={h.name}>{h.name || '未命名'}</span></span></span>
                <span className="run-muted ellipsis mono" title={`${HOOK_BASE}${h.token}`}>…/{h.token}</span>
                <span className="sched-action">
                  {d ? <><Pill {...RESULT[d.result]} /><span className="ellipsis run-muted" title={d.reason}>{d.result === 'created' && t ? `${t.ref} ${t.title}` : d.reason}</span></> : <span className="run-muted">{known ? '还没收到推送' : '-'}</span>}
                </span>
                <span className={cls('run-muted', d?.result === 'failed' && 'danger-text')}>{d ? timeAgo(d.at) : '-'}</span>
                <span className="run-muted" title={known ? `推送 ${pushes.get(h.id) ?? 0} 次，建了 ${made.get(h.id) ?? 0} 条任务` : undefined}>{made.get(h.id) ?? 0} 条{known ? ` / ${pushes.get(h.id) ?? 0} 次` : ''}</span>
                <span className="run-muted">{h.enabled ? '启用' : '停用'}</span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

/* ---------- 抽屉：新建 / 查看任务 ---------- */

export interface TaskDraft { title: string; desc: string; status: TaskStatus; priority: Priority; assignee: string; due: string | null; project_id?: string; acceptance?: string; workdir?: string; repo?: string }
const draftOf = (t: Task): TaskDraft => ({ title: t.title, desc: t.desc, status: t.status, priority: t.priority, assignee: t.assignee, due: t.due, project_id: t.project_id, acceptance: t.acceptance, workdir: t.workdir, repo: t.repo })
/** 两份草稿内容一样：空串、null、undefined 都当没填 */
const sameDraft = (a: TaskDraft, b: TaskDraft) => (Object.keys({ ...a, ...b }) as (keyof TaskDraft)[]).every((k) => (a[k] || '') === (b[k] || ''))

/** 任务详情的标签（SPEC-tasks-4.35）：基础信息、开发任务、SOP（插件在跑才有）、执行记录 */
export type TaskTab = 'info' | 'dev' | 'pipeline' | 'sop' | 'runs'
const TASK_TABS: { key: TaskTab; label: string }[] = [
  { key: 'info', label: '基础信息' }, { key: 'dev', label: '开发任务' }, { key: 'pipeline', label: '流水线' }, { key: 'sop', label: 'SOP' }, { key: 'runs', label: '执行记录' },
]

export function TaskDrawer({ task, initial, fromMessage, fromThread = [], threadWho, hooks, deliveries, assignees, projects, onClose, onSave, onDelete, onOpenMessage, onOpenHook, onOpenSchedule, onOpenIncident, delImpact, dev, sop, handoff, reminders, tab: initialTab, focusRun, focusSopRun }: {
  /** 打开时停在哪个标签；不给时待验收的停在开发任务，其余基础信息。正式产品记在地址 ?tab= 上 */
  tab?: TaskTab
  /** 跳到某次执行（正式产品 ?run=）：切到执行记录并定位 */
  focusRun?: string
  /** 跳到某次 SOP 执行（正式产品 ?sop_run=）：切到 SOP 并定位，从 SOP 运行页返回时用 */
  focusSopRun?: string
  /** 任务抽屉里的「提醒」：关联这条任务的提醒、设一个、取消（SPEC-tasks-4.30） */
  reminders?: { list: Schedule[]; onAdd: (f: ReminderForm) => void; onCancel: (id: string) => void }
  onOpenIncident?: (id: string) => void
  onOpenSchedule?: (id: string) => void
  task: Task | null
  initial?: Partial<TaskDraft>
  /** IM 消息转任务时传进来 */
  fromMessage?: Message
  /** 转任务时这条消息所在消息列里的其它消息（threadForTask），按时间正序；有时出「附上消息列」（SPEC-messages-2.15） */
  fromThread?: Message[]
  /** 消息列里的发信人怎么叫（联系人名优先） */
  threadWho?: (m: Message) => string
  hooks: Webhook[]
  deliveries: Delivery[]
  assignees: string[]
  /** 可选的所属项目；root 是任务没设工作目录时继承的目录 */
  projects: (Pick<Project, 'id' | 'name' | 'root'> & Partial<Pick<Project, 'related' | 'prototypes' | 'profile'>>)[]
  onClose: () => void
  /** replyOnDone：IM 转任务时勾了「执行完成后在原消息里回复」（SPEC-tasks-4.42） */
  onSave: (d: TaskDraft, markMessageDone: boolean, replyOnDone?: boolean) => void
  onDelete: () => void
  onOpenMessage: (id: string) => void
  onOpenHook: (id: string) => void
  /** 删除的连带影响，列在确认里 */
  delImpact?: string[]
  /** 开发闭环：进展、产出物、执行记录、验收 */
  dev?: DevLoop
  /** 关联到这条任务的 SOP 执行和「执行 SOP」（SOP-06）；SOP 插件没开时不给 */
  /** SOP 插件在跑时有：执行、流程、发起、去运行页；gov、onAct 给「流水线」标签（AUTO-12，SPEC-sop-16）用 */
  sop?: { runs: SopRun[]; sops: Sop[]; onStart: (sopId: string) => void; onOpenRun: (runId: string) => void; gov: Governance; onAct: (runId: string, a: RunAction) => void }
  /** 交给 Claude Code 的「切换到终端」（SPEC-tasks-6.10）：终端插件在跑才有 terminalOn；onTerminal 在终端页新开标签执行启动命令 */
  handoff?: { terminalOn: boolean; onTerminal: (o: { task: Task; runId: string; workdir: string; prompt: string }) => void; onManagePresets?: () => void }
}) {
  const statusEnum = useEnumView('task_status')
  const prioEnum = useEnumView('task_priority')
  const msgEnum = useEnumView('msg_status')
  const creating = !task
  // 新建时的默认状态、优先级取设置里的默认值
  const [d, setD] = useState<TaskDraft>(() => ({
    title: task?.title ?? '', desc: task?.desc ?? '', status: task?.status ?? (statusEnum.defaultKey as TaskStatus | undefined) ?? 'todo', priority: task?.priority ?? (prioEnum.defaultKey as Priority | undefined) ?? 'P2',
    assignee: task?.assignee ?? '我', due: task?.due ?? null, project_id: task?.project_id,
    acceptance: task?.acceptance, workdir: task?.workdir, repo: task?.repo, ...initial,
  }))
  const [runOpen, setRunOpen] = useState(false)
  const inheritDir = projects.find((x) => x.id === d.project_id)?.root
  const proj = projects.find((x) => x.id === d.project_id)
  const projectCtx = proj ? projectContext({ name: proj.name, root: proj.root ?? '', related: proj.related ?? [], prototypes: proj.prototypes ?? [] }) : undefined
  const mine = <T extends { task_id: string }>(xs: T[]) => (task ? xs.filter((x) => x.task_id === task.id) : [])
  // 基础信息里点了「设为开发任务」
  const [devOpened, setDevOpened] = useState(false)
  const devOn = !!(task && dev && (isDevTask(task, dev) || devOpened || task.status === 'review' || d.acceptance || d.workdir || d.repo))
  const [tab, setTab] = useState<TaskTab>(() => initialTab ?? (focusRun ? 'runs' : focusSopRun ? 'sop' : task?.status === 'review' ? 'dev' : 'info'))
  // 定位只在打开时用一次，切过标签就不再高亮
  const [focus, setFocus] = useState({ run: focusRun, sop: focusSopRun })
  const pick = (k: TaskTab) => { setTab(k); setFocus({ run: undefined, sop: undefined }) }
  // 标签条：开发任务和执行记录只在开发任务上有，SOP 只在插件在跑时有；停在没有的标签上回基础信息
  const tabShown = (k: TaskTab) => k === 'info' || ((k === 'dev' || k === 'runs') && devOn) || ((k === 'sop' || k === 'pipeline') && !!sop) || k === tab && k !== 'sop' && k !== 'pipeline'
  const cur: TaskTab = tabShown(tab) ? tab : 'info'
  const runsN = dev ? mine(dev.runs).length : 0
  const sopMine = task && sop ? sop.runs.filter((r) => r.object_id === task.id) : []
  // 流水线标签上的卡点数（等人、失败、超时、超出上限）
  const pipeBlocks = task && sop ? taskRuns(task, sop.runs).reduce((n, r) => n + r.steps.filter((_, i) => waitOf(r, i)).length, 0) : 0
  const runningId = dev && mine(dev.runs).find((r) => r.status === 'running')?.id
  const [markDone, setMarkDone] = useState(true)
  const [replyOnDone, setReplyOnDone] = useState(true)
  // 转任务附上消息列：默认勾上，存时拼进描述后面
  const [withThread, setWithThread] = useState(true)
  const threadBody = useMemo(() => threadTaskBody(fromThread, threadWho), [fromThread, threadWho])
  const [tried, setTried] = useState(false)
  const [confirmDel, setConfirmDel] = useState(false)
  const [showPayload, setShowPayload] = useState(false)
  const src = task?.source ?? (fromMessage ? { kind: 'im' as const, message_id: fromMessage.id, channel: fromMessage.channel, sender: fromMessage.sender_name, text: fromMessage.text } : { kind: 'manual' as const })
  const delivery = src.kind === 'webhook' ? deliveries.find((x) => x.id === src.delivery_id) : undefined
  const hook = src.kind === 'webhook' ? hooks.find((h) => h.id === src.hook_id) : undefined
  const save = () => {
    setTried(true)
    if (!d.title.trim()) { pick('info'); return }
    const extra = creating && fromMessage && withThread ? threadBody : ''
    const desc = extra ? (d.desc.trim() ? `${d.desc.trim()}\n\n${extra}` : extra) : d.desc
    onSave({ ...d, title: d.title.trim(), desc }, markDone, replyOnDone)
  }
  // 未保存的改动：已有任务跟它现在的值比（验收、交给 Claude Code 已经直接改了任务，不算），新建跟打开时比
  const [blank] = useState(d)
  const dirty = !sameDraft(d, task ? draftOf(task) : blank)
  const [askClose, setAskClose] = useState(false)
  const close = () => { if (dirty) { setConfirmDel(false); setAskClose(true) } else onClose() }
  // Esc 先于 App 的全局 Esc 处理；弹窗开着时交给弹窗
  const latest = useRef({ dirty, runOpen, askClose, onClose })
  latest.current = { dirty, runOpen, askClose, onClose }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = latest.current
      if (e.key !== 'Escape' || s.runOpen || document.querySelector('.dev-confirm')) return
      e.stopPropagation()
      if (s.askClose) setAskClose(false)
      else if (s.dirty) { setConfirmDel(false); setAskClose(true) }
      else s.onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  const removedProject = task?.project_removed
  const fields = (
    <>
      <label className="field">
        <span className="field-label">标题<em>*</em></span>
        <input value={d.title} autoFocus={creating} className={cls(tried && !d.title.trim() && 'bad')} onChange={(e) => setD({ ...d, title: e.target.value })} placeholder="要做的事" />
        {tried && !d.title.trim() && <span className="field-err">必填</span>}
      </label>
      <label className="field">
        <span className="field-label">描述</span>
        <GrowArea rows={6} value={d.desc} onChange={(e) => setD({ ...d, desc: e.target.value })} />
      </label>
      <div className="field">
        <span className="field-label">状态</span>
        <div className="seg seg-full">
          {statusEnum.optionsWith(d.status).map((s) => <button key={s.key} className={cls(d.status === s.key && 'on')} title={s.desc || undefined} onClick={() => setD({ ...d, status: s.key as TaskStatus })}>{s.label}</button>)}
        </div>
      </div>
      <div className="field">
        <span className="field-label">优先级</span>
        <div className="seg seg-full">
          {prioEnum.optionsWith(d.priority).map((p) => <button key={p.key} className={cls(d.priority === p.key && 'on')} title={p.desc || undefined} onClick={() => setD({ ...d, priority: p.key as Priority })}>{p.label}</button>)}
        </div>
      </div>
      <div className="field-row">
        <label className="field">
          <span className="field-label">负责人</span>
          <input list="task-assignees" value={d.assignee} onChange={(e) => setD({ ...d, assignee: e.target.value })} />
          <datalist id="task-assignees">{assignees.map((a) => <option key={a} value={a} />)}</datalist>
        </label>
        <label className="field">
          <span className="field-label">截止日期</span>
          <input type="date" value={d.due ?? ''} onChange={(e) => setD({ ...d, due: e.target.value || null })} />
        </label>
      </div>
      <div className="field">
        <span className="field-label">所属项目</span>
        <SearchSelect variant="field" value={d.project_id ?? ''} noneLabel="不属于项目" searchPlaceholder="搜项目" aria-label="所属项目"
          options={projects.map((x) => ({ value: x.id, label: x.name }))} missingLabel={() => '已删除的项目'}
          onChange={(v) => setD({ ...d, project_id: v || undefined })} />
        {!d.project_id && removedProject && <span className="list-sub">原属项目「{removedProject}」已删除</span>}
      </div>
    </>
  )
  const devFields = (
    <DevFields d={d} inheritDir={inheritDir} onChange={(p) => setD((x) => ({ ...x, ...p }))}
      onRun={task && dev ? () => setRunOpen(true) : undefined} runningId={runningId}
      onShowRun={(id) => { setTab('runs'); setFocus({ run: id, sop: undefined }) }} />
  )

  return (
    <aside className="drawer">
      <div className="drawer-head">
        <span className="drawer-kicker">{creating ? (fromMessage ? 'IM 消息转任务' : '新建任务') : task.ref}</span>
        <div className="spacer" />
        <button className="icon-btn" onClick={close} title="关闭 (Esc)">
          <svg viewBox="0 0 16 16" width="14" height="14"><path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
        </button>
      </div>
      <div className="drawer-body form">
        {src.kind === 'im' && (
          <div className="src-card">
            <div className="src-card-head">
              <span className="field-group-title">来自 IM 消息</span>
              <span className="muted">{channelLabel(src.channel)} · {src.sender}</span>
              <span className="spacer" />
              <button className="act act-quiet" onClick={() => onOpenMessage(src.message_id)}>查看原消息</button>
            </div>
            <div className="src-quote">{src.text}</div>
          </div>
        )}
        {src.kind === 'incident' && (
          <div className="src-card">
            <div className="src-card-head">
              <span className="field-group-title">来自运行异常</span>
              <span className="muted">{src.title}</span>
              {task?.tags?.includes('claude-code') && <span className="tag" title="运行异常巡检建的，交给 Claude Code 修">claude-code</span>}
              <span className="spacer" />
              {onOpenIncident && <button className="act act-quiet" onClick={() => onOpenIncident(src.incident_id)}>查看异常</button>}
            </div>
          </div>
        )}
        {src.kind === 'schedule' && (
          <div className="src-card">
            <div className="src-card-head">
              <span className="field-group-title">来自定时任务</span>
              <span className="muted">{src.name}</span>
              <span className="spacer" />
              {onOpenSchedule && <button className="act act-quiet" onClick={() => onOpenSchedule(src.schedule_id)}>查看规则</button>}
            </div>
          </div>
        )}
        {src.kind === 'webhook' && (
          <div className="src-card">
            <div className="src-card-head">
              <span className="field-group-title">来自 Webhook</span>
              <span className="muted">{hook?.name ?? '已删除的 Webhook'}{delivery && ` · ${timeAgo(delivery.at)}推送`}</span>
              <span className="spacer" />
              {hook && <button className="act act-quiet" onClick={() => onOpenHook(hook.id)}>查看配置</button>}
              {delivery && <button className="act act-quiet" onClick={() => setShowPayload(!showPayload)}>{showPayload ? '收起推送内容' : '看推送内容'}</button>}
            </div>
            {showPayload && delivery && <pre className="io-json src-payload">{JSON.stringify(delivery.payload, null, 2)}</pre>}
          </div>
        )}
        {creating ? (
          <>
            {fields}
            <DevFields d={d} inheritDir={inheritDir} onChange={(p) => setD((x) => ({ ...x, ...p }))} />
            {fromMessage && fromThread.length > 0 && (
              <div className="totask-thread">
                <label className="check"><input type="checkbox" checked={withThread} onChange={(e) => setWithThread(e.target.checked)} />附上消息列（{fromThread.length} 条），写进任务正文</label>
                {withThread && (
                  <ul className="totask-thread-list" aria-label="附上的消息列">
                    {fromThread.slice(-3).map((x) => (
                      <li key={x.id}><b>{threadWho ? threadWho(x) : x.sender_name}</b>{!x.thread && <span className="list-sub">（原消息）</span>}<span className="list-sub">{timeAgo(x.at)}</span>：<span className="ellipsis">{x.text || '（没有正文）'}</span></li>
                    ))}
                    {fromThread.length > 3 && <li className="list-sub">前面还有 {fromThread.length - 3} 条，一起附上</li>}
                  </ul>
                )}
              </div>
            )}
            {fromMessage && fromMessage.status === 'pending' && (
              <label className="check"><input type="checkbox" checked={markDone} onChange={(e) => setMarkDone(e.target.checked)} />建好后把这条消息标为{msgEnum.label('done')}</label>
            )}
            {fromMessage && (
              <div className="field">
                <label className="check"><input type="checkbox" checked={replyOnDone} onChange={(e) => setReplyOnDone(e.target.checked)} />执行完成后在原消息里回复</label>
                <span className="list-sub">任务交给 Claude Code 执行成功、或标为已完成后，自动在原消息里回复对方，带上执行结论（SOP「IM 任务回执」）</span>
              </div>
            )}
          </>
        ) : (
          <>
            <div className="task-head-title">{d.title.trim() || task.title}</div>
            <div className="np-tabs task-tabs" role="tablist" aria-label="任务详情">
              {TASK_TABS.filter((t) => tabShown(t.key)).map((t) => (
                <button key={t.key} role="tab" aria-selected={cur === t.key} className={cls(cur === t.key && 'on')} onClick={() => pick(t.key)}>
                  {t.label}
                  {t.key === 'dev' && task.status === 'review' && <span className="side-dot" title="等你验收" />}
                  {t.key === 'sop' && sopMine.length > 0 && <span className="seg-n" title={`${sopMine.length} 次 SOP 执行`}>{sopMine.length}</span>}
                  {t.key === 'sop' && (sopMine.some((r) => ['waiting', 'failed'].includes(runStatus(r)))
                    ? <span className="side-dot" title="有执行等你处理" />
                    : sopMine.some((r) => runStatus(r) === 'running') && <span className="proto-light pl-running" title="有执行还没结束" />)}
                  {t.key === 'pipeline' && pipeBlocks > 0 && <><span className="seg-n" title={`${pipeBlocks} 处卡点等你处理`}>{pipeBlocks}</span><span className="side-dot" title="有卡点等你处理" /></>}
                  {t.key === 'runs' && runsN > 0 && <span className="seg-n" title={`${runsN} 次执行`}>{runsN}</span>}
                  {t.key === 'runs' && runningId && <span className="proto-light pl-running" title="有执行在跑" />}
                </button>
              ))}
            </div>
            {cur === 'info' && (
              <>
                {fields}
                {reminders && <TaskReminders task={task} {...reminders} />}
                {/* 需求工作区（AUTO-07，SPEC-tasks-4.50 起）：正式产品是项目插件登记的对象区块 */}
                <TaskWorktreeBlock task={task} projects={projects} />
                {!devOn && dev && (
                  <button className="act act-quiet dev-open" onClick={() => { setDevOpened(true); pick('dev') }}>+ 设为开发任务：验收标准、工作目录，交给 Claude Code 做</button>
                )}
                <div className="list-sub">{timeAgo(task.created_at)}创建 · {timeAgo(task.updated_at)}更新</div>
              </>
            )}
            {cur === 'dev' && dev && (
              <>
                {task.status === 'review' && (
                  <ReviewBar task={task} progress={mine(dev.progress)} onReview={(ok, c) => {
                    dev.review(task.id, ok, c)
                    setD((x) => ({ ...x, status: ok ? 'done' : 'todo' }))
                  }} />
                )}
                {task.status !== 'review' && devFields}
                <ProgressBlock items={mine(dev.progress)} onAppend={(text) => dev.append(task.id, text)} />
                <ArtifactsBlock items={mine(dev.artifacts)} onAdd={(a) => dev.addArtifact(task.id, a)} />
                {task.status === 'review' && devFields}
              </>
            )}
            {cur === 'pipeline' && sop && <TaskPipelineBlock task={task} runs={sop.runs} gov={sop.gov} onAct={sop.onAct} onOpenRun={sop.onOpenRun} />}
            {cur === 'sop' && sop && <TaskSopBlock task={task} runs={sop.runs} sops={sop.sops} onStart={sop.onStart} onOpenRun={sop.onOpenRun} focus={focus.sop} />}
            {cur === 'runs' && dev && <RunsBlock runs={mine(dev.runs)} onCancel={dev.cancel} onFinish={dev.finish} focus={focus.run} />}
          </>
        )}
      </div>
      {runOpen && task && dev && (
        <RunDialog task={{ ...task, workdir: d.workdir }} inheritDir={inheritDir} project={projectCtx} terminalOn={!!handoff?.terminalOn} onClose={() => setRunOpen(false)}
          onManagePresets={handoff?.onManagePresets && (() => { setRunOpen(false); handoff.onManagePresets?.() })}
          onStart={(o) => {
            const runId = dev.start(task, o)
            if (o.mode === 'terminal') {
              setRunOpen(false)
              handoff?.onTerminal({ task, runId, workdir: o.workdir, prompt: buildPrompt({ task, workdir: o.workdir, extra: o.extra_prompt, mode: 'terminal', project: projectCtx, runId, preset: o.preset }) })
              return
            }
            // 交出去就算开工（SPEC-tasks-6.17）；允许写入时 Claude Code 还会领取，负责人改成它
            setD((x) => ({ ...x, status: x.status === 'done' || x.status === 'cancelled' ? x.status : 'doing', ...(o.allow_writes ? { assignee: 'Claude Code' } : {}) }))
            setRunOpen(false)
            // 流式执行发起后切到执行记录看输出（SPEC-tasks-4.41）
            pick('runs')
          }} />
      )}
      <div className="drawer-foot">
        {askClose ? (
          <>
            <span className="warn-text">有未保存的修改，关闭后会丢掉</span>
            <div className="spacer" />
            <button className="btn btn-ghost" onClick={() => setAskClose(false)}>继续编辑</button>
            <button className="btn btn-danger" onClick={onClose}>放弃修改</button>
          </>
        ) : confirmDel ? (
          <>
            <span className="danger-text">{delImpact?.length ? `删除后不能恢复；${delImpact.join('；')}` : '删除后不能恢复'}</span>
            <div className="spacer" />
            <button className="btn btn-ghost" onClick={() => setConfirmDel(false)}>取消</button>
            <button className="btn btn-danger" onClick={onDelete}>删除</button>
          </>
        ) : (
          <>
            {task && <button className="btn btn-ghost btn-danger-ghost" onClick={() => setConfirmDel(true)}>删除任务</button>}
            <div className="spacer" />
            <button className="btn btn-ghost" onClick={close}>取消</button>
            <button className="btn btn-primary" onClick={save}>{creating ? '创建任务' : '保存'}</button>
          </>
        )}
      </div>
    </aside>
  )
}

/* ---------- Webhook 配置 ---------- */

export function newHook(): Webhook {
  const r = () => Math.random().toString(36).slice(2, 8)
  return {
    id: `wh_${Date.now().toString(36)}`, name: '', token: `${r()}${r()}`, secret: `whsec_${r()}${r()}`, enabled: true,
    mapping: { title: 'title', desc: 'description', priority: 'priority', assignee: '', due: '' },
    filter: '', dedupe: '', defaults: { priority: 'P2', assignee: '我' },
    sample: JSON.stringify({ title: '示例：客户要求导出支持 Excel', description: '来自外部系统的说明', priority: 'high' }, null, 2),
    created_at: new Date().toISOString(),
  }
}

function parseJson(s: string): { ok: true; value: Json } | { ok: false; error: string } {
  try {
    const v = JSON.parse(s)
    return v && typeof v === 'object' && !Array.isArray(v) ? { ok: true, value: v } : { ok: false, error: '推送内容要是一个 JSON 对象' }
  } catch (e) { return { ok: false, error: `JSON 格式不对：${(e as Error).message}` } }
}

const RESULT: Record<Delivery['result'], { label: string; color: string }> = {
  created: { label: '已建任务', color: '#2f7d43' },
  skipped: { label: '已忽略', color: '#a19d92' },
  failed: { label: '失败', color: '#c0352b' },
}

export function WebhookPage({ hook, creating, deliveries, tasks, onSave, onDelete, onTest, onOpenTask, onCancel }: {
  hook: Webhook
  creating: boolean
  deliveries: Delivery[]
  tasks: Task[]
  onSave: (h: Webhook) => void
  onDelete: () => void
  onTest: (h: Webhook, payload: Json) => Ingest
  onOpenTask: (id: string) => void
  onCancel: () => void
}) {
  const prioEnum = useEnumView('task_priority')
  const [d, setD] = useState(hook)
  const [showSecret, setShowSecret] = useState(false)
  const [copied, setCopied] = useState('')
  const [sample, setSample] = useState(hook.sample)
  const [last, setLast] = useState<Ingest | null>(null)
  const [openLog, setOpenLog] = useState<string | null>(null)
  // 推送记录先露 20 条
  const [allLogs, setAllLogs] = useState(false)
  const [tried, setTried] = useState(false)
  const [confirmDel, setConfirmDel] = useState(false)
  useEffect(() => { setD(hook); setSample(hook.sample); setLast(null) }, [hook])

  const dirty = JSON.stringify({ ...d, sample }) !== JSON.stringify(hook) || creating
  const url = `${HOOK_BASE}${d.token}`
  const parsed = parseJson(sample)
  // 映射预览：用示例推送实时算一遍，配置时就能看到每个字段取到了什么
  const preview = useMemo(() => (parsed.ok ? mapFields(d, parsed.value) : null), [d, parsed])
  const filterRes = parsed.ok ? passFilter(d, parsed.value) : null
  const mine = deliveries.filter((x) => x.hook_id === hook.id).sort((a, b) => b.at.localeCompare(a.at))
  const copy = (k: string, v: string) => navigator.clipboard?.writeText(v).then(() => { setCopied(k); window.setTimeout(() => setCopied(''), 1500) }, () => {})
  const setMap = (k: keyof Webhook['mapping'], v: string) => setD({ ...d, mapping: { ...d.mapping, [k]: v } })
  const save = () => { setTried(true); if (d.name.trim() && d.mapping.title.trim()) onSave({ ...d, name: d.name.trim(), sample }) }
  const test = () => { if (parsed.ok) setLast(onTest({ ...d, sample }, parsed.value)) }
  const curl = `curl -X POST ${url} \\\n  -H 'Content-Type: application/json' \\\n  -H 'X-PMW-Signature: <用 Secret 对请求体做 HMAC-SHA256>' \\\n  -d '${parsed.ok ? JSON.stringify(parsed.value) : '{}'}'`

  return (
    <div className="page page-fill hook-page">
      <PageTitle parent="Webhook" desc="外部系统往接收地址 POST 一段 JSON，按映射规则自动建任务" actions={!creating && (
        <label className="switch-line">
          <input type="checkbox" checked={d.enabled} onChange={(e) => setD({ ...d, enabled: e.target.checked })} />
          <span className="switch" />{d.enabled ? '已启用' : '已停用'}
        </label>
      )}>{creating ? '新建 Webhook' : d.name || '未命名'}</PageTitle>
      <label className="field hook-name">
        <span className="field-label">名称<em>*</em></span>
        <input className={cls(tried && !d.name.trim() && 'bad')} value={d.name} placeholder="比如：Sentry 线上告警" onChange={(e) => setD({ ...d, name: e.target.value })} />
      </label>

      <div className="hook-grid">
        <div className="hook-col">
          <section className="hook-sec">
            <div className="field-group-title">接收地址</div>
            <div className="copy-line"><code>{url}</code><button className="act act-quiet" onClick={() => copy('url', url)}>{copied === 'url' ? '已复制' : '复制'}</button></div>
            <div className="copy-line">
              <span className="copy-k">Secret</span>
              <code>{showSecret ? d.secret : `${d.secret.slice(0, 6)}${'•'.repeat(12)}`}</code>
              <button className="act act-quiet" onClick={() => setShowSecret(!showSecret)}>{showSecret ? '隐藏' : '显示'}</button>
              <button className="act act-quiet" onClick={() => copy('secret', d.secret)}>{copied === 'secret' ? '已复制' : '复制'}</button>
            </div>
            <div className="list-sub">请求头 X-PMW-Signature 带上用 Secret 算的签名，签名不对的推送直接拒收，不进推送记录。</div>
            <details className="curl">
              <summary>curl 示例</summary>
              <pre className="io-json">{curl}</pre>
            </details>
          </section>

          <section className="hook-sec">
            <div className="field-group-title">字段映射<span className="field-hint">写推送 JSON 里的路径，形如 event.title、items[0].name；右边是用示例推送算出来的值</span></div>
            <div className="map-table">
              {(Object.keys(FIELD_LABEL) as (keyof Webhook['mapping'])[]).map((k) => {
                const v = preview?.[k] ?? ''
                const missing = k === 'title' && (!d.mapping.title.trim() || (preview && !v))
                return (
                  <div key={k} className="map-row">
                    <span className="map-k">{FIELD_LABEL[k]}{k === 'title' && <em>*</em>}</span>
                    <input className={cls('mono-input', tried && missing && 'bad')} value={d.mapping[k]} placeholder={k === 'title' ? '必填' : k === 'priority' ? `留空用默认 ${d.defaults.priority}` : k === 'assignee' ? `留空用默认 ${d.defaults.assignee || '未分配'}` : '留空不取'} onChange={(e) => setMap(k, e.target.value)} />
                    <span className={cls('map-v ellipsis', !v && 'map-v-none')} title={v}>{d.mapping[k] ? (v || '取不到值') : '-'}</span>
                  </div>
                )
              })}
            </div>
            <div className="field-row">
              <label className="field">
                <span className="field-label">默认优先级</span>
                <select value={d.defaults.priority} onChange={(e) => setD({ ...d, defaults: { ...d.defaults, priority: e.target.value as Priority } })}>
                  {prioEnum.optionsWith(d.defaults.priority).map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
                </select>
              </label>
              <label className="field">
                <span className="field-label">默认负责人</span>
                <input value={d.defaults.assignee} onChange={(e) => setD({ ...d, defaults: { ...d.defaults, assignee: e.target.value } })} />
              </label>
            </div>
            <div className="list-sub">优先级取到 fatal / critical / 紧急 记为 P0，error / high / 高 记为 P1，warning / 中 记为 P2，info / low / 低 记为 P3。</div>
          </section>

          <section className="hook-sec">
            <div className="field-group-title">过滤与去重</div>
            <label className="field">
              <span className="field-label">只在满足时建任务<span className="field-hint">路径 == 值 或 路径 != 值，留空不过滤</span></span>
              <input className="mono-input" value={d.filter} placeholder="action == created" onChange={(e) => setD({ ...d, filter: e.target.value })} />
              {filterRes && d.filter.trim() && <span className={cls('field-hint-line', !filterRes.pass && 'warn-text')}>示例推送：{filterRes.pass ? '满足，会建任务' : filterRes.reason}</span>}
            </label>
            <label className="field">
              <span className="field-label">去重字段<span className="field-hint">这个值相同的推送只建一次，防止对方重试造成重复任务</span></span>
              <input className="mono-input" value={d.dedupe} placeholder="event.id" onChange={(e) => setD({ ...d, dedupe: e.target.value })} />
              {parsed.ok && d.dedupe.trim() && <span className="field-hint-line">示例推送取到：{String(getPath(parsed.value, d.dedupe) ?? '取不到值')}</span>}
            </label>
          </section>
        </div>

        <div className="hook-col">
          <section className="hook-sec">
            <div className="field-group-title">测试推送<span className="field-hint">改下面的 JSON 模拟一次推送，会真的建任务并记进推送记录</span></div>
            <textarea className={cls('json-area', !parsed.ok && 'bad')} spellCheck={false} rows={10} value={sample} onChange={(e) => setSample(e.target.value)} />
            {!parsed.ok && <div className="field-err">{parsed.error}</div>}
            <div className="act-row">
              <button className="act act-primary" disabled={!parsed.ok || creating} title={creating ? '先保存再测试' : undefined} onClick={test}>发送测试推送</button>
              {creating && <span className="list-sub">先保存再测试</span>}
              {last && (
                <span className="test-result">
                  <Pill {...RESULT[last.delivery.result]} />
                  {last.task ? <button className="link-btn" onClick={() => onOpenTask(last.task!.id)}>{last.task.ref} {last.task.title}</button> : <span className="list-sub">{last.delivery.reason}</span>}
                </span>
              )}
            </div>
          </section>

          <section className="hook-sec">
            <div className="field-group-title">推送记录<span className="field-hint">{mine.length} 次</span></div>
            {mine.length === 0 ? <div className="io-empty">还没有收到推送</div> : (
              <div className="log-list">
                {(allLogs ? mine : mine.slice(0, 20)).map((x) => {
                  const t = x.task_id ? tasks.find((k) => k.id === x.task_id) : undefined
                  return (
                    <div key={x.id} className="log-item">
                      <button className="log-head" onClick={() => setOpenLog(openLog === x.id ? null : x.id)}>
                        <Pill {...RESULT[x.result]} />
                        <span className="log-what ellipsis">{x.result === 'created' && t ? `${t.ref} ${t.title}` : x.reason}</span>
                        <span className="run-muted">{timeAgo(x.at)}</span>
                      </button>
                      {openLog === x.id && (
                        <div className="log-body">
                          {x.reason && x.result !== 'created' && <div className="list-sub">{x.reason}</div>}
                          {x.mapped && (
                            <div className="log-mapped">
                              {(Object.keys(FIELD_LABEL) as (keyof Webhook['mapping'])[]).filter((k) => x.mapped![k] !== undefined).map((k) => (
                                <span key={k}><b>{FIELD_LABEL[k]}</b>{x.mapped![k] || <i>空</i>}</span>
                              ))}
                            </div>
                          )}
                          <pre className="io-json">{JSON.stringify(x.payload, null, 2)}</pre>
                          <div className="act-row">
                            {t && <button className="act" onClick={() => onOpenTask(t.id)}>打开任务 {t.ref}</button>}
                            <button className="act act-quiet" onClick={() => setSample(JSON.stringify(x.payload, null, 2))}>拿来当测试推送</button>
                          </div>
                        </div>
                      )}
                    </div>
                  )
                })}
                {!allLogs && <ListSegMore n={mine.length - 20} text={`更早的 ${mine.length - 20} 条`} onMore={() => setAllLogs(true)} />}
              </div>
            )}
          </section>
        </div>
      </div>

      <div className="hook-foot">
        {confirmDel ? (
          <>
            <span className="danger-text">删除后这个地址不再接收推送，已建的任务保留</span>
            <span className="spacer" />
            <button className="btn btn-ghost" onClick={() => setConfirmDel(false)}>取消</button>
            <button className="btn btn-danger" onClick={onDelete}>删除</button>
          </>
        ) : (
          <>
            {!creating && <button className="btn btn-ghost btn-danger-ghost" onClick={() => setConfirmDel(true)}>删除 Webhook</button>}
            <span className="spacer" />
            {tried && (!d.name.trim() || !d.mapping.title.trim()) && <span className="field-err">{!d.name.trim() ? '还没有名称' : '标题映射必填'}</span>}
            {creating && <button className="btn btn-ghost" onClick={onCancel}>取消</button>}
            <button className="btn btn-primary" disabled={!dirty} onClick={save}>{creating ? '创建 Webhook' : dirty ? '保存修改' : '已保存'}</button>
          </>
        )}
      </div>
    </div>
  )
}
