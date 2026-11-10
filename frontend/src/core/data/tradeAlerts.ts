// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 盯盘提醒（TRD-03a、TRD-03b）：规则、当前值、触发记录。契约见 docs/api-contract.md「交易套件插件 trade / 盯盘提醒」。
// 判定只在后端：后台任务每 2 秒检查一次，页面关着也照常提醒；前端不再自己判定，只显示后端算的当前值和触发记录。
// 触发时后端发 trade.alert_fired，这里收到后刷新规则（上次触发）和触发记录；事件流断开时退回定时重取。
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useRef } from 'react'
import { request, requestEnvelope, requestList } from '../api'
import { onServerEvent, useEventsLive, type ServerEvent } from './events'
import { tradeApi, tradeKeys, type TradeInstrument } from './trade'

export type TradeAlertCond =
  | 'price_above' | 'price_below' | 'pct_above' | 'pct_below' | 'volume_spike' | 'funding_above' | 'iv_above' | 'limit_near'
export type TradeAlertNotify = 'app' | 'im' | 'sound'

export type TradeAlert = {
  id: string
  symbol: string
  cond: TradeAlertCond
  /** 阈值，单位跟着条件：价格、%、倍于均量 */
  value: number
  /** false 单次：触发一次就停；true 重复：满足就提醒，两次至少隔 cooldown_min 分钟 */
  repeat: boolean
  cooldown_min: number
  notify: TradeAlertNotify[]
  /** 推 IM 用的连接器实例 id，没选 IM 为空串 */
  im_connector: string
  enabled: boolean
  note: string
  /** 最近一次触发，没触发过为空串 */
  last_fired_at: string
  created_at: string
  updated_at: string
}

export type TradeAlertInput = {
  symbol: string
  cond: TradeAlertCond
  value: number
  repeat?: boolean
  cooldown_min?: number
  notify?: TradeAlertNotify[]
  im_connector?: string
  enabled?: boolean
  note?: string
}

/** im_status：空串没选 IM；unavailable 工作台还没有给插件发 IM 的接口、这次没推 */
export type TradeAlertImStatus = '' | 'unavailable' | 'sent' | 'failed'

export type TradeAlertEvent = {
  id: string
  alert_id: string
  symbol: string
  cond: TradeAlertCond
  /** 触发时的当前值 */
  value: number
  text: string
  /** 触发时的最新价 */
  price: number
  note: string
  at: string
  read: boolean
  im_status: TradeAlertImStatus
  im_error: string
}

/** trade.alert_fired 的载荷：触发记录加规则的通知方式 */
export type TradeAlertFired = TradeAlertEvent & { notify: TradeAlertNotify[] }

/**
 * 当前值。ok 算出来了；no_source / loading / stale / error 同报价状态（这时后端不判定）；
 * unsupported 条件不适用于这个标的；unavailable 行情源给不了这项数据（如期权的隐含波动率）
 */
export type TradeAlertValueStatus = 'ok' | 'no_source' | 'loading' | 'stale' | 'error' | 'unsupported' | 'unavailable'
export type TradeAlertValue = {
  alert_id: string
  symbol: string
  cond: TradeAlertCond
  status: TradeAlertValueStatus
  error: string
  value: number | null
  price: number
  at: string
}

export type TradeAlertEventPage = { data: TradeAlertEvent[]; total: number; unread: number }

export const tradeAlertKeys = {
  all: ['trade', 'alerts'] as const,
  list: ['trade', 'alerts', 'list'] as const,
  values: ['trade', 'alerts', 'values'] as const,
  preview: (symbol: string, cond: TradeAlertCond) => ['trade', 'alerts', 'preview', symbol, cond] as const,
  events: ['trade', 'alerts', 'events'] as const,
  eventsPage: (limit: number) => ['trade', 'alerts', 'events', limit] as const,
}

const seg = encodeURIComponent

export const tradeAlertsApi = {
  list: () => requestList<TradeAlert>('/api/trade/alerts').then((r) => r.data),
  create: (body: TradeAlertInput) => request<TradeAlert>('POST', '/api/trade/alerts', { body }),
  patch: (id: string, body: Partial<TradeAlertInput>) => request<TradeAlert>('PATCH', '/api/trade/alerts/' + seg(id), { body }),
  remove: (id: string) => request<null>('DELETE', '/api/trade/alerts/' + seg(id)),
  rearm: (id: string) => request<TradeAlert>('POST', `/api/trade/alerts/${seg(id)}/rearm`),
  values: () => requestList<TradeAlertValue>('/api/trade/alerts/values').then((r) => r.data),
  preview: (symbol: string, cond: TradeAlertCond) =>
    request<TradeAlertValue>('GET', '/api/trade/alerts/preview', { query: new URLSearchParams({ symbol, cond }) }),
  events: async (limit: number): Promise<TradeAlertEventPage> => {
    const r = await requestEnvelope<TradeAlertEvent[] | null>('GET', '/api/trade/alert-events', { query: new URLSearchParams({ limit: String(limit) }) })
    const meta = (r.meta ?? {}) as { total?: number; unread?: number }
    const data = r.data ?? []
    return { data, total: meta.total ?? data.length, unread: meta.unread ?? data.filter((e) => !e.read).length }
  },
  /** ids 不传是全部已读 */
  read: (ids?: string[]) => request<{ updated: number }>('POST', '/api/trade/alert-events/read', { body: ids ? { ids } : {} }),
}

