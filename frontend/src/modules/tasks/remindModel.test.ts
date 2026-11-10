// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { describe, expect, it } from 'vitest'
import type { Schedule } from '../../core/data'
import {
  actionOf, actionText, draftErrors, emptyAction, emptyRule, nextCellText, remindError, scheduleDraftOf,
} from './scheduleModel'
import { emptyReminder, reminderError, reminderInput } from './reminderModel'

const now = new Date(2026, 9, 29, 8, 0)

function remind(p: Partial<Schedule> = {}): Schedule {
  return {
    id: 'sch_r', name: '提醒：回电话', enabled: true, rule: { ...emptyRule(now), freq: 'once', date: '2026-10-29', time: '09:00' },
    action: { kind: 'remind', title: '回电话', body: '', object_id: 'obj_1' }, project_id: null, next_run_at: '2026-10-29T09:00:00+08:00',
    created_at: '', updated_at: '', ...p,
  }
}

describe('动作「提醒」', () => {
  it('提交体只带标题、内容、关联对象、弹窗方式，去首尾空白', () => {
    const a = { ...emptyAction('remind', 'P2'), title: ' 回电话 ', body: ' 问下报价 ', object_id: 'obj_1', priority: 'P1' }
    expect(actionOf(a)).toEqual({ kind: 'remind', title: '回电话', body: '问下报价', object_id: 'obj_1', popup: 'toast' })
    expect(actionOf({ ...a, popup: 'modal' })).toMatchObject({ popup: 'modal' })
  })

  it('标题必填、字数有上限', () => {
    expect(remindError(' ', '')).toBe('提醒标题必填')
    expect(remindError('x'.repeat(101), '')).toBe('提醒标题最多 100 字')
    expect(remindError('x', 'y'.repeat(2001))).toBe('提醒内容最多 2000 字')
    const d = scheduleDraftOf(remind({ action: { kind: 'remind', title: '', body: '', object_id: '' } }), [], now)
    expect(draftErrors(d, now)).toEqual(['提醒标题必填'])
  })

  it('编辑时读回来的字段都在', () => {
    expect(scheduleDraftOf(remind(), [], now).action).toMatchObject({ kind: 'remind', title: '回电话', object_id: 'obj_1' })
  })

  it('列表里「做什么」和「下次执行」', () => {
    expect(actionText(remind().action)).toBe('提醒「回电话」，关联任务')
    expect(actionText({ kind: 'remind', title: '喝水', body: '', object_id: '' })).toBe('提醒「喝水」')
    expect(nextCellText(remind(), undefined, now)).toBe('今天 09:00')
    const after = new Date(2026, 9, 29, 9, 5)
    const done = remind({ enabled: false, project_id: null, next_run_at: null })
    expect(nextCellText(done, { status: 'ok' }, after)).toBe('已提醒')
    expect(nextCellText(done, undefined, after)).toBe('已提醒')
    expect(nextCellText(done, { status: 'missed' }, after)).toBe('已错过')
    expect(nextCellText(done, null, after)).toBe('已停用')
    // 没到点就停用的、重复的提醒停用了都是「已停用」
    expect(nextCellText(done, null, now)).toBe('已停用')
    expect(nextCellText(remind({ enabled: false, rule: { ...emptyRule(now), freq: 'daily' } }), { status: 'ok' }, after)).toBe('已停用')
  })
})

describe('任务抽屉里设提醒', () => {
  it('默认明天 09:00，标题是任务标题；提交体是只提醒一次、关联这条任务', () => {
    const f = emptyReminder({ title: ' 导出改成分批写 ' }, now)
    expect(f).toEqual({ title: '导出改成分批写', body: '', date: '2026-10-30', time: '09:00' })
    const input = reminderInput({ id: 'obj_1' }, { ...f, body: ' 先问后端 ' }, now)
    expect(input.name).toBe('提醒：导出改成分批写')
    expect(input.rule).toMatchObject({ freq: 'once', date: '2026-10-30', time: '09:00' })
    expect(input.action).toEqual({ kind: 'remind', title: '导出改成分批写', body: '先问后端', object_id: 'obj_1' })
  })

  it('过去的时间、空标题不让设', () => {
    expect(reminderError({ title: 'x', body: '', date: '2026-10-29', time: '07:00' }, now)).toBe('这个时间已经过去了')
    expect(reminderError({ title: '', body: '', date: '2026-10-30', time: '09:00' }, now)).toBe('提醒标题必填')
    expect(reminderError({ title: 'x', body: '', date: '2026-10-30', time: '09:00' }, now)).toBe('')
  })
})
