// 定时任务抽屉（SPEC-tasks-8）：配「什么时候」和「做什么」，下面是执行记录和「立即执行一次」。
// 接下来几次由后端预览（POST /api/schedules/preview）；立即执行按已保存的配置跑，有没保存的改动时先保存再执行。
// 视频发布动作（SPEC-videos-15.13）跟着发布记录走：名称和规则只读，两段换成「发布哪条」，不预览也不校验规则。
import { useState } from 'react'
import { useNavigate } from 'react-router'
import {
  errorText, isApiError, useCreateSchedule, useDeleteSchedule, useDictItems, useObject, usePatchSchedule, useRunSchedule, useScheduleRuns,
  useSopFlows, useStakeholders, useVideoPlatforms, useVideoPublishes, type Schedule, type ScheduleActionKind, type ScheduleRule,
} from '../../core/data'
import { Button, Drawer, Field, Input, ScheduleRuleFields, SearchSelect, Select, Textarea, cls, useRuleCheck, type SearchOption } from '../../core/ui'
import { prioText, timeAgo } from './model'
import {
  ACTION_KINDS, ACTION_LABEL, DUE_DAYS, REMIND_BODY_MAX, REMIND_TITLE_MAX, SWEEP_COUNTS, SWEEP_LEVEL_LABEL, buildScheduleInput, buildSchedulePatch, defaultPriority,
  actionLabel, describeRule, draftErrors, emptyAction, emptyScheduleDraft, isManagedSop, isPluginAction, publishIdOf, publishName, runTone, scheduleDirty, scheduleDraftOf, whenText,
  type ActionNames, type ScheduleDraft,
} from './scheduleModel'

// 优先级字典的 id（/api/dictionaries）
const PRIORITY_DICT = 'priority'
// 抽屉开着时多久重取一次执行记录（调度器到点执行不发事件）
const RUNS_POLL_MS = 15_000

/** 建任务类没选优先级时填默认值 */
function withPrio(d: ScheduleDraft, def: string): ScheduleDraft {
  return d.action.kind === 'task' && !d.action.priority && def ? { ...d, action: { ...d.action, priority: def } } : d
}

