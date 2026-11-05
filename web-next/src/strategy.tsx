import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { PageTitle } from './topbar'
import { Subnav } from './subnav'
import { cls, timeAgo } from './ui'
import { CODE_KIND_LABEL, codeKindOf, sweep, sweepableParams } from './backtest'
import {
  COMPARE, DOWN, INDICATORS, INSTRUMENTS, INST_KIND, INTERVALS, MARKETS, UP, fmtPct, fmtPrice, instOf,
  type Backtest, type BacktestConfig, type BacktestStatus, type BarInterval, type Compare, type Indicator, type Operand, type Rule, type RuleGroup, type Strategy,
  type StrategyRun, type TradeAccount,
} from './tradedata'
import './strategy.css'
import { StrategyRunsPanel } from './strategyruns'
import { newId } from './ids'
import { SearchSelect } from './searchselect'

// 交易员 > 策略：策略库、策略编辑（条件规则 / 代码）、回测记录、回测报告
// 回测的排队、进度和调用 runBacktest 由主会话负责，这里只发起和展示

export type StrategyView = 'list' | `st:${string}` | 'backtests' | `bt:${string}` | 'runs'

/* ---------- 小工具 ---------- */

const MODE_LABEL: Record<Strategy['mode'], string> = { rules: '条件规则', code: '代码' }
const DIR_LABEL: Record<Strategy['direction'], string> = { long: '只做多', short: '只做空', both: '多空双向' }
export const BT_STATUS: Record<BacktestStatus, { label: string; color: string }> = {
  queued: { label: '排队中', color: '#a19d92' }, running: { label: '运行中', color: '#3d4fd6' }, done: { label: '已完成', color: '#2f7d43' }, failed: { label: '失败', color: '#c0352b' },
}
const IND_SHORT: Record<Indicator, string> = { price: '收盘价', ma: 'MA', ema: 'EMA', rsi: 'RSI', macd: 'MACD 柱', boll_up: '布林上轨', boll_low: '布林下轨', volume: '成交量', atr: 'ATR' }
const IND_DEFAULT: Record<Indicator, number[]> = { price: [], ma: [20], ema: [20], rsi: [14], macd: [12, 26, 9], boll_up: [20, 2], boll_low: [20, 2], volume: [], atr: [14] }
const LINE_COLORS = ['var(--accent)', '#e8590c', '#0c8599', '#9c4fd6']

const tone = (x: number) => (x > 0 ? UP : x < 0 ? DOWN : undefined)
const instName = (s: string) => instOf(s)?.name ?? s
const opText = (o: Operand) => (o.kind === 'num' ? String(o.value) : o.params.length ? `${IND_SHORT[o.ind]}(${o.params.join(', ')})` : IND_SHORT[o.ind])
const ruleText = (r: Rule) => `${opText(r.left)} ${COMPARE[r.op]} ${opText(r.right)}`
const pctRaw = (x: number) => `${(x * 100).toFixed(2)}%`
const money = (x: number, d = 0) => x.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })
const prog = (p: number) => Math.max(0, Math.min(1, p > 1 ? p / 100 : p))
const currencyOf = (symbols: string[]) => MARKETS[instOf(symbols[0] ?? '')?.market ?? 'us'].currency
function fmtT(t: number, iv: BarInterval) {
  const d = new Date(t)
  const z = (n: number) => String(n).padStart(2, '0')
  return iv === '1d' ? `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}` : `${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}`
}
const spanText = (n: number, iv: BarInterval) => {
  const days = (n * INTERVALS[iv].ms) / 86400000
  return days >= 60 ? `约 ${(days / 30).toFixed(0)} 个月` : days >= 2 ? `约 ${days.toFixed(0)} 天` : `约 ${(days * 24).toFixed(0)} 小时`
}
/** 某个策略最近一次回测；preferDone 时优先取已完成的 */
function latestOf(id: string, bts: Backtest[], preferDone = false) {
  const mine = bts.filter((b) => b.config.strategy_id === id).sort((a, b) => b.created_at.localeCompare(a.created_at))
  return (preferDone ? mine.find((b) => b.status === 'done') : undefined) ?? mine[0]
}

function Pill({ label, color }: { label: string; color: string }) {
  return <span className="pill" style={{ '--c': color } as CSSProperties}><span className="pill-dot" />{label}</span>
}
const Signed = ({ x, text }: { x: number; text?: string }) => <span className="sg-num" style={{ color: tone(x) }}>{text ?? fmtPct(x)}</span>
function ProgressBar({ p, label }: { p: number; label?: boolean }) {
  return (
    <span className="bt-prog-wrap">
      <span className="bt-prog"><i style={{ width: `${prog(p) * 100}%` }} /></span>
      {label !== false && <span className="sg-num run-muted">{Math.round(prog(p) * 100)}%</span>}
    </span>
  )
}
function StatusCell({ b }: { b: Backtest }) {
  if (b.status === 'running') return <ProgressBar p={b.progress} />
  return <Pill {...BT_STATUS[b.status]} />
}
const PlusIcon = ({ s = 12 }: { s?: number }) => <svg viewBox="0 0 16 16" width={s} height={s}><path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" /></svg>
const XIcon = () => <svg viewBox="0 0 16 16" width="10" height="10"><path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>

/** 数字输入：允许中途输入空串和负号，合法时才回传 */
function NumInput({ value, onChange, className, step, min, title, placeholder }: { value: number; onChange: (v: number) => void; className?: string; step?: number; min?: number; title?: string; placeholder?: string }) {
  const [txt, setTxt] = useState(String(value))
  useEffect(() => { if (Number(txt) !== value || txt.trim() === '') setTxt(String(value)) }, [value]) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <input className={className} type="number" inputMode="decimal" step={step ?? 'any'} min={min} title={title} placeholder={placeholder} value={txt}
      onChange={(e) => { const v = e.target.value; setTxt(v); const n = Number(v); if (v.trim() !== '' && Number.isFinite(n)) onChange(n) }}
      onBlur={() => { if (txt.trim() === '' || !Number.isFinite(Number(txt))) setTxt(String(value)) }} />
  )
}

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const [w, setW] = useState(0)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setW(Math.floor(e.contentRect.width)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, w] as const
}

/* ---------- 折线图：资金曲线、回撤、对比共用 ---------- */

interface Line { label: string; values: number[]; color: string; dash?: boolean; fill?: boolean }

function Chart({ lines, height = 220, fmtY, xLabel, base }: { lines: Line[]; height?: number; fmtY: (v: number) => string; xLabel: (f: number) => string; base?: number }) {
  const [ref, w] = useWidth<HTMLDivElement>()
  const [hf, setHf] = useState<number | null>(null)
  const L = 6, R = 6, T = 12, B = 22
  const vals = lines.flatMap((l) => l.values).filter(Number.isFinite)
  let lo = vals.length ? Math.min(...vals) : 0, hi = vals.length ? Math.max(...vals) : 1
  if (base !== undefined) { lo = Math.min(lo, base); hi = Math.max(hi, base) }
  if (hi - lo < 1e-9) { hi += Math.abs(hi) * 0.01 + 1e-6; lo -= Math.abs(lo) * 0.01 + 1e-6 }
  const pad = (hi - lo) * 0.06
  lo -= pad; hi += pad
  const iw = Math.max(w - L - R, 1), ih = height - T - B
  const X = (i: number, n: number) => L + (n > 1 ? i / (n - 1) : 0) * iw
  const Y = (v: number) => T + ((hi - v) / (hi - lo)) * ih
  const pathOf = (vs: number[]) => vs.map((v, i) => `${i ? 'L' : 'M'}${X(i, vs.length).toFixed(1)} ${Y(v).toFixed(1)}`).join('')
  const ticks = [0.12, 0.5, 0.88].map((f) => hi - (hi - lo) * f)
  const hx = hf === null ? 0 : L + hf * iw
  return (
    <div className="bt-chart" ref={ref} style={{ height }}>
      {w > 0 && (
        <svg width={w} height={height} style={{ touchAction: 'pan-y' }}
          onPointerMove={(e) => { const r = e.currentTarget.getBoundingClientRect(); setHf(Math.max(0, Math.min(1, (e.clientX - r.left - L) / iw))) }}
          onPointerLeave={() => setHf(null)}>
          {ticks.map((v, k) => (
            <g key={k}>
              <line className="bt-grid" x1={L} x2={L + iw} y1={Y(v)} y2={Y(v)} />
              <text className="bt-axis" x={L + 2} y={Y(v) - 4}>{fmtY(v)}</text>
            </g>
          ))}
          {base !== undefined && <line className="bt-base" x1={L} x2={L + iw} y1={Y(base)} y2={Y(base)} />}
          {lines.map((l, k) => l.values.length > 0 && (
            <g key={k}>
              {l.fill && <path d={`${pathOf(l.values)}L${X(l.values.length - 1, l.values.length)} ${Y(base ?? lo)}L${X(0, l.values.length)} ${Y(base ?? lo)}Z`} style={{ fill: l.color, opacity: 0.16 }} />}
              <path d={pathOf(l.values)} fill="none" style={{ stroke: l.color }} strokeWidth={1.6} strokeDasharray={l.dash ? '4 3' : undefined} strokeLinejoin="round" />
            </g>
          ))}
          {[0, 0.5, 1].map((f) => <text key={f} className="bt-axis" x={L + f * iw} y={height - 6} textAnchor={f === 0 ? 'start' : f === 1 ? 'end' : 'middle'}>{xLabel(f)}</text>)}
          {hf !== null && (
            <g>
              <line className="bt-cross" x1={hx} x2={hx} y1={T} y2={T + ih} />
              {lines.map((l, k) => {
                const n = l.values.length
                if (!n) return null
                const i = Math.round(hf * (n - 1))
                return Number.isFinite(l.values[i]) ? <circle key={k} cx={X(i, n)} cy={Y(l.values[i])} r={3} style={{ fill: l.color }} /> : null
              })}
            </g>
          )}
        </svg>
      )}
      {hf !== null && w > 0 && (
        <div className={cls('bt-tip', hx > w / 2 && 'flip')} style={{ left: hx }}>
          <div className="bt-tip-t">{xLabel(hf)}</div>
          {lines.map((l, k) => {
            const n = l.values.length
            const v = n ? l.values[Math.round(hf * (n - 1))] : NaN
            return <div key={k} className="bt-tip-row"><i style={{ background: l.color }} /><span>{l.label}</span><b className="sg-num">{Number.isFinite(v) ? fmtY(v) : '-'}</b></div>
          })}
        </div>
      )}
    </div>
  )
}

