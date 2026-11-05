// 宽基监控（SPEC-etf）：宽基 ETF 的份额与资金流、派生指标、异动规则和命中记录。
// 字段名照后端 internal/plugins/etf（Fund、Daily、Metrics、Anomaly、Rule 的 JSON），snake_case。
// 演示数据是确定性的：10 只宽基、截至 2026-11-04 的 70 个交易日；指标按设计口径现算（docs/etf-anomaly-design.md 第七节），
// 和后端 metrics.go 同一套：量比去当日、20 日跟踪误差、分位至少 60 天、样本不足为 null。

export type Severity = 'info' | 'warn' | 'critical'
export type EventStatus = 'open' | 'acked' | 'ignored'
export type PremiumBasis = 'iopv' | 'nav' | 'none'
export type RuleOperator = 'gt' | 'gte' | 'lt' | 'lte' | 'abs_gt'
export type RuleScope = 'all' | 'symbol' | 'index'
export type MetricKey = 'share_change_pct' | 'net_inflow' | 'inflow_streak' | 'amount_ratio' | 'premium_discount' | 'aum_change_pct'
  | 'tracking_error' | 'excess_return' | 'share_pctile' | 'aum_pctile' | 'premium_pctile'

/** 宽基静态元信息（后端 EtfFund 的子集） */
export interface EtfFund {
  symbol: string
  name: string
  /** 跟踪指数名 */
  track_index: string
  manager: string
  market: 'SH' | 'SZ'
  /** 跟踪指数代码 */
  underlying: string
}

/** 一天一只的份额与行情（后端 EtfDaily 的子集） */
export interface EtfDaily {
  date: string
  symbol: string
  /** 份额（份） */
  shares: number
  nav: number
  iopv: number
  price: number
  /** 成交额（元） */
  amount: number
  change_pct: number
  /** 估算规模（元） */
  aum: number
  premium_discount: number
  premium_basis: PremiumBasis
}

/** 派生指标（后端 EtfMetrics）；样本不足的为 null */
export interface EtfMetrics {
  date: string
  symbol: string
  share_change_pct: number | null
  net_inflow: number | null
  inflow_streak: number
  amount_ratio: number | null
  share_pctile: number | null
  aum_pctile: number | null
  premium_pctile: number | null
  tracking_error: number | null
  excess_return: number | null
  aum_change_pct: number | null
  premium_discount: number | null
  premium_basis: PremiumBasis
  /** 'pending_review' 是待核：份额单日变动超过 10% 且量比不到 2 */
  review_flag: '' | 'pending_review'
  updated_at: string
}

/** 异动规则（后端 EtfRule） */
export interface EtfRule {
  id: string
  name: string
  scope: RuleScope
  scope_value: string
  metric: MetricKey
  operator: RuleOperator
  threshold: number
  window_days: number
  severity: Severity
  enabled: boolean
  builtin: boolean
  created_at: string
  updated_at: string
}

/** 命中记录（后端 EtfAnomaly）：同日同标的同规则一条 */
export interface EtfAnomaly {
  id: string
  date: string
  symbol: string
  fund_name: string
  rule_id: string
  rule_name: string
  metric: MetricKey
  value: number
  threshold: number
  operator: RuleOperator
  severity: Severity
  status: EventStatus
  flag: '' | 'pending_review'
  detail: string
  created_at: string
  updated_at: string
  handled_at: string
}

/** 指标说明：规则下拉、条件文案、表头都用它；shares 为 true 的由份额推出来，份额待核时命中也标待核 */
export const METRICS: Record<MetricKey, { label: string; unit: string; shares: boolean; window: number }> = {
  share_change_pct: { label: '份额日变动', unit: '%', shares: true, window: 1 },
  net_inflow: { label: '估算净流入', unit: '元', shares: true, window: 1 },
  inflow_streak: { label: '连续净流入天数', unit: '天', shares: true, window: 1 },
  amount_ratio: { label: '量比', unit: '倍', shares: false, window: 20 },
  premium_discount: { label: '折溢价', unit: '%', shares: false, window: 1 },
  aum_change_pct: { label: '规模日变动', unit: '%', shares: true, window: 1 },
  tracking_error: { label: '跟踪误差（20 日年化）', unit: '%', shares: false, window: 20 },
  excess_return: { label: '超额收益（20 日）', unit: '%', shares: false, window: 20 },
  share_pctile: { label: '份额历史分位', unit: '', shares: true, window: 250 },
  aum_pctile: { label: '规模历史分位', unit: '', shares: true, window: 250 },
  premium_pctile: { label: '折溢价历史分位', unit: '', shares: false, window: 250 },
}
export const METRIC_KEYS = Object.keys(METRICS) as MetricKey[]

