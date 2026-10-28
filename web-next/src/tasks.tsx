import { useEffect, useMemo, useState } from 'react'
import { PageTitle } from './topbar'
import { IM_CHANNELS, type Message } from './data'
import { Subnav } from './subnav'
import {
  FIELD_LABEL, HOOK_BASE, getPath, mapFields, passFilter,
  type Delivery, type Ingest, type Json, type Priority, type Task, type TaskStatus, type Webhook, isOpenTask,
} from './taskdata'
import { cls, timeAgo } from './ui'
import { useEnumView } from './enumdata'

/** 任务页的二级菜单 key */
/** schedule：定时任务建出来的任务；schedules：定时任务本身的管理页 */
export type TaskView = 'all' | 'manual' | 'im' | 'webhook' | 'schedule' | 'incident' | 'schedules' | `hook:${string}`

const channelLabel = (k: string) => IM_CHANNELS.find((c) => c.key === k)?.label ?? k
const today = () => new Date().toISOString().slice(0, 10)

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
  const failing = (h: Webhook) => deliveries.filter((d) => d.hook_id === h.id).sort((a, b) => b.at.localeCompare(a.at))[0]?.result === 'failed' ? 1 : 0
  return (
    <Subnav title="任务" active={view} onSelect={onSelect} items={[
      { key: 'all' as TaskView, label: '全部任务' },
      { key: 'manual' as TaskView, label: '人工创建', group: '来源' },
      { key: 'im' as TaskView, label: 'IM 消息', group: '来源' },
      { key: 'webhook' as TaskView, label: 'Webhook', group: '来源' },
      { key: 'schedule' as TaskView, label: '定时', group: '来源' },
      { key: 'incident' as TaskView, label: '运行异常', group: '来源' },
      { key: 'schedules' as TaskView, label: '定时任务', desc: '到点自动建任务、跑 SOP、叫 Agent', group: '自动化' },
      ...hooks.map((h) => ({ key: `hook:${h.id}` as TaskView, label: h.name, desc: h.enabled ? undefined : '已停用', alert: failing(h), group: 'Webhook 接入' })),
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

export function TasksPage({ tasks, hooks, projects, view, selected, onOpen, onNew, onStatus }: {
  tasks: Task[]; hooks: Webhook[]; projects: { id: string; name: string }[]; view: Exclude<TaskView, `hook:${string}` | 'schedules'>; selected: string | null
  onOpen: (id: string) => void; onNew: () => void; onStatus: (id: string, s: TaskStatus) => void
}) {
  const statusEnum = useEnumView('task_status')
  const prioEnum = useEnumView('task_priority')
  const [st, setSt] = useState<StatusFilter>('open')
  const [prio, setPrio] = useState('')
  const [proj, setProj] = useState('')
  const [q, setQ] = useState('')
  const base = tasks.filter((t) => (view === 'all' || t.source.kind === view) && (!proj || (proj === '-' ? !t.project_id : t.project_id === proj)))
  const match = (t: Task, s: StatusFilter) => s === 'all' || (s === 'open' ? isOpenTask(t.status) : t.status === s)
  const kw = q.trim().toLowerCase()
  const rows = base
    .filter((t) => match(t, st) && (!prio || t.priority === prio) && (!kw || [t.title, t.desc, t.ref, t.assignee].some((v) => v.toLowerCase().includes(kw))))
    .sort((a, b) => a.priority.localeCompare(b.priority) || (a.due ?? '9').localeCompare(b.due ?? '9'))
  const title = { all: '全部任务', manual: '人工创建的任务', im: 'IM 消息转的任务', webhook: 'Webhook 转的任务', schedule: '定时任务建的任务', incident: '运行异常转的研发任务' }[view]
  const sub = {
    all: '人工创建、IM 消息转来、Webhook 推来的任务都在这里',
    manual: '自己手动建的任务',
    im: '在 IM 消息里点「转任务」建的，能回看原消息',
    webhook: '外部系统推到接收地址后按映射规则自动建的，能回看原始推送',
    schedule: '定时任务到点自动建的，规则在「定时任务」里改',
    incident: '从「设置 / 运行异常」转过来的，带着异常详情；做完回去把异常标为已解决',
  }[view]

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
          {([['open', '未完成'], ...statusEnum.items.filter((i) => i.key !== 'cancelled').map((i) => [i.key, i.label]), ['all', '全部']] as [StatusFilter, string][]).map(([k, l]) => (
            <button key={k} className={cls(st === k && 'on')} onClick={() => setSt(k)}>{l}<span className="seg-n">{base.filter((t) => match(t, k)).length}</span></button>
          ))}
        </div>
        <div className="chip chip-select">
          <select value={prio} onChange={(e) => setPrio(e.target.value)}>
            <option value="">全部优先级</option>
            {prioEnum.items.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
          </select>
        </div>
        <div className={cls('chip chip-select', proj && 'chip-on')}>
          <select value={proj} onChange={(e) => setProj(e.target.value)}>
            <option value="">全部项目</option>
            {projects.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
            <option value="-">不属于项目</option>
          </select>
        </div>
        <span className="spacer" />
        <div className="search">
          <svg viewBox="0 0 16 16" width="14" height="14"><circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
          <input placeholder="搜索标题、编号、负责人" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>
      {rows.length === 0 ? (
        <div className="empty">
          <div className="empty-title">{kw || prio ? '没有匹配的任务' : '这里还没有任务'}</div>
          <div className="list-sub">{view === 'im' ? '在 IM 消息里点「转任务」' : view === 'webhook' ? '在左侧建一个 Webhook，把地址填到外部系统里' : '点右上角新建一个'}</div>
        </div>
      ) : (
        <div className="task-table">
          <div className="task-row task-th"><span /><span>任务</span><span>优先级</span><span>负责人</span><span>截止</span><span>状态</span></div>
          {rows.map((t) => {
            const overdue = t.due && t.due < today() && t.status !== 'done' && t.status !== 'cancelled'
            return (
              <div key={t.id} className={cls('task-row', selected === t.id && 'sel', t.status === 'done' && 'is-done')} onClick={() => onOpen(t.id)}>
                <button className={cls('task-check', t.status === 'done' && 'on')} title={t.status === 'done' ? `标为${statusEnum.label('todo')}` : `标为${statusEnum.label('done')}`}
                  onClick={(e) => { e.stopPropagation(); onStatus(t.id, t.status === 'done' ? 'todo' : 'done') }}>
                  {t.status === 'done' && <svg viewBox="0 0 16 16" width="10" height="10"><path d="m3.5 8.5 3 3 6-7" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>}
                </button>
                <span className="task-main">
                  <span className="task-title"><span className="task-ref">{t.ref}</span><span className="ellipsis">{t.title}</span></span>
                  <span className="task-meta"><SourceTag task={t} hooks={hooks} />{t.project_id && <span className="src-tag src-proj">{projects.find((x) => x.id === t.project_id)?.name ?? '已删除的项目'}</span>}{!t.project_id && t.project_removed && <span className="src-tag src-proj" title={`原属项目「${t.project_removed}」`}>原属项目已删除</span>}<span>{timeAgo(t.created_at)}创建</span></span>
                </span>
                <span><PriorityTag p={t.priority} /></span>
                <span className="ellipsis run-muted">{t.assignee || '未分配'}</span>
                <span className={cls('run-muted', overdue && 'danger-text')}>{t.due ? (t.due === today() ? '今天' : t.due.slice(5)) : '-'}{overdue ? ' 逾期' : ''}</span>
                <span><TaskStatusPill s={t.status} /></span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

/* ---------- 抽屉：新建 / 查看任务 ---------- */

export interface TaskDraft { title: string; desc: string; status: TaskStatus; priority: Priority; assignee: string; due: string | null; project_id?: string }

export function TaskDrawer({ task, initial, fromMessage, hooks, deliveries, assignees, projects, onClose, onSave, onDelete, onOpenMessage, onOpenHook, onOpenSchedule, onOpenIncident, delImpact }: {
  onOpenIncident?: (id: string) => void
  onOpenSchedule?: (id: string) => void
  task: Task | null
  initial?: Partial<TaskDraft>
  /** IM 消息转任务时传进来 */
  fromMessage?: Message
  hooks: Webhook[]
  deliveries: Delivery[]
  assignees: string[]
  /** 可选的所属项目 */
  projects: { id: string; name: string }[]
  onClose: () => void
  onSave: (d: TaskDraft, markMessageDone: boolean) => void
  onDelete: () => void
  onOpenMessage: (id: string) => void
  onOpenHook: (id: string) => void
  /** 删除的连带影响，列在确认里 */
  delImpact?: string[]
}) {
  const statusEnum = useEnumView('task_status')
  const prioEnum = useEnumView('task_priority')
  const msgEnum = useEnumView('msg_status')
  const creating = !task
  // 新建时的默认状态、优先级取设置里的默认值
  const [d, setD] = useState<TaskDraft>(() => ({
    title: task?.title ?? '', desc: task?.desc ?? '', status: task?.status ?? (statusEnum.defaultKey as TaskStatus | undefined) ?? 'todo', priority: task?.priority ?? (prioEnum.defaultKey as Priority | undefined) ?? 'P2',
    assignee: task?.assignee ?? '我', due: task?.due ?? null, project_id: task?.project_id, ...initial,
  }))
  const [markDone, setMarkDone] = useState(true)
  const [tried, setTried] = useState(false)
  const [confirmDel, setConfirmDel] = useState(false)
  const [showPayload, setShowPayload] = useState(false)
  const src = task?.source ?? (fromMessage ? { kind: 'im' as const, message_id: fromMessage.id, channel: fromMessage.channel, sender: fromMessage.sender_name, text: fromMessage.text } : { kind: 'manual' as const })
  const delivery = src.kind === 'webhook' ? deliveries.find((x) => x.id === src.delivery_id) : undefined
  const hook = src.kind === 'webhook' ? hooks.find((h) => h.id === src.hook_id) : undefined
  const save = () => { setTried(true); if (d.title.trim()) onSave({ ...d, title: d.title.trim() }, markDone) }

  return (
    <aside className="drawer">
      <div className="drawer-head">
        <span className="drawer-kicker">{creating ? (fromMessage ? 'IM 消息转任务' : '新建任务') : task.ref}</span>
        <div className="spacer" />
        <button className="icon-btn" onClick={onClose} title="关闭 (Esc)">
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
        <label className="field">
          <span className="field-label">标题<em>*</em></span>
          <input value={d.title} autoFocus={creating} className={cls(tried && !d.title.trim() && 'bad')} onChange={(e) => setD({ ...d, title: e.target.value })} placeholder="要做的事" />
          {tried && !d.title.trim() && <span className="field-err">必填</span>}
        </label>
        <label className="field">
          <span className="field-label">描述</span>
          <textarea rows={4} value={d.desc} onChange={(e) => setD({ ...d, desc: e.target.value })} />
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
        <label className="field">
          <span className="field-label">所属项目</span>
          <select value={d.project_id ?? ''} onChange={(e) => setD({ ...d, project_id: e.target.value || undefined })}>
            <option value="">不属于项目</option>
            {projects.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </select>
          {!d.project_id && task?.project_removed && <span className="list-sub">原属项目「{task.project_removed}」已删除</span>}
        </label>
        {creating && fromMessage && fromMessage.status === 'pending' && (
          <label className="check"><input type="checkbox" checked={markDone} onChange={(e) => setMarkDone(e.target.checked)} />建好后把这条消息标为{msgEnum.label('done')}</label>
        )}
        {task && <div className="list-sub">{timeAgo(task.created_at)}创建 · {timeAgo(task.updated_at)}更新</div>}
      </div>
      <div className="drawer-foot">
        {confirmDel ? (
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
            <button className="btn btn-ghost" onClick={onClose}>取消</button>
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
                {mine.map((x) => {
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
