import { useState } from 'react'
import { SearchSelect } from './searchselect'
import { ListSegHead } from './tasks'
import {
  ACTION_LABEL, FREQ_LABEL, SWEEP_LEVEL_LABEL, WEEK, describeRule, emptyRule, nextRun, nextText, ruleError, sweepText, whenText,
  type Freq, type Schedule, type ScheduleAction,
} from './scheduledata'
import type { Priority } from './taskdata'
import { useEnumView } from './enumdata'
import { PageTitle } from './topbar'
import { cls, timeAgo } from './ui'
import { newId } from './ids'

// 任务 > 定时任务：列表 + 抽屉。抽屉里配「什么时候」和「做什么」，下面是执行记录
// 定时发布由视频的发布记录生成，抽屉里只读：时间去内容日历拖，或在发布记录里改

interface Named { id: string; name: string; enabled?: boolean }

export const actionText = (a: ScheduleAction, sops: Named[], agents: Named[], publishes: Named[] = []) => (a.kind === 'task'
  ? `建任务「${a.title || '未填标题'}」`
  : a.kind === 'remind' ? `提醒「${a.title || '未填标题'}」${a.task_id ? '，关联任务' : ''}`
  : a.kind === 'sop' ? `执行「${sops.find((s) => s.id === a.sop_id)?.name ?? '已删除的 SOP'}」`
    : a.kind === 'publish' ? `发布「${publishes.find((x) => x.id === a.publish_id)?.name ?? '已删除的发布记录'}」`
      : a.kind === 'incident_sweep' ? `巡检运行异常：${sweepText(a)}，建任务交给 Claude Code`
      : `${agents.find((x) => x.id === a.agent_id)?.name ?? '已删除的 Agent'}：${a.prompt || '未填要求'}`)

