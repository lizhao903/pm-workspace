// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { describe, expect, it } from 'vitest'
import type { DictItem, Schedule } from '../../core/data'
import {
  actionLabel, actionText, buildScheduleInput, buildSchedulePatch, describeRule, draftErrors, emptyRule, emptyScheduleDraft, fullRule,
  matchSchedule, ruleError, runTone, scheduleDirty, scheduleDraftOf, whenText,
} from './scheduleModel'

const now = new Date(2026, 9, 29, 8, 0) // 周四
const prio = (key: string, meta: Record<string, unknown> = {}): DictItem => ({
  id: key, dict_id: 'priority', type_id: null, key, label: key, color: '', description: '', sort_order: 0, meta, archived_at: null,
  created_at: '', updated_at: '', usage: 0,
})
const sch = (p: Partial<Schedule> = {}): Schedule => ({
  id: 'sch_a', name: '周会前整理议程', enabled: true, rule: { ...emptyRule(now) },
  action: { kind: 'task', title: '整理 {{date}} 周会议程', desc: '', priority: 'P2', assignee: '', due_days: 0 },
  project_id: null, next_run_at: null, created_at: '', updated_at: '', ...p,
})

describe('定时任务的规则', () => {
  it('默认每周一 09:00，一次性默认明天', () => {
    expect(emptyRule(now)).toEqual({ freq: 'weekly', time: '09:00', weekdays: [1], day: 1, date: '2026-10-30', cron: '0 9 * * 1' })
  })

  it('说成一句话：周一在前', () => {
    const r = emptyRule(now)
    expect(describeRule({ ...r, weekdays: [0, 3, 1] })).toBe('每周一、三、日 09:00')
    expect(describeRule({ ...r, freq: 'monthly', day: 25 })).toBe('每月 25 号 09:00')
    expect(describeRule({ ...r, freq: 'cron', cron: '0 18 * * 1' })).toBe('Cron：0 18 * * 1')
    expect(describeRule({ ...r, freq: 'weekdays' })).toBe('工作日 09:00')
  })

  it('五种错误文案', () => {
    const r = emptyRule(now)
    expect(ruleError({ ...r, time: '9:00' }, now)).toBe('时间要写成 09:00 这种格式')
    expect(ruleError({ ...r, weekdays: [] }, now)).toBe('每周执行要至少选一天')
    expect(ruleError({ ...r, freq: 'once', date: '' }, now)).toBe('选一个执行日期')
    expect(ruleError({ ...r, freq: 'once', date: '2026-10-29', time: '07:59' }, now)).toBe('这个时间已经过去了')
    expect(ruleError({ ...r, freq: 'cron', cron: '0 9 * *' }, now)).toBe('Cron 要 5 段：分 时 日 月 周，比如 0 9 * * 1')
    expect(ruleError({ ...r, freq: 'cron', cron: '0 9 * * 1', time: '' }, now)).toBe('')
  })

  it('后端只给自己频率的字段时补齐默认值', () => {
    expect(fullRule({ freq: 'cron', cron: '0 9 31 2 *', time: '', weekdays: [], day: 0, date: '' }, now))
      .toEqual({ freq: 'cron', time: '09:00', weekdays: [1], day: 1, date: '2026-10-30', cron: '0 9 31 2 *' })
  })

  it('什么时候执行：今天、明天、一周内说周几，再远说日期', () => {
    const at = (d: number, h = 9) => new Date(2026, 9, d, h, 0).toISOString()
    expect(whenText(at(29), now)).toBe('今天 09:00')
    expect(whenText(at(30, 18), now)).toBe('明天 18:00')
    expect(whenText(at(31), now)).toBe('周六 09:00')
    expect(whenText(new Date(2026, 10, 15, 9).toISOString(), now)).toBe('11-15 09:00')
    expect(whenText(null, now)).toBe('不再执行')
  })
})