/** 事件流断开时的退回轮询间隔 */
const FALLBACK_MS = 10_000

export function useTradeAlerts() {
  const live = useEventsLive()
  return useQuery({ queryKey: tradeAlertKeys.list, queryFn: tradeAlertsApi.list, refetchInterval: live ? false : FALLBACK_MS })
}

/** 每条启用的提醒的当前值，后端每 2 秒算一轮，这里 2 秒取一次；on 为 false 时不取 */
export function useTradeAlertValues(on = true) {
  return useQuery({ queryKey: tradeAlertKeys.values, queryFn: tradeAlertsApi.values, enabled: on, refetchInterval: on ? 2_000 : false })
}

/** 抽屉里还没保存的标的和条件的当前值，2 秒取一次 */
export function useTradeAlertPreview(symbol: string, cond: TradeAlertCond) {
  return useQuery({
    queryKey: tradeAlertKeys.preview(symbol, cond),
    queryFn: () => tradeAlertsApi.preview(symbol, cond),
    enabled: !!symbol,
    refetchInterval: 2_000,
    retry: false,
  })
}

/** 触发记录，新的在前，取前 limit 条（再显示更多就把 limit 调大） */
export function useTradeAlertEvents(limit: number) {
  const live = useEventsLive()
  return useQuery({
    queryKey: tradeAlertKeys.eventsPage(limit),
    queryFn: () => tradeAlertsApi.events(limit),
    placeholderData: (prev) => prev,
    refetchInterval: live ? false : FALLBACK_MS,
  })
}

function useAlertMutation<A, R>(fn: (a: A) => Promise<R>) {
  const qc = useQueryClient()
  return useMutation({ mutationFn: fn, onSettled: () => qc.invalidateQueries({ queryKey: tradeAlertKeys.all }) })
}
export const useCreateTradeAlert = () => useAlertMutation(tradeAlertsApi.create)
export const usePatchTradeAlert = () =>
  useAlertMutation(({ id, ...body }: Partial<TradeAlertInput> & { id: string }) => tradeAlertsApi.patch(id, body))
export const useRemoveTradeAlert = () => useAlertMutation(tradeAlertsApi.remove)
export const useRearmTradeAlert = () => useAlertMutation(tradeAlertsApi.rearm)
export const useReadTradeAlertEvents = () => useAlertMutation((ids?: string[]) => tradeAlertsApi.read(ids))

/**
 * 订阅后端的 trade.alert_fired：刷新规则和触发记录，再把载荷交给 onFired（比如响声音）。
 * 只在挂着的组件里生效；页面关着时提醒靠后端的应用内通知。
 */
export function useTradeAlertFired(onFired?: (e: TradeAlertFired) => void) {
  const qc = useQueryClient()
  const cb = useRef(onFired)
  useEffect(() => { cb.current = onFired })
  useEffect(() => onServerEvent('trade.alert_fired', (e: ServerEvent) => {
    void qc.invalidateQueries({ queryKey: tradeAlertKeys.list })
    void qc.invalidateQueries({ queryKey: tradeAlertKeys.events })
    cb.current?.(e.payload as unknown as TradeAlertFired)
  }), [qc])
}

/**
 * 一组标的的静态信息，按 symbol 查；标的表里还没有（行情源没同步）的不在结果里，界面按代码显示。
 * 和 useTradeInstrument 共用缓存。
 */
const toInstMap = (rs: { data?: TradeInstrument | null }[]): Record<string, TradeInstrument> =>
  Object.fromEntries(rs.flatMap((r) => (r.data ? [[r.data.symbol, r.data]] : [])))

export function useTradeInstrumentMap(symbols: string[]): Record<string, TradeInstrument> {
  const uniq = useMemo(() => [...new Set(symbols)].sort(), [symbols])
  return useQueries({
    queries: uniq.map((symbol) => ({
      queryKey: tradeKeys.instrument(symbol),
      queryFn: () => tradeApi.instrument(symbol).catch(() => null),
      staleTime: 10 * 60_000,
    })),
    // combine 是模块级的稳定函数，结果按内容结构共享，标的信息没变时引用不变
    combine: toInstMap,
  })
}