export function SchedulesPage({ schedules, sops, agents, publishes = [], selected, onOpen, onNew, onToggle }: {
  schedules: Schedule[]
  sops: Named[]
  agents: Named[]
  /** 定时发布指向的发布记录，name 是「平台 · 标题」 */
  publishes?: Named[]
  selected: string | null
  onOpen: (id: string) => void
  onNew: () => void
  onToggle: (id: string, on: boolean) => void
}) {
  const [q, setQ] = useState('')
  const [kind, setKind] = useState<'' | ScheduleAction['kind']>('')
  // 停用的沉到底部，默认收起
  const [offOpen, setOffOpen] = useState(false)
  const kw = q.trim().toLowerCase()
  const hit = (s: Schedule) => (!kind || s.action.kind === kind) && (!kw || `${s.name} ${describeRule(s.rule)} ${actionText(s.action, sops, agents, publishes)}`.toLowerCase().includes(kw))
  const sorted = schedules.filter(hit).sort((a, b) => (nextRun(a.rule)?.getTime() ?? Infinity) - (nextRun(b.rule)?.getTime() ?? Infinity))
  const on = sorted.filter((s) => s.enabled)
  const off = sorted.filter((s) => !s.enabled)
  const row = (s: Schedule) => {
    const last = s.history[0]
    const next = s.enabled ? nextRun(s.rule) : null
    return (
      <div key={s.id} className={cls('sched-row', selected === s.id && 'sel', !s.enabled && 'is-off')} onClick={() => onOpen(s.id)}>
        <span className="task-main"><span className="task-title"><span className="ellipsis" title={s.name}>{s.name}</span></span></span>
        <span className="run-muted ellipsis">{describeRule(s.rule)}</span>
        <span className="sched-action"><span className={`sched-kind sk-${s.action.kind}`}>{ACTION_LABEL[s.action.kind]}</span><span className="ellipsis run-muted">{actionText(s.action, sops, agents, publishes)}</span></span>
        <span className={cls('run-muted', s.enabled && next && 'sched-next')}>{nextText(s)}</span>
        <span className={cls('run-muted', last && !last.ok && 'danger-text')} title={last?.text}>{last ? `${timeAgo(last.at)}${last.ok ? '' : ' 失败'}` : '还没执行过'}</span>
        <span onClick={(e) => e.stopPropagation()}>
          <label className="switch-line"><input type="checkbox" checked={s.enabled} onChange={(e) => onToggle(s.id, e.target.checked)} /><span className="switch" /></label>
        </span>
      </div>
    )
  }
  return (
    <div className="page page-fill">
      <PageTitle parent="任务" count={schedules.length} desc="到点自动建任务、提醒你、执行 SOP、让 Agent 去做，或者发布视频；它建的任务来源标为「定时」"
        actions={<button className="btn btn-primary" onClick={onNew}>新建定时任务</button>}>定时任务</PageTitle>
      {schedules.length > 0 && (
        <div className="toolbar">
          <div className="seg">
            {([['', '全部'], ...(Object.keys(ACTION_LABEL) as ScheduleAction['kind'][]).map((k) => [k, ACTION_LABEL[k]])] as ['' | ScheduleAction['kind'], string][]).map(([k, l]) => (
              <button key={k} className={cls(kind === k && 'on')} onClick={() => setKind(k)}>{l}<span className="seg-n">{k ? schedules.filter((s) => s.action.kind === k).length : schedules.length}</span></button>
            ))}
          </div>
          <span className="spacer" />
          <div className="search">
            <svg viewBox="0 0 16 16" width="14" height="14"><circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
            <input placeholder="搜索名称、规则、要做的事" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
        </div>
      )}
      {!schedules.length ? (
        <div className="empty"><div className="empty-title">还没有定时任务</div><div className="list-sub">比如每周一 9 点建一条「整理周会议程」，或者每周五让周报助手写周报</div></div>
      ) : !sorted.length ? (
        <div className="empty"><div className="empty-title">没有匹配的定时任务</div><div className="list-sub">换个筛选条件试试</div></div>
      ) : (
        <div className="task-table">
          <div className="sched-row task-th"><span>名称</span><span>什么时候</span><span>做什么</span><span>下次执行</span><span>上次</span><span>启用</span></div>
          {on.map(row)}
          {off.length > 0 && (
            <div role="group" aria-label="已停用">
              {/* 搜索时停用的也展开，免得命中的藏在收起的段里 */}
              <ListSegHead label="已停用" n={off.length} open={offOpen || !!kw} onToggle={() => setOffOpen(!offOpen)} />
              {(offOpen || !!kw) && off.map(row)}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export function ScheduleDrawer({ schedule, sops, agents, publishes = [], assignees, onClose, onSave, onDelete, onRunNow, openTask, onOpenPublish, onOpenCalendar, taskName }: {
  /** 提醒关联的任务「T-004 标题」，任务删了返回 undefined */
  taskName?: (taskId: string) => string | undefined
  schedule: Schedule | null
  sops: Named[]
  agents: Named[]
  /** 定时发布指向的发布记录，name 是「平台 · 标题」 */
  publishes?: Named[]
  /** 定时发布：打开那条发布记录、去内容日历改时间 */
  onOpenPublish?: (publishId: string) => void
  onOpenCalendar?: () => void
  assignees: string[]
  onClose: () => void
  onSave: (s: Schedule) => void
  onDelete: () => void
  /** 立即执行一次，返回执行结果写进记录 */
  onRunNow: (s: Schedule) => void
  /** 执行记录里建出的任务编号：任务还在就返回打开它的回调，删了返回 undefined（编号只显示文字） */
  openTask?: (ref: string) => (() => void) | undefined
}) {
  const prioEnum = useEnumView('task_priority')
  // 新建任务类动作时的默认优先级取设置里的默认值
  const defPrio = (prioEnum.defaultKey ?? 'P2') as Priority
  const creating = !schedule
  const [d, setD] = useState<Schedule>(() => schedule ?? {
    id: newId('sc'), name: '', enabled: true, rule: emptyRule(), created_at: new Date().toISOString(), history: [],
    action: { kind: 'task', title: '', desc: '', priority: defPrio, assignee: '我', due_days: 0 },
  })
  const [tried, setTried] = useState(false)
  const [confirmDel, setConfirmDel] = useState(false)
  const r = d.rule
  const setRule = (p: Partial<typeof r>) => setD({ ...d, rule: { ...r, ...p } })
  const setKind = (k: ScheduleAction['kind']) => setD({
    ...d, action: k === 'task' ? { kind: 'task', title: '', desc: '', priority: defPrio, assignee: '我', due_days: 0 }
      : k === 'remind' ? { kind: 'remind', title: '', body: '', task_id: '' }
      : k === 'sop' ? { kind: 'sop', sop_id: sops[0]?.id ?? '' }
        : k === 'incident_sweep' ? { kind: 'incident_sweep', min_level: 'error', min_count: 1 }
          : { kind: 'agent', agent_id: agents.find((a) => a.enabled !== false)?.id ?? '', prompt: '' },
  })
  const a = d.action
  // 定时发布只读：规则跟着发布记录，过了时间也不算错
  const pub = a.kind === 'publish'
  const rErr = pub ? '' : ruleError(r)
  const aErr = a.kind === 'task' ? (!a.title.trim() ? '任务标题必填' : '') : a.kind === 'remind' ? (!a.title.trim() ? '提醒标题必填' : a.title.trim().length > 100 ? '提醒标题最多 100 字' : '') : a.kind === 'sop' ? (!a.sop_id ? '选一个 SOP' : '') : a.kind === 'publish' || a.kind === 'incident_sweep' ? '' : (!a.agent_id ? '选一个 Agent' : !a.prompt.trim() ? '写一下要它做什么' : '')
  const errors = [!d.name.trim() && '名称必填', rErr, aErr].filter(Boolean) as string[]
  const next = nextRun(r)
  // 列出接下来三次，帮人确认规则是不是自己想的那样
  const upcoming = (() => {
    const out: Date[] = []
    let from = new Date()
    for (let i = 0; i < 3; i += 1) { const n = nextRun(r, from); if (!n) break; out.push(n); from = new Date(n.getTime() + 60000) }
    return out
  })()
  const save = () => { setTried(true); if (!errors.length) onSave({ ...d, name: d.name.trim() }) }

  return (
    <aside className="drawer">
      <div className="drawer-head">
        <span className="drawer-kicker">{creating ? '新建定时任务' : '定时任务'}</span>
        <div className="spacer" />
        <button className="icon-btn" onClick={onClose} title="关闭 (Esc)">
          <svg viewBox="0 0 16 16" width="14" height="14"><path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
        </button>
      </div>
      <div className="drawer-body form">
        <label className="field">
          <span className="field-label">名称<em>*</em></span>
          <input value={d.name} autoFocus={creating} readOnly={pub} className={cls(tried && !d.name.trim() && 'bad')} placeholder="比如：周会前整理议程" onChange={(e) => setD({ ...d, name: e.target.value })} />
        </label>

        {a.kind === 'publish' ? (
          <section className="field-group">
            <div className="field-group-title">发布哪条</div>
            <div className="sched-pub">
              <span className="sched-kind sk-publish">{ACTION_LABEL.publish}</span>
              <span className="ellipsis">{publishes.find((x) => x.id === a.publish_id)?.name ?? '已删除的发布记录'}</span>
            </div>
            <div className="sched-preview">
              <span className="list-sub">{describeRule(r)}，{next ? `下次：${whenText(next)}` : '已经到过点了'}</span>
            </div>
            <span className="field-hint-line">这条定时跟着视频的发布记录走：改时间在内容日历里拖，或者在发布记录里改；到点按发布记录发，失败的记进运行异常</span>
            <div className="act-row">
              {onOpenPublish && publishes.some((x) => x.id === a.publish_id) && <button className="act" onClick={() => onOpenPublish(a.publish_id)}>打开发布记录</button>}
              {onOpenCalendar && <button className="act" onClick={onOpenCalendar}>去内容日历</button>}
            </div>
          </section>
        ) : <>
        <section className="field-group">
          <div className="field-group-title">什么时候</div>
          <div className="seg seg-full sched-freq">
            {(Object.keys(FREQ_LABEL) as Freq[]).map((f) => <button key={f} className={cls(r.freq === f && 'on')} onClick={() => setRule({ freq: f })}>{FREQ_LABEL[f].replace('只执行', '')}</button>)}
          </div>
          {r.freq === 'weekly' && (
            <div className="week-pick">
              {[1, 2, 3, 4, 5, 6, 0].map((w) => (
                <button key={w} className={cls('week-day', r.weekdays.includes(w) && 'on')} onClick={() => setRule({ weekdays: r.weekdays.includes(w) ? r.weekdays.filter((x) => x !== w) : [...r.weekdays, w] })}>{WEEK[w]}</button>
              ))}
            </div>
          )}
          <div className="field-row">
            {r.freq === 'once' && <label className="field"><span className="field-label">日期</span><input type="date" value={r.date} onChange={(e) => setRule({ date: e.target.value })} /></label>}
            {r.freq === 'monthly' && (
              <label className="field"><span className="field-label">几号</span>
                <select value={r.day} onChange={(e) => setRule({ day: Number(e.target.value) })}>
                  {Array.from({ length: 31 }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{n === 31 ? '31（小月按月底）' : n} 号</option>)}
                </select>
              </label>
            )}
            {r.freq === 'cron' ? (
              <label className="field"><span className="field-label">Cron 表达式<span className="field-hint">分 时 日 月 周</span></span><input className="mono" value={r.cron} placeholder="0 9 * * 1" onChange={(e) => setRule({ cron: e.target.value })} /></label>
            ) : (
              <label className="field"><span className="field-label">时间</span><input type="time" value={r.time} onChange={(e) => setRule({ time: e.target.value })} /></label>
            )}
          </div>
          {rErr ? <div className="field-err">{rErr}</div> : (
            <div className="sched-preview">
              <span className="list-sub">{describeRule(r)}，接下来：</span>
              {upcoming.map((u) => <span key={u.toISOString()} className="tag">{whenText(u)}</span>)}
              {!upcoming.length && <span className="list-sub">不会再执行</span>}
            </div>
          )}
        </section>

        <section className="field-group">
          <div className="field-group-title">做什么</div>
          <div className="seg seg-full">
            {(Object.keys(ACTION_LABEL) as ScheduleAction['kind'][]).filter((k) => k !== 'publish').map((k) => <button key={k} className={cls(a.kind === k && 'on')} onClick={() => setKind(k)}>{ACTION_LABEL[k]}</button>)}
          </div>
          {a.kind === 'task' && (
            <>
              <label className="field">
                <span className="field-label">任务标题<em>*</em><span className="field-hint">可以写 {'{{date}}'}，执行时换成当天日期</span></span>
                <input value={a.title} className={cls(tried && !a.title.trim() && 'bad')} placeholder="比如：整理 {{date}} 周会议程" onChange={(e) => setD({ ...d, action: { ...a, title: e.target.value } })} />
              </label>
              <label className="field"><span className="field-label">描述</span><textarea rows={2} value={a.desc} onChange={(e) => setD({ ...d, action: { ...a, desc: e.target.value } })} /></label>
              <div className="field-row">
                <label className="field"><span className="field-label">优先级</span>
                  <select value={a.priority} onChange={(e) => setD({ ...d, action: { ...a, priority: e.target.value as Priority } })}>{prioEnum.optionsWith(a.priority).map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}</select>
                </label>
                <label className="field"><span className="field-label">负责人</span>
                  <input list="sched-assignees" value={a.assignee} onChange={(e) => setD({ ...d, action: { ...a, assignee: e.target.value } })} />
                  <datalist id="sched-assignees">{assignees.map((x) => <option key={x} value={x} />)}</datalist>
                </label>
                <label className="field"><span className="field-label">截止</span>
                  <select value={a.due_days} onChange={(e) => setD({ ...d, action: { ...a, due_days: Number(e.target.value) } })}>
                    {[0, 1, 2, 3, 5, 7].map((n) => <option key={n} value={n}>{n === 0 ? '当天' : `${n} 天后`}</option>)}
                  </select>
                </label>
              </div>
            </>
          )}
          {a.kind === 'remind' && (
            <>
              <label className="field">
                <span className="field-label">提醒标题<em>*</em></span>
                <input value={a.title} className={cls(tried && !a.title.trim() && 'bad')} placeholder="比如：给客户回电话" onChange={(e) => setD({ ...d, action: { ...a, title: e.target.value } })} />
              </label>
              <label className="field"><span className="field-label">内容<span className="field-hint">可以不填；关联了任务时不填就显示任务标题</span></span>
                <textarea rows={2} value={a.body} onChange={(e) => setD({ ...d, action: { ...a, body: e.target.value } })} />
              </label>
              {a.task_id && (
                <div className="sched-pub">
                  <span className="list-sub">关联任务：</span>
                  <span className="ellipsis">{taskName?.(a.task_id) ?? '已删除的任务'}</span>
                  <span className="spacer" />
                  <button className="act" onClick={() => setD({ ...d, action: { ...a, task_id: '' } })}>解除关联</button>
                </div>
              )}
              <span className="field-hint-line">到点在工作台右下角弹一条提醒，不发到 IM；关联了任务的，点提醒打开这条任务。只提醒一次的到点后自动停用</span>
            </>
          )}
          {a.kind === 'incident_sweep' && (
            <>
              <div className="field-row">
                <div className="field"><span className="field-label">最低级别</span>
                  <div className="seg seg-full">{(['error', 'warn'] as const).map((lv) => <button key={lv} className={cls(a.min_level === lv && 'on')} onClick={() => setD({ ...d, action: { ...a, min_level: lv } })}>{SWEEP_LEVEL_LABEL[lv]}</button>)}</div>
                </div>
                <label className="field"><span className="field-label">最少次数</span>
                  <select value={a.min_count} onChange={(e) => setD({ ...d, action: { ...a, min_count: Number(e.target.value) } })}>
                    {[1, 2, 3, 5, 10].map((n) => <option key={n} value={n}>{n === 1 ? '出现过就算' : `至少 ${n} 次`}</option>)}
                  </select>
                </label>
              </div>
              <span className="field-hint-line">到点把满足条件、未处理、还没有任务的运行异常各建一条任务，带 claude-code 标签交给 Claude Code 修；同一条异常不会重复建。结果记在下面的执行记录里</span>
            </>
          )}
          {a.kind === 'sop' && (
            <div className="field"><span className="field-label">执行哪个 SOP</span>
              <SearchSelect variant="field" value={a.sop_id} placeholder="选一个 SOP" searchPlaceholder="搜 SOP" aria-label="执行哪个 SOP"
                options={sops.map((s) => ({ value: s.id, label: s.name }))} missingLabel={() => '已删除的 SOP'}
                onChange={(v) => setD({ ...d, action: { ...a, sop_id: v } })} />
              <span className="field-hint-line">用 SOP 输入字段的默认值执行；流程里的人工检查点照常停下等你</span>
            </div>
          )}
          {a.kind === 'agent' && (
            <>
              <div className="field"><span className="field-label">交给哪个 Agent</span>
                <SearchSelect variant="field" value={a.agent_id} placeholder="选一个 Agent" searchPlaceholder="搜 Agent" aria-label="交给哪个 Agent"
                  options={agents.map((x) => ({ value: x.id, label: x.name, hint: x.enabled === false ? '已停用' : undefined, disabled: x.enabled === false }))}
                  missingLabel={() => '已删除的 Agent'} onChange={(v) => setD({ ...d, action: { ...a, agent_id: v } })} />
              </div>
              <label className="field"><span className="field-label">要它做什么<em>*</em></span>
                <textarea rows={3} value={a.prompt} className={cls(tried && !a.prompt.trim() && 'bad')} placeholder="比如：汇总这周的任务，写成周报草稿" onChange={(e) => setD({ ...d, action: { ...a, prompt: e.target.value } })} />
                <span className="field-hint-line">执行结果在「会话 / 执行记录」里，写操作按 Agent 的权限等你确认</span>
              </label>
            </>
          )}
        </section>
        </>}

        <label className="switch-row">
          <span><span className="field-label">启用</span><span className="switch-hint">{d.enabled && next ? `下次：${whenText(next)}` : '停用后不会自动执行，可以手动执行'}</span></span>
          <span className="switch-line"><input type="checkbox" checked={d.enabled} onChange={(e) => setD({ ...d, enabled: e.target.checked })} /><span className="switch" /></span>
        </label>

        {!creating && (
          <section className="field-group">
            <div className="field-group-title tools-head">
              <span>执行记录<span className="field-hint">{schedule!.history.length} 次</span></span>
              <span className="spacer" />
              <button className="act" disabled={!!errors.length} onClick={() => onRunNow({ ...d, name: d.name.trim() })} title="按当前配置马上跑一次，不影响下次执行时间">立即执行一次</button>
            </div>
            {schedule!.history.length ? (
              <ol className="sched-history">
                {schedule!.history.map((h, i) => {
                  const go = h.ref ? openTask?.(h.ref) : undefined
                  const at = go && h.ref ? h.text.indexOf(h.ref) : -1
                  return (
                  <li key={i} className={cls(!h.ok && 'bad')}>
                    <span className={cls('sched-dot', h.ok ? 'ok' : 'bad')} />
                    <span className="sched-h-text">
                      <span>{at < 0 ? h.text : <>{h.text.slice(0, at)}<button className="link-btn" title="打开这条任务" onClick={go}>{h.ref}</button>{h.text.slice(at + h.ref!.length)}</>}</span>
                      {h.manual && <span className="tag">手动</span>}
                    </span>
                    <time>{timeAgo(h.at)}</time>
                  </li>
                  )
                })}
              </ol>
            ) : <div className="io-empty">还没执行过</div>}
          </section>
        )}
      </div>
      <div className="drawer-foot">
        {confirmDel ? (
          <>
            <span className="danger-text">删除后不再执行，已经建出来的任务保留</span>
            <div className="spacer" />
            <button className="btn btn-ghost" onClick={() => setConfirmDel(false)}>取消</button>
            <button className="btn btn-danger" onClick={onDelete}>删除</button>
          </>
        ) : (
          <>
            {!creating && <button className="btn btn-ghost btn-danger-ghost" onClick={() => setConfirmDel(true)}>删除</button>}
            <div className="spacer" />
            {tried && errors.length > 0 && <span className="field-err">{errors[0]}</span>}
            <button className="btn btn-ghost" onClick={onClose}>取消</button>
            <button className="btn btn-primary" onClick={save}>{creating ? '创建' : '保存'}</button>
          </>
        )}
      </div>
    </aside>
  )
}
