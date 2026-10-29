// 今日来源（ALIGN-08）：插件给今日页「需要你处理」贡献一组、给「正在运行」贡献几行。
// 插件给一个查询和把数据转成条目的函数，今日页用 useQueries 一起取，汇总数字跟着相加；停用插件时按 id 撤掉。
// 和今日卡片（2.8）不同，这里不进清单 provides：条目长什么样由内核定，插件只给数据。
import { useSyncExternalStore } from 'react'
import { useQueries, type QueryKey } from '@tanstack/react-query'
import type { Disposable } from './api'
import { OwnedStore } from './extensions'

/** 圆点颜色：异常、要处理、只是提醒；正在运行里 ok 是绿灯、info 是蓝灯 */
export type TodayTone = 'danger' | 'warn' | 'info' | 'ok'

export type TodayItem = {
  id: string
  tone: TodayTone
  title: string
  sub: string
  /** 相对时间按它算；没有时不显示，组内排在同级最后 */
  at?: string | null
  /** 动作文案，如「回复」；正在运行里不用 */
  action?: string
  /** 站内路径，点了跳过去 */
  to?: string
  /** 外部地址，点了新窗口打开（运行中的原型） */
  href?: string
}

/** 来源顺序（SPEC-today-1.4）：SOP、Agent 待确认、任务待验收、IM 消息、运行异常、连接异常 */
export const TODAY_ORDER = { sop: 10, agent: 20, review: 30, im: 40, incident: 50, connection: 60 } as const

export interface TodaySourceDef<T = unknown> {
  /** 插件内唯一 */
  key: string
  /** need：「需要你处理」的一组；running：「正在运行」的几行 */
  slot: 'need' | 'running'
  /** 组名，如「IM 消息」；running 用在出错提示里 */
  label: string
  /** 越小越靠前，见 TODAY_ORDER */
  order: number
  /** 缓存键放在对应资源的前缀下，资源一变今日跟着刷 */
  queryKey: QueryKey
  queryFn: (ctx: { signal: AbortSignal }) => Promise<T>
  refetchInterval?: number | false
  /** total 是全量条数（汇总数字用），items 可以只给前几条 */
  select: (data: T) => { total: number; items: TodayItem[] }
  /** 「查看全部」去哪；不给不显示入口 */
  more?: string
}

export interface TodaySourceRegistry {
  register<T>(def: TodaySourceDef<T>): Disposable
}

export type PluginTodaySource = TodaySourceDef & { plugin: string }

export const todaySourceStore = new OwnedStore<PluginTodaySource>()

export function todaySourceRegistry(owner: string): TodaySourceRegistry {
  return {
    register(def) {
      if (todaySourceStore.find((s) => s.plugin === owner && s.key === def.key)) throw new Error(`今日来源 ${def.key} 重复注册`)
      return todaySourceStore.add(owner, { ...(def as unknown as TodaySourceDef), plugin: owner })
    },
  }
}

export function useTodaySources(): readonly PluginTodaySource[] {
  return useSyncExternalStore(todaySourceStore.subscribe, todaySourceStore.list)
}

/** 一个来源取到的样子；没取到时 items 为空，error 为 true */
export type TodaySourceState = {
  def: PluginTodaySource
  total: number
  items: TodayItem[]
  pending: boolean
  error: boolean
  refetch: () => void
}

/** 一起取全部来源；数量随插件启停变化，用 useQueries 不违反 hook 规则 */
export function useTodaySourceData(defs: readonly PluginTodaySource[]): TodaySourceState[] {
  return useQueries({
    queries: defs.map((d) => ({
      queryKey: d.queryKey,
      queryFn: d.queryFn,
      refetchInterval: d.refetchInterval,
      select: d.select,
    })),
    combine: (rs) => rs.map((r, i) => ({
      def: defs[i], total: r.data?.total ?? 0, items: r.data?.items ?? [], pending: r.isPending, error: r.isError,
      refetch: () => void r.refetch(),
    })),
  })
}
