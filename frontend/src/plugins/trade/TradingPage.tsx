// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 交易页（TRD-05c、TRD-06b、TRD-07b、TRD-08c，SPEC-trading-1 到 12）：二级菜单 + 总览、持仓、委托、策略运行、交易账户、风控、交易设置；
// 熔断条、一键全停、下单抽屉、部署抽屉、新增账户抽屉、对账抽屉、交易所数据抽屉、证据抽屉。
// 交互照原型 web-next/src/trading.tsx。撮合、估值、风控、部署信号都在后端（TRD-05a、05b、06a），这里只发请求和显示。
// 实盘账户（TRD-07a）只读同步；闸门全开（账户 trade_ready，TRD-08d）后能下单、平仓、撤单、部署，入口复用模拟盘的（下单抽屉、
// 委托列表、部署抽屉），实盘持仓在交易账户的「交易所数据」里看和平仓。总览、持仓只算模拟盘账户；委托、策略运行里实盘的标「实盘」。
// 标题栏固定「模拟盘」标签，有能下单的实盘账户时多一个「实盘可下单」。没有模拟盘账户时就地给「建一个模拟盘账户」。
// 路由挂在 trading/* 下：/trading 总览，/trading/positions，/trading/orders，/trading/runs，/trading/accounts，/trading/risk，/trading/settings。
// 从行情来：/trading?symbol=&side= 打开下单抽屉；从策略来：/trading/runs?deploy=<策略 id> 打开部署抽屉。
import { useEffect, useMemo, useState } from 'react'
import { Navigate, useNavigate, useParams, useSearchParams } from 'react-router'
import {
  QueryState, errorText, evidenceKind, tradeKillPartial, useKillTrading, useReleaseHalt, useTradeAccounts, useTradeFillWatch,
  useTradeHaltEvents, useTradeLiveGate, useTradeOrders, useTradePositions, useTradeRisk, useTradeRuns, useTradeStrategies,
  type TradeAccount, type TradeKillResult, type TradeLiveEvidence, type TradeOrder, type TradePosition, type TradeRisk, type TradeRun,
} from '../../core/data'
import { Button, InSubnavHost, PageTitle, Pill, Subnav, cls } from '../../core/ui'
import './markets.css'
import './monitor.css'
import { MARKETS, guessInstrument } from './model'
import { OrderDrawer } from './OrderDrawer'
import { RiskView } from './RiskView'
import { AccountDrawer, AccountsView, LiveDataDrawer, ReconDrawer } from './TradingAccounts'
import { EvidenceDrawer, SettingsView } from './TradingSettings'
import { NoAccount, type TradeNotice } from './TradingParts'
import { OrdersView, PositionsView } from './TradingTables'
import { RunDrawer, RunsView } from './TradingRuns'
import { ORDER_STATUS, ORDER_TYPE, RUN_STATUS, compact, fmtQty, fmtTime, isLiveReady, num, signed, signedUsd, tone, usd } from './tradingModel'
import './trading.css'

export type TradingView = 'overview' | 'positions' | 'orders' | 'runs' | 'accounts' | 'risk' | 'settings'
const VIEWS: TradingView[] = ['overview', 'positions', 'orders', 'runs', 'accounts', 'risk', 'settings']

const TITLES: Record<TradingView, { title: string; desc: string }> = {
  overview: { title: '交易总览', desc: '模拟盘账户的权益、盈亏和风控；估值按后端行情缓存现算' },
  positions: { title: '持仓', desc: '现价、盈亏、强平价都由后端算；平仓会下一笔反向市价单' },
  orders: { title: '委托', desc: '提交后后端当场检查，过了就挂单；模拟盘限价单在价格到了时成交，实盘委托以交易所回报为准' },
  runs: { title: '策略运行', desc: '策略部署到账户上跑（实盘要闸门全开），K 线收盘时算信号、下市价单，每笔都过风控' },
  accounts: { title: '交易账户', desc: '交易所账户接入（凭证存保险箱，不开提币权限）和模拟盘；实盘账户要闸门全开才能交易，否则只读同步' },
  risk: { title: '风控', desc: '每笔下单在后端逐笔检查；当日亏损到上限自动熔断' },
  settings: { title: '交易设置', desc: '装好只有模拟盘；实盘要过评审、申请 trade:live、再打开实盘开关' },
}

