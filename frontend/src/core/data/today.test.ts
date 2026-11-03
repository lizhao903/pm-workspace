import { describe, expect, it } from 'vitest'
import { pluginTodayCards, reviewCard, schedulesToday, type Schedule, type Today } from './today'

const sch = (id: string, next: string | null, enabled = true): Schedule => ({
  id, name: id, enabled, rule: {} as Schedule['rule'], action: {} as Schedule['action'], next_run_at: next, created_at: '', updated_at: '',
})

describe('今日聚合的纯函数', () => {
  it('插件卡片：去掉内核四张，保持接口顺序', () => {
    const t: Today = {
      cards: [
        { key: 'review', title: '等确认', order: 10, total: 0, items: [] },
        { key: 'demo_inbox', title: '示例收件箱', order: 50, total: 2, items: [1, 2] },
        { key: 'overdue', title: '逾期', order: 20, total: 0, items: [] },
        { key: 'im_mentions', title: '与我相关', order: 100, total: 1, items: [1] },
      ],
    }
    expect(pluginTodayCards(t).map((c) => c.key)).toEqual(['demo_inbox', 'im_mentions'])
    expect(reviewCard(t)?.title).toBe('等确认')
    expect(pluginTodayCards(undefined)).toEqual([])
  })

  it('今天还会自动执行：启用的、下次执行落在本地今天的，早的在前', () => {
    const now = new Date(2026, 9, 29, 8, 0)
    const at = (h: number, d = 29) => new Date(2026, 9, d, h, 30).toISOString()
    const rows = [sch('晚', at(18)), sch('早', at(9)), sch('明天', at(9, 30)), sch('停用', at(10), false), sch('不再执行', null)]
    expect(schedulesToday(rows, now).map((s) => s.id)).toEqual(['早', '晚'])
  })
})