export function ScheduleDrawer({ schedule, onClose, onCreated, onOpenTask }: {
  /** null 表示新建 */
  schedule: Schedule | null
  onClose: () => void
  /** 新建成功后切到这条定时任务 */
  onCreated: (s: Schedule) => void
  /** 执行记录里点建出的任务编号 */
  onOpenTask?: (objectId: string) => void
}) {
  const creating = !schedule
  const prios = useDictItems(PRIORITY_DICT)
  const people = useStakeholders()
  // 「现在」取抽屉打开那一刻，渲染里不直接 new Date()
  const [now] = useState(() => new Date())
  const [base, setBase] = useState<ScheduleDraft>(() =>
    schedule ? scheduleDraftOf(schedule, prios.data ?? [], now) : emptyScheduleDraft(prios.data ?? [], now))
  const [d, setD] = useState<ScheduleDraft>(base)
  const [tried, setTried] = useState(false)
  const [confirmDel, setConfirmDel] = useState(false)
  const [error, setError] = useState('')

  // 优先级没选时按字典的默认值（字典可能晚于抽屉到达），提交时再填进去
  const defPrio = defaultPriority(prios.data ?? [])
  const prio = d.action.priority || defPrio

  const create = useCreateSchedule()
  const patch = usePatchSchedule()
  const del = useDeleteSchedule()
  const run = useRunSchedule()
  const runs = useScheduleRuns(schedule?.id ?? null, { refetchInterval: RUNS_POLL_MS })
  const busy = create.isPending || patch.isPending || del.isPending || run.isPending

  const r = d.rule
  const a = d.action
  const navigate = useNavigate()
  // 视频发布动作（VID-06d）的发布记录，抽屉里给跳转；这种定时名称、规则只读（SPEC-videos-15.13）
  const pubId = schedule ? publishIdOf(schedule.action) : undefined
  const locked = (schedule?.action.kind as string | undefined) === 'video_publish'
  const pubs = useVideoPublishes({ enabled: !!pubId })
  const plats = useVideoPlatforms({ enabled: !!pubId })
  const pubNames: ActionNames = pubs.data
    ? { publishes: Object.fromEntries(pubs.data.map((p) => [p.id, `${plats.data?.find((x) => x.key === p.platform)?.label ?? p.platform} · ${p.title || '未填标题'}`])) }
    : {}
  // 随 SOP 流程管理的那一条（TSK-0463）：动作跟着流程，这里只能改名称、规则、启停
  const managed = !!schedule && isManagedSop(schedule.action)
  const flows = useSopFlows({ enabled: managed })
  const flowName = managed ? flows.data?.find((f) => f.id === a.sop_id)?.name : undefined
  // 只读的规则不在前端校验：已发出去的一次性定时时间早过了，照样要能停用、立即执行
  const check = useRuleCheck(r, { now, off: locked })
  const serverErr = check.serverError
  const upcoming = check.upcoming

  const errors = locked ? [] : draftErrors(d, now)
  const dirty = scheduleDirty(base, d)
  const setRule = (rule: ScheduleRule) => setD((x) => ({ ...x, rule }))
  const setAction = (p: Partial<ScheduleDraft['action']>) => setD((x) => ({ ...x, action: { ...x.action, ...p } }))
  // 切换动作类型时清空该动作的字段（SPEC-tasks-8.7）
  const setKind = (k: ScheduleActionKind) => setD((x) => (x.action.kind === k ? x : { ...x, action: emptyAction(k, defPrio) }))

  // 保存：新建切到查看状态，编辑后留在抽屉里，基准换成保存后的值
  const persist = async (): Promise<Schedule | null> => {
    if (!schedule) {
      const s = await create.mutateAsync(buildScheduleInput(withPrio(d, defPrio)))
      onCreated(s)
      return s
    }
    const p = buildSchedulePatch(base, withPrio(d, defPrio))
    if (!Object.keys(p).length) return schedule
    const s = await patch.mutateAsync({ id: schedule.id, patch: p })
    const next = scheduleDraftOf(s, prios.data ?? [], now)
    setBase(next)
    setD(next)
    return s
  }
  const save = async () => {
    setTried(true)
    if (errors.length || serverErr) return
    setError('')
    try { await persist() } catch (e) { setError(`没保存成功：${errorText(e)}`) }
  }
  const runNow = async () => {
    if (!schedule) return
    setTried(true)
    if (errors.length || serverErr) return
    setError('')
    try {
      if (dirty) await persist()
      await run.mutateAsync(schedule.id)
    } catch (e) {
      setError(`没执行成功：${errorText(e)}`)
    }
  }
  const remove = async () => {
    if (!schedule) return
    try {
      await del.mutateAsync(schedule.id)
      onClose()
    } catch (e) {
      setConfirmDel(false)
      setError(isApiError(e, 'not_found') ? '这条定时任务已经被删掉了' : `没删除成功：${errorText(e)}`)
    }
  }

  const prioItems = (prios.data ?? []).filter((p) => !p.archived_at || p.key === prio)
  const prioOpts = prioItems.some((p) => p.key === prio) || !prio
    ? prioItems.map((p) => ({ value: p.key, label: prioText(p.key, p) }))
    : [...prioItems.map((p) => ({ value: p.key, label: prioText(p.key, p) })), { value: prio, label: `${prio}（已停用）` }]
  const peopleOpts: SearchOption[] = (people.data ?? []).map((s) => ({ value: s.id, label: s.name, hint: s.role || undefined, keywords: s.email }))
  const nameBad = tried && !d.name.trim()
  const titleBad = tried && (a.kind === 'task' || a.kind === 'remind') && !a.title.trim()
  const history = runs.data ?? []
  const nextText = d.enabled && upcoming?.length ? `下次：${whenText(upcoming[0], now)}` : d.enabled ? '启用后到点自动执行' : '停用后不会自动执行，可以手动执行'

  const body = (
    <div className="form sched-form">
      {managed ? (
        <Field label="名称" hint="名称跟着 SOP 流程名，改流程名时一起改" wrap={false}>
          <div className="sched-readonly">{d.name}</div>
        </Field>
      ) : locked ? (
        <Field label="名称" hint="名称跟着发布记录生成，这里不能改" wrap={false}>
          <div className="sched-readonly">{d.name}</div>
        </Field>
      ) : (
        <Field label="名称" required error={nameBad ? '必填' : undefined}>
          <Input value={d.name} autoFocus={creating} invalid={nameBad} placeholder="比如：周会前整理议程"
            onChange={(e) => setD((x) => ({ ...x, name: e.target.value }))} />
        </Field>
      )}

      {locked ? (
        <section className="field-group" aria-label="发布哪条">
          <div className="field-group-title">发布哪条</div>
          <div className="sched-pub-name">{pubId ? publishName(pubId, pubNames) : '未选发布记录'}</div>
          <div className="list-sub">{describeRule(r)}，{d.enabled ? `下次：${whenText(schedule?.next_run_at, now)}` : '已停用，不会自动执行'}</div>
          <div className="list-sub">这条定时跟着视频的发布记录走：改时间在内容日历里拖，或者在发布记录里改；到点按发布记录发，失败的记进运行异常</div>
          <div className="sched-plugin-acts">
            {pubId && <Button size="sm" onClick={() => void navigate(`/videos/publishes?p=${encodeURIComponent(pubId)}`)}>打开发布记录</Button>}
            <Button size="sm" onClick={() => void navigate('/videos/calendar')}>去内容日历</Button>
          </div>
        </section>
      ) : (
        <>
        <section className="field-group" aria-label="什么时候">
          <div className="field-group-title">什么时候</div>
          <ScheduleRuleFields rule={r} onChange={setRule} check={check} now={now} />
        </section>

        <section className="field-group" aria-label="做什么">
          <div className="field-group-title">做什么</div>
          {managed ? (
            <>
              <div className="sched-pub-name">执行 SOP「{flowName ?? a.sop_id}」</div>
              <div className="list-sub">这条定时跟着 SOP 流程走：名称跟流程名，规则、启停在这里改和在流程编辑里改是同一条；要换动作或不再定时，到流程编辑里改触发方式。删掉它，流程的触发方式变成「定时，未配置」</div>
              <div className="sched-plugin-acts">
                <Button size="sm" onClick={() => void navigate(`/sop/flows/${encodeURIComponent(a.sop_id)}`)}>打开流程</Button>
              </div>
            </>
          ) : (
          <>
          <div className="seg seg-full" role="radiogroup" aria-label="动作类型">
            {ACTION_KINDS.map((k) => {
              // SOP、Agent 的接口 M4 之后才有：没法选，已经是这种类型的照样显示；运行异常巡检是内核动作（INC-01b），能选
              const off = (k === 'sop' || k === 'agent') && a.kind !== k
              return (
                <button key={k} type="button" role="radio" aria-checked={a.kind === k} className={cls(a.kind === k && 'on')} disabled={off}
                  title={off ? 'SOP、Agent 的接口 M4 之后才有，现在只能建任务' : undefined} onClick={() => setKind(k)}>{ACTION_LABEL[k]}</button>
              )
            })}
          </div>
          {a.kind === 'task' && (
            <>
              <Field label={<>任务标题<span className="field-hint">可以写 {'{{date}}'}，执行时换成当天日期</span></>} required
                error={titleBad ? '必填' : undefined}>
                <Input value={a.title} invalid={titleBad} placeholder="比如：整理 {{date}} 周会议程" onChange={(e) => setAction({ title: e.target.value })} />
              </Field>
              <Field label="描述"><Textarea rows={2} value={a.desc} onChange={(e) => setAction({ desc: e.target.value })} /></Field>
              <div className="field-row">
                <Field label="优先级">
                  <Select value={prio} options={prioOpts} onValueChange={(v) => setAction({ priority: v })} />
                </Field>
                <Field label="负责人" wrap={false}>
                  <SearchSelect variant="field" aria-label="负责人" value={a.assignee} noneLabel="不指定" placeholder="不指定"
                    searchPlaceholder="搜干系人" options={peopleOpts} emptyText={people.isPending ? '加载中' : '名册里还没有人'}
                    missingLabel={() => '已归档的干系人'} onChange={(v) => setAction({ assignee: v })} />
                </Field>
                <Field label="截止">
                  <Select value={String(a.due_days)} onValueChange={(v) => setAction({ due_days: Number(v) })}
                    options={[...new Set([...DUE_DAYS, a.due_days])].sort((x, y) => x - y)
                      .map((n) => ({ value: String(n), label: n === 0 ? '当天' : `${n} 天后` }))} />
                </Field>
              </div>
            </>
          )}
          {a.kind === 'sop' && (
            <Field label="执行哪个 SOP" hint="SOP 的接口 M4 之后才有，现在到点只记一条「暂不支持」">
              <Input className="mono-input" value={a.sop_id} placeholder="SOP 编号" onChange={(e) => setAction({ sop_id: e.target.value })} />
            </Field>
          )}
          {a.kind === 'incident_sweep' && (
            <>
              <div className="field-row">
                <Field label="最低级别" wrap={false}>
                  <div className="seg seg-full" role="radiogroup" aria-label="最低级别">
                    {(['error', 'warn'] as const).map((lv) => (
                      <button key={lv} type="button" role="radio" aria-checked={a.min_level === lv} className={cls(a.min_level === lv && 'on')}
                        onClick={() => setAction({ min_level: lv })}>{SWEEP_LEVEL_LABEL[lv]}</button>
                    ))}
                  </div>
                </Field>
                <Field label="最少次数">
                  <Select value={String(a.min_count)} onValueChange={(v) => setAction({ min_count: Number(v) })}
                    options={[...new Set([...SWEEP_COUNTS, a.min_count])].sort((x, y) => x - y).map((n) => ({ value: String(n), label: n === 1 ? '出现过就算' : `至少 ${n} 次` }))} />
                </Field>
              </div>
              <div className="list-sub">到点把满足条件、未处理、还没有任务的运行异常各建一条任务，带 claude-code 标签交给 Claude Code 修；同一条异常不会重复建。结果记在下面的执行记录里</div>
            </>
          )}
          {a.kind === 'remind' && <RemindFields title={a.title} body={a.body} objectId={a.object_id} popup={a.popup} titleBad={titleBad} dirty={dirty}
            onChange={setAction} onOpenTask={onOpenTask} />}
          {isPluginAction(a.kind) && <div className="list-sub">{actionLabel(a.kind)}：这种动作由插件登记，这里只读</div>}
          {a.kind === 'agent' && (
            <>
              <Field label="交给哪个 Agent" hint="Agent 的接口 M4 之后才有，现在到点只记一条「暂不支持」">
                <Input className="mono-input" value={a.agent_id} placeholder="Agent 编号" onChange={(e) => setAction({ agent_id: e.target.value })} />
              </Field>
              <Field label="要它做什么" required error={tried && !a.prompt.trim() ? '必填' : undefined}>
                <Textarea rows={3} value={a.prompt} invalid={tried && !a.prompt.trim()} placeholder="比如：汇总这周的任务，写成周报草稿"
                  onChange={(e) => setAction({ prompt: e.target.value })} />
              </Field>
            </>
          )}
          </>
          )}
        </section>
        </>
      )}

      <label className="switch-row">
        <span><span className="field-label">启用</span><span className="switch-hint">{nextText}</span></span>
        <span className="switch-line">
          <input type="checkbox" aria-label="启用" checked={d.enabled} onChange={(e) => { const on = e.target.checked; setD((x) => ({ ...x, enabled: on })) }} />
          <span className="switch" aria-hidden="true" />
        </span>
      </label>

      {schedule && (
        <section className="field-group" aria-label="执行记录">
          <div className="field-group-title tools-head">
            <span>执行记录{runs.data && <span className="field-hint">{history.length >= 50 ? '最近 50 次' : `${history.length} 次`}</span>}</span>
            <span className="spacer" />
            <Button size="sm" disabled={busy || errors.length > 0 || !!serverErr} onClick={() => void runNow()}
              title={dirty ? '先保存这些改动，再按保存后的配置马上跑一次，不影响下次执行时间' : '按当前配置马上跑一次，不影响下次执行时间'}>
              {run.isPending ? '执行中' : dirty ? '保存并执行一次' : '立即执行一次'}
            </Button>
          </div>
          {runs.isError ? (
            <div className="field-err" role="alert">执行记录没取到：{errorText(runs.error)} <Button size="sm" onClick={() => void runs.refetch()}>重试</Button></div>
          ) : runs.isPending ? <div className="sched-empty">加载中</div> : history.length ? (
            <ol className="sched-history">
              {history.map((h) => {
                const tone = runTone(h)
                const at = h.ref && h.object_id && onOpenTask ? h.text.indexOf(h.ref) : -1
                return (
                  <li key={h.id} className={cls(tone === 'bad' && 'bad')}>
                    <span className={cls('sched-dot', tone)} aria-hidden="true" />
                    <span className="sched-h-text">
                      <span>{at < 0 ? h.text : (
                        <>
                          {h.text.slice(0, at)}
                          <button type="button" className="link-btn" disabled={dirty}
                            title={dirty ? '先保存或放弃改动再打开任务' : '打开这条任务'}
                            onClick={() => onOpenTask?.(h.object_id!)}>{h.ref}</button>
                          {h.text.slice(at + h.ref!.length)}
                        </>
                      )}</span>
                      {h.manual && <span className="tag">手动</span>}
                    </span>
                    <time dateTime={h.at} title={new Date(h.at).toLocaleString()}>{timeAgo(h.at)}</time>
                  </li>
                )
              })}
            </ol>
          ) : <div className="sched-empty">还没执行过</div>}
        </section>
      )}
    </div>
  )

  return (
    <Drawer open onClose={onClose} dirty={dirty} kicker={creating ? '新建定时任务' : '定时任务'}
      aria-label={creating ? '新建定时任务' : `定时任务 ${schedule.name}`}
      dirtyMessage="有未保存的修改，关闭后会丢掉。"
      footer={(requestClose) => confirmDel ? (
        <>
          <span className="danger-text">{managed ? `删除后不再执行，流程「${flowName ?? a.sop_id}」的触发方式变成「定时，未配置」` : '删除后不再执行，已经建出来的任务保留'}</span>
          <span className="spacer" />
          <Button onClick={() => setConfirmDel(false)}>取消</Button>
          <Button variant="danger" disabled={del.isPending} onClick={() => void remove()}>删除</Button>
        </>
      ) : (
        <>
          {schedule && <Button variant="danger-ghost" disabled={busy} onClick={() => { setError(''); setConfirmDel(true) }}>删除</Button>}
          <span className="spacer" />
          {error ? <span className="field-err task-save-err" role="alert">{error}</span>
            : tried && (errors[0] || serverErr) ? <span className="field-err task-save-err" role="alert">{errors[0] || serverErr}</span> : null}
          <Button onClick={requestClose}>取消</Button>
          <Button variant="primary" disabled={busy} onClick={() => void save()}>{creating ? '创建' : '保存'}</Button>
        </>
      )}>
      {body}
    </Drawer>
  )
}