export const OPERATORS: Record<RuleOperator, string> = { gt: '>', gte: '≥', lt: '<', lte: '≤', abs_gt: '绝对值 >' }
export const SEVERITY: Record<Severity, { label: string; color: string; rank: number }> = {
  critical: { label: '严重', color: 'var(--danger)', rank: 0 },
  warn: { label: '警告', color: 'var(--warn)', rank: 1 },
  info: { label: '提示', color: 'var(--accent)', rank: 2 },
}
export const STATUS: Record<EventStatus, string> = { open: '未处理', acked: '已确认', ignored: '已忽略' }
export const BASIS: Record<PremiumBasis, string> = { iopv: 'IOPV', nav: '净值', none: '不可用' }
export const SCOPE: Record<RuleScope, string> = { all: '全部', symbol: '某只 ETF', index: '某个跟踪指数' }

/** 本插件覆盖的宽基，同后端 source.go 的 broadBased */
export const ETF_FUNDS: EtfFund[] = [
  { symbol: '510300', name: '沪深300ETF', track_index: '沪深300', manager: '华泰柏瑞基金', market: 'SH', underlying: '000300' },
  { symbol: '510330', name: '沪深300ETF华夏', track_index: '沪深300', manager: '华夏基金', market: 'SH', underlying: '000300' },
  { symbol: '159919', name: '沪深300ETF嘉实', track_index: '沪深300', manager: '嘉实基金', market: 'SZ', underlying: '000300' },
  { symbol: '510500', name: '中证500ETF', track_index: '中证500', manager: '南方基金', market: 'SH', underlying: '000905' },
  { symbol: '510050', name: '上证50ETF', track_index: '上证50', manager: '华夏基金', market: 'SH', underlying: '000016' },
  { symbol: '510180', name: '上证180ETF', track_index: '上证180', manager: '华安基金', market: 'SH', underlying: '000010' },
  { symbol: '159915', name: '创业板ETF', track_index: '创业板指', manager: '易方达基金', market: 'SZ', underlying: '399006' },
  { symbol: '588000', name: '科创50ETF', track_index: '科创50', manager: '华夏基金', market: 'SH', underlying: '000688' },
  { symbol: '512100', name: '中证1000ETF', track_index: '中证1000', manager: '南方基金', market: 'SH', underlying: '000852' },
  { symbol: '159845', name: '中证1000ETF华夏', track_index: '中证1000', manager: '华夏基金', market: 'SZ', underlying: '000852' },
]
export const fundOf = (symbol: string) => ETF_FUNDS.find((f) => f.symbol === symbol)

/** 首批 7 条内置规则，同后端 rules.go 的 defaultRules */
const T0 = '2026-11-04T08:00:00Z'
const builtin = (id: string, name: string, metric: MetricKey, operator: RuleOperator, threshold: number, severity: Severity): EtfRule => ({
  id, name, scope: 'all', scope_value: '', metric, operator, threshold, window_days: METRICS[metric].window, severity, enabled: true, builtin: true,
  created_at: T0, updated_at: T0,
})
export const seedRules: EtfRule[] = [
  builtin('ear_share_jump', '份额单日骤变', 'share_change_pct', 'abs_gt', 2, 'warn'),
  builtin('ear_inflow_streak', '连续净流入', 'inflow_streak', 'gte', 3, 'info'),
  builtin('ear_outflow_streak', '连续净流出', 'inflow_streak', 'lte', -3, 'warn'),
  builtin('ear_volume_spike', '放量', 'amount_ratio', 'gt', 2, 'info'),
  builtin('ear_premium', '折溢价异常', 'premium_discount', 'abs_gt', 0.5, 'warn'),
  builtin('ear_aum_jump', '规模骤变', 'aum_change_pct', 'abs_gt', 3, 'warn'),
  builtin('ear_tracking_error', '跟踪误差扩大', 'tracking_error', 'gt', 1, 'critical'),
]

