// 一级菜单上的提醒：菜单上不放数量，只在有事等你处理时给个红点，原因放在悬停提示里（照原型 App.tsx 的 ALL_MENU）。
// 数据都从后端读：今日看今日聚合的等确认和逾期，IM 消息看待处理条数，视频看今日聚合里视频插件的三张卡（SHELL-02），设置看后端连没连上、连接器有没有出错、
// 有没有未处理的运行错误（INC-01b，警告不算）。
// 会话的红点要等后端给会话加上「等你回答」的状态（契约「今日聚合」末尾），现在不出
import { openErrors, overdueCard, reviewCard, todayCard, useConnectors, useHealth, useImPendingCount, useIncidents, useToday, type Today } from '../data'

export type MenuMark = { alert: boolean; hint: string }

export type MarkInput = {
  today?: Today
  imPending?: number
  backendDown?: boolean
  brokenConnectors?: number
  openIncidents?: number
}

// IM 消息插件的模块 id
const IM_MODULE = 'messages'
// 视频插件的模块 id 和它登记的今日卡片（契约「视频 / 今日卡片」），卡片在插件停用后自然消失
const VIDEO_MODULE = 'videos'
const VIDEO_CARDS = [['video_waiting', '件视频待验收'], ['video_scheduled', '条待发布'], ['video_failed', '条发布失败']] as const

export function menuMarks(x: MarkInput): Record<string, MenuMark> {
  const out: Record<string, MenuMark> = {}
  const review = reviewCard(x.today)?.total ?? 0
  const overdue = overdueCard(x.today)?.total ?? 0
  if (review > 0 || overdue > 0) {
    out.today = { alert: true, hint: [review > 0 && `${review} 件等你确认`, overdue > 0 && `${overdue} 个任务已逾期`].filter(Boolean).join('，') }
  }
  if ((x.imPending ?? 0) > 0) out[IM_MODULE] = { alert: true, hint: `${x.imPending} 条消息待处理` }
  const video = VIDEO_CARDS.map(([k, s]) => [todayCard(x.today, k)?.total ?? 0, s] as const).filter(([n]) => n > 0)
  if (video.length) out[VIDEO_MODULE] = { alert: true, hint: video.map(([n, s]) => `${n} ${s}`).join('，') }
  const settings = [x.backendDown && '后端未连接', (x.brokenConnectors ?? 0) > 0 && `${x.brokenConnectors} 个连接器异常`,
    (x.openIncidents ?? 0) > 0 && `${x.openIncidents} 个运行错误未处理`].filter(Boolean)
  if (settings.length) out.settings = { alert: true, hint: settings.join('，') }
  return out
}

/** active 是菜单里现有的模块 id：插件没启用就不去取它的数据 */
export function useMenuMarks(active: ReadonlySet<string>): Record<string, MenuMark> {
  const today = useToday(undefined, { refetchInterval: 60_000 })
  const im = useImPendingCount({ enabled: active.has(IM_MODULE), refetchInterval: 60_000 })
  const health = useHealth()
  const connectors = useConnectors()
  const incidents = useIncidents()
  return menuMarks({
    today: today.data,
    imPending: active.has(IM_MODULE) ? im.data : 0,
    backendDown: health.isError,
    brokenConnectors: connectors.data?.filter((c) => c.status === 'error').length ?? 0,
    openIncidents: openErrors(incidents.data ?? []).length,
  })
}
