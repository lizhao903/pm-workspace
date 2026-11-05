// 策略运行（SPEC-trading-6）和新建策略运行抽屉（SPEC-trading-7）。部署只能到模拟盘账户；
// 信号、下单、盈亏都在后端（TRD-05b）：K 线收盘时算信号、下市价单，每笔过风控。这里只启停和看日志。
// 原型的「启动」「恢复」在后端合成一个 /resume；熔断中启动、新建都会被后端拒（409 halted），原因原样显示。
import { useState } from 'react'
import {
  errorText, useCreateTradeRun, useTradeRun, useTradeRunAction,
  type TradeAccount, type TradeInterval, type TradeRun, type TradeRunPage, type TradeStrategy,
} from '../../core/data'
import { Button, Drawer, EmptyState, ErrorState, LoadingState, Pill, SearchSelect, cls } from '../../core/ui'
import { MARKETS, fmtPct, guessInstrument } from './model'
import { intervalLabel, instName } from './strategyModel'
import { NoAccount } from './TradingParts'
import { LIVE_MARKETS, NO_SOURCE, RUN_STATUS, fmtQty, fmtTime, num, signed, tone } from './tradingModel'

type Q<T> = { data: T | undefined; isPending: boolean; isError: boolean; error: unknown; refetch: () => unknown }

const ORDER: Record<TradeRun['status'], number> = { error: 0, running: 1, paused: 2, stopped: 3 }
const LOG_FIRST = 3

export function RunsView({ runs, accounts, strategies, halted, onOpenStrategy, onNew }: {
  runs: Q<TradeRunPage>; accounts: TradeAccount[]; strategies: TradeStrategy[]; halted: boolean
  onOpenStrategy: (id: string) => void; onNew: () => void
}) {
  const [showStopped, setShowStopped] = useState(false)
  if (runs.data === undefined) {
    return runs.isError ? <ErrorState title="部署没取到" error={errorText(runs.error)} onRetry={() => void runs.refetch()} /> : <LoadingState />
  }
  const all = [...runs.data.data].sort((a, b) => ORDER[a.status] - ORDER[b.status] || b.started_at.localeCompare(a.started_at))
  if (!all.length) {
    return <EmptyState title="还没有策略在跑" desc="在策略页回测满意后部署，或者直接新建一个运行；现在只能部署到模拟盘" action={<Button variant="primary" onClick={onNew}>新建运行</Button>} />
  }
  const stopped = all.filter((r) => r.status === 'stopped')
  const rows = showStopped ? all : all.filter((r) => r.status !== 'stopped')
  return (
    <>
      {rows.length > 0 && (
        <div className="tr-cards">
          {rows.map((r) => <RunCard key={r.id} r={r} account={accounts.find((a) => a.id === r.account_id)} strategyAlive={strategies.some((s) => s.id === r.strategy_id)}
            halted={halted} onOpenStrategy={onOpenStrategy} />)}
        </div>
      )}
      {stopped.length > 0 && (
        <button type="button" className="tr-link tr-more" onClick={() => setShowStopped(!showStopped)}>{showStopped ? '收起已停止的' : `已停止 ${stopped.length} 个`}</button>
      )}
    </>
  )
}