function Spark({ values, color = 'var(--accent)' }: { values: number[]; color?: string }) {
  if (values.length < 2) return null
  const lo = Math.min(...values), hi = Math.max(...values)
  const d = values.map((v, i) => `${i ? 'L' : 'M'}${((i / (values.length - 1)) * 100).toFixed(2)} ${(hi - lo ? 28 - ((v - lo) / (hi - lo)) * 26 : 15).toFixed(2)}`).join('')
  return <svg className="sg-spark" viewBox="0 0 100 30" preserveAspectRatio="none"><path d={d} fill="none" style={{ stroke: color }} strokeWidth={1.4} vectorEffect="non-scaling-stroke" /></svg>
}

/** 标的标签：一行放得下几个放几个，放不下的收进 +N；第一个太长时省略号截断 */
function SymTags({ symbols, empty }: { symbols: string[]; empty?: string }) {
  const ref = useRef<HTMLSpanElement>(null)
  const head = symbols.slice(0, 6)
  const [hidden, setHidden] = useState(Math.max(0, symbols.length - 2))
  const key = head.join('|')
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = () => {
      const tags = [...el.children] as HTMLElement[]
      const top = tags[0]?.offsetTop ?? 0
      const n = tags.filter((t) => t.offsetTop > top).length + symbols.length - head.length
      setHidden((h) => (h === n ? h : n))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [key, symbols.length])
  if (!symbols.length) return <span className="sg-syms">{empty && <span className="faint">{empty}</span>}</span>
  return (
    <span className="sg-syms" title={symbols.map(instName).join('、')}>
      <span className="sg-syms-line" ref={ref}>{head.map((x) => <span key={x} className="tag">{instName(x)}</span>)}</span>
      {hidden > 0 && <span className="faint sg-syms-more">+{hidden}</span>}
    </span>
  )
}

/* ---------- 二级菜单 ---------- */

/** 菜单里「最近编辑」放几个 */
const NAV_RECENT = 5

// 菜单只放视图和最近编辑的几个策略，完整列表在策略库的表里搜、筛
export function StrategyNav({ strategies, backtests, runs = [], view, onSelect, onNew }: { strategies: Strategy[]; backtests: Backtest[]; runs?: StrategyRun[]; view: StrategyView; onSelect: (v: StrategyView) => void; onNew: () => void }) {
  const running = backtests.filter((b) => b.status === 'running').length
  const live = runs.filter((r) => r.status === 'running').length
  const broken = runs.filter((r) => r.status === 'error').length
  const recent = [...strategies].sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, NAV_RECENT)
  // 打开的策略不在最近编辑里时，高亮「策略库」
  const active: StrategyView = view.startsWith('bt:') ? 'backtests' : view.startsWith('st:') && !recent.some((s) => `st:${s.id}` === view) ? 'list' : view
  return (
    <Subnav title="策略" active={active} onSelect={onSelect} items={[
      { key: 'list' as StrategyView, label: '策略库', desc: `${strategies.length} 个策略`, group: '视图' },
      { key: 'backtests' as StrategyView, label: '回测记录', alert: running, title: running ? `${running} 个回测运行中` : undefined, desc: running ? `${running} 个运行中` : undefined, group: '视图' },
      { key: 'runs' as StrategyView, label: '运行记录', alert: broken, title: broken ? `${broken} 个运行异常` : undefined, desc: live ? `${live} 个在实盘或模拟盘跑` : undefined, group: '视图' },
      ...recent.map((s) => ({ key: `st:${s.id}` as StrategyView, label: s.name || '未命名策略', desc: `${MODE_LABEL[s.mode]} · ${INTERVALS[s.interval].label}`, group: '最近编辑', title: s.name })),
    ]}>
      <button className="subnav-new" onClick={onNew}><PlusIcon s={13} />新建策略</button>
    </Subnav>
  )
}

/* ---------- 策略库 ---------- */

