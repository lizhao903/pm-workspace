// 策略与回测页的纯函数：显示名、规则文字、区间时长、扫参默认值、分段收益、回撤、拦截原因。
// 交互照原型 web-next/src/strategy.tsx；回测本身只在后端跑，这里不算任何收益。
import type {
  TradeBacktestStats, TradeBacktestStatus, TradeCompare, TradeDirection, TradeIndicator, TradeInterval, TradeOperand, TradeRule, TradeStrategy,
  TradeStrategyInput, TradeStrategyMode,
} from '../../core/data'
import type { CSSProperties } from 'react'
import { DOWN, INTERVALS, MARKETS, UP, guessInstrument, intervalMs } from './model'

export const MODE_LABEL: Record<TradeStrategyMode, string> = { rules: '条件规则', code: '代码' }
export const DIR_LABEL: Record<TradeDirection, string> = { long: '只做多', short: '只做空', both: '多空双向' }
export const BT_STATUS: Record<TradeBacktestStatus, { label: string; color: string }> = {
  queued: { label: '排队中', color: '#a19d92' }, running: { label: '运行中', color: '#3d4fd6' }, done: { label: '已完成', color: '#2f7d43' }, failed: { label: '失败', color: '#c0352b' },
}
export const INDICATORS: Record<TradeIndicator, { label: string; params: string[] }> = {
  price: { label: '收盘价', params: [] },
  ma: { label: '均线 MA', params: ['周期'] },
  ema: { label: '指数均线 EMA', params: ['周期'] },
  rsi: { label: 'RSI', params: ['周期'] },
  macd: { label: 'MACD 柱', params: ['快', '慢', '信号'] },
  boll_up: { label: '布林上轨', params: ['周期', '倍数'] },
  boll_low: { label: '布林下轨', params: ['周期', '倍数'] },
  volume: { label: '成交量', params: [] },
  atr: { label: 'ATR', params: ['周期'] },
}
export const IND_SHORT: Record<TradeIndicator, string> = { price: '收盘价', ma: 'MA', ema: 'EMA', rsi: 'RSI', macd: 'MACD 柱', boll_up: '布林上轨', boll_low: '布林下轨', volume: '成交量', atr: 'ATR' }
export const IND_DEFAULT: Record<TradeIndicator, number[]> = { price: [], ma: [20], ema: [20], rsi: [14], macd: [12, 26, 9], boll_up: [20, 2], boll_low: [20, 2], volume: [], atr: [14] }
export const COMPARE: Record<TradeCompare, string> = { cross_up: '上穿', cross_down: '下穿', gt: '大于', lt: '小于' }
export const RESERVED_PARAMS = ['stop_loss', 'take_profit', 'position_pct'] as const
export const RESERVED_LABEL: Record<string, string> = { stop_loss: '止损 %', take_profit: '止盈 %', position_pct: '仓位 %' }
/** K 线周期按钮：编辑页只给到日线，同原型 */
export const STRATEGY_INTERVALS: TradeInterval[] = ['1m', '5m', '15m', '1h', '4h', '1d']
export const intervalLabel = (iv: TradeInterval) => INTERVALS.find((x) => x.key === iv)?.label ?? (iv === '1w' ? '周线' : iv)

export const opText = (o: TradeOperand) => (o.kind === 'num' ? String(o.value) : o.params.length ? `${IND_SHORT[o.ind]}(${o.params.join(', ')})` : IND_SHORT[o.ind])
export const ruleText = (r: TradeRule) => `${opText(r.left)} ${COMPARE[r.op]} ${opText(r.right)}`
export const pctRaw = (x: number) => `${(x * 100).toFixed(2)}%`
export const money = (x: number, d = 0) => x.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })
export const prog = (p: number) => Math.max(0, Math.min(1, p > 1 ? p / 100 : p))
export const instName = (s: string) => guessInstrument(s).name
export const marketOf = (s: string) => guessInstrument(s).market
export const currencyOf = (symbols: string[]) => MARKETS[symbols[0] ? marketOf(symbols[0]) : 'us'].currency

/** 资金曲线、成交的时间：日线写日期，其余「MM-DD HH:mm」（本地时间） */
export function fmtT(t: number, iv: TradeInterval) {
  const d = new Date(t)
  const z = (n: number) => String(n).padStart(2, '0')
  return iv === '1d' || iv === '1w' ? `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}` : `${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}`
}

