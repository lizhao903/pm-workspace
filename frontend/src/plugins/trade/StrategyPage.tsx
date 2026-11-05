// 策略与回测（TRD-04c，SPEC-strategy-1 到 7）：二级菜单 + 策略库（默认）、编辑页、回测记录（含对比）、回测报告。
// 路由挂在 strategy/* 下：/strategy 策略库，/strategy/s/<id> 编辑页，/strategy/backtests 回测记录，/strategy/backtests/<id> 回测报告，/strategy/runs 运行记录。
// 回测只在后端跑（排队、取真实历史 K 线、落库），这里只发起和展示；进度靠轮询（core/data/tradeStrategy.ts）。
// 部署（TRD-05c 起）：「部署」跳到交易「策略运行」打开部署抽屉（/trading/runs?deploy=<策略 id>），只能部署到模拟盘；运行记录来自 /api/trade/runs。
import { useEffect, useMemo, useState } from 'react'
import { Navigate, useNavigate, useParams } from 'react-router'
import {
  QueryState, errorText, useCreateTradeStrategy, useTradeBacktests, useTradeRuns, useTradeStrategies, type TradeBacktestBrief, type TradeStrategy,
} from '../../core/data'
import { Button, EmptyState, InSubnavHost, PageTitle, Pill, SearchSelect, Subnav, cls } from '../../core/ui'
import { BacktestReportPage, BacktestsPage } from './BacktestPages'
import { MARKETS } from './model'
import { StrategyEditor } from './StrategyEditor'
import { StrategyRunsPage } from './StrategyRuns'
import { BT_STATUS, DIR_LABEL, MODE_LABEL, intervalLabel, instName, latestOf, marketOf, pctRaw, timeAgo } from './strategyModel'
import { PlusIcon, ProgressBar, SearchIcon, Signed, SymTags } from './StrategyParts'
import './strategy.css'

type NavKey = 'list' | 'backtests' | 'runs' | `st:${string}`
type Route = { kind: 'list' } | { kind: 'backtests' } | { kind: 'runs' } | { kind: 'strategy'; id: string } | { kind: 'backtest'; id: string } | { kind: 'bad' }

function routeOf(rest: string): Route {
  const seg = rest.split('/').filter(Boolean).map(decodeURIComponent)
  if (!seg.length) return { kind: 'list' }
  if (seg.length === 1 && seg[0] === 'backtests') return { kind: 'backtests' }
  if (seg.length === 1 && seg[0] === 'runs') return { kind: 'runs' }
  if (seg.length === 2 && seg[0] === 'backtests') return { kind: 'backtest', id: seg[1] }
  if (seg.length === 2 && seg[0] === 's') return { kind: 'strategy', id: seg[1] }
  return { kind: 'bad' }
}

/** 菜单里「最近编辑」放几个 */
const NAV_RECENT = 5

