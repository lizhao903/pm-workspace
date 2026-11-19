// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 内置策略（TRD-09，SPEC-strategy-9）：编辑页里的「内置策略」说明和参数表、按币种资金权重、回测区间、
// 从内置策略新建的菜单、回测报告里的分标的统计。信号写在后端（GET /api/trade/strategy-builtins 给目录和参数范围），前端只改参数。
import { useState } from 'react'
import { errorText, useTradeBuiltins, type TradeBuiltinStrategy, type TradeStrategy, type TradeSymbolStats } from '../../core/data'
import { Button, cls } from '../../core/ui'
import { instName, intervalLabel, money, pctRaw, type QuickCfg } from './strategyModel'
import { NumInput, PlusIcon } from './StrategyParts'

/** 出场、仓位一类的参数（各内置策略共用），参数表里单独一组 */
const EXIT_KEYS = new Set(['early_stop', 'min_bars_before_stop', 'breakeven_trigger', 'trail_arm', 'trail_giveback', 'sell_gate', 'pyramid_first_pct', 'pyramid_add_trigger'])

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

/** 编辑页「策略逻辑」里内置策略那一块：说明 + 参数（按范围夹住，越界的后端也会拒） */
export function BuiltinLogic({ st, set }: { st: TradeStrategy; set: (p: Partial<TradeStrategy>) => void }) {
  const cat = useTradeBuiltins()
  const b = cat.data?.find((x) => x.id === st.builtin)
  if (cat.isPending) return <div className="sg-empty-box">读取内置策略…</div>
  if (cat.isError) return <div className="sg-alert" role="alert"><span>内置策略目录没取到：{errorText(cat.error)}</span></div>
  if (!b) return <div className="sg-alert" role="alert"><span>这个版本不认识内置策略「{st.builtin}」，回测和部署会被拒；可以改成条件规则</span></div>
  const changed = b.params.filter((p) => st.params[p.key] !== undefined && st.params[p.key] !== p.default)
  const group = (exit: boolean) => b.params.filter((p) => EXIT_KEYS.has(p.key) === exit)
  return (
    <div className="sg-builtin">
      <div className="sg-builtin-head">
        <span className="tag">{intervalLabel(b.trend_interval)} 定趋势 · {intervalLabel(b.entry_interval)} 入场</span>
        <span className="sg-muted sg-small">{b.trend_mode === 'partial' ? '趋势周期用当前还没收盘的那根' : '趋势周期只用已收盘的'}，由 {intervalLabel(b.entry_interval)} K 线聚合</span>
      </div>
      <p className="sg-builtin-desc">{b.desc}</p>
      <div className="sg-muted sg-small" title={b.source}>移植自 {b.source}</div>
      {[false, true].map((exit) => (
        <div key={String(exit)} className="field">
          <span className="field-label">{exit ? '出场和仓位' : '信号参数'}
            {!exit && changed.length > 0 && <button type="button" className="sg-link sg-reset" onClick={() => set({ params: Object.fromEntries(b.params.map((p) => [p.key, p.default])) })}>全部恢复默认</button>}
          </span>
          <div className="sg-over">
            {group(exit).map((p) => {
              const v = st.params[p.key] ?? p.default
              return (
                <label key={p.key} className={cls('sg-over-item', v !== p.default && 'on')} title={`${p.help ? p.help + '。' : ''}默认 ${p.default}，范围 ${p.min} 到 ${p.max}（${p.key}）`}>
                  <span className="ellipsis">{p.label}{p.unit && <span className="faint"> {p.unit}</span>}</span>
                  <NumInput className="sg-mono-input sg-num" label={p.label} step={p.step || undefined} min={p.min} value={v}
                    onChange={(x) => set({ params: { ...st.params, [p.key]: clamp(x, p.min, p.max) } })} />
                </label>
              )
            })}
          </div>
        </div>
      ))}
    </div>
  )
}

