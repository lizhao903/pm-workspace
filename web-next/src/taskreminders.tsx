import { useState } from 'react'
import { describeRule, emptyRule, nextText, ruleError, type Schedule } from './scheduledata'
import type { Task } from './taskdata'
import { cls } from './ui'
import './reminders.css'

// 任务抽屉里的「提醒」（SPEC-tasks-4.30 到 4.34）：这条任务已有的提醒（定时任务动作 remind、关联它），可以取消；
// 「设个提醒」建一条只提醒一次的，标题默认任务标题。到点在右下角弹出（App 的 ReminderPopups），点了打开这条任务。

export interface ReminderForm { title: string; body: string; date: string; time: string }

export function TaskReminders({ task, list, onAdd, onCancel }: {
  task: Task
  /** 关联这条任务的提醒 */
  list: Schedule[]
  onAdd: (f: ReminderForm) => void
  onCancel: (id: string) => void
}) {
  const [form, setForm] = useState<ReminderForm | null>(null)
  const [tried, setTried] = useState(false)
  const set = (p: Partial<ReminderForm>) => setForm((f) => (f ? { ...f, ...p } : f))
  const err = form ? (!form.title.trim() ? '提醒标题必填' : form.title.trim().length > 100 ? '提醒标题最多 100 字'
    : ruleError({ ...emptyRule(), freq: 'once', date: form.date, time: form.time })) : ''
  const open = () => {
    setTried(false)
    setForm({ title: task.title.trim().slice(0, 100), body: '', date: emptyRule().date, time: '09:00' })
  }
  const save = () => {
    setTried(true)
    if (!form || err) return
    onAdd(form)
    setForm(null)
  }
  return (
    <section className="dev-sec task-reminders">
      <div className="mount-head">
        <span className="field-group-title">提醒{list.length > 0 && <span className="field-hint">{list.length}</span>}</span>
        {!form && <button className="act" onClick={open}>设个提醒</button>}
      </div>
      {list.length > 0 ? (
        <ul className="task-reminder-list">
          {list.map((s) => {
            const when = nextText(s)
            const title = s.action.kind === 'remind' ? s.action.title : s.name
            return (
              <li key={s.id} className={cls(!s.enabled && 'is-off')}>
                <span className="task-reminder-main">
                  <span className="ellipsis" title={title}>{title}</span>
                  <span className="list-sub">{s.rule.freq === 'once' ? when : `${describeRule(s.rule)}，${s.enabled ? `下次 ${when}` : when}`}</span>
                </span>
                <button className="act act-quiet" title={s.enabled ? '取消这条提醒，到点不再弹' : '删掉这条提醒'} onClick={() => onCancel(s.id)}>{s.enabled ? '取消' : '删除'}</button>
              </li>
            )
          })}
        </ul>
      ) : !form && <div className="mount-empty">还没有提醒。设一个，到点在工作台右下角弹出，点了打开这条任务</div>}
      {form && (
        <div className="task-reminder-form">
          <label className="field">
            <span className="field-label">提醒标题<em>*</em></span>
            <input value={form.title} autoFocus className={cls(tried && !form.title.trim() && 'bad')} onChange={(e) => set({ title: e.target.value })} />
          </label>
          <div className="field-row">
            <label className="field"><span className="field-label">日期</span><input type="date" value={form.date} onChange={(e) => set({ date: e.target.value })} /></label>
            <label className="field"><span className="field-label">时间</span><input type="time" value={form.time} onChange={(e) => set({ time: e.target.value })} /></label>
          </div>
          <label className="field"><span className="field-label">内容<span className="field-hint">可以不填，不填就显示任务标题</span></span>
            <textarea rows={2} value={form.body} onChange={(e) => set({ body: e.target.value })} />
          </label>
          <div className="act-row">
            <span className="list-sub">只提醒一次，到点后自动停用；要重复提醒去定时任务页建</span>
            <span className="spacer" />
            <button className="act" onClick={() => setForm(null)}>算了</button>
            <button className="act act-primary" onClick={save}>设好了</button>
          </div>
          {tried && err && <div className="field-err">{err}</div>}
        </div>
      )}
    </section>
  )
}

export interface Reminder { id: string; at: string; title: string; body: string; taskId?: string; taskRef?: string; popup?: 'toast' | 'modal' }

/** 右下角的提醒弹窗：一条条叠起来，点「知道了」或「打开任务」才收；最多显示 3 条，其余折成「还有 N 条」 */
export function ReminderPopups({ items, onOpenTask, onDismiss }: {
  items: Reminder[]
  onOpenTask: (taskId: string) => void
  /** 'toasts'：右下角的全部知道了（中间弹窗不动） */
  onDismiss: (id: string | 'toasts') => void
}) {
  const hhmm = (iso: string) => { const d = new Date(iso); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` }
  // 中间弹窗（SPEC-tasks-8.26）：一次一条，先弹最早的，只有按钮能关；右下角的照旧
  const modals = items.filter((n) => n.popup === 'modal')
  const modal = modals.length ? modals[modals.length - 1] : null
  const toasts = items.filter((n) => n.popup !== 'modal')
  const shown = toasts.slice(0, 3)
  return (
    <>
    {modal && (
      <div className="reminder-modal-scrim">
        <div className="reminder-modal" role="alertdialog" aria-modal="true" aria-label={modal.title}>
          <div className="reminder-pop-kicker">提醒 · {hhmm(modal.at)}</div>
          <div className="reminder-modal-title">{modal.title}</div>
          {modal.body && <div className="reminder-modal-body">{modal.body}</div>}
          <div className="act-row reminder-modal-acts">
            {modals.length > 1 && <span className="list-sub">还有 {modals.length - 1} 条</span>}
            <span className="spacer" />
            {modal.taskId && <button className="act" onClick={() => { onDismiss(modal.id); onOpenTask(modal.taskId!) }}>打开任务{modal.taskRef ? ` ${modal.taskRef}` : ''}</button>}
            <button className="act act-primary" autoFocus onClick={() => onDismiss(modal.id)}>知道了</button>
          </div>
        </div>
      </div>
    )}
    {toasts.length > 0 && <div className="reminder-pops" role="region" aria-label="提醒">
      {shown.map((n) => (
        <div key={n.id} className="reminder-pop" role="alert">
          <div className="reminder-pop-head"><span className="reminder-pop-kicker">提醒 · {hhmm(n.at)}</span>
            <button className="icon-btn" title="知道了" onClick={() => onDismiss(n.id)}>
              <svg viewBox="0 0 16 16" width="12" height="12"><path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
            </button>
          </div>
          <div className="reminder-pop-title">{n.title}</div>
          {n.body && <div className="reminder-pop-body">{n.body}</div>}
          <div className="act-row reminder-pop-acts">
            {n.taskId && <button className="act act-primary" onClick={() => { onDismiss(n.id); onOpenTask(n.taskId!) }}>打开任务{n.taskRef ? ` ${n.taskRef}` : ''}</button>}
            <button className="act" onClick={() => onDismiss(n.id)}>知道了</button>
          </div>
        </div>
      ))}
      {toasts.length > shown.length && (
        <div className="reminder-pop-more">还有 {toasts.length - shown.length} 条提醒<button className="act" onClick={() => onDismiss('toasts')}>全部知道了</button></div>
      )}
    </div>}
    </>
  )
}

/** 关联这条任务的提醒，启用的在前 */
export const remindersOf = (list: Schedule[], taskId: string) =>
  list.filter((s) => s.action.kind === 'remind' && s.action.task_id === taskId).sort((a, b) => Number(b.enabled) - Number(a.enabled))
