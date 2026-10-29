import { describe, expect, it } from 'vitest'
import type { VideoDeal } from '../../core/data'
import { dealItems, gridDays, moveError, movedAt, rangeTitle, sortDay, stepAnchor, ymd, type CalItem } from './calendarModel'

const item = (x: Partial<CalItem>): CalItem => ({ date: '2099-03-12', kind: 'publish', ref_id: 'pb_1', label: '发布', tone: 'muted', movable: true, ...x })

describe('calendarModel', () => {
  it('月视图从 1 号所在周的周一画到月底所在周的周日，周视图是这一周', () => {
    const m = gridDays('month', new Date(2026, 9, 15))
    expect([ymd(m[0]), ymd(m[m.length - 1]), m.length]).toEqual(['2026-09-28', '2026-11-01', 35])
    const w = gridDays('week', new Date(2026, 9, 29))
    expect([ymd(w[0]), ymd(w[6]), w.length]).toEqual(['2026-10-26', '2026-11-01', 7])
    expect(rangeTitle('week', new Date(2026, 9, 29), w)).toBe('10 月 26 日 - 11 月 1 日')
    expect(rangeTitle('month', new Date(2026, 9, 29), m)).toBe('2026 年 10 月')
    expect(ymd(stepAnchor('month', new Date(2026, 0, 31), 1))).toBe('2026-02-01')
    expect(ymd(stepAnchor('week', new Date(2026, 9, 29), -1))).toBe('2026-10-22')
  })

  it('挪日子时刻不变；已定时的不能挪到过去，已发布、失败的不能挪', () => {
    const at = new Date(2099, 2, 12, 10, 30).toISOString()
    const d = new Date(movedAt(at, '2099-03-16'))
    expect([ymd(d), d.getHours(), d.getMinutes()]).toEqual(['2099-03-16', 10, 30])
    const now = new Date(2099, 2, 14, 12, 0)
    expect(moveError(item({ status: 'scheduled', at }), '2099-03-14', now)).toMatch(/不能挪到已经过去的时间/)
    expect(moveError(item({ status: 'scheduled', at }), '2099-03-15', now)).toBe('')
    expect(moveError(item({ status: 'planned', at }), '2099-03-01', now)).toBe('')
    expect(moveError(item({ status: 'published', movable: false }), '2099-03-15', now)).toBe('已经发出去了，日期不能改')
    expect(moveError(item({ status: 'failed', movable: false, tone: 'danger' }), '2099-03-15', now)).toMatch(/先在发布记录里重试/)
  })

  it('商单只取范围内没交付、没丢单的，三天内标橙；同一天失败和落后的排前面', () => {
    const deal = (id: string, deadline: string, status: VideoDeal['status']) => ({ id, project_id: 'obj_pj', brand: '远川', title: id, deadline, status }) as VideoDeal
    const xs = dealItems([deal('a', '2099-03-12', 'signed'), deal('b', '2099-03-20', 'producing'), deal('c', '2099-03-12', 'delivered'), deal('d', '2099-05-01', 'signed')],
      '2099-03-01', '2099-03-31', '2099-03-10')
    expect(xs.map((x) => [x.ref_id, x.tone, x.kind])).toEqual([['a', 'warn', 'deal_deadline'], ['b', 'muted', 'deal_deadline']])
    const day = sortDay([
      item({ ref_id: 'p2', at: '2099-03-12T09:00:00Z' }), item({ ref_id: 'p1', at: '2099-03-12T08:00:00Z' }),
      item({ kind: 'target', ref_id: 't' }), item({ ref_id: 'bad', tone: 'danger' }), xs[0],
    ])
    expect(day.map((x) => x.ref_id)).toEqual(['bad', 'a', 't', 'p1', 'p2'])
  })
})
