// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 策略与回测（TRD-04b 后端、TRD-04c 前端）：策略、回测记录、参数扫描、对比。契约见 docs/api-contract.md「交易套件插件 trade / 策略和回测」。
// 回测只在后端跑（排队、取真实历史 K 线、算结果、落库），前端只发起和展示；进度靠轮询：
// 列表或详情里有排队中、运行中的回测时每秒重取一次，都跑完就停。
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { request, requestEnvelope, requestList } from '../api'
import type { TradeInterval } from './trade'

export type TradeIndicator = 'price' | 'ma' | 'ema' | 'rsi' | 'macd' | 'boll_up' | 'boll_low' | 'volume' | 'atr'
export type TradeCompare = 'cross_up' | 'cross_down' | 'gt' | 'lt'
export type TradeOperand = { kind: 'ind'; ind: TradeIndicator; params: number[] } | { kind: 'num'; value: number }
export type TradeRule = { id: string; left: TradeOperand; op: TradeCompare; right: TradeOperand }
export type TradeRuleGroup = { logic: 'all' | 'any'; rules: TradeRule[] }
export type TradeStrategyMode = 'rules' | 'code'
export type TradeDirection = 'long' | 'short' | 'both'

export type TradeStrategy = {
  id: string
  name: string
  desc: string
  mode: TradeStrategyMode
  symbols: string[]
  interval: TradeInterval
  direction: TradeDirection
  entry: TradeRuleGroup
  exit: TradeRuleGroup
  /** 止损、止盈（%，0 表示不设） */
  stop_loss: number
  take_profit: number
  /** 每次开仓占账户 % */
  position_pct: number
  /** 代码模式的源码；后端不执行，按内置近似回测 */
  code: string
  /** 可调参数；键的顺序有意义（值相同的取先出现的），后端原样保留 */
  params: Record<string, number>
  tags: string[]
  updated_at: string
  created_at: string
}

/** POST、PATCH 能写的字段 */
export type TradeStrategyInput = Partial<Omit<TradeStrategy, 'id' | 'updated_at' | 'created_at'>>

export type TradeBacktestStatus = 'queued' | 'running' | 'done' | 'failed'

export type TradeBacktestConfig = {
  strategy_id: string
  symbols: string[]
  interval: TradeInterval
  bars: number
  capital: number
  fee_bp: number
  slippage_ticks: number
  params: Record<string, number>
}

export type TradeBacktestTrade = { t: number; symbol: string; side: 'buy' | 'sell'; price: number; qty: number; pnl?: number; reason: string }
export type TradeBacktestStats = {
  total_return: number; annual: number; max_dd: number; sharpe: number; win_rate: number; trades: number; profit_factor: number; bench_return: number
}
export type TradeEquityPoint = { t: number; v: number; bench: number }
export type TradeBacktestResult = { equity: TradeEquityPoint[]; trades: TradeBacktestTrade[]; stats: TradeBacktestStats; note?: string }
export type TradeSweepPoint = { value: number; total_return: number; max_dd: number; sharpe: number }
export type TradeSweep = { param: string; points: TradeSweepPoint[]; at: string }

type BacktestBase = {
  id: string
  name: string
  config: TradeBacktestConfig
  status: TradeBacktestStatus
  /** 0 到 1 */
  progress: number
  /** 发起那一刻的策略副本 */
  strategy_snapshot: TradeStrategy
  /** 失败原因，开头是「数据缺失：」「参数不合法：」「引擎错误：」「回测被中断：」之一 */
  error?: string
  created_at: string
  started_at?: string
  finished_at?: string
  /** 实际回测区间第一根、最后一根 K 线的开盘时间 */
  data_from?: string
  data_to?: string
}
export type TradeBacktest = BacktestBase & { result?: TradeBacktestResult; sweep?: TradeSweep }
/** 列表里的一条：不带资金曲线、成交和扫描 */
export type TradeBacktestBrief = BacktestBase & { stats?: TradeBacktestStats; note?: string }