/** 按币种的资金权重：两个以上标的才有；没写的按 1 算 */
export function SymbolWeights({ st, set }: { st: TradeStrategy; set: (p: Partial<TradeStrategy>) => void }) {
  if (st.symbols.length < 2) return null
  const w = st.symbol_weights ?? {}
  const of = (s: string) => (w[s] > 0 ? w[s] : 1)
  const sum = st.symbols.reduce((a, s) => a + of(s), 0)
  const custom = st.symbols.some((s) => w[s] !== undefined && w[s] !== 1)
  return (
    <div className="field">
      <span className="field-label">资金权重<span className="sg-hint">回测和部署按权重把资金分给各标的</span>
        {custom && <button type="button" className="sg-link sg-reset" onClick={() => set({ symbol_weights: {} })}>平均分</button>}
      </span>
      <div className="sg-over">
        {st.symbols.map((s) => (
          <label key={s} className={cls('sg-over-item', w[s] !== undefined && w[s] !== 1 && 'on')} title={s}>
            <span className="ellipsis">{instName(s)}<span className="faint"> {Math.round((of(s) / sum) * 100)}%</span></span>
            <NumInput className="sg-mono-input sg-num" label={`${instName(s)} 的资金权重`} min={0} value={of(s)}
              onChange={(x) => { if (x > 0) set({ symbol_weights: { ...w, [s]: Math.min(x, 1e6) } }) }} />
          </label>
        ))}
      </div>
    </div>
  )
}

/** 快速回测的区间（UTC 日期，左闭右开）：内置策略用 */
export function RangeFields({ qc, setQc }: { qc: QuickCfg; setQc: (q: QuickCfg) => void }) {
  const days = qc.start && qc.end ? Math.round((Date.parse(qc.end) - Date.parse(qc.start)) / 86_400_000) : 0
  const bad = !qc.start || !qc.end || days <= 0
  return (
    <div className="field">
      <span className="field-label">区间（UTC）<span className="sg-hint">{bad ? '开始要早于结束' : `${days} 天，含开始不含结束`}</span></span>
      <div className="sg-field-row">
        <input className={cls('sg-input', bad && 'bad')} type="date" aria-label="回测开始日期" value={qc.start ?? ''} onChange={(e) => setQc({ ...qc, start: e.target.value })} />
        <input className={cls('sg-input', bad && 'bad')} type="date" aria-label="回测结束日期" value={qc.end ?? ''} onChange={(e) => setQc({ ...qc, end: e.target.value })} />
      </div>
    </div>
  )
}

/** 「从内置策略新建」：点开列出内置策略，选一个就建 */
export function NewFromBuiltin({ disabled, onPick }: { disabled?: boolean; onPick: (b: TradeBuiltinStrategy) => void }) {
  const [open, setOpen] = useState(false)
  const cat = useTradeBuiltins()
  return (
    <span className="sg-builtin-new">
      <Button onClick={() => setOpen(!open)} disabled={disabled} aria-expanded={open}><PlusIcon />从内置策略新建</Button>
      {open && (
        <div className="sg-pick-menu" role="menu" aria-label="内置策略">
          {cat.isPending ? <div className="sg-pick-empty">读取中</div>
            : cat.isError ? <div className="sg-pick-empty">没取到：{errorText(cat.error)}</div>
              : (cat.data ?? []).map((b) => (
                <button key={b.id} type="button" role="menuitem" className="sg-pick-opt sg-builtin-opt" onClick={() => {
                  setOpen(false)
                  onPick(b)
                }}>
                  <span className="ellipsis">{b.name}</span>
                  <span className="sg-muted sg-small ellipsis">{intervalLabel(b.trend_interval)} 定趋势 · {intervalLabel(b.entry_interval)} 入场 · {b.params.length} 个参数</span>
                </button>
              ))}
        </div>
      )}
    </span>
  )
}

/** 回测报告里每个标的单独的统计 */
export function PerSymbolTable({ rows }: { rows?: TradeSymbolStats[] }) {
  if (!rows || rows.length === 0) return null
  return (
    <section className="sg-sec" aria-label="分标的统计">
      <div className="sg-sec-title">分标的统计<span className="sg-hint">按各自分到的资金算</span></div>
      <table className="sg-per-symbol">
        <thead><tr><th>标的</th><th>分到资金</th><th>收益</th><th>最大回撤</th><th>胜率</th><th>交易笔数</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.symbol}>
              <td title={r.symbol}>{instName(r.symbol)}</td>
              <td className="sg-mono">{money(r.capital)}</td>
              <td className={cls('sg-mono', r.stats.total_return > 0 ? 'up' : r.stats.total_return < 0 ? 'down' : '')}>{pctRaw(r.stats.total_return)}</td>
              <td className="sg-mono">{pctRaw(r.stats.max_dd)}</td>
              <td className="sg-mono">{r.stats.trades ? pctRaw(r.stats.win_rate) : '—'}</td>
              <td className="sg-mono">{r.stats.trades}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}
