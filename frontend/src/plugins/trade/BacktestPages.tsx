// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 回测记录和对比（SPEC-strategy-6）、回测报告（SPEC-strategy-7）。结果全部来自后端，前端不跑回测；
// 参数扫描也在后端按同一段数据跑，结果留在这条回测上，刷新不丢。
import { useMemo, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router'
import {
  QueryState, errorText, isApiError, useRemoveTradeBacktest, useRerunTradeBacktest, useSweepTradeBacktest, useTradeBacktest,
  useTradeBacktestCompare, type TradeBacktest, type TradeBacktestBrief, type TradeBacktestConfig, type TradeBacktestStatus,
  type TradeStrategy,
} from '../../core/data'
import { Button, EmptyState, PageTitle, SearchSelect, cls } from '../../core/ui'
import { DOWN, UP, fmtPct, fmtPrice } from './model'
import { CodeLines } from './StrategyEditor'
import {
  CODE_KIND_LABEL, DIR_LABEL, MODE_LABEL, codeKindOf, currencyOf, defaultSweepValues, drawdown, fmtT, instName, intervalLabel, metricOf,
  barStyle, money, parseSweepValues, pctRaw, ruleText, segments, spanText, sweepableParams, timeAgo, tone, type MetricKey,
} from './strategyModel'
import { Chart, ProgressBar, SearchIcon, Signed, StatusCell, SymTags, type Line } from './StrategyParts'

const LINE_COLORS = ['var(--accent)', '#e8590c', '#0c8599', '#9c4fd6']
/** 回测记录先露这么多条 */
const BT_PAGE = 50

const METRICS: { key: MetricKey; label: string; fmt: (x: number) => ReactNode; better: 1 | -1 }[] = [
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

type BtFilter = 'all' | TradeBacktestStatus

/* ---------- 回测记录 ---------- */

export function BacktestsPage({ backtests, strategies, now, onOpen }: {
  backtests: TradeBacktestBrief[]; strategies: TradeStrategy[]; now: number; onOpen: (id: string) => void
}) {
  const [st, setSt] = useState<BtFilter>('all')
  const [sid, setSid] = useState('')
  const [q, setQ] = useState('')
  const [picked, setPicked] = useState<string[]>([])
  const [comparing, setComparing] = useState(false)
  const [limit, setLimit] = useState(BT_PAGE)
  const kw = q.trim().toLowerCase()
  const stName = (b: TradeBacktestBrief) => strategies.find((s) => s.id === b.config.strategy_id)?.name ?? b.strategy_snapshot.name
  const rows = backtests
    .filter((b) => (st === 'all' || b.status === st) && (!sid || b.config.strategy_id === sid)
      && (!kw || [b.name, stName(b), ...b.config.symbols, ...b.config.symbols.map(instName)].some((v) => v.toLowerCase().includes(kw))))
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
  // 勾了的回测被重跑或删掉：只算还在、已完成的（SPEC-strategy-6.14）
  const chosen = picked.map((id) => backtests.find((b) => b.id === id)).filter((b): b is TradeBacktestBrief => !!b && b.status === 'done')
  const toggle = (id: string) => setPicked(picked.includes(id) ? picked.filter((x) => x !== id) : picked.length >= 4 ? picked : [...picked, id])
  const sids = [...new Set(backtests.map((b) => b.config.strategy_id))]
  return (
    <div className="sg-page">
      <PageTitle parent="策略" count={backtests.length} desc="每次回测的配置、结果和策略快照；勾选 2 到 4 条已完成的可以对比" actions={
        chosen.length >= 2 ? <Button variant="primary" onClick={() => setComparing(!comparing)}>{comparing ? '收起对比' : `对比 ${chosen.length} 条`}</Button>
          : chosen.length === 1 ? <span className="sg-muted">再勾一条就能对比</span> : undefined
      }>回测记录</PageTitle>
      {comparing && chosen.length >= 2 && (
        <CompareView ids={chosen.map((b) => b.id)} names={chosen.map(stName)} onClose={() => setComparing(false)} onOpen={onOpen} />
      )}
      <div className="sg-toolbar">
        <div className="sg-seg sg-seg-wrap" role="group" aria-label="按状态筛">
          {([['all', '全部'], ['running', '运行中'], ['queued', '排队中'], ['done', '已完成'], ['failed', '失败']] as [BtFilter, string][]).map(([k, l]) => (
            <button key={k} type="button" className={cls(st === k && 'on')} aria-pressed={st === k} onClick={() => { setSt(k); setLimit(BT_PAGE) }}>
              {l}<span className="seg-n">{backtests.filter((b) => k === 'all' || b.status === k).length}</span>
            </button>
          ))}
        </div>
        <SearchSelect value={sid} noneLabel="全部策略" placeholder="全部策略" searchPlaceholder="搜策略名" aria-label="按策略筛" onChange={(v: string) => { setSid(v); setLimit(BT_PAGE) }}
          options={sids.map((x) => ({
            value: x, label: strategies.find((s) => s.id === x)?.name ?? backtests.find((b) => b.config.strategy_id === x)?.strategy_snapshot.name ?? x,
            hint: `${backtests.filter((b) => b.config.strategy_id === x).length} 次`,
          }))} />
        {picked.length > 0 && <button type="button" className="sg-act sg-act-quiet" onClick={() => { setPicked([]); setComparing(false) }}>清除勾选 {picked.length}</button>}
        <span className="spacer" />
        <div className="search">
          <SearchIcon />
          <input placeholder="搜回测名、策略、标的" aria-label="搜回测" value={q} onChange={(e) => { setQ(e.target.value); setLimit(BT_PAGE) }} />
        </div>
      </div>
      {!rows.length ? (
        <EmptyState title={backtests.length ? '没有匹配的回测' : '还没有回测'} desc="在策略编辑页右侧的「快速回测」里发起" />
      ) : (
        <div className="sg-table" role="table" aria-label="回测记录">
          <div className="bt-row sg-th" role="row"><span /><span>回测</span><span>标的</span><span>区间</span><span>状态</span><span>收益</span><span>回撤</span><span>夏普</span><span>时间</span></div>
          {rows.slice(0, limit).map((b) => {
            const s = b.stats
            const can = b.status === 'done'
            const on = picked.includes(b.id)
            return (
              <div key={b.id} className={cls('bt-row', on && 'sel')} role="row" onClick={() => onOpen(b.id)}>
                <span onClick={(e) => e.stopPropagation()}>
                  <input type="checkbox" className="sg-check" checked={on} disabled={!can || (!on && picked.length >= 4)} aria-label={`勾选 ${b.name} 做对比`}
                    title={can ? (picked.length >= 4 && !on ? '最多对比 4 条' : '勾选做对比') : '完成后才能对比'} onChange={() => toggle(b.id)} />
                </span>
                <span className="sg-main">
                  <span className="sg-title ellipsis">{b.name}</span>
                  <span className="sg-meta ellipsis">{stName(b)}</span>
                </span>
                <SymTags symbols={b.config.symbols} />
                <span className="sg-muted sg-num">{b.config.bars} 根 · {intervalLabel(b.config.interval)}</span>
                <span title={b.status === 'failed' ? b.error : undefined}><StatusCell b={b} /></span>
                <span>{s ? <Signed x={s.total_return} /> : <span className="faint">-</span>}</span>
                <span className="sg-num sg-muted">{s ? pctRaw(s.max_dd) : '-'}</span>
                <span className="sg-num sg-muted">{s ? s.sharpe.toFixed(2) : '-'}</span>
                <span className="sg-muted">{timeAgo(b.created_at, now)}</span>
              </div>
            )
          })}
        </div>
      )}
      {rows.length > limit && (
        <button type="button" className="sg-act sg-act-quiet sg-more" onClick={() => setLimit(limit + BT_PAGE)}>
          再显示 {Math.min(BT_PAGE, rows.length - limit)} 条<span className="faint">（还有 {rows.length - limit} 条更早的）</span>
        </button>
      )}
    </div>
  )
}

function CompareView({ ids, names, onClose, onOpen }: { ids: string[]; names: string[]; onClose: () => void; onOpen: (id: string) => void }) {
  const cmp = useTradeBacktestCompare(ids)
  return (
    <section className="sg-sec bt-compare" aria-label="对比">
      <div className="sg-sec-head">
        <span className="sg-sec-title">对比 {ids.length} 条回测<span className="sg-hint">收益率曲线，横轴按各自区间的起止对齐</span></span>
        <span className="spacer" />
        <button type="button" className="sg-act sg-act-quiet" onClick={onClose}>收起</button>
      </div>
      <QueryState query={cmp} errorTitle="对比的回测没取到" compact>
        {(items) => {
          const lines: Line[] = items.map((b, i) => ({ label: b.name, color: LINE_COLORS[i], values: (b.result?.equity ?? []).map((e) => e.v / b.config.capital - 1) }))
          const stats = items.map((b) => b.result!.stats)
          return (
            <>
              <div className="bt-legend">{items.map((b, i) => <span key={b.id}><i style={{ background: LINE_COLORS[i] }} />{b.name}</span>)}</div>
              <Chart label="收益率曲线对比" lines={lines} height={240} base={0} fmtY={(v) => fmtPct(v)} xLabel={(f) => (f === 0 ? '起点' : f === 1 ? '终点' : `${Math.round(f * 100)}%`)} />
              <div className="bt-scroll">
                <table className="bt-mtable">
                  <thead><tr><th>指标</th>{items.map((b, i) => <th key={b.id}><button type="button" className="sg-link" style={{ color: LINE_COLORS[i] }} onClick={() => onOpen(b.id)}>{b.name}</button><div className="faint sg-small">{names[i]}</div></th>)}</tr></thead>
                  <tbody>
                    <tr><td>区间</td>{items.map((b) => <td key={b.id} className="sg-num">{b.config.bars} 根 · {intervalLabel(b.config.interval)}</td>)}</tr>
                    {METRICS.map((m) => {
                      const vs = stats.map((s) => metricOf(s, m.key))
                      const best = m.key === 'trades' || m.key === 'bench_return' ? NaN : m.better > 0 ? Math.max(...vs) : Math.min(...vs)
                      return <tr key={m.key}><td>{m.label}</td>{vs.map((v, i) => <td key={i} className={cls('sg-num', v === best && 'bt-best')}>{m.fmt(v)}</td>)}</tr>
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )
        }}
      </QueryState>
    </section>
  )
}

/* ---------- 回测报告 ---------- */

export function BacktestReportPage({ id, strategies, now, onOpenStrategy, onOpen, onBack }: {
  id: string; strategies: TradeStrategy[]; now: number; onOpenStrategy: (id: string) => void; onOpen: (id: string) => void; onBack: () => void
}) {
  const q = useTradeBacktest(id)
  if (q.isError && isApiError(q.error, 'not_found')) {
    return <EmptyState title="这条回测记录不在了" action={<Button onClick={onBack}>回到回测记录</Button>} />
  }
  return (
    <QueryState query={q} errorTitle="回测没取到">
      {(b) => <BacktestReport key={b.id} b={b} strategyAlive={strategies.some((s) => s.id === b.config.strategy_id)} now={now}
        onOpenStrategy={onOpenStrategy} onOpen={onOpen} onBack={onBack} />}
    </QueryState>
  )
}

function BacktestReport({ b, strategyAlive, now, onOpenStrategy, onOpen, onBack }: {
  b: TradeBacktest; strategyAlive: boolean; now: number; onOpenStrategy: (id: string) => void; onOpen: (id: string) => void; onBack: () => void
}) {
  const rerun = useRerunTradeBacktest()
  const remove = useRemoveTradeBacktest()
  const navigate = useNavigate()
  const [confirmDel, setConfirmDel] = useState(false)
  // 部署：跳到交易「策略运行」打开部署抽屉，策略选好（SPEC-strategy-7.4）；部署用策略现在的版本和参数
  const onDeploy = (sid: string) => void navigate(`/trading/runs?${new URLSearchParams({ deploy: sid })}`)
  const snap = b.strategy_snapshot
  const r = b.result
  const cur = currencyOf(b.config.symbols)
  const busy = b.status === 'running' || b.status === 'queued'
  const doRerun = (params?: Record<string, number>) => rerun.mutate({ id: b.id, params }, { onSuccess: (nb) => onOpen(nb.id) })
  return (
    <div className="sg-page bt-page">
      <PageTitle parent="回测记录" desc={`${snap.name || '未命名策略'} · ${b.config.symbols.map(instName).join('、')} · ${b.config.bars} 根 ${intervalLabel(b.config.interval)}`} actions={<>
        <Button title={strategyAlive ? undefined : '策略已经删除'} onClick={() => onOpenStrategy(b.config.strategy_id)}>打开策略</Button>
        <Button variant="outline" disabled={busy || rerun.isPending} title={busy ? '跑完才能重新回测' : strategyAlive ? '用同样的配置和当前的策略再跑一次' : '策略已经删除，用这次的快照再跑一次'} onClick={() => doRerun()}>重新回测</Button>
        <Button variant="primary" disabled={!strategyAlive} title={strategyAlive ? '部署到模拟盘账户上跑（用策略现在的版本）' : '策略已经删除，不能部署'} onClick={() => onDeploy(b.config.strategy_id)}>部署</Button>
      </>}>{b.name}</PageTitle>

      <div className="bt-meta">
        <StatusCell b={b} />
        <span>初始资金 <b className="sg-num">{money(b.config.capital)}</b> {cur}</span>
        <span>手续费 万分之 <b className="sg-num">{b.config.fee_bp}</b></span>
        <span>滑点 <b className="sg-num">{b.config.slippage_ticks}</b> 跳</span>
        <span>{spanText(b.config.bars, b.config.interval)}</span>
        {b.data_from && b.data_to && <span title="实际回测区间第一根、最后一根 K 线的开盘时间">数据 {fmtT(Date.parse(b.data_from), b.config.interval)} 到 {fmtT(Date.parse(b.data_to), b.config.interval)}</span>}
        <span className="faint">{timeAgo(b.created_at, now)}发起{b.finished_at ? ` · ${timeAgo(b.finished_at, now)}完成` : ''}</span>
      </div>

      {rerun.error && <div className="sg-alert" role="alert"><span><b>没发起成功</b>{errorText(rerun.error)}</span></div>}
      {b.status === 'failed' && (
        <div className="sg-alert" role="alert"><span><b>回测失败</b>{b.error || '没有错误信息'}</span><button type="button" className="sg-act" disabled={rerun.isPending} onClick={() => doRerun()}>重新回测</button></div>
      )}
      {busy && (
        <section className="sg-sec bt-wait" aria-label="进度">
          <div className="sg-sec-title">{b.status === 'queued' ? '排队中' : '回测进行中'}</div>
          <ProgressBar p={b.status === 'queued' ? 0 : b.progress} />
          <div className="sg-muted">{b.status === 'queued' ? '前面的回测跑完就开始' : '跑完会自动出报告，可以先去做别的'}</div>
        </section>
      )}
      {r?.note && <div className="bt-note"><span>{r.note}</span></div>}

      {b.status === 'done' && r && (
        <>
          <div className="bt-stats">
            {METRICS.filter((m) => m.key !== 'bench_return').map((m) => (
              <div key={m.key} className="bt-stat">
                <div className="sg-stat-label">{m.label}{m.key === 'excess' && <span className="faint sg-num"> 基准 {fmtPct(r.stats.bench_return)}</span>}</div>
                <div className="bt-stat-value sg-num">{m.fmt(metricOf(r.stats, m.key))}</div>
              </div>
            ))}
          </div>

          <section className="sg-sec" aria-label="资金曲线">
            <div className="sg-sec-head">
              <span className="sg-sec-title">资金曲线</span>
              <span className="spacer" />
              <div className="bt-legend"><span><i style={{ background: 'var(--accent)' }} />策略</span><span><i className="dash" />等权买入持有</span></div>
            </div>
            <Chart label="资金曲线" height={260} lines={[
              { label: '策略', color: 'var(--accent)', values: r.equity.map((e) => e.v) },
              { label: '基准', color: 'var(--faint)', dash: true, values: r.equity.map((e) => e.bench) },
            ]} fmtY={(v) => money(v)} xLabel={(f) => (r.equity.length ? fmtT(r.equity[Math.round(f * (r.equity.length - 1))].t, b.config.interval) : '')} />
          </section>

          <section className="sg-sec" aria-label="回撤">
            <div className="sg-sec-title">回撤<span className="sg-hint">资金相对此前最高点跌了多少</span></div>
            <Underwater equity={r.equity} iv={b.config.interval} />
          </section>

          <div className="bt-grid2">
            <section className="sg-sec" aria-label="分段收益"><Heatmap equity={r.equity} /></section>
            <section className="sg-sec" aria-label="参数扫描"><SweepPanel b={b} onRerun={doRerun} rerunBusy={rerun.isPending} /></section>
          </div>

          <section className="sg-sec" aria-label="逐笔成交"><TradesTable b={b} /></section>
        </>
      )}

      <section className="sg-sec" aria-label="策略快照">
        <div className="sg-sec-title">策略快照<span className="sg-hint">发起回测那一刻的策略，之后改策略不影响这份报告</span></div>
        <Snapshot st={snap} cfg={b.config} />
      </section>

      <div className="bt-del">
        {confirmDel ? (
          <>
            <span className="danger-text">只删这一条回测记录和它的扫描结果，策略不动{busy ? '；还没跑完的会先停下' : ''}{remove.error ? `；删除失败：${errorText(remove.error)}` : ''}</span>
            <Button size="sm" onClick={() => setConfirmDel(false)}>取消</Button>
            <Button size="sm" variant="danger" disabled={remove.isPending} onClick={() => remove.mutate(b.id, { onSuccess: onBack })}>删除</Button>
          </>
        ) : <Button size="sm" variant="danger-ghost" onClick={() => setConfirmDel(true)}>删除这条回测记录</Button>}
      </div>
    </div>
  )
}

function Underwater({ equity, iv }: { equity: { t: number; v: number }[]; iv: TradeBacktestConfig['interval'] }) {
  const dd = useMemo(() => drawdown(equity), [equity])
  return <Chart label="回撤" height={140} base={0} lines={[{ label: '回撤', color: DOWN, values: dd, fill: true }]} fmtY={(v) => pctRaw(v)}
    xLabel={(f) => (equity.length ? fmtT(equity[Math.round(f * (equity.length - 1))].t, iv) : '')} />
}

function Heatmap({ equity }: { equity: { t: number; v: number }[] }) {
  const data = useMemo(() => segments(equity), [equity])
  if (!data) return <><div className="sg-sec-title">分段收益</div><div className="sg-empty-box">数据不够</div></>
  const max = Math.max(...data.cells.map((c) => Math.abs(c.ret)), 1e-9)
  const bg = (r: number) => (Math.abs(r) < 1e-12 ? undefined : `color-mix(in srgb, ${r > 0 ? UP : DOWN} ${Math.round(10 + (Math.abs(r) / max) * 55)}%, transparent)`)
  const title = { month: '月度收益', day: '每日收益', hour: '每 4 小时收益' }[data.mode]
  if (data.mode === 'month') {
    const years = [...new Set(data.cells.map((c) => c.key.slice(0, 4)))]
    return (
      <>
        <div className="sg-sec-title">{title}</div>
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
      <div className="sg-sec-title">{title}{data.cells.length > shown.length && <span className="sg-hint">只显示最近 {shown.length} 段</span>}</div>
      <div className="bt-cells">
        {shown.map((c) => <div key={c.key} className="bt-cell" style={{ background: bg(c.ret) }} title={`${c.key} ${fmtPct(c.ret)}`}><span>{c.key}</span><b className="sg-num">{fmtPct(c.ret)}</b></div>)}
      </div>
    </>
  )
}

function SweepPanel({ b, onRerun, rerunBusy }: { b: TradeBacktest; onRerun: (params: Record<string, number>) => void; rerunBusy: boolean }) {
  const opts = sweepableParams(b.strategy_snapshot)
  const cur = (k: string) => b.config.params[k] ?? opts.find((o) => o.key === k)?.value ?? 0
  const [param, setParam] = useState(() => b.sweep?.param ?? opts[0]?.key ?? 'stop_loss')
  const [txt, setTxt] = useState(() => (b.sweep && b.sweep.param === param ? b.sweep.points.map((p) => p.value) : defaultSweepValues(cur(param), param)).join(', '))
  const sweep = useSweepTradeBacktest()
  const values = parseSweepValues(txt)
  const pick = (k: string) => {
    setParam(k)
    setTxt(defaultSweepValues(cur(k), k).join(', '))
  }
  const res = b.sweep
  const rows = res?.points ?? []
  const max = Math.max(...rows.map((r) => Math.abs(r.total_return)), 1e-9)
  const best = rows.length ? rows.reduce((a, x) => (x.sharpe > a.sharpe ? x : a)) : null
  return (
    <>
      <div className="sg-sec-title">参数扫描<span className="sg-hint">同一份配置、同一段数据，只改一个参数各跑一次</span></div>
      <div className="bt-sweep-form">
        <label className="field">
          <span className="field-label">参数</span>
          <select className="sg-select sg-select-full" value={param} onChange={(e) => pick(e.target.value)}>
            {opts.map((o) => <option key={o.key} value={o.key}>{o.label}（当前 {cur(o.key)}）</option>)}
          </select>
        </label>
        <label className="field">
          <span className="field-label">取值<span className="sg-hint">逗号分隔，最多 20 个</span></span>
          <input className="sg-mono-input" value={txt} onChange={(e) => setTxt(e.target.value)} />
        </label>
      </div>
      <div className="sg-act-row">
        <button type="button" className="sg-act sg-act-primary" disabled={!values.length || sweep.isPending} onClick={() => sweep.mutate({ id: b.id, param, values })}>
          {sweep.isPending ? '扫描中…' : '开始扫描'}
        </button>
        {res && best && <span className="sg-muted">按夏普最高的是 {res.param} = {best.value}</span>}
      </div>
      {sweep.error && <div className="sg-alert" role="alert"><span>扫描失败：{errorText(sweep.error)}</span></div>}
      {res && (
        <div className="bt-sweep" role="table" aria-label="扫描结果">
          <div className="bt-sweep-row sg-th" role="row"><span>{res.param}</span><span>总收益</span><span>回撤</span><span>夏普</span><span /></div>
          {rows.map((x) => (
            <div key={x.value} className={cls('bt-sweep-row', x === best && 'best')} role="row">
              <span className="sg-num sg-mono">{x.value}{x.value === cur(res.param) && <span className="faint"> 当前</span>}</span>
              <span className="bt-bar-cell">
                <span className="bt-bar-track"><i style={barStyle(x.total_return, max)} /></span>
                <Signed x={x.total_return} />
              </span>
              <span className="sg-num sg-muted">{pctRaw(x.max_dd)}</span>
              <span className="sg-num">{x.sharpe.toFixed(2)}</span>
              <button type="button" className="sg-act sg-act-quiet" disabled={rerunBusy} title="按这个值发起一次正式回测" onClick={() => onRerun({ [res.param]: x.value })}>回测</button>
            </div>
          ))}
        </div>
      )}
    </>
  )
}

function TradesTable({ b }: { b: TradeBacktest }) {
  const [n, setN] = useState(20)
  const [onlyClose, setOnlyClose] = useState(false)
  const all = b.result!.trades
  const list = onlyClose ? all.filter((t) => t.pnl !== undefined) : all
  return (
    <>
      <div className="sg-sec-head">
        <span className="sg-sec-title">逐笔成交<span className="sg-hint">{all.length} 笔成交，{all.filter((t) => t.pnl !== undefined).length} 笔平仓</span></span>
        <span className="spacer" />
        <label className="check"><input type="checkbox" checked={onlyClose} onChange={(e) => setOnlyClose(e.target.checked)} />只看平仓</label>
      </div>
      {!list.length ? <div className="sg-empty-box">没有成交</div> : (
        <div className="bt-scroll">
          <div className="bt-trades" role="table" aria-label="逐笔成交">
            <div className="bt-trade sg-th" role="row"><span>时间</span><span>标的</span><span>方向</span><span>价格</span><span>数量</span><span>盈亏</span><span>原因</span></div>
            {list.slice(0, n).map((t, i) => (
              <div key={i} className="bt-trade" role="row">
                <span className="sg-num sg-muted">{fmtT(t.t, b.config.interval)}</span>
                <span className="ellipsis" title={t.symbol}>{instName(t.symbol)}</span>
                <span style={{ color: t.side === 'buy' ? UP : DOWN }}>{t.side === 'buy' ? '买入' : '卖出'}</span>
                <span className="sg-num">{fmtPrice(t.price, decimals(t.price))}</span>
                <span className="sg-num">{Number(t.qty.toPrecision(6))}</span>
                <span>{t.pnl === undefined ? <span className="faint">-</span> : <Signed x={t.pnl} text={`${t.pnl > 0 ? '+' : ''}${money(t.pnl, 2)}`} />}</span>
                <span className="ellipsis sg-muted" title={t.reason}>{t.reason}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {list.length > n && <div className="sg-act-row"><button type="button" className="sg-act sg-act-quiet" onClick={() => setN(n + 100)}>再显示 {Math.min(100, list.length - n)} 笔（共 {list.length}）</button></div>}
    </>
  )
}

/** 成交价按它自己的小数位显示（后端已按标的精度加两位取整） */
function decimals(x: number) {
  const s = String(x)
  const i = s.indexOf('.')
  return i < 0 ? 0 : Math.min(8, s.length - i - 1)
}

function Snapshot({ st, cfg }: { st: TradeStrategy; cfg: TradeBacktestConfig }) {
  const over = Object.entries(cfg.params).filter(([k, v]) => st.params[k] !== v && !(k === 'stop_loss' && v === st.stop_loss) && !(k === 'take_profit' && v === st.take_profit) && !(k === 'position_pct' && v === st.position_pct))
  return (
    <div className="bt-snap">
      <dl className="bt-kv">
        <div><dt>名称</dt><dd>{st.name || '未命名策略'}</dd></div>
        <div><dt>模式</dt><dd>{MODE_LABEL[st.mode]}{st.mode === 'code' && <span className="faint"> · 按「{CODE_KIND_LABEL[codeKindOf(st)]}」近似</span>}</dd></div>
        <div><dt>标的</dt><dd>{cfg.symbols.map(instName).join('、') || '-'}</dd></div>
        <div><dt>周期 / 方向</dt><dd>{intervalLabel(cfg.interval)} · {DIR_LABEL[st.direction]}</dd></div>
        <div><dt>止损 / 止盈</dt><dd className="sg-num">{st.stop_loss ? `${st.stop_loss}%` : '不设'} / {st.take_profit ? `${st.take_profit}%` : '不设'}</dd></div>
        <div><dt>仓位</dt><dd className="sg-num">每次 {st.position_pct}%</dd></div>
        <div><dt>参数</dt><dd className="sg-tags">
          {Object.entries(st.params).map(([k, v]) => <span key={k} className="tag sg-mono">{k} = {v}</span>)}
          {!Object.keys(st.params).length && <span className="faint">无</span>}
        </dd></div>
        {over.length > 0 && <div><dt>本次覆盖</dt><dd className="sg-tags">{over.map(([k, v]) => <span key={k} className="tag sg-mono sg-tag-over">{k} = {v}</span>)}</dd></div>}
      </dl>
      {st.mode === 'rules' ? (
        <div className="bt-rules">
          {([['入场', st.entry], ['出场', st.exit]] as const).map(([t, g]) => (
            <div key={t}>
              <div className="sg-group-title">{t}{g.rules.length > 1 && <span className="sg-hint">{g.logic === 'all' ? '全部满足' : '任一满足'}</span>}</div>
              {g.rules.length ? g.rules.map((r) => <div key={r.id} className="bt-rule sg-mono">{ruleText(r)}</div>) : <div className="faint">无</div>}
            </div>
          ))}
        </div>
      ) : <CodeLines code={st.code} />}
    </div>
  )
}

