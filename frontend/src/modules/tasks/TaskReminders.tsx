// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 任务抽屉里的「提醒」：这条任务已有的提醒（定时任务动作 remind、object_id 是它），可以取消；「设个提醒」给它建一条只提醒一次的。
// 到点在工作台右下角弹出（外壳的 ReminderPopups），点了打开这条任务。重复的提醒在定时任务页建，这里也列出来、能取消。
import { useState } from 'react'
import {
  errorText, isApiError, useCreateSchedule, useDeleteSchedule, useLastScheduleRuns, useObjectReminders,
  type Schedule, type WorkObject,
} from '../../core/data'
import { Button, Field, Input, Textarea } from '../../core/ui'
import { emptyReminder, reminderError, reminderInput, type ReminderForm } from './reminderModel'
import { describeRule, fullRule, nextCellText } from './scheduleModel'
import './reminders.css'

export function TaskReminders({ task }: { task: WorkObject }) {
  const list = useObjectReminders(task.id)
  const rows = list.data ?? []
  const last = useLastScheduleRuns(rows.map((s) => s.id))
  const create = useCreateSchedule()
  const del = useDeleteSchedule()
  // 「现在」取抽屉打开那一刻
  const [now] = useState(() => new Date())
  const [form, setForm] = useState<ReminderForm | null>(null)
  const [tried, setTried] = useState(false)
  const [error, setError] = useState('')

  const ferr = form ? reminderError(form, now) : ''
  const set = (p: Partial<ReminderForm>) => setForm((f) => (f ? { ...f, ...p } : f))
  const open = () => { setError(''); setTried(false); setForm(emptyReminder(task, now)) }
  const save = async () => {
    if (!form) return
    setTried(true)
    if (ferr) return
    setError('')
    try {
      await create.mutateAsync(reminderInput(task, form, now))
      setForm(null)
    } catch (e) {
      setError(`没设成：${errorText(e).replace(/^validation failed:\s*/, '')}`)
    }
  }
  const cancel = async (s: Schedule) => {
    setError('')
    try {
      await del.mutateAsync(s.id)
    } catch (e) {
      setError(isApiError(e, 'not_found') ? '这条提醒已经没了' : `没取消成：${errorText(e)}`)
    }
  }

  return (
    <section className="field-group task-reminders" aria-label="提醒">
      <div className="mount-head">
        <span className="field-group-title">提醒{rows.length > 0 && <span className="field-hint">{rows.length}</span>}</span>
        <span className="spacer" />
        {!form && <Button size="sm" onClick={open}>设个提醒</Button>}
      </div>
      {list.isError ? (
        <div className="field-err" role="alert">提醒没取到：{errorText(list.error)} <Button size="sm" onClick={() => void list.refetch()}>重试</Button></div>
      ) : rows.length > 0 ? (
        <ul className="task-reminder-list">
          {rows.map((s) => {
            const when = nextCellText(s, last[s.id], now)
            const done = !s.enabled
            return (
              <li key={s.id} className={done ? 'is-off' : undefined}>
                <span className="task-reminder-main">
                  <span className="ellipsis" title={s.action.kind === 'remind' ? s.action.title : s.name}>
                    {s.action.kind === 'remind' ? s.action.title : s.name}
                  </span>
                  <span className="list-sub">{s.rule.freq === 'once' ? when : `${describeRule(fullRule(s.rule, now))}，${s.enabled ? `下次 ${when}` : when}`}</span>
                </span>
                <Button size="sm" variant="danger-ghost" disabled={del.isPending} onClick={() => void cancel(s)}
                  title={done ? '删掉这条提醒' : '取消这条提醒，到点不再弹'}>{done ? '删除' : '取消'}</Button>
              </li>
            )
          })}
        </ul>
      ) : !form && !list.isPending ? <div className="list-sub">还没有提醒。设一个，到点在工作台右下角弹出，点了打开这条任务</div> : null}
      {form && (
        <div className="task-reminder-form">
          <Field label="提醒标题" required error={tried && !form.title.trim() ? '必填' : undefined}>
            <Input value={form.title} autoFocus invalid={tried && !form.title.trim()} onChange={(e) => set({ title: e.target.value })} />
          </Field>
          <div className="field-row">
            <Field label="日期"><Input type="date" aria-label="提醒日期" value={form.date} onChange={(e) => set({ date: e.target.value })} /></Field>
            <Field label="时间"><Input type="time" aria-label="提醒时间" value={form.time} onChange={(e) => set({ time: e.target.value })} /></Field>
          </div>
          <Field label="内容" hint="可以不填，不填就显示任务标题">
            <Textarea rows={2} value={form.body} onChange={(e) => set({ body: e.target.value })} />
          </Field>
          <div className="task-reminder-acts">
            <span className="list-sub">只提醒一次，到点后自动停用；要重复提醒去定时任务页建</span>
            <span className="spacer" />
            <Button size="sm" onClick={() => { setForm(null); setError('') }}>算了</Button>
            <Button size="sm" variant="primary" disabled={create.isPending} onClick={() => void save()}>设好了</Button>
          </div>
          {tried && ferr && <div className="field-err" role="alert">{ferr}</div>}
        </div>
      )}
      {error && <div className="field-err" role="alert">{error}</div>}
    </section>
  )
}
