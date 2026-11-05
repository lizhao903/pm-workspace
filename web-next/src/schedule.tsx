import { useState } from 'react'
import { SearchSelect } from './searchselect'
import { ListSegHead } from './tasks'
import {
  ACTION_LABEL, INTERVAL_HOURS, RULE_MODES, RULE_MODE_LABEL, SWEEP_LEVEL_LABEL, WEEK, claudeActionError, claudeOutPath, describeRule, emptyRule, intervalCron, intervalOf,
  modeOf, nextRun, nextText, ruleError, sweepText, whenText, withMode, type RuleMode, type Schedule, type ScheduleAction, type ScheduleRule,
} from './scheduledata'
import type { Priority } from './taskdata'
import { useEnumView } from './enumdata'
import { PageTitle } from './topbar'
import { cls, timeAgo } from './ui'
import { newId } from './ids'
import { useRunPresets } from './runpresets'

// 任务 > 定时任务：列表 + 抽屉。抽屉里配「什么时候」和「做什么」，下面是执行记录
// 定时发布由视频的发布记录生成，抽屉里只读：时间去内容日历拖，或在发布记录里改

interface Named { id: string; name: string; enabled?: boolean }

export const actionText = (a: ScheduleAction, sops: Named[], agents: Named[], publishes: Named[] = []) => (a.kind === 'task'
  ? `建任务「${a.title || '未填标题'}」`
  : a.kind === 'remind' ? `提醒「${a.title || '未填标题'}」${a.task_id ? '，关联任务' : ''}`
  : a.kind === 'sop' ? `执行「${sops.find((s) => s.id === a.sop_id)?.name ?? '已删除的 SOP'}」${a.managed ? '，随流程管理' : ''}`
    : a.kind === 'publish' ? `发布「${publishes.find((x) => x.id === a.publish_id)?.name ?? '已删除的发布记录'}」`
      : a.kind === 'incident_sweep' ? `巡检运行异常：${sweepText(a)}，建任务交给 Claude Code`
      : a.kind === 'claude' ? a.prompt || '未填要求'
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
  // 「交给 Claude Code」勾「允许写入」前的确认（同 SPEC-tasks-6.3）
  const [askWrite, setAskWrite] = useState(false)
  const presets = useRunPresets()
  const r = d.rule
  const setKind = (k: ScheduleAction['kind']) => setD({
    ...d, action: k === 'task' ? { kind: 'task', title: '', desc: '', priority: defPrio, assignee: '我', due_days: 0 }
      : k === 'remind' ? { kind: 'remind', title: '', body: '', task_id: '', popup: 'toast' }
      : k === 'sop' ? { kind: 'sop', sop_id: sops[0]?.id ?? '' }
        : k === 'incident_sweep' ? { kind: 'incident_sweep', min_level: 'error', min_count: 1 }
        : k === 'claude' ? { kind: 'claude', workdir: '', prompt: '', preset_id: '', allow_writes: false, out_dir: '' }
          : { kind: 'agent', agent_id: agents.find((a) => a.enabled !== false)?.id ?? '', prompt: '' },
  })
  const a = d.action
  // 定时发布只读：规则跟着发布记录，过了时间也不算错
  const pub = a.kind === 'publish'
  const rErr = pub ? '' : ruleError(r)
  const aErr = a.kind === 'task' ? (!a.title.trim() ? '任务标题必填' : '') : a.kind === 'remind' ? (!a.title.trim() ? '提醒标题必填' : a.title.trim().length > 100 ? '提醒标题最多 100 字' : '') : a.kind === 'sop' ? (!a.sop_id ? '选一个 SOP' : '') : a.kind === 'publish' || a.kind === 'incident_sweep' ? '' : a.kind === 'claude' ? claudeActionError(a) : (!a.agent_id ? '选一个 Agent' : !a.prompt.trim() ? '写一下要它做什么' : '')
  const errors = [!d.name.trim() && '名称必填', rErr, aErr].filter(Boolean) as string[]
  const next = nextRun(r)
  // 随 SOP 流程管理的那条（TSK-0463）：名称跟流程名、动作锁定，规则和启停照常改
  const managed = a.kind === 'sop' && !!a.managed
  const flowName = a.kind === 'sop' ? sops.find((x) => x.id === a.sop_id)?.name ?? '已删除的 SOP' : ''
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
          <input value={d.name} autoFocus={creating} readOnly={pub || managed} className={cls(tried && !d.name.trim() && 'bad')} placeholder="比如：周会前整理议程" onChange={(e) => setD({ ...d, name: e.target.value })} />
          {managed && <span className="field-hint-line">名称跟着 SOP 流程名，改流程名时一起改</span>}
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
          <RuleFields rule={r} onChange={(rule) => setD({ ...d, rule })} />
        </section>

        <section className="field-group">
          <div className="field-group-title">做什么</div>
          {managed ? (
            <>
              <div className="sched-pub"><span className="sched-kind sk-sop">{ACTION_LABEL.sop}</span><span className="ellipsis">{flowName}</span></div>
              <span className="field-hint-line">这条定时跟着 SOP 流程走：规则、启停在这里改和在流程编辑里改是同一条；要换动作或不再定时，到流程编辑里改触发方式。删掉它，流程的触发方式变成「定时，未配置」</span>
            </>
          ) : <>
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
              <fieldset className="sched-popup">
                <legend className="field-label">弹窗方式</legend>
                <div className="sched-popup-opts">
                  {([['toast', '右下角提示', '不挡操作，几条叠在右下角'], ['modal', '中间弹窗', '屏幕中间大号弹出，点「知道了」才关，适合点餐、开会这类不能错过的']] as const).map(([v, label, hint]) => (
                    <label key={v} className={cls('sched-popup-opt', (a.popup ?? 'toast') === v && 'on')}>
                      <input type="radio" name="sched-popup" checked={(a.popup ?? 'toast') === v} onChange={() => setD({ ...d, action: { ...a, popup: v } })} />
                      <span><b>{label}</b><span className="list-sub">{hint}</span></span>
                    </label>
                  ))}
                </div>
              </fieldset>
              <span className="field-hint-line">到点在工作台里弹出提醒，不发到 IM；关联了任务的，点提醒打开这条任务。只提醒一次的到点后自动停用</span>
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
          {a.kind === 'claude' && (() => {
            const role = presets.find((x) => x.id === a.preset_id)
            const ro = role?.permission === 'read_only'
            const wErr = !a.workdir.trim() ? '选一个工作目录' : !a.workdir.trim().startsWith('/') ? '要写本机绝对路径' : ''
            const oErr = a.out_dir.trim().startsWith('/') || a.out_dir.trim().split('/').includes('..') ? '要写工作目录下的相对路径，比如 lists' : ''
            const setA = (p: Partial<typeof a>) => setD({ ...d, action: { ...a, ...p } })
            return (
              <>
                <label className="field"><span className="field-label">工作目录<em>*</em><span className="field-hint">Claude Code 在这里跑</span></span>
                  <input className={cls('mono-input', tried && wErr && 'bad')} value={a.workdir} placeholder="本机绝对路径，比如 /Users/me/pm/fde-feedback" onChange={(e) => setA({ workdir: e.target.value })} />
                  {tried && wErr && <span className="field-err">{wErr}</span>}
                </label>
                <label className="field"><span className="field-label">角色<span className="field-hint">执行要求和输出要求拼进提示词，在「设置 / 角色」里管</span></span>
                  <select value={a.preset_id} onChange={(e) => {
                    const rp = presets.find((x) => x.id === e.target.value)
                    setAskWrite(false)
                    setA({ preset_id: e.target.value, allow_writes: rp ? rp.permission === 'accept_edits' : a.allow_writes })
                  }}>
                    <option value="">不用</option>
                    {presets.map((p) => <option key={p.id} value={p.id}>{p.scene}{p.permission === 'read_only' ? '（只读）' : ''}</option>)}
                    {a.preset_id && !role && <option value={a.preset_id}>已删除的角色</option>}
                  </select>
                </label>
                <label className="field"><span className="field-label">要它做什么<em>*</em><span className="field-hint">可以写 {'{{date}}'}，执行时换成当天日期</span></span>
                  <textarea rows={4} value={a.prompt} className={cls(tried && !a.prompt.trim() && 'bad')} placeholder="比如：从 FDE 反馈表读全部反馈，去重归并成需求清单，写成 {{date}}.md" onChange={(e) => setA({ prompt: e.target.value })} />
                </label>
                <label className="field"><span className="field-label">结果存到<span className="field-hint">工作目录下的相对路径，空为工作目录本身</span></span>
                  <input className={cls('mono-input', oErr && 'bad')} value={a.out_dir} placeholder="比如 lists" onChange={(e) => setA({ out_dir: e.target.value })} />
                  {oErr ? <span className="field-err">{oErr}</span> : !wErr && <span className="field-hint-line">产出写到 <span className="mono">{claudeOutPath(a)}</span>，执行记录里列出每次写了哪些文件</span>}
                </label>
                <div className="dev-perm">
                  <label className="check check-lg">
                    <input type="checkbox" checked={!ro && a.allow_writes} disabled={ro} onChange={(e) => { if (!e.target.checked) { setAskWrite(false); setA({ allow_writes: false }) } else setAskWrite(true) }} />
                    允许写入
                  </label>
                  <span className="list-sub">{ro ? `角色「${role!.scene}」只读：只跑一遍给结论，不写文件` : a.allow_writes ? '会以 acceptEdits 权限模式运行：可以直接改工作目录里的文件' : '默认只读：只跑一遍给结论，不写文件；要存结果得允许写入'}</span>
                  {askWrite && !a.allow_writes && (
                    <div className="dev-perm-ask">
                      <span>允许写入后，每次到点 Claude Code 可以不经确认直接改「{a.workdir.trim() || '工作目录'}」里的文件，没人在旁边看着。其他需要权限的操作仍会被挡下，任何情况下都不会跳过权限确认。</span>
                      <div className="act-row">
                        <button className="act act-warn" onClick={() => { setAskWrite(false); setA({ allow_writes: true }) }}>确认允许写入</button>
                        <button className="act act-quiet" onClick={() => setAskWrite(false)}>算了，只读</button>
                      </div>
                    </div>
                  )}
                </div>
                <span className="field-hint-line">到点在工作目录里无人值守跑一次 Claude Code（同「流式执行」，不开终端、不建任务），最长 30 分钟；需要确认的操作会被挡下。结论和写出的文件记在下面的执行记录里，失败的同时记进运行异常</span>
              </>
            )
          })()}
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
          </>}
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
                      {h.files?.length ? <span className="sched-files">{h.files.map((f) => <span key={f} className="mono" title={f}>{f.split('/').pop()}</span>)}</span> : null}
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
            <span className="danger-text">{managed ? `删除后不再执行，流程「${flowName}」的触发方式变成「定时，未配置」` : '删除后不再执行，已经建出来的任务保留'}</span>
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

/**
 * 定时规则的编辑（「什么时候」）：频率、周几、日期、几号、时间、每隔几小时、Cron，下面是接下来几次。
 * 定时任务抽屉和 SOP 开始节点的「定时」触发（TSK-0463）共用；compact 时频率用下拉（窄的属性面板放不下一排按钮）
 */
export function RuleFields({ rule: r, onChange, count = 3, compact }: { rule: ScheduleRule; onChange: (r: ScheduleRule) => void; count?: number; compact?: boolean }) {
  const set = (p: Partial<ScheduleRule>) => onChange({ ...r, ...p })
  const mode = modeOf(r)
  const iv = intervalOf(r)
  const rErr = ruleError(r)
  // 列出接下来几次，帮人确认规则是不是自己想的那样
  const upcoming = (() => {
    const out: Date[] = []
    let from = new Date()
    for (let i = 0; i < count; i += 1) { const n = nextRun(r, from); if (!n) break; out.push(n); from = new Date(n.getTime() + 60000) }
    return out
  })()
  return (
    <>
      {compact ? (
        <label className="field"><span className="field-label">频率</span>
          <select value={mode} onChange={(e) => onChange(withMode(r, e.target.value as RuleMode))}>
            {RULE_MODES.map((m) => <option key={m} value={m}>{RULE_MODE_LABEL[m]}</option>)}
          </select>
        </label>
      ) : (
        <div className="seg seg-full sched-freq rule-modes">
          {RULE_MODES.map((m) => <button key={m} className={cls(mode === m && 'on')} onClick={() => onChange(withMode(r, m))}>{RULE_MODE_LABEL[m]}</button>)}
        </div>
      )}
      {mode === 'weekly' && (
        <div className="week-pick">
          {[1, 2, 3, 4, 5, 6, 0].map((w) => (
            <button key={w} className={cls('week-day', r.weekdays.includes(w) && 'on')} onClick={() => set({ weekdays: r.weekdays.includes(w) ? r.weekdays.filter((x) => x !== w) : [...r.weekdays, w] })}>{WEEK[w]}</button>
          ))}
        </div>
      )}
      <div className="field-row">
        {mode === 'once' && <label className="field"><span className="field-label">日期</span><input type="date" value={r.date} onChange={(e) => set({ date: e.target.value })} /></label>}
        {mode === 'monthly' && (
          <label className="field"><span className="field-label">几号</span>
            <select value={r.day} onChange={(e) => set({ day: Number(e.target.value) })}>
              {Array.from({ length: 31 }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{n === 31 ? '31（小月按月底）' : n} 号</option>)}
            </select>
          </label>
        )}
        {mode === 'interval' && iv ? (
          <>
            <label className="field"><span className="field-label">每隔</span>
              <select value={iv.hours} onChange={(e) => set({ cron: intervalCron(Number(e.target.value), iv.minute) })}>
                {[...new Set([...INTERVAL_HOURS, iv.hours])].sort((x, y) => x - y).map((h) => <option key={h} value={h}>{h} 小时</option>)}
              </select>
            </label>
            <label className="field"><span className="field-label">在第几分</span>
              <select value={iv.minute} onChange={(e) => set({ cron: intervalCron(iv.hours, Number(e.target.value)) })}>
                {[...new Set([...Array.from({ length: 12 }, (_, i) => i * 5), iv.minute])].sort((x, y) => x - y).map((m) => <option key={m} value={m}>{m ? `${m} 分` : '整点'}</option>)}
              </select>
            </label>
          </>
        ) : mode === 'cron' ? (
          <label className="field"><span className="field-label">Cron 表达式<span className="field-hint">分 时 日 月 周</span></span><input className="mono" value={r.cron} placeholder="0 9 * * 1" onChange={(e) => set({ cron: e.target.value })} /></label>
        ) : (
          <label className="field"><span className="field-label">时间</span><input type="time" value={r.time} onChange={(e) => set({ time: e.target.value })} /></label>
        )}
      </div>
      {mode === 'interval' && <span className="field-hint-line">从 0 点起算，每天在固定的几个整点（或第几分）执行</span>}
      {rErr ? <div className="field-err">{rErr}</div> : (
        <div className="sched-preview">
          <span className="list-sub">{describeRule(r)}，接下来：</span>
          {upcoming.map((u) => <span key={u.toISOString()} className="tag">{whenText(u)}</span>)}
          {!upcoming.length && <span className="list-sub">不会再执行</span>}
        </div>
      )}
    </>
  )
}