/* ---------- 演示行情：确定性生成 ---------- */

/** 演示数据截至的最近交易日；「立即采集」每次往后推一个交易日 */
export const LATEST = '2026-11-04'
const HISTORY = 70

/** 从 LATEST 往前数 HISTORY 个交易日（只跳周末），再往后补 extra 个 */
export function tradingDays(extra = 0): string[] {
  const out: string[] = []
  const d = new Date(`${LATEST}T00:00:00Z`)
  while (out.length < HISTORY) {
    const w = d.getUTCDay()
    if (w !== 0 && w !== 6) out.unshift(d.toISOString().slice(0, 10))
    d.setUTCDate(d.getUTCDate() - 1)
  }
  const f = new Date(`${LATEST}T00:00:00Z`)
  for (let i = 0; i < extra;) {
    f.setUTCDate(f.getUTCDate() + 1)
    const w = f.getUTCDay()
    if (w !== 0 && w !== 6) { out.push(f.toISOString().slice(0, 10)); i++ }
  }
  return out
}

function rand(seed: string) {
  let h = 2166136261
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619)
  return ((h >>> 0) % 100000) / 100000
}
const noise = (seed: string) => rand(seed) * 2 - 1

/** 基准：份额（亿份）、价格（元）、日成交额（亿元）、跟踪偏差（每天 ETF 和指数涨跌幅差的幅度，%） */
const BASE: Record<string, { shares: number; price: number; amount: number; te: number }> = {
  '510300': { shares: 445, price: 4.17, amount: 62, te: 0.02 },
  '510330': { shares: 262, price: 4.32, amount: 21, te: 0.02 },
  '159919': { shares: 108, price: 4.25, amount: 6.5, te: 0.03 },
  '510500': { shares: 131, price: 6.41, amount: 18, te: 0.03 },
  '510050': { shares: 214, price: 2.98, amount: 15, te: 0.02 },
  '510180': { shares: 59, price: 3.66, amount: 1.2, te: 0.03 },
  '159915': { shares: 431, price: 2.56, amount: 38, te: 0.03 },
  '588000': { shares: 523, price: 1.18, amount: 29, te: 0.04 },
  '512100': { shares: 142, price: 2.71, amount: 9.8, te: 0.04 },
  '159845': { shares: 88, price: 2.69, amount: 4.1, te: 0.16 },
}

/**
 * 写好的几处异动（相对 LATEST 的交易日偏移，0 是最近交易日）：份额额外变动 %、成交额倍数、折溢价。
 * 平时份额一天涨一天跌，不会连着同向，连续流入流出只出现在这里写的地方
 */
const SCRIPT: Record<string, Record<number, { share?: number; amount?: number; premium?: number }>> = {
  '510300': { 3: { share: 0.4 }, 2: { share: 0.5 }, 1: { share: 0.6 }, 0: { share: 2.6 } }, // 连续流入 4 天，最后一天骤增
  '588000': { 2: { share: -0.7 }, 1: { share: -0.9 }, 0: { share: -1.1 } }, // 连续流出 3 天
  '510180': { 0: { share: 14 } }, // 份额跳 14%、没放量：待核
  '159915': { 0: { amount: 2.6 } }, // 放量
  '510050': { 0: { premium: 0.62 } }, // 溢价
  '510500': { 3: { share: -2.4 } }, // 三天前骤减，已确认
  '512100': { 5: { amount: 2.3 } }, // 五天前放量，已忽略
}

export interface IndexDay { date: string; code: string; change_pct: number }
export interface EtfDataset { days: string[]; daily: EtfDaily[]; index: IndexDay[] }

