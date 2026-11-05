// 宽基监控插件 etf（ETF-01a 起，ETF-01b 加指标、异动、规则）：宽基清单、每日快照、派生指标、命中记录、异动规则。
// 契约见 docs/api-contract.md「宽基监控插件 etf」。只读公开数据，没有任何交易相关的接口。
// 写操作（采集、确认或忽略、改规则）成功后整个 etf 前缀一起刷：采集会改快照、指标和命中，改规则后下次采集才重判。
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { request, requestList } from '../api'

export type EtfFund = {
  symbol: string
  name: string
  track_index: string
  category: string
  manager: string
  market: string
  secid: string
  /** 跟踪指数代码（000300） */
  underlying: string
  launch_date: string
  updated_at: string
}

export type EtfPremiumBasis = 'iopv' | 'nav' | 'none' | ''

export type EtfDaily = {
  date: string
  symbol: string
  /** 份 */
  shares: number
  nav: number
  price: number
  open: number
  high: number
  low: number
  volume: number
  /** 元 */
  amount: number
  change_pct: number
  change_amount: number
  amplitude: number
  turnover_rate: number
  aum: number
  premium_discount: number
  iopv: number
  premium_basis: EtfPremiumBasis
  source: string
  updated_at: string
}

/** 派生指标；样本不足的为 null */
export type EtfMetrics = {
  date: string
  symbol: string
  share_change_pct: number | null
  net_inflow: number | null
  /** 正数连续净流入天数，负数连续净流出 */
  inflow_streak: number
  amount_ratio: number | null
  share_pctile: number | null
  aum_pctile: number | null
  premium_pctile: number | null
  tracking_error: number | null
  excess_return: number | null
  aum_change_pct: number | null
  premium_discount: number | null
  premium_basis: EtfPremiumBasis
  /** pending_review：份额跳变没有行情配合，待核 */
  review_flag: string
  updated_at: string
}

export type EtfSeverity = 'info' | 'warn' | 'critical'
export type EtfAnomalyStatus = 'open' | 'acked' | 'ignored'
export type EtfOperator = 'gt' | 'gte' | 'lt' | 'lte' | 'abs_gt'
export type EtfScope = 'all' | 'symbol' | 'index'

export type EtfAnomaly = {
  id: string
  date: string
  symbol: string
  fund_name: string
  rule_id: string
  rule_name: string
  metric: string
  value: number
  threshold: number
  operator: EtfOperator
  severity: EtfSeverity
  status: EtfAnomalyStatus
  flag: string
  detail: string
  created_at: string
  updated_at: string
  handled_at: string
}

export type EtfRule = {
  id: string
  name: string
  scope: EtfScope
  scope_value: string
  metric: string
  operator: EtfOperator
  threshold: number
  window_days: number
  severity: EtfSeverity
  enabled: boolean
  builtin: boolean
  created_at: string
  updated_at: string
}

export type EtfRuleInput = {
  name: string
  metric: string
  operator: EtfOperator
  threshold: number
  scope?: EtfScope
  scope_value?: string
  window_days?: number
  severity?: EtfSeverity
  enabled?: boolean
}
export type EtfRulePatch = Partial<EtfRuleInput>

export type EtfCollectResult = {
  date: string
  source: string
  upserted: number
  skipped: number
  indexes: number
  metrics: number
  hits: number
  new_hits: number
  errors: string[]
}

export type EtfAnomalyFilter = { severity?: EtfSeverity; status?: EtfAnomalyStatus; symbol?: string; date?: string }

export const etfKeys = {
  all: ['etf'] as const,
  funds: ['etf', 'funds'] as const,
  daily: (from: string) => ['etf', 'daily', from] as const,
  metrics: (from: string) => ['etf', 'metrics', from] as const,
  anomalies: (f: EtfAnomalyFilter) => ['etf', 'anomalies', f] as const,
  rules: ['etf', 'rules'] as const,
}

const base = '/api/etf'

function qs(params: Record<string, string | number | undefined>) {
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') q.set(k, String(v))
  return q
}

export const etfApi = {
  funds: async (signal?: AbortSignal) => (await requestList<EtfFund>(`${base}/funds`, { signal })).data,
  daily: async (from: string, signal?: AbortSignal) =>
    (await requestList<EtfDaily>(`${base}/daily`, { query: qs({ from, limit: 5000 }), signal })).data,
  metrics: async (from: string, signal?: AbortSignal) =>
    (await requestList<EtfMetrics>(`${base}/metrics`, { query: qs({ from, limit: 5000 }), signal })).data,
  anomalies: async (f: EtfAnomalyFilter, signal?: AbortSignal) =>
    (await requestList<EtfAnomaly>(`${base}/anomalies`, { query: qs({ ...f, limit: 500 }), signal })).data,
  ack: (id: string, status: EtfAnomalyStatus) =>
    request<EtfAnomaly>('POST', `${base}/anomalies/${encodeURIComponent(id)}/ack`, { body: { status } }),
  rules: async (signal?: AbortSignal) => (await requestList<EtfRule>(`${base}/rules`, { signal })).data,
  createRule: (body: EtfRuleInput) => request<EtfRule>('POST', `${base}/rules`, { body }),
  patchRule: (id: string, body: EtfRulePatch) => request<EtfRule>('PATCH', `${base}/rules/${encodeURIComponent(id)}`, { body }),
  collect: (date?: string) => request<EtfCollectResult>('POST', `${base}/collect`, { body: date ? { date } : {} }),
}

export function useEtfFunds() {
  return useQuery({ queryKey: etfKeys.funds, queryFn: ({ signal }) => etfApi.funds(signal) })
}

/** from 起的每日快照，按日期倒序 */
export function useEtfDaily(from: string) {
  return useQuery({ queryKey: etfKeys.daily(from), queryFn: ({ signal }) => etfApi.daily(from, signal) })
}

/** from 起的派生指标，按日期正序 */
export function useEtfMetrics(from: string) {
  return useQuery({ queryKey: etfKeys.metrics(from), queryFn: ({ signal }) => etfApi.metrics(from, signal) })
}

export function useEtfAnomalies(f: EtfAnomalyFilter) {
  return useQuery({ queryKey: etfKeys.anomalies(f), queryFn: ({ signal }) => etfApi.anomalies(f, signal) })
}

export function useEtfRules() {
  return useQuery({ queryKey: etfKeys.rules, queryFn: ({ signal }) => etfApi.rules(signal) })
}

function useEtfMutation<V, R>(fn: (v: V) => Promise<R>) {
  const qc = useQueryClient()
  return useMutation({ mutationFn: fn, onSuccess: () => qc.invalidateQueries({ queryKey: etfKeys.all }) })
}

/** 确认（acked）、忽略（ignored）或撤回（open） */
export const useAckEtfAnomaly = () => useEtfMutation(({ id, status }: { id: string; status: EtfAnomalyStatus }) => etfApi.ack(id, status))
export const useCreateEtfRule = () => useEtfMutation((body: EtfRuleInput) => etfApi.createRule(body))
export const usePatchEtfRule = () => useEtfMutation(({ id, patch }: { id: string; patch: EtfRulePatch }) => etfApi.patchRule(id, patch))
/** 立即采集最近交易日，采集后后端算指标、跑规则 */
export const useCollectEtf = () => useEtfMutation((date?: string) => etfApi.collect(date))
