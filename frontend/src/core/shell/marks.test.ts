import { describe, expect, it } from 'vitest'
import type { Today } from '../data'
import { menuMarks } from './marks'

const card = (key: string, total: number) => ({ key, title: key, order: 0, total, items: [] })
const today = (review: number, overdue: number): Today => ({ cards: [card('review', review), card('overdue', overdue), card('due_today', 3), card('running', 2)] })

describe('menuMarks', () => {
  it('今日有等确认或逾期才出红点，今天到期和运行中不算', () => {
    expect(menuMarks({ today: today(0, 0) }).today).toBeUndefined()
    expect(menuMarks({ today: today(2, 0) }).today).toEqual({ alert: true, hint: '2 件等你确认' })
    expect(menuMarks({ today: today(2, 1) }).today?.hint).toBe('2 件等你确认，1 个任务已逾期')
    expect(menuMarks({}).today).toBeUndefined()
  })

  it('IM 消息有待处理才出红点，清掉后消失', () => {
    expect(menuMarks({ imPending: 3 }).messages).toEqual({ alert: true, hint: '3 条消息待处理' })
    expect(menuMarks({ imPending: 0 }).messages).toBeUndefined()
  })

  it('视频：待验收、待发布、发布失败有条目才出红点，清掉后消失', () => {
    const v = (w: number, s: number, f: number): Today => ({ cards: [card('video_waiting', w), card('video_scheduled', s), card('video_failed', f), card('video_deal_due', 4)] })
    expect(menuMarks({ today: v(0, 0, 0) }).videos).toBeUndefined()
    expect(menuMarks({ today: v(2, 0, 1) }).videos).toEqual({ alert: true, hint: '2 件视频待验收，1 条发布失败' })
    expect(menuMarks({ today: v(0, 3, 0) }).videos?.hint).toBe('3 条待发布')
    expect(menuMarks({ today: today(2, 1) }).videos).toBeUndefined()
  })

  it('设置：后端没连上或连接器出错', () => {
    expect(menuMarks({ backendDown: true, brokenConnectors: 2 }).settings?.hint).toBe('后端未连接，2 个连接器异常')
    expect(menuMarks({ brokenConnectors: 0 }).settings).toBeUndefined()
    // 未处理的运行错误（INC-01b）
    expect(menuMarks({ openIncidents: 3 }).settings?.hint).toBe('3 个运行错误未处理')
    expect(menuMarks({ openIncidents: 0 }).settings).toBeUndefined()
  })
})