/** 生成 extra 个额外交易日后的整套数据；同样的 extra 结果一样 */
export function buildDataset(extra = 0): EtfDataset {
  const days = tradingDays(extra)
  const last = days.indexOf(LATEST)
  const daily: EtfDaily[] = []
  const index: IndexDay[] = []
  const codes = [...new Set(ETF_FUNDS.map((f) => f.underlying))]
  const idxChg: Record<string, number> = {}
  for (const d of days) for (const c of codes) {
    const v = Math.round(1.1 * noise(`${c}|${d}`) * 100) / 100
    idxChg[`${c}|${d}`] = v
    index.push({ date: d, code: c, change_pct: v })
  }
  for (const f of ETF_FUNDS) {
    const b = BASE[f.symbol]
    let shares = b.shares * 1e8
    let price = b.price
    days.forEach((d, i) => {
      const s = SCRIPT[f.symbol]?.[last - i] ?? {}
      if (i > 0) {
        // 各只的奇偶错开，不会全市场同一天一起流入或流出
        const swing = ((i + (rand(`par|${f.symbol}`) > 0.5 ? 1 : 0)) % 2 ? 1 : -1) * (0.05 + 0.25 * rand(`s|${f.symbol}|${d}`))
        shares *= 1 + (s.share ?? swing) / 100
      }
      const chg = Math.round((idxChg[`${f.underlying}|${d}`] + b.te * noise(`t|${f.symbol}|${d}`)) * 100) / 100
      if (i > 0) price *= 1 + chg / 100
      const premium = s.premium ?? Math.round(0.08 * noise(`p|${f.symbol}|${d}`) * 1000) / 1000
      // 最近交易日（和之后推出来的）有实时快照，折溢价按 IOPV；更早的只有净值
      const basis: PremiumBasis = i >= last ? 'iopv' : 'nav'
      const fair = price / (1 + premium / 100)
      const amount = b.amount * 1e8 * (1 + 0.18 * noise(`a|${f.symbol}|${d}`)) * (s.amount ?? 1)
      daily.push({
        date: d, symbol: f.symbol, shares: Math.round(shares), price: Math.round(price * 1000) / 1000, amount: Math.round(amount),
        change_pct: chg, nav: basis === 'nav' ? fair : fair * 0.9998, iopv: basis === 'iopv' ? fair : 0,
        aum: Math.round(shares * fair), premium_discount: premium, premium_basis: basis,
      })
    })
  }
  return { days, daily, index }
}

/* ---------- 指标：口径同后端 metrics.go ---------- */

const AMOUNT_WINDOW = 20
const PCTILE_MIN = 60
const PCTILE_WINDOW = 250
const TE_WINDOW = 20

function pctile(vals: number[], cur: number): number | null {
  const w = vals.slice(-PCTILE_WINDOW)
  if (w.length < PCTILE_MIN) return null
  return (w.filter((v) => v <= cur).length / w.length) * 100
}