/** N 根 K 线大约多长 */
export function spanText(n: number, iv: TradeInterval) {
  const days = (n * intervalMs(iv)) / 86400000
  return days >= 60 ? `约 ${(days / 30).toFixed(0)} 个月` : days >= 2 ? `约 ${days.toFixed(0)} 天` : `约 ${(days * 24).toFixed(0)} 小时`
}

export function timeAgo(iso: string | undefined, now = Date.now()) {
  if (!iso) return ''
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000))
  if (s < 60) return '刚刚'
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} 天前`
  return new Date(iso).toLocaleDateString('zh-CN')
}

/** 代码策略按哪种内置近似回测，同后端 CodeKindOf：只做文本匹配，不执行源码 */
export type CodeKind = 'grid' | 'basis' | 'ma'
export const CODE_KIND_LABEL: Record<CodeKind, string> = { grid: '网格', basis: '期现基差', ma: '未识别，按双均线' }
export function codeKindOf(st: Pick<TradeStrategy, 'name' | 'code' | 'params'>): CodeKind {
  const txt = `${st.name} ${st.code}`
  if ('grids' in st.params || /网格|grid/i.test(txt)) return 'grid'
  if ('open_bp' in st.params || /基差|期现|basis/i.test(txt)) return 'basis'
  return 'ma'
}

/** 开始回测的拦截原因，没有为空串（SPEC-strategy-3.23、3.24） */
export const blockerOf = (st: TradeStrategy) =>
  !st.symbols.length ? '先选至少一个标的' : st.mode === 'rules' && !st.entry.rules.length ? '入场规则还是空的' : ''

/** 某个策略最近一次回测；preferDone 时优先取已完成的 */
export function latestOf<T extends { config: { strategy_id: string }; created_at: string; status: TradeBacktestStatus }>(id: string, bts: T[], preferDone = false) {
  const mine = bts.filter((b) => b.config.strategy_id === id).sort((a, b) => b.created_at.localeCompare(a.created_at))
  return (preferDone ? mine.find((b) => b.status === 'done') : undefined) ?? mine[0]
}

/** 策略内容（不含 id 和时间）和快照比，判断回测之后有没有改过；规则的 id 不比 */
export function sig(s: TradeStrategy) {
  const strip = (g: TradeStrategy['entry']) => ({ logic: g.logic, rules: g.rules.map(({ left, op, right }) => ({ left, op, right })) })
  return JSON.stringify({ ...s, id: '', updated_at: '', created_at: '', entry: strip(s.entry), exit: strip(s.exit) })
}

/** 写给后端的字段：名称为空时不传（名称必填，其余照样保存，SPEC-strategy-3.26） */
export function inputOf(st: TradeStrategy): TradeStrategyInput {
  const { id: _id, updated_at: _u, created_at: _c, ...rest } = st
  const body: TradeStrategyInput = rest
  if (!st.name.trim()) delete body.name
  return body
}

/** 规则模式下改参数值，规则里等于旧值的周期、数值一起改；有别的参数和旧值相同时不连带改（SPEC-strategy-3.18） */
export function withParam(st: TradeStrategy, k: string, v: number): Partial<TradeStrategy> {
  const old = st.params[k]
  const params = { ...st.params, [k]: v }
  if (st.mode !== 'rules' || old === v) return { params }
  const shared = Object.entries(st.params).some(([x, y]) => x !== k && y === old)
  if (shared) return { params }
  const fix = (o: TradeOperand): TradeOperand =>
    o.kind === 'num' ? (o.value === old ? { ...o, value: v } : o) : o.params[0] === old ? { ...o, params: [v, ...o.params.slice(1)] } : o
  const grp = (g: TradeStrategy['entry']) => ({ ...g, rules: g.rules.map((r) => ({ ...r, left: fix(r.left), right: fix(r.right) })) })
  return { params, entry: grp(st.entry), exit: grp(st.exit) }
}

/** 前端新加条件用的临时编号（策略里的下标，不是实体 id；后端发现重复会重编） */
let seq = 0
export const newRuleId = () => `rl_${Date.now().toString(36)}${(seq++).toString(36)}`

/** 快速回测的本地设置（SPEC-strategy-5） */
export type QuickCfg = { bars: number; capital: number; fee_bp: number; slippage_ticks: number; over: Record<string, number> }
export const quickDefaults = (st: TradeStrategy): QuickCfg => ({
  bars: 1000, capital: 100000, fee_bp: st.symbols[0] && marketOf(st.symbols[0]) === 'crypto' ? 5 : 3, slippage_ticks: 1, over: {},
})
/** 本次回测的参数：策略参数加覆盖（只认策略里有的参数名） */
export const quickParams = (st: TradeStrategy, qc: QuickCfg) => ({
  ...st.params, ...Object.fromEntries(Object.entries(qc.over).filter(([k]) => k in st.params)),
})

/** 能扫的参数：策略参数加三个保留键 */
export function sweepableParams(st: TradeStrategy) {
  return [
    ...Object.entries(st.params).map(([key, value]) => ({ key, label: key, value })),
    { key: 'stop_loss', label: RESERVED_LABEL.stop_loss, value: st.stop_loss },
    { key: 'take_profit', label: RESERVED_LABEL.take_profit, value: st.take_profit },
    { key: 'position_pct', label: RESERVED_LABEL.position_pct, value: st.position_pct },
  ]
}

/** 扫参取值的默认一组（SPEC-strategy-7.11） */
export function defaultSweepValues(v: number, key: string) {
  if (!v) return key === 'take_profit' || key === 'stop_loss' ? [0, 3, 6, 10, 15] : [0, 1, 2, 5, 10]
  const int = Number.isInteger(v)
  const xs = [0.5, 0.75, 1, 1.25, 1.5, 2].map((k) => (int ? Math.max(1, Math.round(v * k)) : Number((v * k).toPrecision(3))))
  return [...new Set(xs)]
}
/** 取值输入：逗号、中文逗号或空格分隔，非数字忽略，去重，最多 20 个 */
export const parseSweepValues = (txt: string) => [...new Set(txt.split(/[,，\s]+/).filter(Boolean).map(Number).filter(Number.isFinite))].slice(0, 20)

/** 回撤（水下）曲线：相对此前最高点 */
export function drawdown(equity: { v: number }[]) {
  let peak = -Infinity
  return equity.map((e) => {
    peak = Math.max(peak, e.v)
    return peak > 0 ? e.v / peak - 1 : 0
  })
}

/** 分段收益：区间够 60 天按月，够 3 天按天，再短按 4 小时（本地时间） */
export function segments(equity: { t: number; v: number }[]) {
  if (equity.length < 2) return null
  const span = equity[equity.length - 1].t - equity[0].t
  const mode: 'month' | 'day' | 'hour' = span >= 60 * 86400000 ? 'month' : span >= 3 * 86400000 ? 'day' : 'hour'
  const z = (n: number) => String(n).padStart(2, '0')
  const keyOf = (t: number) => {
    const d = new Date(t)
    return mode === 'month' ? `${d.getFullYear()}-${z(d.getMonth() + 1)}` : mode === 'day' ? `${z(d.getMonth() + 1)}-${z(d.getDate())}` : `${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(Math.floor(d.getHours() / 4) * 4)}时`
  }
  const cells: { key: string; ret: number }[] = []
  let start = equity[0].v
  let cur = ''
  let last = equity[0].v
  for (const e of equity) {
    const k = keyOf(e.t)
    if (k !== cur) {
      if (cur) {
        cells.push({ key: cur, ret: last / start - 1 })
        start = last
      }
      cur = k
    }
    last = e.v
  }
  cells.push({ key: cur, ret: last / start - 1 })
  return { mode, cells }
}

export type MetricKey = keyof TradeBacktestStats | 'excess'
export const metricOf = (s: TradeBacktestStats, k: MetricKey) => (k === 'excess' ? s.total_return - s.bench_return : s[k])

/** 失败原因的分类（后端以固定开头写） */
export function failKind(err: string | undefined) {
  const e = err ?? ''
  return e.startsWith('数据缺失') ? 'data' : e.startsWith('参数不合法') ? 'param' : e.startsWith('回测被中断') ? 'abort' : e ? 'engine' : ''
}

/** 涨红跌绿，0 不上色 */
export const tone = (x: number) => (x > 0 ? UP : x < 0 ? DOWN : undefined)

/** 扫描结果里收益条：以中线为界，正的往右、负的往左 */
export const barStyle = (x: number, max: number): CSSProperties => ({
  width: `${(Math.abs(x) / max) * 50}%`, background: tone(x) ?? 'var(--line-2)', [x >= 0 ? 'left' : 'right']: '50%',
})
