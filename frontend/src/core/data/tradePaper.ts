// 模拟盘交易（TRD-05a、05b、06a 后端，TRD-05c、06b 前端）：账户、委托、持仓、部署、风控、熔断。
// 契约见 docs/api-contract.md「交易套件插件 trade / 模拟盘账户、委托和撮合」「策略部署」「风控」。
//
// 撮合、估值、风控全在后端：前端不撮合、不算账，只发请求和显示。没有推送：
// - 委托只在有挂单时每秒重取（市价单通常一秒内成交），挂单变少时顺手刷新账户、持仓、部署；
// - 账户、持仓按现价估值，页面开着时几秒重取一次；
// - 熔断、解除靠内核事件 trade.halted / trade.halt_released 刷新，事件流断开时退回定时重取。
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'
import { isApiError, request, requestEnvelope, requestList } from '../api'
import { errorText } from './errors'
import { onServerEvent, useEventsLive, type ServerEvent } from './events'
import type { TradeMarket } from './trade'

export type TradeAccount = {
  id: string
  name: string
  broker: string
  kind: string
  markets: TradeMarket[]
  paper: boolean
  currency: string
  equity: number
  available: number
  margin_used: number
  status: string
  error?: string
  api_hint: string
  permissions: string[]
  /** 这次估值的时间 */
  updated_at: string
  initial: number
  /** initial + realized_pnl − fees */
  balance: number
  realized_pnl: number
  unrealized_pnl: number
  fees: number
  /** 开仓挂单的占用 */
  order_hold: number
  fee_bp: number
  slippage_ticks: number
  /** live 持仓现价都是实时的；stale 有的按缓存或均价估 */
  marks_status: 'live' | 'stale'
  created_at: string
  // 下面只有实盘账户有（TRD-07a、TRD-08b）
  connector_id?: string
  /** 最近一次查到的 Key 权限 */
  key_permissions?: string[]
  /** 用户要不要交易权限（只记意愿，实盘下单没上线） */
  want_trade?: boolean
  /** 最近一次同步成功的时间 */
  synced_at?: string
  recon?: TradeReconBrief
}

/** 账户卡片上的「对账」一行（TradeAccount.recon），实盘账户才有 */
export type TradeReconBrief = { status: 'ok' | 'diff' | 'failed' | 'none'; at?: string; open: number; error?: string }

export type TradeAccountInput = { name?: string; currency?: string; initial?: number; markets?: TradeMarket[]; fee_bp?: number; slippage_ticks?: number }

export type TradeOrderSide = 'buy' | 'sell'
export type TradeOrderType = 'market' | 'limit' | 'stop' | 'stop_limit'
/** 后端没有 pending（下单当场检查完）；partial 预留，模拟撮合一次全部成交 */
export type TradeOrderStatus = 'open' | 'partial' | 'filled' | 'canceled' | 'rejected'
export type TradeOrderSource = 'manual' | 'close' | 'run' | 'liquidation'

export type TradeOrder = {
  id: string
  account_id: string
  symbol: string
  side: TradeOrderSide
  type: TradeOrderType
  qty: number
  price?: number
  stop_price?: number
  filled: number
  avg_fill?: number
  status: TradeOrderStatus
  reject_reason?: string
  reduce_only: boolean
  run_id?: string
  created_at: string
  updated_at: string
  leverage: number
  fee: number
  source: TradeOrderSource
  /** 止损限价已触发 */
  triggered: boolean
  confirmed: boolean
}

export type TradeOrderInput = {
  account_id: string
  symbol: string
  side: TradeOrderSide
  type: TradeOrderType
  qty: number
  price?: number
  stop_price?: number
  leverage?: number
  reduce_only?: boolean
  confirmed?: boolean
}

export type TradeOrderQuery = { account_id?: string; status?: 'active' | 'history' | TradeOrderStatus; run_id?: string; symbol?: string; limit?: number }
export type TradeOrderPage = { data: TradeOrder[]; total: number; active: number; history: number }

export type TradePosition = {
  id: string
  account_id: string
  symbol: string
  name: string
  side: 'long' | 'short'
  qty: number
  avg_price: number
  leverage?: number
  liq_price?: number
  run_id?: string
  opened_at: string
  cost: number
  margin: number
  /** 现价；行情缓存里没有时为 0（盈亏按均价估） */
  last: number
  value: number
  pnl: number
  /** pnl / margin，小数 */
  pct: number
  mark_status: string
  mark_at: string
}

export type TradeRunStatus = 'running' | 'paused' | 'stopped' | 'error'
export type TradeRunLog = { at: string; level: 'info' | 'warn' | 'error'; text: string }
export type TradeRunHolding = { symbol: string; side: 'long' | 'short'; qty: number; avg_price: number }