export function StrategyListPage({ strategies, backtests, onOpen, onNew }: { strategies: Strategy[]; backtests: Backtest[]; onOpen: (id: string) => void; onNew: () => void }) {
  const [mode, setMode] = useState<'' | Strategy['mode']>('')
  const [market, setMarket] = useState('')
  const [q, setQ] = useState('')
  const kw = q.trim().toLowerCase()
  const rows = strategies
    .filter((s) => (!mode || s.mode === mode) && (!market || s.symbols.some((x) => instOf(x)?.market === market)) && (!kw || [s.name, s.desc, ...s.tags, ...s.symbols.map(instName)].some((v) => v.toLowerCase().includes(kw))))
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
  return (
    <div className="page page-fill">
      <PageTitle parent="策略" count={strategies.length} desc="条件规则或代码写的交易策略，回测通过后部署到实盘或模拟盘" actions={
        <button className="btn btn-primary" onClick={onNew}><PlusIcon />新建策略</button>
      }>策略库</PageTitle>
      <div className="toolbar">
        <div className="seg">
          {([['', '全部'], ['rules', '条件规则'], ['code', '代码']] as const).map(([k, l]) => (
            <button key={k} className={cls(mode === k && 'on')} onClick={() => setMode(k)}>{l}<span className="seg-n">{strategies.filter((s) => !k || s.mode === k).length}</span></button>
          ))}
        </div>
        <label className={cls('chip chip-select', market && 'chip-on')}>
          <select value={market} onChange={(e) => setMarket(e.target.value)}>
            <option value="">全部市场</option>
            {Object.entries(MARKETS).map(([k, m]) => <option key={k} value={k}>{m.label}</option>)}
          </select>
        </label>
        <span className="spacer" />
        <div className="search">
          <svg viewBox="0 0 16 16" width="14" height="14"><circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
          <input placeholder="搜策略名、标签、标的" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>
      {!rows.length ? (
        <div className="empty">
          <div className="empty-title">{strategies.length ? '没有匹配的策略' : '还没有策略'}</div>
          <div className="list-sub">用条件规则拼出入场出场条件，或者直接写代码</div>
          {!strategies.length && <button className="btn btn-primary" onClick={onNew}>新建策略</button>}
        </div>
      ) : (
        <div className="sg-table">
          <div className="sg-row sg-th"><span>策略</span><span>模式</span><span>标的</span><span>周期</span><span>方向</span><span>最近回测</span><span>更新</span></div>
          {rows.map((s) => {
            const bt = latestOf(s.id, backtests, true)
            const live = latestOf(s.id, backtests)
            return (
              <div key={s.id} className="sg-row" onClick={() => onOpen(s.id)}>
                <span className="task-main">
                  <span className="task-title"><span className="ellipsis">{s.name || '未命名策略'}</span></span>
                  <span className="task-meta"><span className="ellipsis">{s.desc || '没有说明'}</span></span>
                </span>
                <span><span className={cls('tag', s.mode === 'code' && 'sg-tag-code')}>{MODE_LABEL[s.mode]}</span></span>
                <SymTags symbols={s.symbols} empty="未选标的" />
                <span className="run-muted">{INTERVALS[s.interval].label}</span>
                <span className="run-muted">{DIR_LABEL[s.direction]}</span>
                <span className="sg-last">
                  {live && (live.status === 'running' || live.status === 'queued') ? (
                    live.status === 'running' ? <ProgressBar p={live.progress} /> : <Pill {...BT_STATUS.queued} />
                  ) : bt?.result ? (
                    <>
                      <Signed x={bt.result.stats.total_return} />
                      <span className="sg-last-sub sg-num">回撤 {pctRaw(bt.result.stats.max_dd)} · 夏普 {bt.result.stats.sharpe.toFixed(2)}</span>
                    </>
                  ) : <span className="faint">未回测</span>}
                </span>
                <span className="run-muted">{timeAgo(s.updated_at)}</span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

/* ---------- 策略编辑 ---------- */

type EditorProps = {
  strategy: Strategy
  onChange: (s: Strategy) => void
  onDelete: () => void
  /** 删除的连带影响，列在确认里 */
  delImpact?: string[]
  /** 用当前策略发起回测：主会话负责排队、进度和调用 runBacktest */
  onBacktest: (cfg: BacktestConfig) => void
  /** 部署到实盘/模拟盘：主会话跳到交易模块的「策略运行」新建 */
  onDeploy: (strategyId: string) => void
  lastBacktest?: Backtest
  onOpenBacktest: (id: string) => void
  /** 运行记录：这个策略部署后的每次运行 */
  runs: StrategyRun[]; accounts: TradeAccount[]; onOpenRuns: () => void
}

/** 换策略时整体重建，快速回测面板的本地状态跟着重置 */
export function StrategyEditor(props: EditorProps) {
  return <Editor key={props.strategy.id} {...props} />
}

interface QuickCfg { bars: number; capital: number; fee_bp: number; slippage_ticks: number; over: Record<string, number> }
const quickDefaults = (st: Strategy): QuickCfg => ({ bars: 1000, capital: 100000, fee_bp: instOf(st.symbols[0] ?? '')?.market === 'crypto' ? 5 : 3, slippage_ticks: 1, over: {} })

function Editor({ strategy: st, onChange, onDelete, onBacktest, onDeploy, lastBacktest, onOpenBacktest, runs, accounts, onOpenRuns, delImpact }: EditorProps) {
  const [qc, setQc] = useState<QuickCfg>(() => quickDefaults(st))
  const [confirmDel, setConfirmDel] = useState(false)
  const set = (patch: Partial<Strategy>) => onChange({ ...st, ...patch, updated_at: new Date().toISOString() })
  const cfg: BacktestConfig = {
    strategy_id: st.id, symbols: st.symbols, interval: st.interval, bars: qc.bars, capital: qc.capital, fee_bp: qc.fee_bp, slippage_ticks: qc.slippage_ticks,
    params: { ...st.params, ...Object.fromEntries(Object.entries(qc.over).filter(([k]) => k in st.params)) },
  }
  const blocker = !st.symbols.length ? '先选至少一个标的' : st.mode === 'rules' && !st.entry.rules.length ? '入场规则还是空的' : ''

  // 规则模式下改参数值，规则里引用旧值的周期、数值一起改，保证参数和规则对得上
  const setParam = (k: string, v: number) => {
    const old = st.params[k]
    const params = { ...st.params, [k]: v }
    if (st.mode !== 'rules' || old === v) return set({ params })
    const shared = Object.entries(st.params).some(([x, y]) => x !== k && y === old)
    const fix = (o: Operand): Operand => shared ? o : o.kind === 'num' ? (o.value === old ? { ...o, value: v } : o) : o.params[0] === old ? { ...o, params: [v, ...o.params.slice(1)] } : o
    const grp = (g: RuleGroup): RuleGroup => ({ ...g, rules: g.rules.map((r) => ({ ...r, left: fix(r.left), right: fix(r.right) })) })
    set({ params, entry: grp(st.entry), exit: grp(st.exit) })
  }

  return (
    <div className="page page-fill hook-page sg-page">
      <PageTitle parent="策略" desc={st.desc || undefined} actions={<>
        <button className="btn btn-outline" onClick={() => onDeploy(st.id)}>部署</button>
        <button className="btn btn-primary" disabled={!!blocker} title={blocker || undefined} onClick={() => onBacktest(cfg)}>开始回测</button>
      </>}>{st.name || '未命名策略'}</PageTitle>

      <div className="sg-grid">
        <div className="hook-col">
          <BasicInfo st={st} set={set} />

          <section className="hook-sec">
            <div className="sg-sec-head">
              <span className="field-group-title">策略逻辑</span>
              <span className="spacer" />
              <div className="seg seg-sm">
                {(['rules', 'code'] as const).map((m) => <button key={m} className={cls(st.mode === m && 'on')} onClick={() => set({ mode: m })}>{MODE_LABEL[m]}</button>)}
              </div>
            </div>
            {st.mode === 'rules' ? (
              <>
                <GroupEditor title="入场条件" hint={st.direction === 'both' ? '满足时做多，有空单先平' : st.direction === 'short' ? '满足时开空' : '满足时开多'} group={st.entry} onChange={(entry) => set({ entry })} />
                <GroupEditor title="出场条件" hint={st.direction === 'both' ? '满足时做空，有多单先平' : '满足时平仓'} group={st.exit} onChange={(exit) => set({ exit })} />
              </>
            ) : (
              <CodeEditor st={st} set={set} />
            )}
          </section>

          <section className="hook-sec">
            <div className="field-group-title">风控与仓位</div>
            <div className="sg-risk">
              <label className="field"><span className="field-label">止损 %<span className="field-hint">0 不设</span></span><NumInput min={0} value={st.stop_loss} onChange={(v) => set({ stop_loss: Math.max(0, v) })} /></label>
              <label className="field"><span className="field-label">止盈 %<span className="field-hint">0 不设</span></span><NumInput min={0} value={st.take_profit} onChange={(v) => set({ take_profit: Math.max(0, v) })} /></label>
              <label className="field"><span className="field-label">每次开仓占账户 %</span><NumInput min={1} value={st.position_pct} onChange={(v) => set({ position_pct: Math.max(0, Math.min(100, v)) })} /></label>
            </div>
          </section>

          <ParamsTable st={st} setParams={(params) => set({ params })} setParam={setParam} />
        </div>

        <div className="hook-col sg-side">
          <QuickPanel st={st} qc={qc} setQc={setQc} cfg={cfg} blocker={blocker} onRun={() => onBacktest(cfg)} />
          <LastPanel st={st} bt={lastBacktest} onOpen={onOpenBacktest} />
          <StrategyRunsPanel st={st} runs={runs} accounts={accounts} onOpenAll={onOpenRuns} onDeploy={() => onDeploy(st.id)} />
        </div>
      </div>

      <div className="hook-foot">
        {confirmDel ? (
          <>
            <span className="danger-text">{delImpact?.length ? `删除后不能恢复：${delImpact.join('；')}` : '删除后不能恢复，已有的回测记录保留'}</span>
            <span className="spacer" />
            <button className="btn btn-ghost" onClick={() => setConfirmDel(false)}>取消</button>
            <button className="btn btn-danger" onClick={onDelete}>删除</button>
          </>
        ) : (
          <>
            <button className="btn btn-ghost btn-danger-ghost" onClick={() => setConfirmDel(true)}>删除策略</button>
            <span className="spacer" />
            <span className="list-sub">改动自动保存 · {timeAgo(st.updated_at)}更新</span>
          </>
        )}
      </div>
    </div>
  )
}

function BasicInfo({ st, set }: { st: Strategy; set: (p: Partial<Strategy>) => void }) {
  const [tagInput, setTagInput] = useState('')
  const [nameTouched, setNameTouched] = useState(false)
  const nameErr = nameTouched && !st.name.trim()
  const addTag = () => { const t = tagInput.trim(); if (t && !st.tags.includes(t)) set({ tags: [...st.tags, t] }); setTagInput('') }
  const currencies = new Set(st.symbols.map((s) => currencyOf([s])))
  return (
    <section className="hook-sec">
      <div className="field-group-title">基本信息</div>
      <label className="field"><span className="field-label">名称<em>*</em></span><input value={st.name} placeholder="比如：双均线趋势" aria-invalid={nameErr} onBlur={() => setNameTouched(true)} onChange={(e) => set({ name: e.target.value })} />
        {nameErr && <span className="danger-text sg-small">名称不能为空，其余改动照常保存</span>}</label>
      <label className="field"><span className="field-label">说明</span><textarea rows={2} value={st.desc} placeholder="什么行情下用、怎么进出场" onChange={(e) => set({ desc: e.target.value })} /></label>
      <div className="field">
        <span className="field-label">标签<span className="field-hint">用于在策略库里搜</span></span>
        <div className="tag-input">
          {st.tags.map((t) => <span key={t} className="tag">{t}<button type="button" title="移除" onClick={() => set({ tags: st.tags.filter((x) => x !== t) })}><XIcon /></button></span>)}
          <input value={tagInput} placeholder={st.tags.length ? '' : '输入后回车添加'} onChange={(e) => setTagInput(e.target.value)} onBlur={addTag}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); addTag() }
              if (e.key === 'Backspace' && !tagInput && st.tags.length) set({ tags: st.tags.slice(0, -1) })
            }} />
        </div>
      </div>
      <SymbolPicker value={st.symbols} onChange={(symbols) => set({ symbols })} />
      {currencies.size > 1 && <div className="field-hint-line">选了不同币种的标的，回测按各自币种直接相加，不做汇率换算</div>}
      <div className="field">
        <span className="field-label">K 线周期</span>
        <div className="seg sg-seg-wrap">
          {(Object.keys(INTERVALS) as BarInterval[]).map((k) => <button key={k} className={cls(st.interval === k && 'on')} onClick={() => set({ interval: k })}>{INTERVALS[k].label}</button>)}
        </div>
      </div>
      <div className="field">
        <span className="field-label">方向</span>
        <div className="seg sg-seg-wrap">
          {(Object.keys(DIR_LABEL) as Strategy['direction'][]).map((k) => <button key={k} className={cls(st.direction === k && 'on')} onClick={() => set({ direction: k })}>{DIR_LABEL[k]}</button>)}
        </div>
      </div>
    </section>
  )
}

function SymbolPicker({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)
  const kw = q.trim().toLowerCase()
  const opts = INSTRUMENTS.filter((i) => !value.includes(i.symbol) && (!kw || [i.symbol, i.name, i.venue, MARKETS[i.market].label, INST_KIND[i.kind].short].some((v) => v.toLowerCase().includes(kw)))).slice(0, 8)
  const add = (s: string) => { onChange([...value, s]); setQ('') }
  return (
    <div className="field">
      <span className="field-label">标的<em>*</em><span className="field-hint">可多选，回测时资金平均分配</span></span>
      <div className="sg-pick">
        <div className="tag-input">
          {value.map((s) => (
            <span key={s} className="tag" title={s}>{instName(s)}<span className="faint">{instOf(s) ? INST_KIND[instOf(s)!.kind].short : ''}</span>
              <button type="button" title="移除" onClick={() => onChange(value.filter((x) => x !== s))}><XIcon /></button>
            </span>
          ))}
          <input value={q} placeholder={value.length ? '继续添加' : '搜名称、代码、交易所'} onFocus={() => setOpen(true)} onBlur={() => setOpen(false)}
            onChange={(e) => { setQ(e.target.value); setOpen(true) }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && opts[0]) { e.preventDefault(); add(opts[0].symbol) }
              if (e.key === 'Backspace' && !q && value.length) onChange(value.slice(0, -1))
              if (e.key === 'Escape') setOpen(false)
            }} />
        </div>
        {open && (
          <div className="sg-pick-menu">
            {opts.length ? opts.map((i) => (
              <button key={i.symbol} type="button" className="sg-pick-opt" onMouseDown={(e) => { e.preventDefault(); add(i.symbol) }}>
                <span className="ellipsis">{i.name}</span>
                <span className="mono faint ellipsis">{i.symbol}</span>
                <span className="tag">{MARKETS[i.market].label} · {INST_KIND[i.kind].short}</span>
              </button>
            )) : <div className="io-empty">没有匹配的标的</div>}
          </div>
        )}
      </div>
    </div>
  )
}

function OperandEditor({ o, onChange, allowNum }: { o: Operand; onChange: (o: Operand) => void; allowNum?: boolean }) {
  const sel = o.kind === 'num' ? '__num' : o.ind
  return (
    <span className="sg-opnd">
      <select className="sg-select" value={sel} onChange={(e) => {
        const v = e.target.value
        if (v === '__num') onChange({ kind: 'num', value: o.kind === 'num' ? o.value : 0 })
        else onChange({ kind: 'ind', ind: v as Indicator, params: [...IND_DEFAULT[v as Indicator]] })
      }}>
        {allowNum && <option value="__num">数值</option>}
        {(Object.keys(INDICATORS) as Indicator[]).map((k) => <option key={k} value={k}>{INDICATORS[k].label}</option>)}
      </select>
      {o.kind === 'num' ? (
        <NumInput className="sg-numin sg-numin-wide" value={o.value} onChange={(value) => onChange({ kind: 'num', value })} />
      ) : INDICATORS[o.ind].params.map((label, i) => (
        <NumInput key={i} className="sg-numin" title={label} placeholder={label} value={o.params[i] ?? IND_DEFAULT[o.ind][i]}
          onChange={(v) => { const ps = [...o.params]; ps[i] = v; onChange({ ...o, params: ps }) }} />
      ))}
    </span>
  )
}

function GroupEditor({ title, hint, group, onChange }: { title: string; hint: string; group: RuleGroup; onChange: (g: RuleGroup) => void }) {
  const setRule = (id: string, r: Rule) => onChange({ ...group, rules: group.rules.map((x) => (x.id === id ? r : x)) })
  const addRule = () => onChange({ ...group, rules: [...group.rules, { id: newId('rl'), left: { kind: 'ind', ind: 'price', params: [] }, op: 'cross_up', right: { kind: 'ind', ind: 'ma', params: [20] } }] })
  return (
    <div className="sg-group">
      <div className="sg-sec-head">
        <span className="sg-group-title">{title}</span>
        <span className="field-hint">{hint}</span>
        <span className="spacer" />
        {group.rules.length > 1 && (
          <div className="seg seg-sm">
            <button className={cls(group.logic === 'all' && 'on')} onClick={() => onChange({ ...group, logic: 'all' })}>全部满足</button>
            <button className={cls(group.logic === 'any' && 'on')} onClick={() => onChange({ ...group, logic: 'any' })}>任一满足</button>
          </div>
        )}
      </div>
      {group.rules.length === 0 && <div className="mount-empty">还没有条件{title === '入场条件' ? '，不会开仓' : '，只靠止损止盈离场'}</div>}
      {group.rules.map((r, i) => (
        <div key={r.id} className="sg-rule">
          <span className="sg-rule-join">{i === 0 ? '当' : group.logic === 'all' ? '并且' : '或者'}</span>
          <OperandEditor o={r.left} onChange={(left) => setRule(r.id, { ...r, left })} />
          <select className="sg-select sg-op" value={r.op} onChange={(e) => setRule(r.id, { ...r, op: e.target.value as Compare })}>
            {(Object.keys(COMPARE) as Compare[]).map((k) => <option key={k} value={k}>{COMPARE[k]}</option>)}
          </select>
          <OperandEditor o={r.right} allowNum onChange={(right) => setRule(r.id, { ...r, right })} />
          <button className="icon-btn sg-rule-del" title="删除这条" onClick={() => onChange({ ...group, rules: group.rules.filter((x) => x.id !== r.id) })}><XIcon /></button>
        </div>
      ))}
      <div className="act-row"><button className="act act-quiet" onClick={addRule}><PlusIcon />加一条条件</button></div>
    </div>
  )
}

function CodeLines({ code }: { code: string }) {
  const lines = code.split('\n')
  return (
    <div className="sg-code sg-code-ro">
      <div className="sg-gutter">{lines.map((_, i) => <div key={i}>{i + 1}</div>)}</div>
      <pre className="sg-code-pre">{code || ' '}</pre>
    </div>
  )
}

function CodeEditor({ st, set }: { st: Strategy; set: (p: Partial<Strategy>) => void }) {
  const gut = useRef<HTMLDivElement>(null)
  const ta = useRef<HTMLTextAreaElement>(null)
  const lines = st.code.split('\n').length
  const found = [...new Set([...st.code.matchAll(/params\.([A-Za-z_]\w*)/g)].map((m) => m[1]))]
  const missing = found.filter((k) => !(k in st.params))
  const kind = codeKindOf(st)
  return (
    <>
      <div className="sg-code">
        <div className="sg-gutter" ref={gut}>{Array.from({ length: lines }, (_, i) => <div key={i}>{i + 1}</div>)}</div>
        <textarea ref={ta} value={st.code} spellCheck={false} wrap="off" placeholder="# def on_bar(ctx, bar): ..."
          onScroll={(e) => { if (gut.current) gut.current.scrollTop = e.currentTarget.scrollTop }}
          onChange={(e) => set({ code: e.target.value })}
          onKeyDown={(e) => {
            if (e.key !== 'Tab') return
            e.preventDefault()
            const el = e.currentTarget
            const a = el.selectionStart, b = el.selectionEnd
            set({ code: `${st.code.slice(0, a)}    ${st.code.slice(b)}` })
            requestAnimationFrame(() => { if (ta.current) ta.current.selectionStart = ta.current.selectionEnd = a + 4 })
          }} />
      </div>
      <div className="sg-code-foot">
        <span className="list-sub">不执行源码，回测按「{CODE_KIND_LABEL[kind]}」内置近似模拟。代码里用 params.名字 引用右侧参数</span>
        <span className="spacer" />
        {missing.length > 0 && <button className="act" onClick={() => set({ params: { ...st.params, ...Object.fromEntries(missing.map((k) => [k, 0])) } })}>从代码补全参数 {missing.length} 个</button>}
      </div>
    </>
  )
}

function ParamsTable({ st, setParams, setParam }: { st: Strategy; setParams: (p: Record<string, number>) => void; setParam: (k: string, v: number) => void }) {
  const entries = Object.entries(st.params)
  const rename = (from: string, to: string) => {
    const k = to.trim()
    if (!k || k === from || k in st.params) return false
    setParams(Object.fromEntries(entries.map(([x, v]) => [x === from ? k : x, v])))
    return true
  }
  const add = () => { let n = entries.length + 1; while (`p${n}` in st.params) n++; setParams({ ...st.params, [`p${n}`]: 0 }) }
  return (
    <section className="hook-sec">
      <div className="field-group-title">可调参数<span className="field-hint">{st.mode === 'rules' ? '规则里的周期或数值等于某个参数值时跟着它走，回测时可以覆盖、扫参' : '回测时可以覆盖、扫参'}</span></div>
      {entries.length === 0 ? <div className="mount-empty">没有参数</div> : (
        <div className="sg-params">
          {entries.map(([k, v]) => (
            <div key={k} className="sg-param-row">
              <input className="mono-input" defaultValue={k} title="参数名，失焦后生效"
                onBlur={(e) => { if (!rename(k, e.target.value)) e.target.value = k }}
                onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }} />
              <NumInput className="mono-input sg-num" value={v} onChange={(x) => setParam(k, x)} />
              <button className="icon-btn" title="删除参数" onClick={() => setParams(Object.fromEntries(entries.filter(([x]) => x !== k)))}><XIcon /></button>
            </div>
          ))}
        </div>
      )}
      <div className="act-row"><button className="act act-quiet" onClick={add}><PlusIcon />添加参数</button></div>
    </section>
  )
}