type DrawerState =
  | { kind: 'order'; symbol: string; side: 'buy' | 'sell'; accountId?: string; key: number }
  | { kind: 'run'; strategyId?: string; key: number }
  | { kind: 'account'; key: number }
  | { kind: 'recon' | 'livedata'; accountId: string; key: number }
  | { kind: 'evidence'; ev: TradeLiveEvidence; key: number }
  | null

const DEFAULT_SYMBOL = 'BINANCE:BTCUSDT'

export default function TradingPage() {
  const rest = useParams()['*'] ?? ''
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const view = (rest.split('/').filter(Boolean)[0] ?? 'overview') as TradingView
  const accounts = useTradeAccounts()
  const positions = useTradePositions()
  const risk = useTradeRisk()
  const runs = useTradeRuns()
  const active = useTradeOrders({ status: 'active', limit: 1 })
  const strategies = useTradeStrategies()
  const gate = useTradeLiveGate()
  const kill = useKillTrading()
  // 外部请求（行情「买入」「卖出」、策略「部署」）：进页面时按地址打开抽屉，再把参数从地址里去掉，刷新不会再开一次
  const [drawer, setDrawer] = useState<DrawerState>(() => {
    const sym = params.get('symbol')
    if (sym) return { kind: 'order', symbol: sym, side: params.get('side') === 'sell' ? 'sell' : 'buy', key: Date.now() }
    if (params.has('deploy')) return { kind: 'run', strategyId: params.get('deploy') || undefined, key: Date.now() }
    return null
  })
  const [killAsk, setKillAsk] = useState<'' | 'nav' | 'top'>('')
  const [notice, setNotice] = useState<TradeNotice>(null)
  useTradeFillWatch(active.data?.active)
  useTradeHaltEvents()

  const hasReq = params.has('symbol') || params.has('deploy')
  useEffect(() => {
    if (hasReq) setParams((p) => { for (const k of ['symbol', 'side', 'paper', 'deploy']) p.delete(k); return p }, { replace: true })
  }, [hasReq, setParams])

  const segs = rest.split('/').filter(Boolean)
  if (segs.length > 1 || (segs[0] && !VIEWS.includes(view))) return <Navigate to="/trading" replace />

  const go = (v: TradingView) => void navigate(v === 'overview' ? '/trading' : `/trading/${v}`)
  const openOrder = (symbol = DEFAULT_SYMBOL, side: 'buy' | 'sell' = 'buy', accountId?: string) => setDrawer({ kind: 'order', symbol, side, accountId, key: Date.now() })
  const openRun = (strategyId?: string) => setDrawer({ kind: 'run', strategyId, key: Date.now() })
  const openStrategy = (id: string) => void navigate(`/strategy/s/${encodeURIComponent(id)}`)
  // 证据：审计、对账记录在抽屉里看；熔断记录、部署跳到对应视图
  const openEvidence = (ev: TradeLiveEvidence) => {
    if (evidenceKind(ev.href)) setDrawer({ kind: 'evidence', ev, key: Date.now() })
    else if (ev.view && VIEWS.includes(ev.view as TradingView)) go(ev.view as TradingView)
  }

  const runList = runs.data?.data ?? []
  const badAcct = (accounts.data ?? []).filter((a) => a.status !== 'connected').length
  const liveAcct = (accounts.data ?? []).filter((a) => !a.paper).length
  const liveReady = (accounts.data ?? []).filter(isLiveReady).length
  const badRun = runList.filter((r) => r.status === 'error').length
  const liveRun = runList.filter((r) => r.status === 'running').length
  const r = risk.data
  const halted = !!r?.halted

  const doKill = (reason?: string) => {
    setKillAsk('')
    kill.mutate(reason, {
      onSuccess: (res) => setNotice(killNotice(res)),
      onError: (e) => {
        const part = tradeKillPartial(e)
        setNotice({
          tone: 'danger', text: `全停没有完成：${errorText(e)}`, retry: () => doKill(reason),
          detail: part ? [
            ...(part.remaining_runs.length ? [`还在跑的部署：${part.remaining_runs.join('、')}`] : []),
            ...(part.remaining_orders.length ? [`没撤掉的挂单：${part.remaining_orders.join('、')}`] : []),
            ...part.failed,
          ] : undefined,
        })
      },
    })
  }

  const t = TITLES[view] ?? TITLES.overview
  const actions = (
    <>
      <Button variant="danger" className="tr-kill-top" disabled={kill.isPending} title="停掉所有策略、撤掉所有挂单、进入熔断" onClick={() => setKillAsk('top')}>一键全停</Button>
      {view === 'runs' && <Button variant="outline" onClick={() => openRun()}>新建运行</Button>}
      {view === 'accounts' && <Button variant="outline" onClick={() => setDrawer({ kind: 'account', key: Date.now() })}>新增账户</Button>}
      <Button variant="primary" onClick={() => openOrder()}>下单</Button>
    </>
  )

  const subnav = (
    <InSubnavHost>
      <Subnav<TradingView> title="交易" className="tr-subnav" active={view} onSelect={go} items={[
        { key: 'overview', label: '总览', desc: '模拟盘' },
        { key: 'positions', label: '持仓', desc: positions.data?.length ? `${positions.data.length} 个持仓` : undefined },
        { key: 'orders', label: '委托', desc: active.data?.active ? `${active.data.active} 笔挂单` : undefined },
        {
          key: 'runs', label: '策略运行', alert: badRun, title: badRun ? `${badRun} 个运行异常` : undefined,
          desc: badRun ? `${badRun} 个异常` : liveRun ? `${liveRun} 个运行中` : undefined,
        },
        {
          key: 'accounts', label: '交易账户', alert: badAcct, title: badAcct ? `${badAcct} 个账户异常` : undefined,
          desc: badAcct ? `${badAcct} 个异常` : liveReady ? `${liveReady} 个实盘可下单` : liveAcct ? `${liveAcct} 个实盘只读` : undefined,
        },
        { key: 'risk', label: '风控', alert: halted ? 1 : 0, desc: halted ? '熔断中' : undefined, title: halted ? '熔断中' : undefined },
        { key: 'settings', label: '交易设置', desc: gate.data?.enabled ? '实盘已开启' : '只开模拟盘' },
      ]}>
        {killAsk === 'nav' ? (
          <>
            <Button size="sm" onClick={() => setKillAsk('')}>取消</Button>
            <button type="button" className="tr-kill" onClick={() => doKill()}>确认全停</button>
          </>
        ) : (
          <button type="button" className="tr-kill" disabled={kill.isPending} title="停掉所有策略、撤掉所有挂单、进入熔断" onClick={() => setKillAsk('nav')}>
            {kill.isPending ? '全停中…' : '一键全停'}
          </button>
        )}
      </Subnav>
    </InSubnavHost>
  )

  const allAccts = accounts.data ?? []
  // 总览、持仓只算模拟盘账户（实盘的余额、持仓在交易账户页看）；委托、策略运行里也有实盘的（TRD-08d）
  const paperAccts = allAccts.filter((a) => a.paper)
  const tradeAccts = allAccts.filter((a) => a.paper || a.trade_ready || a.want_trade)
  const noAccount = accounts.data && !paperAccts.length && !liveReady
  let body
  if (view === 'settings') body = <SettingsView onView={go} onEvidence={openEvidence} />
  else if (accounts.isPending && !accounts.data) body = <QueryState query={accounts} errorTitle="账户没取到">{() => null}</QueryState>
  else if (accounts.isError && !accounts.data) body = <QueryState query={accounts} errorTitle="交易账户没取到">{() => null}</QueryState>
  else if (view === 'accounts') {
    body = <AccountsView accounts={allAccts} positions={positions.data ?? []} onNew={() => setDrawer({ kind: 'account', key: Date.now() })}
      onRecon={(id) => setDrawer({ kind: 'recon', accountId: id, key: Date.now() })} onLiveData={(id) => setDrawer({ kind: 'livedata', accountId: id, key: Date.now() })}
      onOrder={(id) => openOrder(DEFAULT_SYMBOL, 'buy', id)} />
  } else if (noAccount && view !== 'risk') body = <NoAccount />
  else {
    const accts = paperAccts
    const acctName = (id: string) => allAccts.find((a) => a.id === id)?.name ?? '已删除的账户'
    if (view === 'overview') {
      body = <Overview accounts={accts} allAccounts={allAccts} positions={positions.data ?? []} runs={runList} risk={r} acctName={acctName} onView={go} onOpenStrategy={openStrategy} />
    } else if (view === 'positions') {
      body = <PositionsView accounts={accts} positions={positions} runs={runList} acctName={acctName} onNew={() => openOrder()} onNotice={setNotice}
        onChart={(s) => void navigate(`/markets?${new URLSearchParams({ symbol: s })}`)} />
    } else if (view === 'orders') {
      body = <OrdersView accounts={tradeAccts} acctName={acctName} />
    } else if (view === 'runs') {
      body = <RunsView runs={runs} accounts={allAccts} strategies={strategies.data ?? []} halted={halted} onOpenStrategy={openStrategy} onNew={() => openRun()} />
    } else {
      body = <RiskView risk={risk} killing={kill.isPending} onKill={() => doKill('风控页手动一键全停')} />
    }
  }

  return (
    <div className="tr-mod">
      {subnav}
      <div className="tr-page">
        <PageTitle parent="交易" desc={t.desc} actions={actions} icon={liveReady ? (
          <>
            <span className="tag tr-paper" title="模拟盘账户的委托只在本地撮合">模拟盘</span>
            <span className="tag tr-paper tr-tag-live" title={`${liveReady} 个实盘账户闸门全开：在这些账户上下单会在交易所真实成交`}>实盘可下单</span>
          </>
        ) : <span className="tag tr-paper" title="只有模拟盘能下单：委托只在本地撮合；实盘账户闸门没开全，只读同步">模拟盘</span>}>
          {t.title}
        </PageTitle>
        {killAsk === 'top' && (
          <div className="tr-banner tr-banner-danger tr-kill-ask" role="alert">
            <span>确定一键全停？停掉所有策略、撤掉所有挂单、进入熔断；持仓不动，熔断后要手动解除才能开新仓</span>
            <span className="tr-banner-act">
              <Button size="sm" onClick={() => setKillAsk('')}>取消</Button>
              <Button size="sm" variant="danger" onClick={() => doKill()}>确认全停</Button>
            </span>
          </div>
        )}
        {r?.halted && <HaltBar risk={r} />}
        {notice && (
          <div className={cls('tr-banner', notice.tone === 'danger' ? 'tr-banner-danger' : 'tr-banner-ok')} role={notice.tone === 'danger' ? 'alert' : 'status'}>
            <span>
              {notice.text}
              {notice.detail?.length ? <ul className="tr-banner-list">{notice.detail.map((d) => <li key={d}>{d}</li>)}</ul> : null}
            </span>
            <span className="tr-banner-act">
              {notice.retry && <Button size="sm" variant="danger" disabled={kill.isPending} onClick={notice.retry}>重试</Button>}
              <Button size="sm" onClick={() => setNotice(null)}>知道了</Button>
            </span>
          </div>
        )}
        {body}
      </div>

      {drawer?.kind === 'order' && (
        <OrderDrawer key={drawer.key} init={drawer} accounts={accounts.data ?? []} positions={positions.data ?? []} risk={r}
          onClose={() => setDrawer(null)} onPlaced={(o) => { setDrawer(null); setNotice(placedNotice(o)) }} />
      )}
      {drawer?.kind === 'account' && (
        <AccountDrawer key={drawer.key} onClose={() => setDrawer(null)} onCreated={(a) => {
          setDrawer(null)
          setNotice({ tone: 'ok', text: a.paper ? `已建模拟盘账户「${a.name}」` : `已接入「${a.name}」（只读同步${a.recon ? '，第一次同步完成' : ''}）` })
          if (view !== 'accounts') go('accounts')
        }} />
      )}
      {(drawer?.kind === 'recon' || drawer?.kind === 'livedata') && (() => {
        const a = allAccts.find((x) => x.id === drawer.accountId)
        if (!a) return null
        return drawer.kind === 'recon'
          ? <ReconDrawer key={drawer.key} account={a} onClose={() => setDrawer(null)} />
          : <LiveDataDrawer key={drawer.key} account={a} onClose={() => setDrawer(null)} />
      })()}
      {drawer?.kind === 'evidence' && <EvidenceDrawer key={drawer.key} ev={drawer.ev} onClose={() => setDrawer(null)} />}
      {drawer?.kind === 'run' && (
        <RunDrawer key={drawer.key} initStrategy={drawer.strategyId} strategies={strategies.data ?? []} accounts={accounts.data ?? []} halted={halted}
          onClose={() => setDrawer(null)} onCreated={() => { setDrawer(null); if (view !== 'runs') go('runs') }} />
      )}
    </div>
  )
}

