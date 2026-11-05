// SOP 的定时触发（TSK-0463，SPEC-sop-9.3、SPEC-sop-2、SPEC-sop-5）：触发方式「定时」的时间规则存在随流程管理的定时任务里（flow.schedule），
// 编排页改的是草稿（draft.sched），保存时一起提交；流程库卡片、流程详情显示下次执行和启停。
import type { SopField, SopFlow, SopScheduleDraft } from '../../core/data'
import { describeRule as describeScheduleRule, fullRule as fullScheduleRule, whenText as scheduleWhenText } from '../../core/ui/scheduleRule'
import { LEGACY_SCHEDULE_TRIGGERS, TRIGGER_LABEL, normTrigger } from './model'

export const SCHEDULE = 'schedule'

/** 新选「定时」时的默认规则：每天 09:00 */
export function defaultSched(now: Date = new Date()): SopScheduleDraft {
  return { rule: { ...fullScheduleRule(undefined, now), freq: 'daily', time: '09:00' }, enabled: true }
}

/** 旧触发方式等价的规则（后端迁移同一口径）：daily 每天 09:00，weekly 每周一 18:00；cron 原来只是标签，没有规则 */
function legacySched(trigger: string, now: Date): SopScheduleDraft | undefined {
  if (trigger === 'daily') return defaultSched(now)
  if (trigger === 'weekly') return { rule: { ...fullScheduleRule(undefined, now), freq: 'weekly', time: '18:00', weekdays: [1] }, enabled: true }
  return undefined
}

/** 编排页的初值：触发方式换成新 key，定时的规则取随流程管理的那条；没有那条时旧触发方式按等价规则，否则为未配置 */
export function draftScheduleOf(f: Pick<SopFlow, 'trigger' | 'schedule'>, now: Date = new Date()): { trigger: string; sched?: SopScheduleDraft } {
  const trigger = normTrigger(f.trigger)
  if (trigger !== SCHEDULE) return { trigger }
  if (f.schedule) return { trigger, sched: { rule: fullScheduleRule(f.schedule.rule, now), enabled: f.schedule.enabled } }
  return { trigger, sched: legacySched(f.trigger, now) }
}

/** 定时发起时不带输入：必填又没默认值的字段，到点会执行失败 */
export function fieldsWithoutDefault(fields: readonly SopField[]): string[] {
  return fields.filter((x) => x.required && !(x.default ?? '').trim()).map((x) => x.label || x.key)
}

export type ScheduleState =
  | { kind: 'none' }
  | { kind: 'unset' }
  | { kind: 'set'; rule: string; enabled: boolean; next: string }

/** 流程库卡片、流程详情要显示的：不是定时为 none；定时没有那条定时任务为 unset（「定时，未配置」） */
export function scheduleStateOf(f: Pick<SopFlow, 'trigger' | 'schedule'>, now: Date = new Date()): ScheduleState {
  if (normTrigger(f.trigger) !== SCHEDULE) return { kind: 'none' }
  const s = f.schedule
  if (!s) return { kind: 'unset' }
  return {
    kind: 'set', rule: describeScheduleRule(fullScheduleRule(s.rule, now)), enabled: s.enabled,
    next: s.enabled ? (s.next_run_at ? `下次 ${scheduleWhenText(s.next_run_at, now)}` : '不会再执行') : '已停用',
  }
}

const FALLBACK_TRIGGERS: { value: string; label: string }[] = ['manual', 'im', SCHEDULE].map((v) => ({ value: v, label: TRIGGER_LABEL[v] }))

/** 字典条目换成选项：去掉旧的定时类，保证正好一项「定时」（字典里有 schedule 用它的名字，没有排在最后补上） */
export function triggerOptionsOf(items: readonly { key: string; label: string }[]): { value: string; label: string }[] {
  const opts = items.filter((x) => !LEGACY_SCHEDULE_TRIGGERS.includes(x.key)).map((x) => ({ value: x.key, label: x.label }))
  if (!opts.length) return FALLBACK_TRIGGERS
  return opts.some((x) => x.value === SCHEDULE) ? opts : [...opts, { value: SCHEDULE, label: TRIGGER_LABEL[SCHEDULE] }]
}