function QuickPanel({ st, qc, setQc, cfg, blocker, onRun }: { st: Strategy; qc: QuickCfg; setQc: (q: QuickCfg) => void; cfg: BacktestConfig; blocker: string; onRun: () => void }) {
  const keys = Object.keys(st.params)
  const overridden = keys.filter((k) => k in qc.over && qc.over[k] !== st.params[k])
  return (
    <section className="hook-sec">
      <div className="field-group-title">快速回测<span className="field-hint">{st.symbols.length} 个标的 · {INTERVALS[st.interval].label}</span></div>
      <div className="field">
        <span className="field-label">区间：最近 {qc.bars} 根<span className="field-hint">{spanText(qc.bars, st.interval)}</span></span>
        <div className="seg seg-full">
          {[200, 500, 1000, 2000].map((n) => <button key={n} className={cls(qc.bars === n && 'on')} onClick={() => setQc({ ...qc, bars: n })}>{n}</button>)}
        </div>
      </div>
      <div className="field-row">
        <label className="field"><span className="field-label">初始资金<span className="field-hint">{currencyOf(st.symbols)}</span></span><NumInput min={1} value={qc.capital} onChange={(v) => setQc({ ...qc, capital: Math.max(1, v) })} /></label>
        <label className="field"><span className="field-label">K 线根数</span><NumInput min={50} value={qc.bars} onChange={(v) => setQc({ ...qc, bars: Math.max(50, Math.min(5000, Math.round(v))) })} /></label>
      </div>
      <div className="field-row">
        <label className="field"><span className="field-label">手续费<span className="field-hint">万分之</span></span><NumInput min={0} value={qc.fee_bp} onChange={(v) => setQc({ ...qc, fee_bp: Math.max(0, v) })} /></label>
        <label className="field"><span className="field-label">滑点<span className="field-hint">跳</span></span><NumInput min={0} value={qc.slippage_ticks} onChange={(v) => setQc({ ...qc, slippage_ticks: Math.max(0, v) })} /></label>
      </div>
      {keys.length > 0 && (
        <div className="field">
          <span className="field-label">参数覆盖<span className="field-hint">只影响这次回测，不改策略</span>
            {overridden.length > 0 && <button className="link-btn sg-reset" onClick={() => setQc({ ...qc, over: {} })}>恢复默认</button>}
          </span>
          <div className="sg-over">
            {keys.map((k) => (
              <label key={k} className={cls('sg-over-item', overridden.includes(k) && 'on')}>
                <span className="mono ellipsis" title={k}>{k}</span>
                <NumInput className="mono-input sg-num" value={cfg.params[k]} onChange={(v) => setQc({ ...qc, over: { ...qc.over, [k]: v } })} />
              </label>
            ))}
          </div>
        </div>
      )}
      <div className="act-row">
        <button className="act act-primary" disabled={!!blocker} onClick={onRun}>开始回测</button>
        {blocker && <span className="warn-text sg-small">{blocker}</span>}
      </div>
    </section>
  )
}