/** 一只 ETF 截止到 series 最后一天的指标；series 按日期正序 */
export function computeMetrics(series: EtfDaily[], indexChg: Map<string, number> | null): EtfMetrics {
  const n = series.length - 1
  const cur = series[n]
  const prev = n >= 1 ? series[n - 1] : null
  const unit = cur.nav > 0 ? cur.nav : cur.iopv > 0 ? cur.iopv : cur.price
  const m: EtfMetrics = {
    date: cur.date, symbol: cur.symbol, share_change_pct: null, net_inflow: null, inflow_streak: 0, amount_ratio: null,
    share_pctile: null, aum_pctile: null, premium_pctile: null, tracking_error: null, excess_return: null, aum_change_pct: null,
    premium_discount: cur.premium_basis === 'none' ? null : cur.premium_discount, premium_basis: cur.premium_basis, review_flag: '',
    updated_at: `${cur.date}T08:00:00Z`,
  }
  if (prev && prev.shares > 0 && cur.shares > 0) {
    m.share_change_pct = ((cur.shares - prev.shares) / prev.shares) * 100
    m.net_inflow = (cur.shares - prev.shares) * unit
  }
  if (prev && prev.aum > 0 && cur.aum > 0) m.aum_change_pct = ((cur.aum - prev.aum) / prev.aum) * 100
  // 连续天数：从最后一天往前数份额同向变动的天数
  let sign = 0
  let count = 0
  for (let i = n; i >= 1; i--) {
    const a = series[i - 1].shares
    const b = series[i].shares
    if (a <= 0 || b <= 0 || a === b) break
    const s = b > a ? 1 : -1
    if (!sign) sign = s
    if (s !== sign) break
    count++
  }
  m.inflow_streak = sign * count
  // 量比：之前 20 个交易日的均额，不含当日
  if (n >= AMOUNT_WINDOW && cur.amount > 0) {
    const w = series.slice(n - AMOUNT_WINDOW, n)
    if (w.every((p) => p.amount > 0)) m.amount_ratio = cur.amount / (w.reduce((s, p) => s + p.amount, 0) / AMOUNT_WINDOW)
  }
  if (cur.shares > 0) m.share_pctile = pctile(series.filter((p) => p.shares > 0).map((p) => p.shares), cur.shares)
  if (cur.aum > 0) m.aum_pctile = pctile(series.filter((p) => p.aum > 0).map((p) => p.aum), cur.aum)
  if (m.premium_discount !== null) {
    m.premium_pctile = pctile(series.filter((p) => p.premium_basis !== 'none').map((p) => p.premium_discount), cur.premium_discount)
  }
  // 跟踪误差：近 20 日差值的样本标准差 × √252；有一天缺指数就不算
  if (indexChg && series.length >= TE_WINDOW) {
    const w = series.slice(-TE_WINDOW)
    if (w.every((p) => indexChg.has(p.date))) {
      const diffs = w.map((p) => p.change_pct - indexChg.get(p.date)!)
      const mean = diffs.reduce((s, d) => s + d, 0) / diffs.length
      const sd = Math.sqrt(diffs.reduce((s, d) => s + (d - mean) ** 2, 0) / (diffs.length - 1))
      m.tracking_error = sd * Math.sqrt(252)
      const e = w.reduce((s, p) => s * (1 + p.change_pct / 100), 1)
      const x = w.reduce((s, p) => s * (1 + indexChg.get(p.date)! / 100), 1)
      m.excess_return = (e - x) * 100
    }
  }
  if (m.share_change_pct !== null && Math.abs(m.share_change_pct) > 10 && (m.amount_ratio === null || m.amount_ratio < 2)) m.review_flag = 'pending_review'
  return m
}

/** 整套数据里每只每天的指标，按 symbol 分组、日期正序 */
export function allMetrics(ds: EtfDataset): Map<string, EtfMetrics[]> {
  const out = new Map<string, EtfMetrics[]>()
  for (const f of ETF_FUNDS) {
    const series = ds.daily.filter((d) => d.symbol === f.symbol)
    const idx = new Map(ds.index.filter((x) => x.code === f.underlying).map((x) => [x.date, x.change_pct]))
    out.set(f.symbol, series.map((_, i) => computeMetrics(series.slice(0, i + 1), idx)))
  }
  return out
}

export function metricValue(m: EtfMetrics, k: MetricKey): number | null {
  return k === 'inflow_streak' ? m.inflow_streak : m[k]
}

export function ruleHit(op: RuleOperator, v: number, th: number) {
  switch (op) {
    case 'gt': return v > th
    case 'gte': return v >= th
    case 'lt': return v < th
    case 'lte': return v <= th
    case 'abs_gt': return Math.abs(v) > th
  }
}

export function inScope(r: EtfRule, f: EtfFund) {
  if (r.scope === 'symbol') return r.scope_value === f.symbol
  if (r.scope === 'index') return r.scope_value === f.underlying || r.scope_value === f.track_index
  return true
}

