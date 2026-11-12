// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 宽基监控页的纯函数（ETF-01b，SPEC-etf）：文案、数字格式、按只汇总最新一天、迷你折线的点。
import type {
  EtfAnomalyStatus, EtfDaily, EtfFund, EtfMetrics, EtfOperator, EtfPremiumBasis, EtfRule, EtfScope, EtfSeverity,
} from '../../core/data'

export const SEVERITY: Record<EtfSeverity, { label: string; color: string; rank: number }> = {
  critical: { label: '严重', color: 'var(--danger)', rank: 0 },
  warn: { label: '警告', color: 'var(--warn)', rank: 1 },
  info: { label: '提示', color: 'var(--accent)', rank: 2 },
}

export const STATUS: Record<EtfAnomalyStatus, string> = { open: '未处理', acked: '已确认', ignored: '已忽略' }

export const BASIS: Record<Exclude<EtfPremiumBasis, ''>, string> = { iopv: 'IOPV', nav: '净值', none: '不可用' }

export const OPERATORS: Record<EtfOperator, string> = { gt: '>', gte: '≥', lt: '<', lte: '≤', abs_gt: '绝对值 >' }

export const SCOPES: Record<EtfScope, string> = { all: '全部', symbol: '某只 ETF', index: '某个跟踪指数' }

/** 规则能用的指标，同后端 MetricCatalog */
export const METRICS: Record<string, { label: string; unit: string }> = {
  share_change_pct: { label: '份额日变动', unit: '%' },
  net_inflow: { label: '估算净流入', unit: '元' },
  inflow_streak: { label: '连续净流入天数', unit: '天' },
  amount_ratio: { label: '量比', unit: '倍' },
  premium_discount: { label: '折溢价', unit: '%' },
  aum_change_pct: { label: '规模日变动', unit: '%' },
  tracking_error: { label: '跟踪误差（20 日年化）', unit: '%' },
  excess_return: { label: '超额收益（20 日）', unit: '%' },
  share_pctile: { label: '份额历史分位', unit: '' },
  aum_pctile: { label: '规模历史分位', unit: '' },
  premium_pctile: { label: '折溢价历史分位', unit: '' },
}

export const REVIEW_PENDING = 'pending_review'

export const metricLabel = (m: string) => METRICS[m]?.label ?? m

/** 规则条件一句话：「份额日变动 绝对值 > 2%」 */
export function ruleCond(r: Pick<EtfRule, 'metric' | 'operator' | 'threshold'>): string {
  const unit = METRICS[r.metric]?.unit ?? ''
  return `${metricLabel(r.metric)} ${OPERATORS[r.operator] ?? r.operator} ${fmtUnit(r.threshold, unit)}`
}

export function fmtUnit(v: number, unit: string): string {
  if (unit === '元') return fmtMoney(v)
  if (unit === '天') return `${v} 天`
  if (unit === '倍') return `${v} 倍`
  if (unit === '%') return `${v.toFixed(2)}%`
  return `${v}${unit}`
}

export function scopeText(r: Pick<EtfRule, 'scope' | 'scope_value'>, funds: readonly EtfFund[] = []): string {
  if (r.scope === 'symbol') {
    const f = funds.find((x) => x.symbol === r.scope_value)
    return f ? `${f.symbol} ${f.name}` : r.scope_value
  }
  if (r.scope === 'index') {
    const f = funds.find((x) => x.underlying === r.scope_value || x.track_index === r.scope_value)
    return f ? `跟踪${f.track_index}` : `跟踪 ${r.scope_value}`
  }
  return '全部'
}

/** 元换成「亿元 / 万元」，带符号 */
export function fmtMoney(v: number): string {
  const a = Math.abs(v)
  if (a >= 1e8) return `${(v / 1e8).toFixed(2)} 亿元`
  if (a >= 1e4) return `${(v / 1e4).toFixed(2)} 万元`
  return `${v.toFixed(0)} 元`
}

