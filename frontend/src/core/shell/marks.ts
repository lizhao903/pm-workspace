// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 一级菜单上的提醒：菜单上不放数量，只在有事等你处理时给个红点，原因放在悬停提示里（照原型 App.tsx 的 ALL_MENU）。
// 数据都从后端读：今日看今日聚合的等确认和逾期，IM 消息看待处理条数，设置看后端连没连上、连接器有没有出错、
// 有没有未处理的运行错误（INC-01b，警告不算）。
// 会话的红点看等确认注意力（P0-O3）：有 Agent 工具调用等你确认就出，原因放在悬停提示里。
// 视频三个模块（SPEC-videos-0.1，原来 SHELL-02 一个「视频」看三张卡）：做视频看今日卡「视频待验收」（停在检查点或被退回），
// 发布与数据看「视频发布失败」，条数写在提示里；素材收集看待整理的素材条数，只在菜单里有素材收集时才去取素材
import { useQuery } from '@tanstack/react-query'
import {
  openErrors, overdueCard, reviewCard, todayCard, useAgentAttention, useConnectors, useHealth, useImPendingCount, useIncidents, useToday, videoKeys, videoTopicApi, type Today,
} from '../data'

export type MenuMark = { alert: boolean; hint: string }

export type MarkInput = {
  today?: Today
  imPending?: number
  /** Agent 等确认的调用数（不限于哪个会话），会话菜单出红点 */
  agentPending?: number
  backendDown?: boolean
  brokenConnectors?: number
  openIncidents?: number
  /** 待整理的素材条数（视频插件的素材收件箱） */
  clipsPending?: number
}

// IM 消息插件的模块 id
const IM_MODULE = 'messages'
// 会话模块的 id（外壳菜单里叫「会话」）
const CONVERSATIONS_MODULE = 'conversations'
// 视频插件的三个模块和它登记的今日卡片（契约「视频 / 今日卡片」），卡片在插件停用后自然消失
const VIDEO_MAKE = 'videos'
const VIDEO_CLIPS = 'video_clips'
const VIDEO_PUBLISH = 'video_publish'

export function menuMarks(x: MarkInput): Record<string, MenuMark> {
  const out: Record<string, MenuMark> = {}
  const review = reviewCard(x.today)?.total ?? 0
  const overdue = overdueCard(x.today)?.total ?? 0
  if (review > 0 || overdue > 0) {
    out.today = { alert: true, hint: [review > 0 && `${review} 件等你确认`, overdue > 0 && `${overdue} 个任务已逾期`].filter(Boolean).join('，') }
  }
  if ((x.imPending ?? 0) > 0) out[IM_MODULE] = { alert: true, hint: `${x.imPending} 条消息待处理` }
  // Agent 工具调用等你确认：会话菜单出红点，多少条放在提示里
  const agentPending = x.agentPending ?? 0
  if (agentPending > 0) out[CONVERSATIONS_MODULE] = { alert: true, hint: `${agentPending} 个 Agent 调用等你确认` }
  const waiting = todayCard(x.today, 'video_waiting')?.total ?? 0
  if (waiting > 0) out[VIDEO_MAKE] = { alert: true, hint: `${waiting} 集停在检查点或被退回` }
  const failed = todayCard(x.today, 'video_failed')?.total ?? 0
  if (failed > 0) out[VIDEO_PUBLISH] = { alert: true, hint: `${failed} 条发布失败` }
  if ((x.clipsPending ?? 0) > 0) out[VIDEO_CLIPS] = { alert: true, hint: `${x.clipsPending} 条素材待整理` }
  const settings = [x.backendDown && '后端未连接', (x.brokenConnectors ?? 0) > 0 && `${x.brokenConnectors} 个连接器异常`,
    (x.openIncidents ?? 0) > 0 && `${x.openIncidents} 个运行错误未处理`].filter(Boolean)
  if (settings.length) out.settings = { alert: true, hint: settings.join('，') }
  return out
}

/** active 是菜单里现有的模块 id：插件没启用就不去取它的数据 */
export function useMenuMarks(active: ReadonlySet<string>): Record<string, MenuMark> {
  const today = useToday(undefined, { refetchInterval: 60_000 })
  const im = useImPendingCount({ enabled: active.has(IM_MODULE), refetchInterval: 60_000 })
  // 等确认的调用数：会话菜单的红点（P0-O3），不分会话
  const attention = useAgentAttention()
  const health = useHealth()
  const connectors = useConnectors()
  const incidents = useIncidents()
  // 同素材收件箱页的查询，缓存共用
  const clips = useQuery({ queryKey: videoKeys.clips, queryFn: ({ signal }) => videoTopicApi.clips(signal), enabled: active.has(VIDEO_CLIPS), refetchInterval: 60_000 })
  return menuMarks({
    today: today.data,
    imPending: active.has(IM_MODULE) ? im.data : 0,
    agentPending: active.has(CONVERSATIONS_MODULE) ? attention.data?.total ?? 0 : 0,
    backendDown: health.isError,
    brokenConnectors: connectors.data?.filter((c) => c.status === 'error').length ?? 0,
    openIncidents: openErrors(incidents.data ?? []).length,
    clipsPending: active.has(VIDEO_CLIPS) ? clips.data?.filter((c) => !c.triaged).length ?? 0 : 0,
  })
}