export default function StrategyPage() {
  const rest = useParams()['*'] ?? ''
  const navigate = useNavigate()
  const route = routeOf(rest)
  const strategies = useTradeStrategies()
  const backtests = useTradeBacktests()
  const runs = useTradeRuns()
  const create = useCreateTradeStrategy()
  const now = useNow(60_000)
  const root = '/strategy'

  const list = useMemo(() => strategies.data ?? [], [strategies.data])
  const bts = useMemo(() => backtests.data ?? [], [backtests.data])
  const recent = useMemo(() => [...list].sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, NAV_RECENT), [list])

  if (route.kind === 'bad') return <Navigate to={root} replace />

  const openStrategy = (id: string) => void navigate(`${root}/s/${encodeURIComponent(id)}`)
  const openBacktest = (id: string) => void navigate(`${root}/backtests/${encodeURIComponent(id)}`)
  const onNew = () => create.mutate(undefined, { onSuccess: (st) => openStrategy(st.id) })
  const select = (k: NavKey) => {
    if (k === 'list') void navigate(root)
    else if (k === 'backtests') void navigate(`${root}/backtests`)
    else if (k === 'runs') void navigate(`${root}/runs`)
    else openStrategy(k.slice(3))
  }
  const running = bts.filter((b) => b.status === 'running').length
  // 打开的策略不在最近编辑里时，高亮「策略库」；看回测报告时高亮「回测记录」
  const runBad = runs.data?.error ?? 0
  const runLive = runs.data ? runs.data.running + runs.data.paused : 0
  const active: NavKey = route.kind === 'runs' ? 'runs' : route.kind === 'backtests' || route.kind === 'backtest' ? 'backtests'
    : route.kind === 'strategy' && recent.some((s) => s.id === route.id) ? `st:${route.id}` : 'list'

  const subnav = (
    <InSubnavHost>
      <Subnav<NavKey> title="策略" className="sg-subnav" active={active} onSelect={select} items={[
        // 计数加载失败时不显示，不当成 0（SPEC-strategy-1.7）
        { key: 'list', label: '策略库', desc: strategies.data ? `${list.length} 个策略` : undefined, group: '视图' },
        {
          key: 'backtests', label: '回测记录', alert: backtests.isError ? 0 : running, group: '视图',
          title: running ? `${running} 个回测运行中` : undefined, desc: running ? `${running} 个运行中` : undefined,
        },
        // 计数加载失败时同样不显示（SPEC-strategy-1.3、1.7）
        {
          key: 'runs', label: '运行记录', alert: runs.isError ? 0 : runBad, group: '视图', title: runBad ? `${runBad} 个运行异常` : undefined,
          desc: runLive ? `${runLive} 个在模拟盘跑` : undefined,
        },
        ...recent.map((s) => ({
          key: `st:${s.id}` as NavKey, label: s.name || '未命名策略', desc: `${MODE_LABEL[s.mode]} · ${intervalLabel(s.interval)}`, group: '最近编辑', title: s.name,
        })),
      ]}>
        <Button className="subnav-new" onClick={onNew} disabled={create.isPending}><PlusIcon s={13} />新建策略</Button>
      </Subnav>
    </InSubnavHost>
  )

  let body
  if (route.kind === 'list') {
    body = (
      <QueryState query={strategies} errorTitle="策略没取到">
        {(sts) => <StrategyListPage strategies={sts} backtests={bts} now={now} onOpen={openStrategy} onNew={onNew} creating={create.isPending}
          createError={create.error ? errorText(create.error) : ''} />}
      </QueryState>
    )
  } else if (route.kind === 'strategy') {
    const id = route.id
    body = (
      <QueryState query={strategies} errorTitle="策略没取到">
        {(sts) => {
          const st = sts.find((s) => s.id === id)
          if (!st) return <EmptyState title="这个策略已经删除" action={<Button onClick={() => void navigate(root)}>回到策略库</Button>} />
          return <StrategyEditor key={id} strategy={st} backtests={bts} now={now} onOpenBacktest={openBacktest} onDeleted={() => void navigate(root, { replace: true })} />
        }}
      </QueryState>
    )
  } else if (route.kind === 'runs') {
    body = <StrategyRunsPage strategies={list} now={now} onOpenStrategy={openStrategy} onManage={() => void navigate('/trading/runs')} onToList={() => void navigate(root)} />
  } else if (route.kind === 'backtests') {
    body = (
      <QueryState query={backtests} errorTitle="回测记录没取到">
        {(b) => <BacktestsPage backtests={b} strategies={list} now={now} onOpen={openBacktest} />}
      </QueryState>
    )
  } else {
    body = (
      <BacktestReportPage id={route.id} strategies={list} now={now} onOpenStrategy={openStrategy} onOpen={openBacktest}
        onBack={() => void navigate(`${root}/backtests`)} />
    )
  }

  return (
    <div className="sg-mod">
      {subnav}
      {body}
    </div>
  )
}

function useNow(ms: number) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), ms)
    return () => window.clearInterval(t)
  }, [ms])
  return now
}

/* ---------- 策略库（SPEC-strategy-2） ---------- */