/** 策略内容（不含时间戳）和快照比，判断回测之后有没有改过 */
const sig = (s: Strategy) => JSON.stringify({ ...s, updated_at: '', created_at: '' })

function LastPanel({ st, bt, onOpen }: { st: Strategy; bt?: Backtest; onOpen: (id: string) => void }) {
  if (!bt) return (
    <section className="hook-sec">
      <div className="field-group-title">最近一次回测</div>
      <div className="mount-empty">还没回测过，调好参数点「开始回测」</div>
    </section>
  )
  const s = bt.result?.stats
  return (
    <section className="hook-sec">
      <div className="sg-sec-head">
        <span className="field-group-title">最近一次回测</span>
        <span className="spacer" />
        <StatusCell b={bt} />
      </div>
      <div className="list-sub">{bt.name} · {timeAgo(bt.created_at)}</div>
      {bt.status === 'failed' && <div className="detail-alert"><span>{bt.error || '回测失败'}</span></div>}
      {bt.status === 'queued' && <div className="mount-empty">排队中，前面的回测跑完就轮到它</div>}
      {s && (
        <>
          <div className="sg-mini">
            <div><span className="stat-label">总收益</span><Signed x={s.total_return} /></div>
            <div><span className="stat-label">最大回撤</span><span className="sg-num">{pctRaw(s.max_dd)}</span></div>
            <div><span className="stat-label">夏普</span><span className="sg-num">{s.sharpe.toFixed(2)}</span></div>
            <div><span className="stat-label">交易</span><span className="sg-num">{s.trades} 笔</span></div>
          </div>
          <Spark values={bt.result!.equity.map((e) => e.v)} color={tone(s.total_return) ?? 'var(--accent)'} />
        </>
      )}
      {sig(bt.strategy_snapshot) !== sig(st) && <div className="field-hint-line">策略在这次回测之后改过，结果可能对不上</div>}
      <div className="act-row"><button className="act" onClick={() => onOpen(bt.id)}>查看报告</button></div>
    </section>
  )
}

/* ---------- 回测记录 ---------- */

type BtFilter = 'all' | BacktestStatus

/** 回测记录先露这么多条 */
const BT_PAGE = 50

