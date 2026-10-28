// 一级菜单上的提醒：菜单上不放数量，只在有事等你处理时给个红点，原因放在悬停提示里（照原型）。
// 数据都从后端读：今日看 /api/counts 的已逾期计数，设置看后端连没连上
import { useCounts, useHealth } from '../data'

export type MenuMark = { alert: boolean; hint: string }

export function useMenuMarks(): Record<string, MenuMark> {
  const c = useCounts({ refetchInterval: 60_000 })
  const health = useHealth()
  const out: Record<string, MenuMark> = {}
  const overdue = c.data?.overdue ?? 0
  if (overdue > 0) out.today = { alert: true, hint: `${overdue} 条已逾期` }
  if (health.isError) out.settings = { alert: true, hint: '后端未连接' }
  return out
}