function StrategyListPage({ strategies, backtests, now, onOpen, onNew, creating, createError }: {
  strategies: TradeStrategy[]; backtests: TradeBacktestBrief[]; now: number; onOpen: (id: string) => void; onNew: () => void; creating: boolean; createError: string
}) {
  const [mode, setMode] = useState<'' | TradeStrategy['mode']>('')
  const [market, setMarket] = useState('')
  const [q, setQ] = useState('')
  const kw = q.trim().toLowerCase()
  const rows = strategies
    .filter((s) => (!mode || s.mode === mode) && (!market || s.symbols.some((x) => marketOf(x) === market))
      && (!kw || [s.name, s.desc, ...s.tags, ...s.symbols, ...s.symbols.map(instName)].some((v) => v.toLowerCase().includes(kw))))
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
  return (
    <div className="sg-page">
      <PageTitle parent="策略" count={strategies.length} desc="条件规则或代码写的交易策略，回测通过后部署到实盘或模拟盘" actions={
        <Button variant="primary" onClick={onNew} disabled={creating}><PlusIcon />新建策略</Button>
      }>策略库</PageTitle>
      {createError && <div className="sg-alert" role="alert"><span>新建失败：{createError}</span></div>}
      <div className="sg-toolbar">
        <div className="sg-seg" role="group" aria-label="按模式筛">
          {([['', '全部'], ['rules', '条件规则'], ['code', '代码']] as const).map(([k, l]) => (
            <button key={k} type="button" className={cls(mode === k && 'on')} aria-pressed={mode === k} onClick={() => setMode(k)}>
              {l}<span className="seg-n">{strategies.filter((s) => !k || s.mode === k).length}</span>
            </button>
          ))}
        </div>
        <SearchSelect value={market} noneLabel="全部市场" placeholder="全部市场" aria-label="按市场筛" onChange={(v: string) => setMarket(v)}
          options={Object.entries(MARKETS).map(([k, m]) => ({ value: k, label: m.label }))} />
        <span className="spacer" />
        <div className="search">
          <SearchIcon />
          <input placeholder="搜策略名、标签、标的" aria-label="搜策略" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>
      {!rows.length ? (
        <EmptyState title={strategies.length ? '没有匹配的策略' : '还没有策略'} desc="用条件规则拼出入场出场条件，或者直接写代码"
          action={!strategies.length ? <Button variant="primary" onClick={onNew} disabled={creating}>新建策略</Button> : undefined} />
      ) : (
        <div className="sg-table" role="table" aria-label="策略库">
          <div className="sg-row sg-th" role="row"><span>策略</span><span>模式</span><span>标的</span><span>周期</span><span>方向</span><span>最近回测</span><span>更新</span></div>
          {rows.map((s) => {
            const done = latestOf(s.id, backtests, true)
            const live = latestOf(s.id, backtests)
            return (
              <div key={s.id} className="sg-row" role="row" tabIndex={0} onClick={() => onOpen(s.id)} onKeyDown={(e) => { if (e.key === 'Enter') onOpen(s.id) }}>
                <span className="sg-main">
                  <span className="sg-title ellipsis">{s.name || '未命名策略'}</span>
                  <span className="sg-meta ellipsis">{s.desc || '没有说明'}</span>
                </span>
                <span><span className={cls('tag', s.mode === 'code' && 'sg-tag-code')}>{MODE_LABEL[s.mode]}</span></span>
                <SymTags symbols={s.symbols} empty="未选标的" />
                <span className="sg-muted">{intervalLabel(s.interval)}</span>
                <span className="sg-muted">{DIR_LABEL[s.direction]}</span>
                <span className="sg-last">
                  {live && (live.status === 'running' || live.status === 'queued') ? (
                    live.status === 'running' ? <ProgressBar p={live.progress} /> : <Pill {...BT_STATUS.queued} />
                  ) : done?.stats ? (
                    <>
                      <Signed x={done.stats.total_return} />
                      <span className="sg-last-sub sg-num">回撤 {pctRaw(done.stats.max_dd)} · 夏普 {done.stats.sharpe.toFixed(2)}</span>
                    </>
                  ) : <span className="faint">未回测</span>}
                </span>
                <span className="sg-muted">{timeAgo(s.updated_at, now)}</span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