export type TradeRun = {
  id: string
  strategy_id: string
  account_id: string
  symbols: string[]
  params: Record<string, number>
  capital: number
  status: TradeRunStatus
  error?: string
  /** realized_pnl − fees + unrealized_pnl */
  pnl: number
  started_at: string
  stopped_at?: string
  stop_reason?: string
  /** 按时间正序；列表里最近 60 条，详情最近 500 条 */
  logs: TradeRunLog[]
  log_total: number
  /** 部署时的策略快照 */
  strategy_name: string
  interval: string
  realized_pnl: number
  unrealized_pnl: number
  fees: number
  holdings: TradeRunHolding[]
  updated_at: string
}

export type TradeRunInput = { strategy_id: string; account_id: string; symbols?: string[]; params?: Record<string, number>; capital?: number }
export type TradeRunPage = { data: TradeRun[]; total: number; running: number; paused: number; stopped: number; error: number; pnl: number }

export type TradeRiskDay = {
  date: string
  start_equity: number
  equity: number
  pnl: number
  loss_used: number
  loss_limit: number
  /** stale：有持仓的现价不是实时，这一刻不判定日亏损 */
  status: 'ok' | 'stale'
}

export type TradeRiskRules = {
  max_position_pct: number
  daily_loss_pct: number
  max_order_value: number
  max_leverage: number
  confirm_above: number
}

export type TradeRisk = TradeRiskRules & {
  halted: boolean
  halted_reason?: string
  halted_at?: string
  halt_id?: string
  updated_at: string
  day: TradeRiskDay
}

export type TradeKillResult = {
  halted: boolean
  reason: string
  at: string
  halt_id: string
  kind: 'manual' | 'auto'
  runs_stopped: number
  orders_canceled: number
  remaining_runs: string[]
  remaining_orders: string[]
  failed: string[]
}

export type TradeHalt = {
  id: string
  kind: 'manual' | 'auto'
  reason: string
  at: string
  runs_stopped: number
  orders_canceled: number
  released_at?: string
  release_reason?: string
}

/** 下单（含平仓、挂止损）被拦时的三种情况；接口返回 409 时 error 里带的字段 */
export type TradePlaceError =
  | { kind: 'risk'; message: string; blocks: string[]; order?: TradeOrder }
  | { kind: 'confirm'; message: string; value: number; confirm_above: number }
  | { kind: 'other'; message: string; reason?: string }

/** 把下单、平仓、部署的错误拆开：风控拦截（原样逐条）、要二次确认、其他（熔断中不能部署、状态不对等） */
export function tradePlaceError(e: unknown): TradePlaceError {
  if (isApiError(e) && e.status === 409) {
    const x = e.extra
    if (x.reason === 'risk') {
      const blocks = Array.isArray(x.blocks) ? x.blocks.map(String) : []
      return { kind: 'risk', message: e.message, blocks: blocks.length ? blocks : [e.message], order: x.order as TradeOrder | undefined }
    }
    if (x.reason === 'confirm') {
      return { kind: 'confirm', message: e.message, value: Number(x.value) || 0, confirm_above: Number(x.confirm_above) || 0 }
    }
    return { kind: 'other', message: e.message, reason: typeof x.reason === 'string' ? x.reason : undefined }
  }
  return { kind: 'other', message: errorText(e) }
}

/** 一键全停没做完（500）时 error.result 带回的部分结果 */
export function tradeKillPartial(e: unknown): TradeKillResult | undefined {
  if (isApiError(e) && e.extra.result && typeof e.extra.result === 'object') return e.extra.result as TradeKillResult
  return undefined
}

export const tradePaperKeys = {
  all: ['trade', 'paper'] as const,
  accounts: ['trade', 'paper', 'accounts'] as const,
  orders: ['trade', 'paper', 'orders'] as const,
  orderList: (q: TradeOrderQuery) => ['trade', 'paper', 'orders', q] as const,
  positions: ['trade', 'paper', 'positions'] as const,
  runs: ['trade', 'paper', 'runs'] as const,
  runList: (strategyId: string) => ['trade', 'paper', 'runs', 'list', strategyId] as const,
  run: (id: string) => ['trade', 'paper', 'runs', 'one', id] as const,
  risk: ['trade', 'paper', 'risk'] as const,
  halts: ['trade', 'paper', 'halts'] as const,
}

const seg = encodeURIComponent

function orderQuery(q: TradeOrderQuery) {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== '') p.set(k, String(v))
  return p
}