export type TradeBacktestStart = {
  strategy_id: string
  bars?: number
  capital?: number
  fee_bp?: number
  slippage_ticks?: number
  params?: Record<string, number>
}

export const tradeStrategyKeys = {
  strategies: ['trade', 'strategies'] as const,
  strategy: (id: string) => ['trade', 'strategies', id] as const,
  backtests: ['trade', 'backtests'] as const,
  backtest: (id: string) => ['trade', 'backtests', 'one', id] as const,
  compare: (ids: string[]) => ['trade', 'backtests', 'compare', ids.join(',')] as const,
}

const seg = encodeURIComponent

export const tradeStrategyApi = {
  strategies: () => requestList<TradeStrategy>('/api/trade/strategies').then((r) => r.data),
  strategy: (id: string) => request<TradeStrategy>('GET', '/api/trade/strategies/' + seg(id)),
  createStrategy: (body: TradeStrategyInput = {}) => request<TradeStrategy>('POST', '/api/trade/strategies', { body }),
  patchStrategy: (id: string, body: TradeStrategyInput) => request<TradeStrategy>('PATCH', '/api/trade/strategies/' + seg(id), { body }),
  removeStrategy: (id: string) => request<null>('DELETE', '/api/trade/strategies/' + seg(id)),
  backtests: () => requestList<TradeBacktestBrief>('/api/trade/backtests').then((r) => r.data),
  backtest: (id: string) => request<TradeBacktest>('GET', '/api/trade/backtests/' + seg(id)),
  compare: (ids: string[]) =>
    requestList<TradeBacktest>('/api/trade/backtests/compare', { query: new URLSearchParams({ ids: ids.join(',') }) }).then((r) => r.data),
  startBacktest: (body: TradeBacktestStart) => request<TradeBacktest>('POST', '/api/trade/backtests', { body }),
  rerunBacktest: (id: string, params?: Record<string, number>) =>
    request<TradeBacktest>('POST', `/api/trade/backtests/${seg(id)}/rerun`, { body: params ? { params } : {} }),
  removeBacktest: (id: string) => request<null>('DELETE', '/api/trade/backtests/' + seg(id)),
  sweep: async (id: string, param: string, values: number[]) =>
    (await requestEnvelope<TradeSweep>('POST', `/api/trade/backtests/${seg(id)}/sweep`, { body: { param, values } })).data,
}

const POLL_MS = 1_000
const IDLE_MS = 30_000
const busy = (s: TradeBacktestStatus) => s === 'queued' || s === 'running'

export const useTradeStrategies = () => useQuery({ queryKey: tradeStrategyKeys.strategies, queryFn: tradeStrategyApi.strategies })

/** 回测记录：有排队、运行中的时每秒重取（进度），否则 30 秒一次 */
export const useTradeBacktests = () =>
  useQuery({
    queryKey: tradeStrategyKeys.backtests,
    queryFn: tradeStrategyApi.backtests,
    refetchInterval: (q) => (q.state.data?.some((b) => busy(b.status)) ? POLL_MS : IDLE_MS),
  })

/** 一条回测的完整结果；没跑完时每秒重取 */
export function useTradeBacktest(id: string, enabled = true) {
  return useQuery({
    queryKey: tradeStrategyKeys.backtest(id),
    queryFn: () => tradeStrategyApi.backtest(id),
    enabled: enabled && !!id,
    refetchInterval: (q) => (q.state.data && busy(q.state.data.status) ? POLL_MS : false),
  })
}

/** 对比用：2 到 4 条已完成的完整结果 */
export function useTradeBacktestCompare(ids: string[]) {
  return useQuery({
    queryKey: tradeStrategyKeys.compare(ids),
    queryFn: () => tradeStrategyApi.compare(ids),
    enabled: ids.length >= 2,
    staleTime: 5 * 60_000,
  })
}