function RunCard({ r, account: a, strategyAlive, halted, onOpenStrategy }: {
  r: TradeRun; account?: TradeAccount; strategyAlive: boolean; halted: boolean; onOpenStrategy: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [stopAsk, setStopAsk] = useState(false)
  const act = useTradeRunAction()
  const detail = useTradeRun(r.id, open)
  const src = open && detail.data ? detail.data : r
  const logs = [...src.logs].reverse()
  const shown = open ? logs : logs.slice(0, LOG_FIRST)
  const run = (action: 'pause' | 'resume' | 'stop') => act.mutate({ id: r.id, action }, { onSuccess: () => setStopAsk(false) })
  return (
    <section className={cls('tr-card', r.status === 'error' && 'tr-card-bad', r.status === 'stopped' && 'tr-dim')} aria-label={`部署 ${r.strategy_name}`}>
      <div className="tr-card-head">
        <button type="button" className="tr-card-title ellipsis" disabled={!strategyAlive} onClick={() => onOpenStrategy(r.strategy_id)} title={strategyAlive ? '打开策略' : '策略已经删除'}>
          {r.strategy_name || '未命名策略'}
        </button>
        <Pill {...RUN_STATUS[r.status]} />
      </div>
      <div className="tr-card-sub">
        <span className="tag tr-tag-sm">模拟</span>
        <span className="ellipsis">{a?.name ?? '已删除的账户'} · {r.symbols.map(instName).join('、')} · {intervalLabel(r.interval as TradeInterval)} K 线</span>
      </div>
      {r.error && <div className="tr-inline-msg tr-inline-bad"><span>{r.error}</span></div>}
      {r.status === 'stopped' && r.stop_reason && <div className="tr-muted tr-small">停止原因：{r.stop_reason}{r.stopped_at ? ` · ${fmtTime(r.stopped_at)}` : ''}</div>}
      <div className="tr-card-nums">
        <div><span className="tr-stat-label">盈亏</span><b className="tr-num" style={{ color: tone(r.pnl) }}>{signed(r.pnl)}</b></div>
        <div><span className="tr-stat-label">分配资金</span><b className="tr-num">{num(r.capital)}</b></div>
        <div><span className="tr-stat-label">收益率</span><b className="tr-num" style={{ color: tone(r.pnl) }}>{fmtPct(r.capital ? r.pnl / r.capital : 0)}</b></div>
      </div>
      <div className="tr-muted tr-small">
        启动于 {fmtTime(r.started_at)} · 已实现 {signed(r.realized_pnl)} · 浮动 {signed(r.unrealized_pnl)} · 手续费 {num(r.fees, 2)}
        {Object.keys(r.params).length > 0 && <> · {Object.entries(r.params).map(([k, v]) => `${k}=${v}`).join('  ')}</>}
      </div>
      {r.holdings.length > 0 && (
        <div className="tr-muted tr-small">持仓：{r.holdings.map((h) => `${instName(h.symbol)} ${h.side === 'long' ? '多' : '空'} ${fmtQty(h.qty)} @ ${num(h.avg_price, 2)}`).join('；')}</div>
      )}
      <div className="tr-logs" aria-label="运行日志">
        {!shown.length && <div className="faint tr-small">还没有日志</div>}
        {shown.map((l, k) => (
          <div key={`${l.at}-${k}`} className={cls('tr-log', `tr-log-${l.level}`)}><i /><span className="tr-log-at">{fmtTime(l.at)}</span><span className="tr-log-text">{l.text}</span></div>
        ))}
        {r.log_total > LOG_FIRST && (
          <button type="button" className="tr-link tr-log-more" onClick={() => setOpen(!open)}>
            {open ? '收起' : `全部 ${r.log_total} 条日志`}{open && detail.isFetching && !detail.data ? '（加载中）' : ''}
            {open && src.log_total > src.logs.length ? `（显示最近 ${src.logs.length} 条）` : ''}
          </button>
        )}
      </div>
      {act.error && <div className="tr-inline-msg tr-inline-bad" role="alert"><span>{errorText(act.error)}</span></div>}
      <div className="tr-card-foot">
        {stopAsk ? (
          <>
            <span className="tr-small danger-text">停止后撤掉这个部署的挂单，持仓保留、不自动平仓</span>
            <span className="spacer" />
            <Button size="sm" onClick={() => setStopAsk(false)}>取消</Button>
            <Button size="sm" variant="danger" disabled={act.isPending} onClick={() => run('stop')}>确认停止</Button>
          </>
        ) : (
          <>
            {r.status === 'running' && <Button size="sm" variant="outline" disabled={act.isPending} onClick={() => run('pause')}>暂停</Button>}
            {r.status !== 'running' && (
              <Button size="sm" variant="primary" disabled={halted || act.isPending || !a} title={halted ? '熔断中，先到风控解除' : !a ? '账户已删除' : undefined}
                onClick={() => run('resume')}>{r.status === 'paused' ? '恢复' : '启动'}</Button>
            )}
            {r.status !== 'stopped' && <Button size="sm" onClick={() => setStopAsk(true)}>停止</Button>}
            <span className="spacer" />
            {halted && r.status !== 'running' && <span className="faint tr-small">熔断中不能启动</span>}
          </>
        )}
      </div>
    </section>
  )
}

/* ---------- 新建策略运行抽屉 ---------- */

const runnable = (s: string) => LIVE_MARKETS.includes(guessInstrument(s).market) && guessInstrument(s).kind !== 'option'

export function RunDrawer({ initStrategy, strategies, accounts, halted, onClose, onCreated }: {
  initStrategy?: string; strategies: TradeStrategy[]; accounts: TradeAccount[]; halted: boolean
  onClose: () => void; onCreated: (r: TradeRun) => void
}) {
  // 策略、账户列表是异步来的：选择存成「用户选了什么」，没选或选的不能用时按默认值推，不在初始化时定死
  const [pickedSid, setSid] = useState(initStrategy ?? '')
  const s = strategies.find((x) => x.id === pickedSid) ?? (initStrategy ? undefined : strategies[0])
  const sid = s?.id ?? pickedSid
  const why = (a: TradeAccount, st?: TradeStrategy) => {
    if (!a.paper) return '不是模拟盘账户'
    const ms = new Set((st?.symbols ?? []).map((x) => guessInstrument(x).market))
    if (ms.size && ![...ms].some((m) => a.markets.includes(m))) return `不支持${[...ms].map((m) => MARKETS[m].label).join(' / ')}`
    return undefined
  }
  const usable = (st: TradeStrategy | undefined, acc: TradeAccount | undefined) =>
    (st?.symbols ?? []).filter((x) => acc?.markets.includes(guessInstrument(x).market) && runnable(x))
  const [aid, setAid] = useState('')
  const a = accounts.find((x) => x.id === aid && !why(x, s)) ?? accounts.find((x) => !why(x, s))
  const [pickedSyms, setSyms] = useState<string[] | null>(null)
  const ok = usable(s, a)
  const syms = pickedSyms ? pickedSyms.filter((x) => ok.includes(x)) : ok
  const [capital, setCapital] = useState('20000')
  const [pickedParams, setParams] = useState<Record<string, string> | null>(null)
  const params = pickedParams ?? Object.fromEntries(Object.entries(s?.params ?? {}).map(([k, v]) => [k, String(v)]))
  const [tried, setTried] = useState(false)
  const [showBlocked, setShowBlocked] = useState(false)
  const create = useCreateTradeRun()

  const pickStrategy = (id: string) => {
    setSid(id)
    setParams(null)
    setSyms(null)
    create.reset()
  }
  const pickAcct = (acc: TradeAccount) => { setAid(acc.id); setSyms(null); create.reset() }

  const cap = Number(capital)
  const errors: string[] = []
  if (halted) errors.push('熔断中，不能启动新运行；先到风控解除熔断')
  if (!s) errors.push(initStrategy && !strategies.length ? '策略还在加载' : initStrategy && pickedSid === initStrategy ? '要部署的策略已经删除，换一个' : '选一个策略')
  if (!a) errors.push('选一个模拟盘账户')
  if (s && !syms.length) errors.push('至少选一个标的')
  if (!(cap > 0)) errors.push('填分配资金')
  else if (a && cap > a.available) errors.push(`分配资金超过账户可用 ${num(a.available, 2)} ${a.currency}`)
  if (Object.values(params).some((v) => v.trim() === '' || Number.isNaN(Number(v)))) errors.push('参数要填数字')
  const blockedAccts = accounts.filter((x) => why(x, s))

  const submit = () => {
    setTried(true)
    if (errors.length || !s || !a) return
    create.mutate({
      strategy_id: s.id, account_id: a.id, symbols: syms, capital: cap,
      params: Object.fromEntries(Object.entries(params).map(([k, v]) => [k, Number(v)])),
    }, { onSuccess: onCreated })
  }

  return (
    <Drawer open onClose={onClose} kicker="新建策略运行 · 模拟盘" aria-label="新建策略运行" className="tr-drawer"
      footer={(requestClose) => (
        <>
          {create.error ? <span className="field-err" role="alert">没启动：{errorText(create.error)}</span>
            : tried && errors.length ? <span className="field-err" role="alert">{errors[0]}</span> : null}
          <span className="spacer" />
          <Button onClick={requestClose}>取消</Button>
          <Button variant="primary" disabled={halted || create.isPending} title={halted ? '熔断中，先到风控解除' : undefined} onClick={submit}>{create.isPending ? '启动中…' : '启动运行'}</Button>
        </>
      )}>
      <div className="form">
        {halted && <div className="tr-block" role="alert"><b>熔断中</b><span>不能启动新运行，先到风控解除熔断</span></div>}
        <div className="field">
          <span className="field-label">策略</span>
          {!strategies.length ? <div className="tr-empty-box">还没有策略，先去策略页建一个</div> : (
            <SearchSelect variant="field" value={sid} placeholder="选一个策略" searchPlaceholder="搜策略名、标的" aria-label="策略"
              options={strategies.map((x) => ({ value: x.id, label: x.name || '未命名策略', hint: `${intervalLabel(x.interval)} · ${x.symbols.map(instName).join('、') || '未选标的'}`, keywords: [...x.tags, ...x.symbols].join(' ') }))}
              missingLabel={() => '已删除的策略'} onChange={(v: string) => { if (v) pickStrategy(v) }} />
          )}
        </div>
        <div className="field">
          <span className="field-label">账户<span className="tr-hint">只能部署到模拟盘</span></span>
          {!accounts.length ? <NoAccount compact /> : (
            <>
              <div className="tr-acct-pick">
                {[...accounts.filter((x) => !why(x, s)), ...(showBlocked ? blockedAccts : [])].map((x) => {
                  const w = why(x, s)
                  return (
                    <button key={x.id} type="button" disabled={!!w} className={cls('tr-acct-opt', a?.id === x.id && 'on')} aria-pressed={a?.id === x.id} onClick={() => pickAcct(x)}>
                      <span><span className="ellipsis">{x.name}</span><span className="tag tr-tag-sm">模拟</span></span>
                      <span className={cls('tr-small', w ? 'faint' : 'tr-muted')}>{w ?? `可用 ${num(x.available, 2)} ${x.currency}`}</span>
                    </button>
                  )
                })}
              </div>
              {blockedAccts.length > 0 && (
                <button type="button" className="tr-link tr-acct-more" onClick={() => setShowBlocked(!showBlocked)}>
                  {showBlocked ? '收起不可用的账户' : `其他 ${blockedAccts.length} 个账户不可用`}
                </button>
              )}
            </>
          )}
        </div>
        {s && (
          <div className="field">
            <span className="field-label">标的<span className="tr-hint">只列策略适用、账户支持、有行情源的</span></span>
            {!s.symbols.length ? <div className="tr-empty-box">策略还没选标的</div> : (
              <div className="tr-chips">
                {s.symbols.map((x) => {
                  const okSym = ok.includes(x)
                  const on = syms.includes(x)
                  const reason = !runnable(x) ? `${MARKETS[guessInstrument(x).market].label}${NO_SOURCE}` : '这个账户不支持该市场'
                  return (
                    <label key={x} className={cls('tr-chip', on && 'on', !okSym && 'off')} title={okSym ? x : reason}>
                      <input type="checkbox" disabled={!okSym} checked={on} onChange={() => { setSyms(on ? syms.filter((y) => y !== x) : [...syms, x]); create.reset() }} />{instName(x)}
                    </label>
                  )
                })}
              </div>
            )}
          </div>
        )}
        <label className="field"><span className="field-label">分配资金{a && <span className="tr-hint">{a.currency}，账户可用 {num(a.available, 2)}</span>}</span>
          <input className={cls('input', tried && !(cap > 0) && 'bad')} inputMode="decimal" aria-label="分配资金" value={capital} onChange={(e) => { setCapital(e.target.value); create.reset() }} />
        </label>
        {s && Object.keys(params).length > 0 && (
          <section className="tr-sec tr-sec-flat">
            <div className="tr-sec-title">参数覆盖<span className="tr-hint">默认值来自策略，只影响这次运行</span></div>
            <div className="tr-params">
              {Object.entries(params).map(([k, v]) => (
                <label key={k} className="field"><span className="field-label">{k}<span className="tr-hint">默认 {s.params[k]}</span></span>
                  <input className="input" inputMode="decimal" aria-label={`参数 ${k}`} value={v} onChange={(e) => { setParams({ ...params, [k]: e.target.value }); create.reset() }} />
                </label>
              ))}
            </div>
          </section>
        )}
        {s && (
          <div className="tr-hints">
            <div>止损 {s.stop_loss ? `${s.stop_loss}%` : '未设'} · 止盈 {s.take_profit ? `${s.take_profit}%` : '未设'} · 每次开仓 {s.position_pct}%；{intervalLabel(s.interval)} K 线收盘时算信号、下市价单，每笔同样走风控检查</div>
          </div>
        )}
      </div>
    </Drawer>
  )
}
