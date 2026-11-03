// 任务抽屉里「设个提醒」的表单（TaskReminders）：默认值、校验、提交体。只提醒一次，关联这条任务。
import type { ScheduleInput, WorkObject } from '../../core/data'
import { REMIND_TITLE_MAX, fullRule, remindError, ruleError, type ScheduleDraft } from './scheduleModel'

// 新建提醒的默认时刻
const DEFAULT_TIME = '09:00'
// 名称上限，和后端一致
const NAME_MAX = 100

export type ReminderForm = { title: string; body: string; date: string; time: string }

const pad = (n: number) => String(n).padStart(2, '0')
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

/** 默认明天 09:00，标题是任务标题（截到上限） */
export function emptyReminder(task: Pick<WorkObject, 'title'>, now: Date = new Date()): ReminderForm {
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
  return { title: task.title.trim().slice(0, REMIND_TITLE_MAX), body: '', date: ymd(tomorrow), time: DEFAULT_TIME }
}

/** 表单的错误：标题、内容同定时任务页，时间不能是过去 */
export function reminderError(f: ReminderForm, now: Date = new Date()): string {
  return remindError(f.title, f.body) || ruleError(onceRule(f, now), now)
}

function onceRule(f: ReminderForm, now: Date): ScheduleDraft['rule'] {
  return { ...fullRule(undefined, now), freq: 'once', date: f.date, time: f.time }
}

/** 提交体：只提醒一次，名称「提醒：标题」 */
export function reminderInput(task: Pick<WorkObject, 'id'>, f: ReminderForm, now: Date = new Date()): ScheduleInput {
  const title = f.title.trim()
  return {
    name: `提醒：${title}`.slice(0, NAME_MAX),
    enabled: true,
    rule: onceRule(f, now),
    action: { kind: 'remind' as const, title, body: f.body.trim(), object_id: task.id },
  }
}