function killNotice(res: TradeKillResult): TradeNotice {
  const left = res.remaining_runs.length + res.remaining_orders.length
  return {
    tone: left || res.failed.length ? 'danger' : 'ok',
    text: `一键全停完成：停掉 ${res.runs_stopped} 个部署，撤掉 ${res.orders_canceled} 笔挂单，持仓保留；已进入熔断`,
    detail: [
      ...(res.remaining_runs.length ? [`还在跑的部署：${res.remaining_runs.join('、')}`] : []),
      ...(res.remaining_orders.length ? [`没撤掉的挂单：${res.remaining_orders.join('、')}`] : []),
      ...res.failed,
    ],
  }
}

function placedNotice(o: TradeOrder): TradeNotice {
  const what = `${o.live ? '实盘' : ''}${o.side === 'buy' ? '买入' : '卖出'} ${fmtQty(o.qty)} ${guessInstrument(o.symbol).name}`
  if (o.status === 'rejected') return { tone: 'danger', text: `委托被拒：${what}，${o.reject_reason ?? '没有原因'}` }
  const tail = o.live ? (o.status === 'unknown' ? '，交易所没回准状态，后台按委托编号查单确认、不会重发' : '，状态以交易所回报为准')
    : o.type === 'market' ? '，市价单通常一秒内成交' : ''
  return { tone: 'ok', text: `已下单：${what}，${ORDER_STATUS[o.status]?.label ?? o.status}${tail}` }
}