function useInvalidate() {
  const qc = useQueryClient()
  return {
    qc,
    strategies: () => qc.invalidateQueries({ queryKey: tradeStrategyKeys.strategies }),
    backtests: () => qc.invalidateQueries({ queryKey: tradeStrategyKeys.backtests }),
  }
}

/** 把保存回来的策略写进列表缓存，不等重取 */
function putStrategy(qc: ReturnType<typeof useQueryClient>, st: TradeStrategy) {
  qc.setQueryData<TradeStrategy[]>(tradeStrategyKeys.strategies, (list) => {
    if (!list) return list
    return list.some((x) => x.id === st.id) ? list.map((x) => (x.id === st.id ? st : x)) : [st, ...list]
  })
}

export function useCreateTradeStrategy() {
  const inv = useInvalidate()
  return useMutation({
    mutationFn: (body: TradeStrategyInput | void) => tradeStrategyApi.createStrategy(body ?? {}),
    onSuccess: (st) => putStrategy(inv.qc, st),
    onSettled: inv.strategies,
  })
}

/** 自动保存：只把服务端回来的写进缓存，编辑中的界面以本地草稿为准 */
export function usePatchTradeStrategy() {
  const inv = useInvalidate()
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: TradeStrategyInput }) => tradeStrategyApi.patchStrategy(id, body),
    onSuccess: (st) => putStrategy(inv.qc, st),
  })
}

export function useRemoveTradeStrategy() {
  const inv = useInvalidate()
  return useMutation({
    mutationFn: (id: string) => tradeStrategyApi.removeStrategy(id),
    onSuccess: (_, id) => inv.qc.setQueryData<TradeStrategy[]>(tradeStrategyKeys.strategies, (l) => l?.filter((x) => x.id !== id)),
    onSettled: inv.strategies,
  })
}

/** 新的回测先放进列表缓存（排队中），马上开始轮询 */
function putBacktest(qc: ReturnType<typeof useQueryClient>, b: TradeBacktest) {
  const { result: _r, sweep: _s, ...brief } = b
  qc.setQueryData<TradeBacktestBrief[]>(tradeStrategyKeys.backtests, (list) => (list ? [brief, ...list.filter((x) => x.id !== b.id)] : list))
  qc.setQueryData(tradeStrategyKeys.backtest(b.id), b)
}

export function useStartTradeBacktest() {
  const inv = useInvalidate()
  return useMutation({
    mutationFn: (body: TradeBacktestStart) => tradeStrategyApi.startBacktest(body),
    onSuccess: (b) => putBacktest(inv.qc, b),
    onSettled: inv.backtests,
  })
}

export function useRerunTradeBacktest() {
  const inv = useInvalidate()
  return useMutation({
    mutationFn: ({ id, params }: { id: string; params?: Record<string, number> }) => tradeStrategyApi.rerunBacktest(id, params),
    onSuccess: (b) => putBacktest(inv.qc, b),
    onSettled: inv.backtests,
  })
}

export function useRemoveTradeBacktest() {
  const inv = useInvalidate()
  return useMutation({
    mutationFn: (id: string) => tradeStrategyApi.removeBacktest(id),
    onSuccess: (_, id) => inv.qc.setQueryData<TradeBacktestBrief[]>(tradeStrategyKeys.backtests, (l) => l?.filter((x) => x.id !== id)),
    onSettled: inv.backtests,
  })
}

/** 参数扫描：后端按同一段数据跑完，结果留在这条回测上 */
export function useSweepTradeBacktest() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, param, values }: { id: string; param: string; values: number[] }) => tradeStrategyApi.sweep(id, param, values),
    onSuccess: (sw, { id }) => qc.setQueryData<TradeBacktest>(tradeStrategyKeys.backtest(id), (b) => (b ? { ...b, sweep: sw } : b)),
  })
}
