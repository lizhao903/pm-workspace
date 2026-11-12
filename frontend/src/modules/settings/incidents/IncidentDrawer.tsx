// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 运行异常抽屉（SPEC-settings-19），照原型 web-next/src/incidents.tsx IncidentDrawer：
// 现象、上下文、时间线，转研发任务（POST /api/incidents/{id}/task）、忽略、标为已解决、重新打开（PATCH {status}）。
import { useState } from 'react'
import { useNavigate } from 'react-router'
import {
  INCIDENT_STATUS, errorText, useDictItems, useIncidentToTask, useObject, useSetIncidentStatus, useStakeholders, type Incident, type IncidentStatus,
} from '../../../core/data'
import { Button, Drawer, Field, Input, Pill, SearchSelect, Textarea, cls, prioText, type SearchOption } from '../../../core/ui'
import { timeAgo } from '../providers/model'
import { LEVEL_LABEL, levelPriority, taskDesc, taskTitle } from './model'

// 优先级字典的 id（/api/dictionaries）
const PRIORITY_DICT = 'priority'
const ago = (iso: string) => timeAgo(Date.parse(iso))

export function IncidentDrawer({ incident: x, doneStatus, onClose }: {
  incident: Incident
  /** 任务的「已完成」状态 key；任务完成了而异常没解决时提示去标为已解决 */
  doneStatus?: string
  onClose: () => void
}) {
  const navigate = useNavigate()
  const prios = useDictItems(PRIORITY_DICT)
  const people = useStakeholders()
  const task = useObject(x.task_id)
  const setStatus = useSetIncidentStatus()
  const toTask = useIncidentToTask()
  const [making, setMaking] = useState(false)
  const [draft, setDraft] = useState(() => ({ title: taskTitle(x), body: taskDesc(x), priority: '', assignee: '' }))
  const [showCtx, setShowCtx] = useState(true)
  const [err, setErr] = useState('')

  const ctx = Object.entries(x.context ?? {})
  const prio = draft.priority || levelPriority(x, prios.data ?? [])
  const prioItems = (prios.data ?? []).filter((p) => !p.archived_at || p.key === prio)
  const prioOpts = prioItems.some((p) => p.key === prio) ? prioItems : [...prioItems, { key: prio, label: prio } as (typeof prioItems)[number]]
  const peopleOpts: SearchOption[] = (people.data ?? []).filter((s) => !s.archived_at).map((s) => ({ value: s.id, label: s.name, hint: s.role || undefined, keywords: s.email }))
  const busy = setStatus.isPending || toTask.isPending
  const t = task.data

  const changeStatus = (status: IncidentStatus) => {
    setErr('')
    setStatus.mutate({ id: x.id, status }, { onError: (e) => setErr(`没改成：${errorText(e)}`) })
  }
  // 建任务失败表单不收起，红字写原因（SPEC-settings-19.18）
  const submit = () => {
    if (!draft.title.trim() || busy) return
    setErr('')
    toTask.mutate({
      id: x.id,
      input: { title: draft.title.trim(), body: draft.body, priority: prio || undefined, assignee_id: draft.assignee || undefined },
    }, { onSuccess: () => setMaking(false), onError: (e) => setErr(`没建成任务：${errorText(e)}`) })
  }

  const live = x.status === 'open' || x.status === 'tasked'
  return (
    <Drawer open onClose={onClose} kicker="运行异常" aria-label={`运行异常 ${x.title}`} dirty={making && draft.title !== taskTitle(x)}
      dirtyMessage="转任务的表单还没提交，关闭后会丢掉。"
      footer={live ? (
        <>
          {x.status === 'open' && <Button disabled={busy} onClick={() => changeStatus('ignored')}>忽略</Button>}
          <span className="spacer" />
          {err && <span className="inc-err" role="alert">{err}</span>}
          <Button variant="outline" disabled={busy} onClick={() => changeStatus('resolved')}>标为已解决</Button>
          {!x.task_id && !making && <Button variant="primary" disabled={busy} onClick={() => { setErr(''); setMaking(true) }}>转为研发任务</Button>}
        </>
      ) : (
        <>
          <span className="inc-muted">{x.status === 'ignored' ? '已忽略：再次出现时会重新打开' : '已解决：再次出现时会重新打开'}</span>
          <span className="spacer" />
          {err && <span className="inc-err" role="alert">{err}</span>}
          <Button variant="outline" disabled={busy} onClick={() => changeStatus(x.task_id ? 'tasked' : 'open')}>重新打开</Button>
        </>
      )}>
      <div className="inc-form">
        <div className="inc-head">
          <span className={cls('inc-level big', `il-${x.level}`)} aria-hidden="true" />
          <div className="inc-head-text">
            <h2>{x.title}</h2>
            <div className="inc-muted">{x.module} · {LEVEL_LABEL[x.level]} · 共 {x.count} 次 · 首次 {ago(x.first_at)}，最近 {ago(x.last_at)}</div>
          </div>
          <Pill {...INCIDENT_STATUS[x.status]} />
        </div>
        {x.note && <div className="inc-note">{x.note}</div>}
        <div className="inc-msg">{x.message}</div>

        {x.task_id ? (
          <section className="inc-group-box" aria-label="已转为研发任务">
            <div className="inc-box-head">
              <span className="inc-box-title">已转为研发任务</span>
              <span className="inc-muted ellipsis">{t ? `${t.ref} ${t.title}` : task.isError ? '任务没取到' : '加载中'}</span>
              <span className="spacer" />
              <Button size="sm" onClick={() => void navigate(`/tasks?t=${encodeURIComponent(x.task_id!)}`)}>打开任务</Button>
            </div>
            {(x.task_done || (t && doneStatus && t.status === doneStatus)) && x.status !== 'resolved' && (
              <div className="inc-act-row">
                <span className="inc-muted">任务已经完成了，确认问题不再出现就可以标为已解决</span>
                <Button size="sm" variant="primary" disabled={busy} onClick={() => changeStatus('resolved')}>标为已解决</Button>
              </div>
            )}
          </section>
        ) : making ? (
          <section className="inc-group-box" aria-label="转为研发任务">
            <div className="inc-box-title">转为研发任务<span className="inc-hint">描述里已经带上现象、频率、上下文和报错，研发拿到就能查</span></div>
            <Field label="标题" required error={!draft.title.trim() ? '必填' : undefined}>
              <Input value={draft.title} invalid={!draft.title.trim()} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
            </Field>
            <Field label="描述"><Textarea rows={8} className="inc-code" value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} /></Field>
            <div className="field-row">
              <Field label={<>优先级<span className="inc-hint">按级别和次数预填</span></>} wrap={false}>
                <div className="inc-seg inc-seg-full" role="radiogroup" aria-label="优先级">
                  {prioOpts.map((p) => (
                    <button key={p.key} type="button" role="radio" aria-checked={prio === p.key} className={cls(prio === p.key && 'on')}
                      onClick={() => setDraft({ ...draft, priority: p.key })}>{prioText(p.key, p)}</button>
                  ))}
                </div>
              </Field>
              <Field label="负责人" wrap={false}>
                <SearchSelect variant="field" aria-label="负责人" value={draft.assignee} noneLabel="未分配" placeholder="未分配"
                  searchPlaceholder="搜干系人" options={peopleOpts} emptyText={people.isPending ? '加载中' : '名册里还没有人'}
                  onChange={(v) => setDraft({ ...draft, assignee: v })} />
              </Field>
            </div>
            <div className="inc-act-row">
              <Button variant="primary" disabled={!draft.title.trim() || busy} onClick={submit}>{toTask.isPending ? '建任务中' : '建任务'}</Button>
              <Button disabled={busy} onClick={() => { setMaking(false); setErr('') }}>取消</Button>
            </div>
          </section>
        ) : null}

        {(x.stack || ctx.length > 0) && (
          <section className="inc-group-box" aria-label="上下文与报错">
            <div className="inc-box-head">
              <span className="inc-box-title">上下文与报错</span>
              <span className="spacer" />
              <Button size="sm" onClick={() => setShowCtx(!showCtx)}>{showCtx ? '收起' : '展开'}</Button>
            </div>
            {showCtx && (
              <>
                {ctx.length > 0 && (
                  <dl className="inc-ctx">
                    {ctx.map(([k, v]) => (
                      <div key={k} className="inc-ctx-row">
                        <dt>{k}</dt>
                        <dd>{v !== null && typeof v === 'object' ? <pre className="inc-json">{JSON.stringify(v, null, 2)}</pre> : String(v)}</dd>
                      </div>
                    ))}
                  </dl>
                )}
                {x.stack && <pre className="inc-stack">{x.stack}</pre>}
              </>
            )}
          </section>
        )}

        <section className="inc-group-box" aria-label="最近发生">
          <div className="inc-box-title">最近发生<span className="inc-hint">最多显示 20 次</span></div>
          <div className="inc-times">
            {(x.occurrences ?? []).map((at, i) => <span key={i} className="tag" title={new Date(at).toLocaleString('zh-CN')}>{ago(at)}</span>)}
          </div>
        </section>
      </div>
    </Drawer>
  )
}