/** 提醒的两种弹窗方式（SPEC-tasks-8.26） */
const POPUP_OPTS: { value: 'toast' | 'modal'; label: string; hint: string }[] = [
  { value: 'toast', label: '右下角提示', hint: '不挡操作，几条叠在右下角' },
  { value: 'modal', label: '中间弹窗', hint: '屏幕中间大号弹出，点「知道了」才关，适合点餐、开会这类不能错过的' },
]

/** 动作「提醒」：标题、内容，关联了任务时显示是哪条（任务抽屉里「设个提醒」建的），可以解除关联 */
function RemindFields({ title, body, objectId, popup, titleBad, dirty, onChange, onOpenTask }: {
  title: string
  body: string
  objectId: string
  popup: 'toast' | 'modal'
  titleBad: boolean
  dirty: boolean
  onChange: (p: { title?: string; body?: string; object_id?: string; popup?: 'toast' | 'modal' }) => void
  onOpenTask?: (objectId: string) => void
}) {
  const task = useObject(objectId || null)
  const gone = !!objectId && (isApiError(task.error, 'not_found') || !!task.data?.deleted_at)
  return (
    <>
      <Field label="提醒标题" required error={titleBad ? '必填' : title.trim().length > REMIND_TITLE_MAX ? `最多 ${REMIND_TITLE_MAX} 字` : undefined}>
        <Input value={title} invalid={titleBad} placeholder="比如：给客户回电话" onChange={(e) => onChange({ title: e.target.value })} />
      </Field>
      <Field label="内容" hint={body.trim().length > REMIND_BODY_MAX ? `最多 ${REMIND_BODY_MAX} 字` : '可以不填；关联了任务时不填就显示任务标题'}>
        <Textarea rows={2} value={body} onChange={(e) => onChange({ body: e.target.value })} />
      </Field>
      {objectId && (
        <div className="sched-remind-obj">
          <span className="list-sub">关联任务：</span>
          {gone ? <span className="danger-text">已删除的任务</span>
            : task.data ? (
              <button type="button" className="link-btn" disabled={dirty || !onOpenTask} title={dirty ? '先保存或放弃改动再打开任务' : '打开这条任务'}
                onClick={() => onOpenTask?.(objectId)}>{task.data.ref} {task.data.title}</button>
            ) : <span className="list-sub">{objectId}</span>}
          <span className="spacer" />
          <Button size="sm" onClick={() => onChange({ object_id: '' })}>解除关联</Button>
        </div>
      )}
      <fieldset className="sched-popup">
        <legend className="field-label">弹窗方式</legend>
        <div className="sched-popup-opts">
          {POPUP_OPTS.map((o) => (
            <label key={o.value} className={`sched-popup-opt${popup === o.value ? ' on' : ''}`}>
              <input type="radio" name="sched-popup" value={o.value} checked={popup === o.value} onChange={() => onChange({ popup: o.value })} />
              <span>
                <b>{o.label}</b>
                <span className="list-sub">{o.hint}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <div className="list-sub">到点在工作台里弹出提醒，不发到 IM；关联了任务的，点提醒打开这条任务。只提醒一次的到点后自动停用</div>
    </>
  )
}