/* ---------- 熔断条（SPEC-trading-1.5、1.6） ---------- */

function HaltBar({ risk }: { risk: TradeRisk }) {
  const [asking, setAsking] = useState(false)
  const [reason, setReason] = useState('')
  const release = useReleaseHalt()
  const ok = reason.trim().length > 0
  const submit = () => {
    if (!ok) return
    release.mutate(reason.trim(), { onSuccess: () => { setAsking(false); setReason('') } })
  }
  return (
    <div className="tr-banner tr-banner-danger tr-halt" role="alert">
      <span><b>熔断中</b>{risk.halted_reason ?? '手动全停'}{risk.halted_at && ` · ${fmtTime(risk.halted_at)}`}。所有策略已停止、挂单已撤，只能平仓或减仓。</span>
      {asking ? (
        <span className="tr-halt-act">
          <span className="tr-halt-q">解除后可以重新开仓，策略不会自动恢复</span>
          <input className="tr-input tr-halt-input" aria-label="解除原因" placeholder="解除原因（必填）" value={reason} autoFocus
            onChange={(e) => setReason(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') submit() }} />
          <Button size="sm" onClick={() => { setAsking(false); release.reset() }}>取消</Button>
          <Button size="sm" variant="danger" disabled={!ok || release.isPending} title={ok ? undefined : '先写解除原因'} onClick={submit}>确认解除</Button>
          {release.error && <span className="tr-halt-err">没解除：{errorText(release.error)}</span>}
        </span>
      ) : (
        <Button size="sm" variant="outline" onClick={() => setAsking(true)}>解除熔断</Button>
      )}
    </div>
  )
}

/* ---------- 总览（SPEC-trading-2） ---------- */

const OV_ACCTS = 6

function Overview({ accounts, allAccounts, positions, runs, risk, acctName, onView, onOpenStrategy }: {
  accounts: TradeAccount[]; allAccounts: TradeAccount[]; positions: TradePosition[]; runs: TradeRun[]; risk?: TradeRisk; acctName: (id: string) => string
  onView: (v: TradingView) => void; onOpenStrategy: (id: string) => void
}) {
  const recent = useTradeOrders({ limit: 6 })
  const sum = useMemo(() => {
    const s = { equity: 0, available: 0, margin: 0, float: 0, realized: 0, fees: 0 }
    for (const a of accounts) {
      s.equity += a.equity
      s.available += a.available
      s.margin += a.margin_used
      s.float += a.unrealized_pnl
      s.realized += a.realized_pnl
      s.fees += a.fees
    }
    return s
  }, [accounts])
  // 资产分布：持仓按市值（合约按保证金）+ 可用现金
  const byMarket: Record<string, number> = {}
  for (const p of positions) {
    const m = marketOfSymbol(p.symbol)
    byMarket[m] = (byMarket[m] ?? 0) + (p.leverage ? p.margin : Math.abs(p.value))
  }
  const segs = [
    ...Object.entries(MARKETS).map(([k, m]) => ({ key: k, label: m.label, color: m.color, v: byMarket[k] ?? 0 })),
    { key: 'cash', label: '可用现金', color: 'var(--line-2)', v: Math.max(0, sum.available) },
  ].filter((x) => x.v > 0)
  const total = segs.reduce((s, x) => s + x.v, 0)
  const going = runs.filter((x) => x.status === 'running' || x.status === 'error')
  const day = risk?.day
  const lossPct = day && day.loss_limit ? Math.min(1, day.loss_used / day.loss_limit) : 0
  const marginRate = sum.equity ? sum.margin / sum.equity : 0
  const stale = accounts.some((a) => a.marks_status === 'stale')
  const acctShown = accounts.slice(0, OV_ACCTS)
  const at = accounts[0]?.updated_at
  return (
    <>
      <section className="tr-stats">
        <div className="tr-stat"><div className="tr-stat-label">总权益（USD）</div><div className="tr-stat-value tr-num" title={usd(sum.equity, 2)}>{compact(sum.equity)}</div></div>
        <div className="tr-stat"><div className="tr-stat-label">今日盈亏</div>
          <div className="tr-stat-value tr-num" style={{ color: tone(day?.pnl ?? 0) }} title={day ? signedUsd(day.pnl, 2) : undefined}>{day ? compact(day.pnl, true) : '-'}</div></div>
        <div className="tr-stat"><div className="tr-stat-label">持仓浮盈</div><div className="tr-stat-value tr-num" style={{ color: tone(sum.float) }} title={signedUsd(sum.float, 2)}>{compact(sum.float, true)}</div></div>
        <div className="tr-stat"><div className="tr-stat-label">可用资金</div><div className="tr-stat-value tr-num" title={usd(sum.available, 2)}>{compact(sum.available)}</div></div>
        <div className="tr-stat"><div className="tr-stat-label">保证金占用率</div><div className={cls('tr-stat-value tr-num', marginRate > 0.5 && 'danger-text')}>{(marginRate * 100).toFixed(1)}%</div></div>
      </section>

      <div className="tr-ov-box"><div className="tr-ov">
        <div className="tr-ov-main">
          <section className="tr-sec">
            <div className="tr-sec-title">资产分布<span className="tr-hint">持仓按市值（合约按保证金）+ 可用现金</span></div>
            {total > 0 ? (
              <>
                <div className="tr-dist">{segs.map((s) => <i key={s.key} style={{ width: `${(s.v / total) * 100}%`, background: s.color }} title={`${s.label} ${usd(s.v)}`} />)}</div>
                <div className="tr-legend">
                  {segs.map((s) => (
                    <span key={s.key} className="tr-legend-item"><i style={{ background: s.color }} />{s.label}<b className="tr-num">{usd(s.v)}</b><span className="faint">{((s.v / total) * 100).toFixed(1)}%</span></span>
                  ))}
                </div>
              </>
            ) : <div className="tr-empty-box">没有可用资金也没有持仓</div>}
          </section>

          <section className="tr-sec">
            <div className="tr-sec-title">运行中的策略<span className="tr-hint">{going.length} 个</span></div>
            {!going.length ? <div className="tr-empty-box">没有运行中的策略</div> : (
              <div className="tr-mini-grid">
                {going.map((x) => (
                  <button key={x.id} type="button" className="tr-mini" onClick={() => onOpenStrategy(x.strategy_id)} title="打开策略">
                    <span className="tr-mini-top"><span className="ellipsis">{x.strategy_name || '未命名策略'}</span><Pill {...RUN_STATUS[x.status]} /></span>
                    <span className="tr-muted ellipsis">{acctName(x.account_id)} · {allAccounts.find((a) => a.id === x.account_id)?.paper === false ? '实盘' : '模拟'} · {x.symbols.join('、')}</span>
                    <span className="tr-mini-pnl tr-num" style={{ color: tone(x.pnl) }}>{signed(x.pnl)}</span>
                  </button>
                ))}
              </div>
            )}
          </section>

          <section className="tr-sec">
            <div className="tr-sec-title">最近委托<span className="spacer" /><button type="button" className="tr-link" onClick={() => onView('orders')}>全部委托</button></div>
            <QueryState query={recent} compact errorTitle="委托没取到">
              {(pg) => !pg.data.length ? <div className="tr-empty-box">还没有委托</div> : (
                <div className="tr-list">
                  {pg.data.map((o) => (
                    <div key={o.id} className="tr-list-row">
                      <span className={cls('tr-side', o.side === 'buy' ? 'buy' : 'sell')}>{o.side === 'buy' ? '买' : '卖'}</span>
                      <span className="tr-list-main">
                        <span className="ellipsis" title={o.symbol}>{guessInstrument(o.symbol).name}</span>
                        <span className="tr-muted ellipsis">{ORDER_TYPE[o.type]} · {fmtQty(o.qty)}{o.price !== undefined ? ` @ ${num(o.price, 2)}` : ''} · {acctName(o.account_id)}</span>
                      </span>
                      <span className="tr-list-side"><Pill {...ORDER_STATUS[o.status]} /><span className="faint">{fmtTime(o.created_at)}</span></span>
                    </div>
                  ))}
                </div>
              )}
            </QueryState>
          </section>
        </div>

        <div className="tr-ov-side">
          <section className={cls('tr-sec', risk?.halted && 'tr-sec-bad')}>
            <div className="tr-sec-title">风控状态<span className="spacer" /><button type="button" className="tr-link" onClick={() => onView('risk')}>去风控</button></div>
            {!risk ? <div className="tr-empty-box">风控没取到</div> : (
              <>
                <div className="tr-kv"><span>状态</span><b className={risk.halted ? 'danger-text' : 'tr-ok'}>{risk.halted ? '熔断中' : '正常'}</b></div>
                <div className="tr-loss">
                  <div className="tr-kv"><span>当日亏损</span><b className="tr-num">{usd(risk.day.loss_used)} / {usd(risk.day.loss_limit)}</b></div>
                  <div className="tr-bar" role="progressbar" aria-label="当日亏损" aria-valuenow={Math.round(lossPct * 100)} aria-valuemin={0} aria-valuemax={100}>
                    <i className={cls(lossPct > 0.8 && 'hot')} style={{ width: `${lossPct * 100}%` }} />
                  </div>
                  {risk.day.status === 'stale' && <span className="faint tr-small">有持仓的现价不是实时，这一刻不判定日亏损</span>}
                </div>
                <div className="tr-kv"><span>单笔上限</span><b className="tr-num">{usd(risk.max_order_value)}</b></div>
                <div className="tr-kv"><span>单标的仓位</span><b className="tr-num">{risk.max_position_pct}%</b></div>
                <div className="tr-kv"><span>最大杠杆</span><b className="tr-num">{risk.max_leverage}x</b></div>
                <div className="tr-kv"><span>二次确认</span><b className="tr-num">超过 {usd(risk.confirm_above)}</b></div>
              </>
            )}
          </section>
          <section className="tr-sec">
            <div className="tr-sec-title">账户<span className="tr-hint">{accounts.length} 个模拟盘</span><span className="spacer" /><button type="button" className="tr-link" onClick={() => onView('accounts')}>交易账户</button></div>
            <div className="tr-list">
              {acctShown.map((a) => (
                <div key={a.id} className="tr-list-row tr-acct-row">
                  <span className="tr-dot ok" />
                  <span className="tr-list-main">
                    <span className="ellipsis">{a.name}</span>
                    <span className="tr-muted ellipsis">模拟 · {a.markets.map((m) => MARKETS[m]?.label ?? m).join(' / ')} · 已实现 {signed(a.realized_pnl)} · 手续费 {num(a.fees, 2)}</span>
                  </span>
                  <span className="tr-num tr-list-val">{num(a.equity, 2)} <span className="faint">{a.currency}</span></span>
                </div>
              ))}
            </div>
            {accounts.length > OV_ACCTS && <button type="button" className="tr-link" onClick={() => onView('accounts')}>其余 {accounts.length - OV_ACCTS} 个账户在交易账户页</button>}
          </section>
          <div className="faint tr-foot-note">
            {at ? `按 ${new Date(at).toLocaleTimeString('zh-CN', { hour12: false })} 的行情估值` : ''}{stale ? '；有持仓的现价不是实时，按缓存或均价估' : ''}
          </div>
        </div>
      </div></div>
    </>
  )
}

const marketOfSymbol = (s: string): string => guessInstrument(s).market