export function BacktestsPage({ backtests, strategies, onOpen }: { backtests: Backtest[]; strategies: Strategy[]; onOpen: (id: string) => void; onCompare?: never }) {
  const [st, setSt] = useState<BtFilter>('all')
  const [sid, setSid] = useState('')
  const [q, setQ] = useState('')
  const [picked, setPicked] = useState<string[]>([])
  const [comparing, setComparing] = useState(false)
  const [limit, setLimit] = useState(BT_PAGE)
  const kw = q.trim().toLowerCase()
  const stName = (b: Backtest) => strategies.find((s) => s.id === b.config.strategy_id)?.name ?? b.strategy_snapshot.name
  const rows = backtests
    .filter((b) => (st === 'all' || b.status === st) && (!sid || b.config.strategy_id === sid) && (!kw || [b.name, stName(b), ...b.config.symbols.map(instName)].some((v) => v.toLowerCase().includes(kw))))
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
  const chosen = picked.map((id) => backtests.find((b) => b.id === id)).filter((b): b is Backtest => !!b && b.status === 'done' && !!b.result)
  const toggle = (id: string) => setPicked(picked.includes(id) ? picked.filter((x) => x !== id) : picked.length >= 4 ? picked : [...picked, id])
  const sids = [...new Set(backtests.map((b) => b.config.strategy_id))]
  return (
    <div className="page page-fill">
      <PageTitle parent="策略" count={backtests.length} desc="每次回测的配置、结果和策略快照；勾选 2 到 4 条已完成的可以对比" actions={
        chosen.length >= 2 ? <button className="btn btn-primary" onClick={() => setComparing(!comparing)}>{comparing ? '收起对比' : `对比 ${chosen.length} 条`}</button> : chosen.length === 1 ? <span className="list-sub">再勾一条就能对比</span> : undefined
      }>回测记录</PageTitle>
      {comparing && chosen.length >= 2 && <CompareView items={chosen} names={chosen.map(stName)} onClose={() => setComparing(false)} onOpen={onOpen} />}
      <div className="toolbar">
        <div className="seg sg-seg-wrap">
          {([['all', '全部'], ['running', '运行中'], ['queued', '排队中'], ['done', '已完成'], ['failed', '失败']] as [BtFilter, string][]).map(([k, l]) => (
            <button key={k} className={cls(st === k && 'on')} onClick={() => { setSt(k); setLimit(BT_PAGE) }}>{l}<span className="seg-n">{backtests.filter((b) => k === 'all' || b.status === k).length}</span></button>
          ))}
        </div>
        <SearchSelect value={sid} noneLabel="全部策略" searchPlaceholder="搜策略名" onChange={(v) => { setSid(v); setLimit(BT_PAGE) }}
          options={sids.map((x) => ({ value: x, label: strategies.find((s) => s.id === x)?.name ?? backtests.find((b) => b.config.strategy_id === x)?.strategy_snapshot.name ?? x, hint: `${backtests.filter((b) => b.config.strategy_id === x).length} 次` }))} />
        {picked.length > 0 && <button className="act act-quiet" onClick={() => { setPicked([]); setComparing(false) }}>清除勾选 {picked.length}</button>}
        <span className="spacer" />
        <div className="search">
          <svg viewBox="0 0 16 16" width="14" height="14"><circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
          <input placeholder="搜回测名、策略、标的" value={q} onChange={(e) => { setQ(e.target.value); setLimit(BT_PAGE) }} />
        </div>
      </div>
      {!rows.length ? (
        <div className="empty">
          <div className="empty-title">{backtests.length ? '没有匹配的回测' : '还没有回测'}</div>
          <div className="list-sub">在策略编辑页右侧的「快速回测」里发起</div>
        </div>
      ) : (
        <div className="sg-table">
          <div className="bt-row sg-th"><span /><span>回测</span><span>标的</span><span>区间</span><span>状态</span><span>收益</span><span>回撤</span><span>夏普</span><span>时间</span></div>
          {rows.slice(0, limit).map((b) => {
            const s = b.result?.stats
            const can = b.status === 'done' && !!b.result
            const on = picked.includes(b.id)
            return (
              <div key={b.id} className={cls('bt-row', on && 'sel')} onClick={() => onOpen(b.id)}>
                <span onClick={(e) => e.stopPropagation()}>
                  <input type="checkbox" className="sg-check" checked={on} disabled={!can || (!on && picked.length >= 4)} title={can ? (picked.length >= 4 && !on ? '最多对比 4 条' : '勾选做对比') : '完成后才能对比'} onChange={() => toggle(b.id)} />
                </span>
                <span className="task-main">
                  <span className="task-title"><span className="ellipsis">{b.name}</span></span>
                  <span className="task-meta"><span className="ellipsis">{stName(b)}</span></span>
                </span>
                <SymTags symbols={b.config.symbols} />
                <span className="run-muted sg-num">{b.config.bars} 根 · {INTERVALS[b.config.interval].label}</span>
                <span><StatusCell b={b} /></span>
                <span>{s ? <Signed x={s.total_return} /> : <span className="faint">-</span>}</span>
                <span className="sg-num run-muted">{s ? pctRaw(s.max_dd) : '-'}</span>
                <span className="sg-num run-muted">{s ? s.sharpe.toFixed(2) : '-'}</span>
                <span className="run-muted">{timeAgo(b.created_at)}</span>
              </div>
            )
          })}
        </div>
      )}
      {rows.length > limit && <button className="act act-quiet sg-more" onClick={() => setLimit(limit + BT_PAGE)}>再显示 {Math.min(BT_PAGE, rows.length - limit)} 条<span className="faint">（还有 {rows.length - limit} 条更早的）</span></button>}
    </div>
  )
}

const METRICS: { key: keyof NonNullable<Backtest['result']>['stats'] | 'excess'; label: string; fmt: (x: number) => ReactNode; better: 1 | -1 }[] = [
  { key: 'total_return', label: '总收益', fmt: (x) => <Signed x={x} />, better: 1 },
  { key: 'annual', label: '年化', fmt: (x) => <Signed x={x} />, better: 1 },
  { key: 'excess', label: '超额', fmt: (x) => <Signed x={x} />, better: 1 },
  { key: 'max_dd', label: '最大回撤', fmt: pctRaw, better: -1 },
  { key: 'sharpe', label: '夏普', fmt: (x) => x.toFixed(2), better: 1 },
  { key: 'win_rate', label: '胜率', fmt: pctRaw, better: 1 },
  { key: 'trades', label: '交易次数', fmt: (x) => String(x), better: 1 },
  { key: 'profit_factor', label: '盈亏比', fmt: (x) => (x >= 99 ? '无亏损' : x.toFixed(2)), better: 1 },
  { key: 'bench_return', label: '基准收益', fmt: (x) => <Signed x={x} />, better: 1 },
]
const metricOf = (b: Backtest, k: (typeof METRICS)[number]['key']) => {
  const s = b.result!.stats
  return k === 'excess' ? s.total_return - s.bench_return : s[k]
}

function CompareView({ items, names, onClose, onOpen }: { items: Backtest[]; names: string[]; onClose: () => void; onOpen: (id: string) => void }) {
  const lines: Line[] = items.map((b, i) => ({ label: b.name, color: LINE_COLORS[i], values: b.result!.equity.map((e) => e.v / b.config.capital - 1) }))
  return (
    <section className="hook-sec bt-compare">
      <div className="sg-sec-head">
        <span className="field-group-title">对比 {items.length} 条回测<span className="field-hint">收益率曲线，横轴按各自区间的起止对齐</span></span>
        <span className="spacer" />
        <button className="act act-quiet" onClick={onClose}>收起</button>
      </div>
      <div className="bt-legend">{items.map((b, i) => <span key={b.id}><i style={{ background: LINE_COLORS[i] }} />{b.name}</span>)}</div>
      <Chart lines={lines} height={240} base={0} fmtY={(v) => fmtPct(v)} xLabel={(f) => (f === 0 ? '起点' : f === 1 ? '终点' : `${Math.round(f * 100)}%`)} />
      <div className="bt-scroll">
        <table className="bt-mtable">
          <thead><tr><th>指标</th>{items.map((b, i) => <th key={b.id}><button className="link-btn" style={{ color: LINE_COLORS[i] }} onClick={() => onOpen(b.id)}>{b.name}</button><div className="faint sg-small">{names[i]}</div></th>)}</tr></thead>
          <tbody>
            <tr><td>区间</td>{items.map((b) => <td key={b.id} className="sg-num">{b.config.bars} 根 · {INTERVALS[b.config.interval].label}</td>)}</tr>
            {METRICS.map((m) => {
              const vs = items.map((b) => metricOf(b, m.key))
              const best = m.key === 'trades' || m.key === 'bench_return' ? NaN : m.better > 0 ? Math.max(...vs) : Math.min(...vs)
              return <tr key={m.key}><td>{m.label}</td>{vs.map((v, i) => <td key={i} className={cls('sg-num', v === best && 'bt-best')}>{m.fmt(v)}</td>)}</tr>
            })}
          </tbody>
        </table>
      </div>
    </section>
  )
}

/* ---------- 回测报告 ---------- */

