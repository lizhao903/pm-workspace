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

  it('设置：后端没连上或连接器出错', () => {
    expect(menuMarks({ backendDown: true, brokenConnectors: 2 }).settings?.hint).toBe('后端未连接，2 个连接器异常')
    expect(menuMarks({ brokenConnectors: 0 }).settings).toBeUndefined()
  })
})