export function fmtMetric(v: number, unit: string) {
  if (unit === '元') {
    if (Math.abs(v) >= 1e8) return `${(v / 1e8).toFixed(2)} 亿元`
    if (Math.abs(v) >= 1e4) return `${(v / 1e4).toFixed(2)} 万元`
    return `${v.toFixed(0)} 元`
  }
  if (unit === '天') return `${v.toFixed(0)} 天`
  if (unit === '倍') return `${v.toFixed(2)} 倍`
  return `${v.toFixed(2)}${unit}`
}

export const condText = (r: Pick<EtfRule, 'metric' | 'operator' | 'threshold'>) =>
  `${METRICS[r.metric].label} ${OPERATORS[r.operator]} ${fmtMetric(r.threshold, METRICS[r.metric].unit)}`

/**
 * 按启用的规则判定某一天，和已有记录合并：命中的覆盖值、保持状态；不再命中的未处理记录撤掉，确认、忽略过的留着。
 * 回合并后的全部记录和这次新增的条数（同后端 rules.go 的 evaluateDay）
 */
export function evaluateDay(date: string, metrics: Map<string, EtfMetrics[]>, rules: EtfRule[], events: EtfAnomaly[], seq: () => string): { events: EtfAnomaly[]; fresh: number } {
  const keep = events.filter((e) => e.date !== date)
  const old = new Map(events.filter((e) => e.date === date).map((e) => [`${e.symbol}|${e.rule_id}`, e]))
  const out: EtfAnomaly[] = []
  let fresh = 0
  const now = `${date}T08:00:00Z`
  for (const f of ETF_FUNDS) {
    const m = metrics.get(f.symbol)?.find((x) => x.date === date)
    if (!m) continue
    for (const r of rules) {
      const key = `${f.symbol}|${r.id}`
      const was = old.get(key)
      if (!r.enabled || !inScope(r, f)) { if (was) out.push(was); continue }
      const v = metricValue(m, r.metric)
      if (v === null || !ruleHit(r.operator, v, r.threshold)) {
        if (was && was.status !== 'open') out.push(was)
        continue
      }
      const flag = METRICS[r.metric].shares && m.review_flag === 'pending_review' ? 'pending_review' as const : ''
      const info = METRICS[r.metric]
      const detail = `${info.label} ${fmtMetric(v, info.unit)}，规则 ${OPERATORS[r.operator]} ${fmtMetric(r.threshold, info.unit)}`
        + (flag ? '；份额单日变动超过 10% 且没有放量配合，疑似分红、拆分或份额折算，待核' : '')
      if (!was) fresh++
      out.push({
        id: was?.id ?? seq(), date, symbol: f.symbol, fund_name: f.name, rule_id: r.id, rule_name: r.name, metric: r.metric, value: v,
        threshold: r.threshold, operator: r.operator, severity: r.severity, status: was?.status ?? 'open', flag, detail,
        created_at: was?.created_at ?? now, updated_at: now, handled_at: was?.handled_at ?? '',
      })
    }
  }
  return { events: [...keep, ...out], fresh }
}

/** 初始命中记录：最近 6 个交易日按内置规则判一遍，再标上一条已确认、一条已忽略 */
export function seedEvents(ds: EtfDataset, metrics: Map<string, EtfMetrics[]>): EtfAnomaly[] {
  let n = 0
  const seq = () => `eae_demo${String(++n).padStart(3, '0')}`
  let events: EtfAnomaly[] = []
  const end = ds.days.indexOf(LATEST)
  for (const d of ds.days.slice(end - 5, end + 1)) events = evaluateDay(d, metrics, seedRules, events, seq).events
  const d3 = ds.days[end - 3]
  const d5 = ds.days[end - 5]
  return events.map((e) => {
    if (e.date === d3 && e.symbol === '510500' && e.rule_id === 'ear_share_jump') return { ...e, status: 'acked' as const, handled_at: `${ds.days[end - 2]}T01:32:00Z` }
    if (e.date === d5 && e.symbol === '512100' && e.rule_id === 'ear_volume_spike') return { ...e, status: 'ignored' as const, handled_at: `${ds.days[end - 4]}T02:05:00Z` }
    return e
  })
}