describe('定时任务的表单', () => {
  const prios = [prio('P1'), prio('P2'), prio('P3', { default: true })]

  it('新建默认取字典的默认优先级', () => {
    expect(emptyScheduleDraft(prios, now).action.priority).toBe('P3')
    expect(emptyScheduleDraft([prio('P1'), prio('P2')], now).action.priority).toBe('P2')
  })

  it('必填项按底栏顺序报错', () => {
    const d = emptyScheduleDraft(prios, now)
    expect(draftErrors(d, now)).toEqual(['名称必填', '任务标题必填'])
    expect(draftErrors({ ...d, name: 'x', action: { ...d.action, kind: 'agent', agent_id: 'ag_1' } }, now)).toEqual(['写一下要它做什么'])
    expect(draftErrors({ ...d, name: 'x', action: { ...d.action, kind: 'sop' } }, now)).toEqual(['选一个 SOP'])
  })

  it('提交体按动作类型只留自己的字段，去首尾空白', () => {
    const d = emptyScheduleDraft(prios, now)
    const input = buildScheduleInput({ ...d, name: ' 周报 ', action: { ...d.action, title: ' 写周报 ', sop_id: 'sop_x' } })
    expect(input.name).toBe('周报')
    expect(input.action).toEqual({ kind: 'task', title: '写周报', desc: '', priority: 'P3', assignee: '', due_days: 0 })
  })

  it('编辑只传改过的；只改名称或启停不带规则，切频率又切回来不算改动', () => {
    const base = scheduleDraftOf(sch(), prios, now)
    expect(buildSchedulePatch(base, { ...base, enabled: false })).toEqual({ enabled: false })
    expect(buildSchedulePatch(base, { ...base, name: '新名字 ' })).toEqual({ name: '新名字' })
    const back = { ...base, rule: { ...base.rule, freq: 'daily' as const } }
    expect(scheduleDirty(base, { ...back, rule: { ...back.rule, freq: 'weekly' } })).toBe(false)
    // 不用的字段改了也不算：每天时改周几
    expect(scheduleDirty(base, { ...back, rule: { ...back.rule, weekdays: [2] } })).toBe(true)
    expect(scheduleDirty({ ...back }, { ...back, rule: { ...back.rule, weekdays: [2] } })).toBe(false)
    expect(buildSchedulePatch(base, { ...base, action: { ...base.action, due_days: 2 } }).action).toMatchObject({ due_days: 2 })
  })
})

describe('列表的文字', () => {
  it('做什么：没填时说未填', () => {
    expect(actionText({ kind: 'task', title: '', desc: '', priority: '', assignee: '', due_days: 0 })).toBe('建任务「未填标题」')
    expect(actionText({ kind: 'agent', agent_id: 'ag_1', prompt: '' })).toBe('ag_1：未填要求')
    expect(actionText({ kind: 'sop', sop_id: 'sop_1' })).toBe('执行「sop_1」')
    // 随流程管理的（TSK-0463）：有流程名时显示名字
    expect(actionText({ kind: 'sop', sop_id: 'sop_1', managed: true }, { flows: { sop_1: '周报' } })).toBe('执行「周报」，随流程管理')
  })

  it('搜索名称、规则文字、做什么', () => {
    const s = sch()
    expect(matchSchedule(s, '议程')).toBe(true)
    expect(matchSchedule(s, '每周一')).toBe(true)
    expect(matchSchedule(s, '{{date}}')).toBe(true)
    expect(matchSchedule(s, '周报')).toBe(false)
    expect(matchSchedule(s, '  ')).toBe(true)
  })

  it('执行记录的颜色：成功绿、执行中灰、其余红', () => {
    expect(runTone({ status: 'ok' })).toBe('ok')
    expect(runTone({ status: 'running' })).toBe('wait')
    for (const status of ['failed', 'skipped', 'unsupported', 'missed'] as const) expect(runTone({ status })).toBe('bad')
  })

  it('视频发布动作（VID-06d）：类型叫「发布视频」，文字用发布标题，取不到时显示编号；草稿不报动作错误', () => {
    const a = { kind: 'video_publish', publish_id: 'pb_1' } as unknown as Schedule['action']
    expect(actionLabel('video_publish')).toBe('发布视频')
    expect(actionLabel('trade_brief')).toBe('trade_brief')
    expect(actionText(a, { publishes: { pb_1: 'B 站首发' } })).toBe('发布「B 站首发」')
    expect(actionText(a, { publishes: {} })).toBe('发布「已删除的发布记录」')
    expect(actionText(a)).toBe('发布记录 pb_1')
    const s = { id: 'sch_1', name: '周四发布', enabled: true, rule: { freq: 'once', date: '2099-03-12', time: '10:00' }, action: a } as unknown as Schedule
    expect(matchSchedule(s, 'B 站', { publishes: { pb_1: 'B 站首发' } })).toBe(true)
    const d = scheduleDraftOf(s, [prio('P2')], now)
    expect(draftErrors({ ...d, name: '改个名' }, now)).toEqual([])
    expect(buildSchedulePatch(d, { ...d, name: '改个名' })).toEqual({ name: '改个名' })
  })
})