export const tradePaperApi = {
  accounts: () => requestList<TradeAccount>('/api/trade/accounts').then((r) => r.data),
  createAccount: (body: TradeAccountInput = {}) => request<TradeAccount>('POST', '/api/trade/accounts', { body }),
  orders: async (q: TradeOrderQuery): Promise<TradeOrderPage> => {
    const r = await requestEnvelope<TradeOrder[] | null>('GET', '/api/trade/orders', { query: orderQuery(q) })
    const meta = (r.meta ?? {}) as { total?: number; active?: number; history?: number }
    const data = r.data ?? []
    return { data, total: meta.total ?? data.length, active: meta.active ?? 0, history: meta.history ?? 0 }
  },
  placeOrder: (body: TradeOrderInput) => request<TradeOrder>('POST', '/api/trade/orders', { body }),
  modifyOrder: (id: string, body: { price?: number; stop_price?: number }) => request<TradeOrder>('PATCH', '/api/trade/orders/' + seg(id), { body }),
  cancelOrder: (id: string) => request<TradeOrder>('POST', `/api/trade/orders/${seg(id)}/cancel`),
  cancelAll: (accountId?: string) => request<{ canceled: number }>('POST', '/api/trade/orders/cancel-all', { body: accountId ? { account_id: accountId } : {} }),
  positions: (accountId?: string) =>
    requestList<TradePosition>('/api/trade/positions', { query: accountId ? new URLSearchParams({ account_id: accountId }) : undefined }).then((r) => r.data),
  closePosition: (id: string, body: { type?: TradeOrderType; price?: number; stop_price?: number; confirmed?: boolean } = {}) =>
    request<TradeOrder>('POST', `/api/trade/positions/${seg(id)}/close`, { body }),
  runs: async (strategyId = ''): Promise<TradeRunPage> => {
    const r = await requestEnvelope<TradeRun[] | null>('GET', '/api/trade/runs', { query: strategyId ? new URLSearchParams({ strategy_id: strategyId }) : undefined })
    const m = (r.meta ?? {}) as Partial<Omit<TradeRunPage, 'data'>>
    const data = r.data ?? []
    return {
      data, total: m.total ?? data.length, running: m.running ?? 0, paused: m.paused ?? 0, stopped: m.stopped ?? 0, error: m.error ?? 0,
      pnl: m.pnl ?? data.reduce((s, x) => s + x.pnl, 0),
    }
  },
  run: (id: string) => request<TradeRun>('GET', '/api/trade/runs/' + seg(id)),
  createRun: (body: TradeRunInput) => request<TradeRun>('POST', '/api/trade/runs', { body }),
  runAction: (id: string, action: 'pause' | 'resume' | 'stop', reason?: string) =>
    request<TradeRun>('POST', `/api/trade/runs/${seg(id)}/${action}`, { body: action === 'stop' && reason ? { reason } : {} }),
  risk: () => request<TradeRisk>('GET', '/api/trade/risk'),
  patchRisk: (body: Partial<TradeRiskRules>) => request<TradeRisk>('PATCH', '/api/trade/risk', { body }),
  kill: (reason?: string) => request<TradeKillResult>('POST', '/api/trade/risk/kill', { body: reason ? { reason } : {} }),
  release: (reason: string) => request<TradeRisk>('POST', '/api/trade/risk/release', { body: { reason } }),
  halts: () => requestList<TradeHalt>('/api/trade/risk/halts').then((r) => r.data),
}

/** 账户、持仓按现价估值，这么久重取一次 */
const VALUE_MS = 3_000
/** 有挂单时委托的重取间隔 */
const ORDER_MS = 1_000
/** 有运行中的部署时（日志、盈亏）的重取间隔 */
const RUN_MS = 5_000
/** 事件流断开时风控、熔断记录的退回轮询 */
const FALLBACK_MS = 10_000

export const useTradeAccounts = () => useQuery({ queryKey: tradePaperKeys.accounts, queryFn: tradePaperApi.accounts, refetchInterval: VALUE_MS })

export const useTradePositions = () => useQuery({ queryKey: tradePaperKeys.positions, queryFn: () => tradePaperApi.positions(), refetchInterval: VALUE_MS })

/** 委托：只在有挂单时每秒重取，没有挂单时不轮询 */
export function useTradeOrders(q: TradeOrderQuery, enabled = true) {
  return useQuery({
    queryKey: tradePaperKeys.orderList(q),
    queryFn: () => tradePaperApi.orders(q),
    enabled,
    placeholderData: (prev) => prev,
    refetchInterval: (x) => (x.state.data?.active ? ORDER_MS : false),
  })
}