export function BacktestReport({ backtest: b, onRerun, onDeploy, onOpenStrategy, onDelete }: { backtest: Backtest; onRerun: (cfg: BacktestConfig) => void; onDeploy: (strategyId: string) => void; onOpenStrategy: (id: string) => void; onDelete?: () => void }) {
  const [confirmDel, setConfirmDel] = useState(false)
  const snap = b.strategy_snapshot
  const r = b.result as (Backtest['result'] & { note?: string }) | undefined
  const cur = currencyOf(b.config.symbols)
  return (
    <div className="page page-fill bt-page">
      <PageTitle parent="回测记录" desc={`${snap.name} · ${b.config.symbols.map(instName).join('、')} · ${b.config.bars} 根 ${INTERVALS[b.config.interval].label}`} actions={<>
        <button className="btn btn-ghost" onClick={() => onOpenStrategy(b.config.strategy_id)}>打开策略</button>
        <button className="btn btn-outline" disabled={b.status === 'running' || b.status === 'queued'} onClick={() => onRerun(b.config)}>重新回测</button>
        <button className="btn btn-primary" onClick={() => onDeploy(b.config.strategy_id)}>部署</button>
      </>}>{b.name}</PageTitle>

      <div className="bt-meta">
        <StatusCell b={b} />
        <span>初始资金 <b className="sg-num">{money(b.config.capital)}</b> {cur}</span>
        <span>手续费 万分之 <b className="sg-num">{b.config.fee_bp}</b></span>
        <span>滑点 <b className="sg-num">{b.config.slippage_ticks}</b> 跳</span>
        <span>{spanText(b.config.bars, b.config.interval)}</span>
        {r && r.equity.length > 0 && <span title="实际回测区间第一根、最后一根 K 线的开盘时间">数据 {fmtT(r.equity[0].t, b.config.interval)} 到 {fmtT(r.equity[r.equity.length - 1].t, b.config.interval)}</span>}
        <span className="faint">{timeAgo(b.created_at)}发起{b.finished_at ? ` · ${timeAgo(b.finished_at)}完成` : ''}</span>
      </div>

      {b.status === 'failed' && <div className="detail-alert"><span><b>回测失败</b>{b.error || '没有错误信息'}</span><button className="act" onClick={() => onRerun(b.config)}>重新回测</button></div>}
      {(b.status === 'queued' || b.status === 'running') && (
        <section className="hook-sec bt-wait">
          <div className="field-group-title">{b.status === 'queued' ? '排队中' : '回测进行中'}</div>
          <ProgressBar p={b.status === 'queued' ? 0 : b.progress} />
          <div className="list-sub">{b.status === 'queued' ? '前面的回测跑完就开始' : '跑完会自动出报告，可以先去做别的'}</div>
        </section>
      )}
      {r?.note && <div className="bt-note"><span>{r.note}</span></div>}

      {b.status === 'done' && r && (
        <>
          <div className="stats bt-stats">
            {METRICS.filter((m) => m.key !== 'bench_return').map((m) => {
              const v = metricOf(b, m.key)
              return (
                <div key={m.key} className="stat">
                  <div className="stat-label">{m.label}{m.key === 'excess' && <span className="faint sg-num"> 基准 {fmtPct(r.stats.bench_return)}</span>}</div>
                  <div className="stat-value sg-num">{m.fmt(v)}</div>
                </div>
              )
            })}
          </div>

          <section className="hook-sec">
            <div className="sg-sec-head">
              <span className="field-group-title">资金曲线</span>
              <span className="spacer" />
              <div className="bt-legend"><span><i style={{ background: 'var(--accent)' }} />策略</span><span><i className="dash" />等权买入持有</span></div>
            </div>
            <Chart height={260} lines={[
              { label: '策略', color: 'var(--accent)', values: r.equity.map((e) => e.v) },
              { label: '基准', color: 'var(--faint)', dash: true, values: r.equity.map((e) => e.bench) },
            ]} fmtY={(v) => money(v)} xLabel={(f) => (r.equity.length ? fmtT(r.equity[Math.round(f * (r.equity.length - 1))].t, b.config.interval) : '')} />
          </section>

          <section className="hook-sec">
            <div className="field-group-title">回撤<span className="field-hint">资金相对此前最高点跌了多少</span></div>
            <Underwater equity={r.equity} iv={b.config.interval} />
          </section>

          <div className="bt-grid2">
            <section className="hook-sec"><Heatmap equity={r.equity} /></section>
            <section className="hook-sec"><SweepPanel b={b} onRerun={onRerun} /></section>
          </div>

          <section className="hook-sec"><TradesTable b={b} /></section>
        </>
      )}

      <section className="hook-sec">
        <div className="field-group-title">策略快照<span className="field-hint">发起回测那一刻的策略，之后改策略不影响这份报告</span></div>
        <Snapshot st={snap} cfg={b.config} />
      </section>

      {onDelete && (
        <div className="bt-del">
          {confirmDel ? (
            <>
              <span className="danger-text">只删这一条回测记录和它的扫描结果，策略不动{b.status === 'running' || b.status === 'queued' ? '；还没跑完的会先停下' : ''}</span>
              <button className="btn btn-ghost" onClick={() => setConfirmDel(false)}>取消</button>
              <button className="btn btn-danger" onClick={onDelete}>删除</button>
            </>
          ) : <button className="btn btn-ghost btn-danger-ghost" onClick={() => setConfirmDel(true)}>删除这条回测记录</button>}
        </div>
      )}
    </div>
  )
}

function Underwater({ equity, iv }: { equity: { t: number; v: number }[]; iv: BarInterval }) {
  const dd = useMemo(() => {
    let peak = -Infinity
    return equity.map((e) => { peak = Math.max(peak, e.v); return peak > 0 ? e.v / peak - 1 : 0 })
  }, [equity])
  return <Chart height={140} base={0} lines={[{ label: '回撤', color: DOWN, values: dd, fill: true }]} fmtY={(v) => pctRaw(v)} xLabel={(f) => (equity.length ? fmtT(equity[Math.round(f * (equity.length - 1))].t, iv) : '')} />
}

