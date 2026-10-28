// 定时任务抽屉（SPEC-tasks-8）：配「什么时候」和「做什么」，下面是执行记录和「立即执行一次」。
// 接下来几次由后端预览（POST /api/schedules/preview）；立即执行按已保存的配置跑，有没保存的改动时先保存再执行。
import { useEffect, useState } from 'react'
import {
  errorText, isApiError, useCreateSchedule, useDeleteSchedule, useDictItems, usePatchSchedule, useRunSchedule, useScheduleRuns,
  useSchedulePreview, useStakeholders, type Schedule, type ScheduleActionKind, type ScheduleFreq, type ScheduleRule,
} from '../../core/data'
import { Button, Drawer, Field, Input, SearchSelect, Select, Textarea, cls, type SearchOption } from '../../core/ui'
import { timeAgo } from './model'
import {
  ACTION_KINDS, ACTION_LABEL, DUE_DAYS, FREQS, FREQ_LABEL, WEEK, WEEK_ORDER, buildScheduleInput, buildSchedulePatch, defaultPriority,
  describeRule, draftErrors, emptyAction, emptyScheduleDraft, ruleError, runTone, scheduleDirty, scheduleDraftOf, whenText,
  type ScheduleDraft,
} from './scheduleModel'

// 优先级字典的 id（/api/dictionaries）
const PRIORITY_DICT = 'priority'
// 改规则时停手多久再去预览
const PREVIEW_DELAY = 300
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
  const clientErr = ruleError(r, now)
  // 规则停手一会儿再预览，cron 一个字一个字敲时不连发
  const [previewRule, setPreviewRule] = useState<ScheduleRule | null>(clientErr ? null : r)
  useEffect(() => {
    const next = clientErr ? null : r
    const id = setTimeout(() => setPreviewRule(next), PREVIEW_DELAY)
    return () => clearTimeout(id)
  }, [r, clientErr])
  const preview = useSchedulePreview(previewRule)
  // 后端校验的说明带着「validation failed:」前缀，去掉只留原因
  const serverErr = previewRule && preview.isError ? `规则不对：${errorText(preview.error).replace(/^validation failed:\s*/, '')}` : ''
  const ruleErr = clientErr || serverErr
  const upcoming = !clientErr && preview.data ? preview.data.next_runs : null

  const errors = draftErrors(d, now)
  const dirty = scheduleDirty(base, d)
  const setRule = (p: Partial<ScheduleRule>) => setD((x) => ({ ...x, rule: { ...x.rule, ...p } }))
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
    ? prioItems.map((p) => ({ value: p.key, label: p.label }))
    : [...prioItems.map((p) => ({ value: p.key, label: p.label })), { value: prio, label: `${prio}（已停用）` }]
  const peopleOpts: SearchOption[] = (people.data ?? []).map((s) => ({ value: s.id, label: s.name, hint: s.role || undefined, keywords: s.email }))
  const nameBad = tried && !d.name.trim()
  const titleBad = tried && a.kind === 'task' && !a.title.trim()
  const history = runs.data ?? []
  const nextText = d.enabled && upcoming?.length ? `下次：${whenText(upcoming[0], now)}` : d.enabled ? '启用后到点自动执行' : '停用后不会自动执行，可以手动执行'

  const body = (
    <div className="form sched-form">
      <Field label="名称" required error={nameBad ? '必填' : undefined}>
        <Input value={d.name} autoFocus={creating} invalid={nameBad} placeholder="比如：周会前整理议程"
          onChange={(e) => setD((x) => ({ ...x, name: e.target.value }))} />
      </Field>

      <section className="field-group" aria-label="什么时候">
        <div className="field-group-title">什么时候</div>
        <div className="seg seg-full sched-freq" role="radiogroup" aria-label="频率">
          {FREQS.map((f: ScheduleFreq) => (
            <button key={f} type="button" role="radio" aria-checked={r.freq === f} className={cls(r.freq === f && 'on')}
              onClick={() => setRule({ freq: f })}>{FREQ_LABEL[f]}</button>
          ))}
        </div>
        {r.freq === 'weekly' && (
          <div className="week-pick" role="group" aria-label="周几">
            {WEEK_ORDER.map((w) => {
              const on = r.weekdays.includes(w)
              return (
                <button key={w} type="button" aria-pressed={on} aria-label={`周${WEEK[w]}`} className={cls('week-day', on && 'on')}
                  onClick={() => setRule({ weekdays: on ? r.weekdays.filter((x) => x !== w) : [...r.weekdays, w].sort() })}>{WEEK[w]}</button>
              )
            })}
          </div>
        )}
        <div className="field-row">
          {r.freq === 'once' && (
            <Field label="日期"><Input type="date" value={r.date} onChange={(e) => setRule({ date: e.target.value })} /></Field>
          )}
          {r.freq === 'monthly' && (
            <Field label="几号">
              <Select value={String(r.day)} onValueChange={(v) => setRule({ day: Number(v) })}
                options={Array.from({ length: 31 }, (_, i) => ({ value: String(i + 1), label: i === 30 ? '31（小月按月底） 号' : `${i + 1} 号` }))} />
            </Field>
          )}
          {r.freq === 'cron' ? (
            <Field label={<>Cron 表达式<span className="field-hint">分 时 日 月 周</span></>}>
              <Input className="mono-input" value={r.cron} placeholder="0 9 * * 1" invalid={!!ruleErr}
                onChange={(e) => setRule({ cron: e.target.value })} />
            </Field>
          ) : (
            <Field label="时间"><Input type="time" value={r.time} onChange={(e) => setRule({ time: e.target.value })} /></Field>
          )}
        </div>
        {ruleErr ? <div className="field-err" role="alert">{ruleErr}</div> : (
          <div className="sched-preview" aria-live="polite">
            <span className="list-sub">{describeRule(r)}，接下来：</span>
            {upcoming ? (upcoming.length
              ? upcoming.map((u) => <span key={u} className="tag">{whenText(u, now)}</span>)
              : <span className="list-sub">不会再执行</span>) : <span className="list-sub">正在算</span>}
          </div>
        )}
      </section>

      <section className="field-group" aria-label="做什么">
        <div className="field-group-title">做什么</div>
        <div className="seg seg-full" role="radiogroup" aria-label="动作类型">
          {ACTION_KINDS.map((k) => {
            // SOP、Agent 的接口 M4 之后才有：没法选，已经是这种类型的照样显示
            const off = k !== 'task' && a.kind !== k
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
      </section>

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
          <span className="danger-text">删除后不再执行，已经建出来的任务保留</span>
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