/**
 * 挂单数变少（成交、撤单、被拒）时刷新账户、持仓、部署：成交改的是它们。
 * active 是任意一个委托查询 meta 里的挂单数。
 */
export function useTradeFillWatch(active: number | undefined) {
  const qc = useQueryClient()
  const prev = useRef(active)
  useEffect(() => {
    const was = prev.current
    prev.current = active
    if (was !== undefined && active !== undefined && active < was) {
      void qc.invalidateQueries({ queryKey: tradePaperKeys.accounts })
      void qc.invalidateQueries({ queryKey: tradePaperKeys.positions })
      void qc.invalidateQueries({ queryKey: tradePaperKeys.runs })
    }
  }, [active, qc])
}

/** 部署列表；strategyId 给了只取这个策略的。有运行中的时 5 秒重取（信号、成交日志），否则 30 秒 */
export function useTradeRuns(strategyId = '') {
  return useQuery({
    queryKey: tradePaperKeys.runList(strategyId),
    queryFn: () => tradePaperApi.runs(strategyId),
    refetchInterval: (x) => (x.state.data?.running ? RUN_MS : 30_000),
  })
}

/** 一个部署的详情（最近 500 条日志），展开全部日志时取 */
export function useTradeRun(id: string, enabled = true) {
  return useQuery({ queryKey: tradePaperKeys.run(id), queryFn: () => tradePaperApi.run(id), enabled: enabled && !!id, refetchInterval: RUN_MS })
}

/** 风控规则、熔断状态和当日亏损；当日亏损跟着现价变，几秒取一次 */
export const useTradeRisk = () => useQuery({ queryKey: tradePaperKeys.risk, queryFn: tradePaperApi.risk, refetchInterval: VALUE_MS })

export function useTradeHalts() {
  const live = useEventsLive()
  return useQuery({ queryKey: tradePaperKeys.halts, queryFn: tradePaperApi.halts, refetchInterval: live ? false : FALLBACK_MS })
}

/** 熔断、解除（手动一键全停或日亏损自动熔断）后把交易相关的都刷新一遍 */
export function useTradeHaltEvents(onEvent?: (e: ServerEvent) => void) {
  const qc = useQueryClient()
  const cb = useRef(onEvent)
  useEffect(() => { cb.current = onEvent })
  useEffect(() => {
    const h = (e: ServerEvent) => {
      void qc.invalidateQueries({ queryKey: tradePaperKeys.all })
      cb.current?.(e)
    }
    const offs = [onServerEvent('trade.halted', h), onServerEvent('trade.halt_released', h)]
    return () => offs.forEach((f) => f())
  }, [qc])
}

function usePaperMutation<A, R>(fn: (a: A) => Promise<R>) {
  const qc = useQueryClient()
  return useMutation({ mutationFn: fn, onSettled: () => qc.invalidateQueries({ queryKey: tradePaperKeys.all }) })
}

export const useCreateTradeAccount = () => usePaperMutation((body: TradeAccountInput | void) => tradePaperApi.createAccount(body ?? {}))
/** 下单；409 也刷新（风控拦下的委托记成了被拒绝） */
export const usePlaceTradeOrder = () => usePaperMutation(tradePaperApi.placeOrder)
export const useModifyTradeOrder = () =>
  usePaperMutation(({ id, ...body }: { id: string; price?: number; stop_price?: number }) => tradePaperApi.modifyOrder(id, body))
export const useCancelTradeOrder = () => usePaperMutation(tradePaperApi.cancelOrder)
export const useCancelAllTradeOrders = () => usePaperMutation((accountId?: string) => tradePaperApi.cancelAll(accountId))
export const useCloseTradePosition = () =>
  usePaperMutation(({ id, ...body }: { id: string; type?: TradeOrderType; stop_price?: number; confirmed?: boolean }) => tradePaperApi.closePosition(id, body))
export const useCreateTradeRun = () => usePaperMutation(tradePaperApi.createRun)
export const useTradeRunAction = () =>
  usePaperMutation(({ id, action, reason }: { id: string; action: 'pause' | 'resume' | 'stop'; reason?: string }) => tradePaperApi.runAction(id, action, reason))

export function usePatchTradeRisk() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: tradePaperApi.patchRisk,
    onSuccess: (r) => qc.setQueryData(tradePaperKeys.risk, r),
    onSettled: () => qc.invalidateQueries({ queryKey: tradePaperKeys.risk }),
  })
}
export const useKillTrading = () => usePaperMutation((reason?: string) => tradePaperApi.kill(reason))
export const useReleaseHalt = () => usePaperMutation(tradePaperApi.release)