/** 分段收益：区间够长按月，否则按天，再短按 4 小时 */
function Heatmap({ equity }: { equity: { t: number; v: number }[] }) {
  const data = useMemo(() => {
    if (equity.length < 2) return null
    const span = equity[equity.length - 1].t - equity[0].t
    const mode: 'month' | 'day' | 'hour' = span >= 60 * 86400000 ? 'month' : span >= 3 * 86400000 ? 'day' : 'hour'
    const z = (n: number) => String(n).padStart(2, '0')
    const keyOf = (t: number) => {
      const d = new Date(t)
      return mode === 'month' ? `${d.getFullYear()}-${z(d.getMonth() + 1)}` : mode === 'day' ? `${z(d.getMonth() + 1)}-${z(d.getDate())}` : `${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(Math.floor(d.getHours() / 4) * 4)}时`
    }
    const cells: { key: string; ret: number }[] = []
    let start = equity[0].v, cur = '', last = equity[0].v
    for (const e of equity) {
      const k = keyOf(e.t)
      if (k !== cur) {
        if (cur) { cells.push({ key: cur, ret: last / start - 1 }); start = last }
        cur = k
      }
      last = e.v
    }
    cells.push({ key: cur, ret: last / start - 1 })
    return { mode, cells }
  }, [equity])
  if (!data) return <div className="mount-empty">数据不够</div>
  const max = Math.max(...data.cells.map((c) => Math.abs(c.ret)), 1e-9)
  const bg = (r: number) => (Math.abs(r) < 1e-12 ? undefined : `color-mix(in srgb, ${r > 0 ? UP : DOWN} ${Math.round(10 + (Math.abs(r) / max) * 55)}%, transparent)`)
  const title = { month: '月度收益', day: '每日收益', hour: '每 4 小时收益' }[data.mode]
  if (data.mode === 'month') {
    const years = [...new Set(data.cells.map((c) => c.key.slice(0, 4)))]
    return (
      <>
        <div className="field-group-title">{title}</div>
        <div className="bt-scroll">
          <table className="bt-heat">
            <thead><tr><th />{Array.from({ length: 12 }, (_, i) => <th key={i}>{i + 1}月</th>)}<th>全年</th></tr></thead>
            <tbody>
              {years.map((y) => {
                const ys = data.cells.filter((c) => c.key.startsWith(y))
                const yr = ys.reduce((s, c) => s * (1 + c.ret), 1) - 1
                return (
                  <tr key={y}>
                    <th>{y}</th>
                    {Array.from({ length: 12 }, (_, i) => {
                      const c = ys.find((x) => x.key === `${y}-${String(i + 1).padStart(2, '0')}`)
                      return <td key={i} style={{ background: c ? bg(c.ret) : undefined }} title={c ? `${c.key} ${fmtPct(c.ret)}` : undefined}>{c ? (c.ret * 100).toFixed(1) : ''}</td>
                    })}
                    <td className="bt-heat-y" style={{ color: tone(yr) }}>{(yr * 100).toFixed(1)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <div className="field-hint-line">单位 %</div>
      </>
    )
  }
  const shown = data.cells.slice(-120)
  return (
    <>
      <div className="field-group-title">{title}{data.cells.length > shown.length && <span className="field-hint">只显示最近 {shown.length} 段</span>}</div>
      <div className="bt-cells">
        {shown.map((c) => <div key={c.key} className="bt-cell" style={{ background: bg(c.ret) }} title={`${c.key} ${fmtPct(c.ret)}`}><span>{c.key}</span><b className="sg-num">{fmtPct(c.ret)}</b></div>)}
      </div>
    </>
  )
}

function defaultValues(v: number, key: string) {
  if (!v) return key === 'take_profit' || key === 'stop_loss' ? [0, 3, 6, 10, 15] : [0, 1, 2, 5, 10]
  const int = Number.isInteger(v)
  const xs = [0.5, 0.75, 1, 1.25, 1.5, 2].map((k) => (int ? Math.max(1, Math.round(v * k)) : Number((v * k).toPrecision(3))))
  return [...new Set(xs)]
}

function SweepPanel({ b, onRerun }: { b: Backtest; onRerun: (cfg: BacktestConfig) => void }) {
  const opts = sweepableParams(b.strategy_snapshot)
  const [param, setParam] = useState(opts[0]?.key ?? 'stop_loss')
  const curVal = b.config.params[param] ?? opts.find((o) => o.key === param)?.value ?? 0
  const [txt, setTxt] = useState(() => defaultValues(curVal, param).join(', '))
  const [res, setRes] = useState<{ param: string; rows: ReturnType<typeof sweep> } | null>(null)
  const values = [...new Set(txt.split(/[,，\s]+/).filter(Boolean).map(Number).filter(Number.isFinite))].slice(0, 20)
  const pick = (k: string) => {
    setParam(k)
    const v = b.config.params[k] ?? opts.find((o) => o.key === k)?.value ?? 0
    setTxt(defaultValues(v, k).join(', '))
  }
  const rows = res?.rows ?? []
  const max = Math.max(...rows.map((r) => Math.abs(r.total_return)), 1e-9)
  const best = rows.length ? rows.reduce((a, x) => (x.sharpe > a.sharpe ? x : a)) : null
  return (
    <>
      <div className="field-group-title">参数扫描<span className="field-hint">同一份配置，只改一个参数各跑一次</span></div>
      <div className="bt-sweep-form">
        <label className="field">
          <span className="field-label">参数</span>
          <select value={param} onChange={(e) => pick(e.target.value)}>
            {opts.map((o) => <option key={o.key} value={o.key}>{o.label}（当前 {b.config.params[o.key] ?? o.value}）</option>)}
          </select>
        </label>
        <label className="field">
          <span className="field-label">取值<span className="field-hint">逗号分隔，最多 20 个</span></span>
          <input className="mono-input" value={txt} onChange={(e) => setTxt(e.target.value)} />
        </label>
      </div>
      <div className="act-row">
        <button className="act act-primary" disabled={!values.length} onClick={() => setRes({ param, rows: sweep(b.config, b.strategy_snapshot, param, values) })}>开始扫描</button>
        {res && <span className="list-sub">按夏普最高的是 {res.param} = {best?.value}</span>}
      </div>
      {res && (
        <div className="bt-sweep">
          <div className="bt-sweep-row sg-th"><span>{res.param}</span><span>总收益</span><span>回撤</span><span>夏普</span><span /></div>
          {rows.map((x) => (
            <div key={x.value} className={cls('bt-sweep-row', x === best && 'best')}>
              <span className="sg-num mono">{x.value}{x.value === (b.config.params[res.param] ?? opts.find((o) => o.key === res.param)?.value) && <span className="faint"> 当前</span>}</span>
              <span className="bt-bar-cell">
                <span className="bt-bar-track"><i style={{ width: `${(Math.abs(x.total_return) / max) * 50}%`, background: tone(x.total_return) ?? 'var(--line-2)', [x.total_return >= 0 ? 'left' : 'right']: '50%' } as CSSProperties} /></span>
                <Signed x={x.total_return} />
              </span>
              <span className="sg-num run-muted">{pctRaw(x.max_dd)}</span>
              <span className="sg-num">{x.sharpe.toFixed(2)}</span>
              <button className="act act-quiet" title="按这个值发起一次正式回测" onClick={() => onRerun({ ...b.config, params: { ...b.config.params, [res.param]: x.value } })}>回测</button>
            </div>
          ))}
        </div>
      )}
    </>
  )
}

function TradesTable({ b }: { b: Backtest }) {
  const [n, setN] = useState(20)
  const [onlyClose, setOnlyClose] = useState(false)
  const all = b.result!.trades
  const list = onlyClose ? all.filter((t) => t.pnl !== undefined) : all
  return (
    <>
      <div className="sg-sec-head">
        <span className="field-group-title">逐笔成交<span className="field-hint">{all.length} 笔成交，{all.filter((t) => t.pnl !== undefined).length} 笔平仓</span></span>
        <span className="spacer" />
        <label className="check"><input type="checkbox" checked={onlyClose} onChange={(e) => setOnlyClose(e.target.checked)} />只看平仓</label>
      </div>
      {!list.length ? <div className="mount-empty">没有成交</div> : (
        <div className="bt-scroll">
          <div className="bt-trades">
            <div className="bt-trade sg-th"><span>时间</span><span>标的</span><span>方向</span><span>价格</span><span>数量</span><span>盈亏</span><span>原因</span></div>
            {list.slice(0, n).map((t, i) => (
              <div key={i} className="bt-trade">
                <span className="sg-num run-muted">{fmtT(t.t, b.config.interval)}</span>
                <span className="ellipsis" title={t.symbol}>{instName(t.symbol)}</span>
                <span style={{ color: t.side === 'buy' ? UP : DOWN }}>{t.side === 'buy' ? '买入' : '卖出'}</span>
                <span className="sg-num">{fmtPrice(t.symbol, t.price)}</span>
                <span className="sg-num">{Number(t.qty.toPrecision(6))}</span>
                <span>{t.pnl === undefined ? <span className="faint">-</span> : <Signed x={t.pnl} text={`${t.pnl > 0 ? '+' : ''}${money(t.pnl, 2)}`} />}</span>
                <span className="ellipsis run-muted" title={t.reason}>{t.reason}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {list.length > n && <div className="act-row"><button className="act act-quiet" onClick={() => setN(n + 100)}>再显示 {Math.min(100, list.length - n)} 笔（共 {list.length}）</button></div>}
    </>
  )
}

function Snapshot({ st, cfg }: { st: Strategy; cfg: BacktestConfig }) {
  const over = Object.entries(cfg.params).filter(([k, v]) => st.params[k] !== v)
  return (
    <div className="bt-snap">
      <dl className="bt-kv">
        <div><dt>名称</dt><dd>{st.name}</dd></div>
        <div><dt>模式</dt><dd>{MODE_LABEL[st.mode]}{st.mode === 'code' && <span className="faint"> · 按「{CODE_KIND_LABEL[codeKindOf(st)]}」近似</span>}</dd></div>
        <div><dt>标的</dt><dd>{cfg.symbols.map(instName).join('、') || '-'}</dd></div>
        <div><dt>周期 / 方向</dt><dd>{INTERVALS[cfg.interval].label} · {DIR_LABEL[st.direction]}</dd></div>
        <div><dt>止损 / 止盈</dt><dd className="sg-num">{st.stop_loss ? `${st.stop_loss}%` : '不设'} / {st.take_profit ? `${st.take_profit}%` : '不设'}</dd></div>
        <div><dt>仓位</dt><dd className="sg-num">每次 {st.position_pct}%</dd></div>
        <div><dt>参数</dt><dd className="tags">
          {Object.entries(st.params).map(([k, v]) => <span key={k} className="tag mono">{k} = {v}</span>)}
          {!Object.keys(st.params).length && <span className="faint">无</span>}
        </dd></div>
        {over.length > 0 && <div><dt>本次覆盖</dt><dd className="tags">{over.map(([k, v]) => <span key={k} className="tag mono sg-tag-over">{k} = {v}</span>)}</dd></div>}
      </dl>
      {st.mode === 'rules' ? (
        <div className="bt-rules">
          {([['入场', st.entry], ['出场', st.exit]] as const).map(([t, g]) => (
            <div key={t}>
              <div className="sg-group-title">{t}{g.rules.length > 1 && <span className="field-hint">{g.logic === 'all' ? '全部满足' : '任一满足'}</span>}</div>
              {g.rules.length ? g.rules.map((r) => <div key={r.id} className="bt-rule mono">{ruleText(r)}</div>) : <div className="faint">无</div>}
            </div>
          ))}
        </div>
      ) : <CodeLines code={st.code} />}
    </div>
  )
}