export const fmtPct = (v: number | null | undefined, digits = 2, signed = true) =>
  v == null ? '—' : `${signed && v > 0 ? '+' : ''}${v.toFixed(digits)}%`

export const fmtShares = (v: number) => (v > 0 ? `${(v / 1e8).toFixed(2)} 亿份` : '—')

export function streakText(n: number): string {
  if (n > 0) return `流入 ${n} 天`
  if (n < 0) return `流出 ${-n} 天`
  return '—'
}

/** 一只 ETF 在最新一天的一行；daily、metrics 可能缺（还没采集或样本不足） */
export type FundRow = {
  fund: EtfFund
  daily?: EtfDaily
  metrics?: EtfMetrics
  /** 近 30 天份额，按日期正序，没有份额的天跳过 */
  trend: number[]
}

/** 最新交易日：快照里最大的日期 */
export const latestDate = (daily: readonly EtfDaily[]) => daily.reduce((d, x) => (x.date > d ? x.date : d), '')

export function buildRows(funds: readonly EtfFund[], daily: readonly EtfDaily[], metrics: readonly EtfMetrics[]): { date: string; rows: FundRow[] } {
  const date = latestDate(daily)
  const rows = funds.map((fund) => {
    const mine = daily.filter((d) => d.symbol === fund.symbol).sort((a, b) => a.date.localeCompare(b.date))
    return {
      fund,
      daily: mine.find((d) => d.date === date),
      metrics: metrics.find((m) => m.symbol === fund.symbol && m.date === date),
      trend: mine.slice(-30).map((d) => d.shares).filter((v) => v > 0),
    }
  })
  return { date, rows }
}

export type Summary = { inflow: number; up: number; down: number }

/** 摘要：合计估算净流入，净流入只数、净流出只数（只算有指标的） */
export function summarize(rows: readonly FundRow[]): Summary {
  let inflow = 0
  let up = 0
  let down = 0
  for (const r of rows) {
    const v = r.metrics?.net_inflow
    if (v == null) continue
    inflow += v
    if (v > 0) up++
    else if (v < 0) down++
  }
  return { inflow, up, down }
}

/** 迷你折线的点（SVG polyline 的 points），少于 2 个点回空串 */
export function sparkPoints(vals: readonly number[], w: number, h: number): string {
  if (vals.length < 2) return ''
  const min = Math.min(...vals)
  const max = Math.max(...vals)
  const span = max - min || 1
  return vals
    .map((v, i) => `${((i / (vals.length - 1)) * w).toFixed(1)},${(h - 1 - ((v - min) / span) * (h - 2)).toFixed(1)}`)
    .join(' ')
}

/** 新建规则的初始值 */
export const blankRule = (): RuleDraft => ({
  name: '', metric: 'share_change_pct', operator: 'abs_gt', threshold: '2', scope: 'all', scope_value: '', severity: 'warn', enabled: true,
})

/** 抽屉里的规则草稿：阈值先按字符串编辑 */
export type RuleDraft = {
  name: string
  metric: string
  operator: EtfOperator
  threshold: string
  scope: EtfScope
  scope_value: string
  severity: EtfSeverity
  enabled: boolean
}

export const draftOf = (r: EtfRule): RuleDraft => ({
  name: r.name, metric: r.metric, operator: r.operator, threshold: String(r.threshold), scope: r.scope, scope_value: r.scope_value,
  severity: r.severity, enabled: r.enabled,
})

/** 草稿的问题，空数组就是能存 */
export function draftErrors(d: RuleDraft): string[] {
  const out: string[] = []
  if (!d.name.trim()) out.push('名称必填')
  if (d.threshold.trim() === '' || !Number.isFinite(Number(d.threshold))) out.push('阈值要是数字')
  if (d.scope !== 'all' && !d.scope_value.trim()) out.push(d.scope === 'symbol' ? '选一只 ETF' : '选一个跟踪指数')
  return out
}
