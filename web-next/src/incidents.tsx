import { useState } from 'react'
import { INCIDENT_MODULES, INCIDENT_STATUS, levelPriority, taskDesc, type Incident, type IncidentStatus } from './incidentdata'
import type { Priority, Task } from './taskdata'
import { useEnumView } from './enumdata'
import { PageTitle } from './topbar'
import { cls, timeAgo } from './ui'

// 设置 > 运行异常：列表 + 详情抽屉。详情里能转研发任务、忽略、标为已解决

const Pill = ({ label, color }: { label: string; color: string }) => <span className="pill" style={{ '--c': color } as React.CSSProperties}><span className="pill-dot" />{label}</span>
type Filter = IncidentStatus | 'all'

export function IncidentsPage({ incidents, tasks, selected, onOpen }: { incidents: Incident[]; tasks: Task[]; selected: string | null; onOpen: (id: string) => void }) {
  const [st, setSt] = useState<Filter>('open')
  const [mod, setMod] = useState('')
  const [level, setLevel] = useState<'' | 'error' | 'warn'>('')
  const [q, setQ] = useState('')
  const statusEnum = useEnumView('task_status')
  const kw = q.trim().toLowerCase()
  const match = (x: Incident, s: Filter) => s === 'all' || x.status === s
  const rows = incidents
    .filter((x) => match(x, st) && (!mod || x.module === mod) && (!level || x.level === level) && (!kw || `${x.title}${x.message}`.toLowerCase().includes(kw)))
    .sort((a, b) => b.last_at.localeCompare(a.last_at))
  const mods = INCIDENT_MODULES.filter((m) => incidents.some((x) => x.module === m))

  return (
    <div className="page page-fill">
      <PageTitle parent="设置" count={incidents.filter((x) => x.status === 'open').length + ' 个未处理'} desc="系统运行中出的问题，同一个问题合并记次数；能转成研发任务去优化">运行异常</PageTitle>
      <div className="toolbar">
        <div className="seg">
          {([['open', '未处理'], ['tasked', '已转任务'], ['resolved', '已解决'], ['ignored', '已忽略'], ['all', '全部']] as [Filter, string][]).map(([k, l]) => (
            <button key={k} className={cls(st === k && 'on')} onClick={() => setSt(k)}>{l}<span className="seg-n">{incidents.filter((x) => match(x, k)).length}</span></button>
          ))}
        </div>
        <div className="seg">
          {([['', '全部级别'], ['error', '错误'], ['warn', '警告']] as const).map(([k, l]) => <button key={k} className={cls(level === k && 'on')} onClick={() => setLevel(k)}>{l}</button>)}
        </div>
        <label className={cls('chip chip-select', mod && 'chip-on')}>
          <select value={mod} onChange={(e) => setMod(e.target.value)}>
            <option value="">全部模块</option>
            {mods.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </label>
        <span className="spacer" />
        <div className="search">
          <svg viewBox="0 0 16 16" width="14" height="14"><circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
          <input placeholder="搜异常标题和描述" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>
      {!rows.length ? (
        <div className="empty"><div className="empty-title">{st === 'open' ? '没有未处理的异常' : '没有匹配的异常'}</div><div className="list-sub">连接器、模型服务商、Webhook、SOP、原型和页面本身出的问题都会记在这里</div></div>
      ) : (
        <div className="task-table">
          <div className="inc-row task-th"><span /><span>异常</span><span>模块</span><span>次数</span><span>最近一次</span><span>状态</span></div>
          {rows.map((x) => {
            const task = x.task_id ? tasks.find((t) => t.id === x.task_id) : undefined
            return (
              <div key={x.id} className={cls('inc-row', selected === x.id && 'sel', x.status !== 'open' && 'is-done')} onClick={() => onOpen(x.id)}>
                <span className={cls('inc-level', `il-${x.level}`)} title={x.level === 'error' ? '错误' : '警告'} />
                <span className="task-main">
                  <span className="task-title"><span className="ellipsis">{x.title}</span></span>
                  <span className="task-meta"><span className="ellipsis">{x.message}</span></span>
                </span>
                <span><span className="tag">{x.module}</span></span>
                <span className={cls('inc-count', x.count >= 5 && 'hot')}>{x.count}</span>
                <span className="run-muted">{timeAgo(x.last_at)}</span>
                <span className="inc-st">
                  <Pill {...INCIDENT_STATUS[x.status]} />
                  {task && <span className="task-ref">{task.ref}{task.status === 'done' && ` ${statusEnum.label('done')}`}</span>}
                </span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

export function IncidentDrawer({ incident, task, assignees, onClose, onStatus, onToTask, onOpenTask }: {
  incident: Incident
  task: Task | undefined
  assignees: string[]
  onClose: () => void
  onStatus: (s: IncidentStatus, note?: string) => void
  onToTask: (t: { title: string; desc: string; priority: Priority; assignee: string }) => void
  onOpenTask: (id: string) => void
}) {
  const prioEnum = useEnumView('task_priority')
  const x = incident
  const [making, setMaking] = useState(false)
  const [draft, setDraft] = useState(() => ({ title: `[异常] ${x.module}：${x.title}`, desc: taskDesc(x), priority: levelPriority(x), assignee: '我' }))
  const [showCtx, setShowCtx] = useState(true)
  return (
    <aside className="drawer">
      <div className="drawer-head">
        <span className="drawer-kicker">运行异常</span>
        <div className="spacer" />
        <button className="icon-btn" onClick={onClose} title="关闭 (Esc)">
          <svg viewBox="0 0 16 16" width="14" height="14"><path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
        </button>
      </div>
      <div className="drawer-body form">
        <div className="inc-head">
          <span className={cls('inc-level big', `il-${x.level}`)} />
          <div className="profile-text">
            <h2>{x.title}</h2>
            <div className="list-sub">{x.module} · {x.level === 'error' ? '错误' : '警告'} · 共 {x.count} 次 · 首次 {timeAgo(x.first_at)}，最近 {timeAgo(x.last_at)}</div>
          </div>
          <Pill {...INCIDENT_STATUS[x.status]} />
        </div>
        {x.note && <div className="detail-alert"><span>{x.note}</span></div>}
        <div className="inc-msg">{x.message}</div>

        {task ? (
          <div className="src-card">
            <div className="src-card-head">
              <span className="field-group-title">已转为研发任务</span>
              <span className="muted">{task.ref} {task.title}</span>
              <span className="spacer" />
              <button className="act act-quiet" onClick={() => onOpenTask(task.id)}>打开任务</button>
            </div>
            {task.status === 'done' && x.status !== 'resolved' && (
              <div className="act-row"><span className="list-sub">任务已经完成了，确认问题不再出现就可以标为已解决</span><button className="act act-primary" onClick={() => onStatus('resolved')}>标为已解决</button></div>
            )}
          </div>
        ) : making ? (
          <section className="field-group">
            <div className="field-group-title">转为研发任务<span className="field-hint">描述里已经带上现象、频率、上下文和报错，研发拿到就能查</span></div>
            <label className="field"><span className="field-label">标题</span><input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} /></label>
            <label className="field"><span className="field-label">描述</span><textarea rows={8} className="code-input" value={draft.desc} onChange={(e) => setDraft({ ...draft, desc: e.target.value })} /></label>
            <div className="field-row">
              <div className="field"><span className="field-label">优先级<span className="field-hint">按级别和次数预填</span></span>
                <div className="seg seg-full">{prioEnum.optionsWith(draft.priority).map((p) => <button key={p.key} className={cls(draft.priority === p.key && 'on')} title={p.desc || undefined} onClick={() => setDraft({ ...draft, priority: p.key as Priority })}>{p.label}</button>)}</div>
              </div>
              <label className="field"><span className="field-label">负责人</span>
                <input list="inc-assignees" value={draft.assignee} onChange={(e) => setDraft({ ...draft, assignee: e.target.value })} />
                <datalist id="inc-assignees">{assignees.map((a) => <option key={a} value={a} />)}</datalist>
              </label>
            </div>
            <div className="act-row">
              <button className="act act-primary" disabled={!draft.title.trim()} onClick={() => { onToTask(draft); setMaking(false) }}>建任务</button>
              <button className="act act-quiet" onClick={() => setMaking(false)}>取消</button>
            </div>
          </section>
        ) : null}

        {(x.stack || Object.keys(x.context).length > 0) && (
          <section className="field-group">
            <div className="field-group-title tools-head">
              <span>上下文与报错</span><span className="spacer" />
              <button className="act act-quiet" onClick={() => setShowCtx(!showCtx)}>{showCtx ? '收起' : '展开'}</button>
            </div>
            {showCtx && <>
              <dl className="io-fields inc-ctx">
                {Object.entries(x.context).map(([k, v]) => (
                  <div key={k} className="io-field"><dt>{k}</dt><dd>{typeof v === 'object' ? <pre className="io-json">{JSON.stringify(v, null, 2)}</pre> : <span className="io-text">{String(v)}</span>}</dd></div>
                ))}
              </dl>
              {x.stack && <pre className="proto-logs">{x.stack}</pre>}
            </>}
          </section>
        )}

        <section className="field-group">
          <div className="field-group-title">最近发生<span className="field-hint">最多显示 20 次</span></div>
          <div className="inc-times">{x.occurrences.map((t, i) => <span key={i} className="tag" title={new Date(t).toLocaleString('zh-CN')}>{timeAgo(t)}</span>)}</div>
        </section>
      </div>
      <div className="drawer-foot">
        {x.status === 'open' || x.status === 'tasked' ? (
          <>
            {x.status === 'open' && <button className="btn btn-ghost" onClick={() => onStatus('ignored')}>忽略</button>}
            <div className="spacer" />
            <button className="btn btn-outline" onClick={() => onStatus('resolved')}>标为已解决</button>
            {!task && !making && <button className="btn btn-primary" onClick={() => setMaking(true)}>转为研发任务</button>}
          </>
        ) : (
          <>
            <span className="list-sub">{x.status === 'ignored' ? '已忽略：再次出现时会重新打开' : '已解决：再次出现时会重新打开'}</span>
            <div className="spacer" />
            <button className="btn btn-outline" onClick={() => onStatus(x.task_id ? 'tasked' : 'open')}>重新打开</button>
          </>
        )}
      </div>
    </aside>
  )
}
