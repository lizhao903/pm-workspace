// 策略的运行记录（SPEC-strategy-5.10、5.11、5.15，SPEC-strategy-8）：每次部署到模拟盘算一次运行，停了也留着。
// 这里只看，启停到「交易 / 策略运行」里做。数据来自 GET /api/trade/runs（?strategy_id= 只取一个策略的）。
import { useState } from 'react'
import {
  QueryState, useTradeAccounts, useTradeRuns,
  type TradeAccount, type TradeRun, type TradeRunStatus, type TradeStrategy,
} from '../../core/data'
import { Button, EmptyState, PageTitle, Pill, SearchSelect, cls } from '../../core/ui'
import { instName, money, timeAgo, tone } from './strategyModel'
import { RUN_STATUS, runDuration } from './tradingModel'

const ORDER: Record<TradeRunStatus, number> = { error: 0, running: 1, paused: 2, stopped: 3 }
const signedMoney = (x: number) => `${x > 0 ? '+' : ''}${money(x, 2)}`
const endOf = (r: TradeRun) => (r.status === 'stopped' ? r.stopped_at ?? r.logs[r.logs.length - 1]?.at : undefined)

/** 编辑页侧栏：这个策略跑过几次、现在在不在跑、累计盈亏 */
export function StrategyRunsPanel({ st, onOpenAll, onDeploy }: { st: TradeStrategy; onOpenAll: () => void; onDeploy: () => void }) {
  const runs = useTradeRuns(st.id)
  const accounts = useTradeAccounts()
  const mine = [...(runs.data?.data ?? [])].sort((a, b) => b.started_at.localeCompare(a.started_at))
  const live = mine.filter((r) => r.status === 'running' || r.status === 'paused')
  const total = mine.reduce((n, r) => n + r.pnl, 0)
  return (
    <section className="sg-sec" aria-label="运行记录">
      <div className="sg-sec-head">
        <span className="sg-sec-title">运行记录</span>
        <span className="spacer" />
        {mine.length > 0 && <button type="button" className="sg-link" onClick={onOpenAll}>全部 {mine.length} 次</button>}
      </div>
      <QueryState query={runs} compact errorTitle="运行记录没取到">
        {() => !mine.length ? (
          <div className="sg-empty-box">还没部署过。回测满意后点「部署」，到模拟盘跑起来，记录会出现在这里。<button type="button" className="sg-link" onClick={onDeploy}>部署</button></div>
        ) : (
          <>
            <div className="sg-mini sr-mini3">
              <div><span className="sg-stat-label">运行中</span><span className="sg-num">{live.length}</span></div>
              <div><span className="sg-stat-label">累计盈亏</span><span className="sg-num" style={{ color: tone(total) }}>{signedMoney(total)}</span></div>
              <div><span className="sg-stat-label">出过异常</span><span className="sg-num">{mine.filter((r) => r.status === 'error').length}</span></div>
            </div>
            <div className="sr-mini-list">
              {mine.slice(0, 4).map((r) => (
                <button key={r.id} type="button" className="sr-mini" onClick={onOpenAll}>
                  <Pill {...RUN_STATUS[r.status]} />
                  <span className="ellipsis">{accounts.data?.find((a) => a.id === r.account_id)?.name ?? '已删除的账户'}</span>
                  <span className="spacer" />
                  <span className="sg-num" style={{ color: tone(r.pnl) }}>{signedMoney(r.pnl)}</span>
                </button>
              ))}
            </div>
          </>
        )}
      </QueryState>
    </section>
  )
}

/** 全部运行记录（SPEC-strategy-8） */
export function StrategyRunsPage({ strategies, now, onOpenStrategy, onManage, onToList }: {
  strategies: TradeStrategy[]; now: number
  onOpenStrategy: (id: string) => void
  /** 到交易「策略运行」里启停 */
  onManage: () => void
  onToList: () => void
}) {
  const runs = useTradeRuns()
  const accounts = useTradeAccounts()
  return (
    <QueryState query={runs} errorTitle="运行记录没取到">
      {(pg) => <RunsList runs={pg.data} accounts={accounts.data ?? []} strategies={strategies} now={now} onOpenStrategy={onOpenStrategy} onManage={onManage} onToList={onToList} />}
    </QueryState>
  )
}

function RunsList({ runs, accounts, strategies, now, onOpenStrategy, onManage, onToList }: {
  runs: TradeRun[]; accounts: TradeAccount[]; strategies: TradeStrategy[]; now: number
  onOpenStrategy: (id: string) => void; onManage: () => void; onToList: () => void
}) {
  const [stf, setStf] = useState('')
  const [status, setStatus] = useState<'' | TradeRunStatus>('')
  const [open, setOpen] = useState<string | null>(null)
  const [showStopped, setShowStopped] = useState(false)
  const accOf = (r: TradeRun) => accounts.find((a) => a.id === r.account_id)
  const rows = runs
    .filter((r) => (!stf || r.strategy_id === stf) && (!status || r.status === status))
    .sort((a, b) => ORDER[a.status] - ORDER[b.status] || b.started_at.localeCompare(a.started_at))
  const stoppedN = rows.filter((r) => r.status === 'stopped').length
  const foldStopped = status !== 'stopped' && !showStopped
  const shown = foldStopped ? rows.filter((r) => r.status !== 'stopped') : rows
  const total = rows.reduce((n, r) => n + r.pnl, 0)
  const sids = [...new Set(runs.map((r) => r.strategy_id))]
  const stName = (id: string) => strategies.find((s) => s.id === id)?.name || runs.find((r) => r.strategy_id === id)?.strategy_name || '已删除的策略'

  return (
    <div className="sg-page">
      <PageTitle parent="策略" count={runs.length} desc="每次部署到模拟盘算一次运行，停了的也留着；启停到「交易 / 策略运行」里操作">运行记录</PageTitle>

      <div className="sr-stats">
        <div className="bt-stat"><div className="sg-stat-label">运行中</div><div className="bt-stat-value sr-ok">{runs.filter((r) => r.status === 'running').length}</div></div>
        <div className="bt-stat"><div className="sg-stat-label">异常</div><div className={cls('bt-stat-value', runs.some((r) => r.status === 'error') && 'danger-text')}>{runs.filter((r) => r.status === 'error').length}</div></div>
        <div className="bt-stat"><div className="sg-stat-label">筛选结果累计盈亏</div><div className="bt-stat-value sg-num" style={{ color: tone(total) }}>{signedMoney(total)}</div></div>
        <div className="bt-stat"><div className="sg-stat-label">模拟盘</div><div className="bt-stat-value">{runs.length}</div></div>
      </div>

      <div className="sg-toolbar">
        <SearchSelect value={stf} noneLabel="全部策略" placeholder="全部策略" searchPlaceholder="搜策略名" aria-label="按策略筛" onChange={(v: string) => setStf(v)} missingLabel={() => '已删除的策略'}
          options={sids.map((id) => ({ value: id, label: stName(id), hint: `${runs.filter((r) => r.strategy_id === id).length} 次` }))} />
        <SearchSelect value={status} noneLabel="全部状态" placeholder="全部状态" aria-label="按状态筛" onChange={(v: string) => setStatus(v as typeof status)}
          options={(Object.keys(RUN_STATUS) as TradeRunStatus[]).map((k) => ({ value: k, label: RUN_STATUS[k].label }))} />
      </div>

      {!rows.length ? (
        <EmptyState title="没有运行记录" desc="在策略里点「部署」，跑起来之后这里会有记录" action={!runs.length ? <Button variant="primary" onClick={onToList}>去策略库部署</Button> : undefined} />
      ) : (
        <>
          {shown.length > 0 && (
            <div className="sr-list">
              {shown.map((r) => {
                const acc = accOf(r)
                const end = endOf(r)
                const expanded = open === r.id
                const alive = strategies.some((s) => s.id === r.strategy_id)
                return (
                  <div key={r.id} className={cls('sr-row', expanded && 'on', r.status === 'error' && 'sr-bad')}>
                    <button type="button" className="sr-head" aria-expanded={expanded} onClick={() => setOpen(expanded ? null : r.id)}>
                      <Pill {...RUN_STATUS[r.status]} />
                      <span className="sr-main">
                        <b className="ellipsis">{r.strategy_name || stName(r.strategy_id)}</b>
                        <span className="sg-meta ellipsis">{acc?.name ?? '已删除的账户'}{acc && <span className="tag sr-tag">模拟盘</span>} · {r.symbols.map(instName).join('、')}</span>
                      </span>
                      <span className="sr-cell"><span className="sg-stat-label">资金</span><span className="sg-num">{money(r.capital)}</span></span>
                      <span className="sr-cell"><span className="sg-stat-label">盈亏</span><span className="sg-num" style={{ color: tone(r.pnl) }}>{signedMoney(r.pnl)} <small>{r.capital ? ((r.pnl / r.capital) * 100).toFixed(2) : '0.00'}%</small></span></span>
                      <span className="sr-cell"><span className="sg-stat-label">{end ? '跑了' : '已运行'}</span><span className="sg-num">{runDuration(r.started_at, end, now)}</span></span>
                      <span className="sr-cell sr-when"><span className="sg-stat-label">启动</span><span className="sg-muted">{timeAgo(r.started_at, now)}</span></span>
                    </button>
                    {expanded && (
                      <div className="sr-body">
                        {r.error && <div className="sg-alert"><span>{r.error}</span></div>}
                        {r.stop_reason && <div className="sg-muted">停止原因：{r.stop_reason}</div>}
                        <div className="sg-muted">参数：{Object.entries(r.params).map(([k, v]) => `${k} = ${v}`).join('，') || '无'}</div>
                        <ol className="sr-logs">
                          {[...r.logs].reverse().map((l, i) => (
                            <li key={`${l.at}-${i}`} className={`sr-log-${l.level}`}><span className="sg-muted">{new Date(l.at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>{l.text}</li>
                          ))}
                        </ol>
                        {r.log_total > r.logs.length && <div className="faint sg-small">只列最近 {r.logs.length} 条，共 {r.log_total} 条；全部日志到交易里看</div>}
                        <div className="sg-act-row">
                          <button type="button" className="sg-act" disabled={!alive} title={alive ? undefined : '策略已经删除'} onClick={() => onOpenStrategy(r.strategy_id)}>打开策略</button>
                          {r.status !== 'stopped' && <button type="button" className="sg-act sg-act-primary" onClick={onManage}>到交易里管理</button>}
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
          {stoppedN > 0 && status !== 'stopped' && (
            <button type="button" className="sg-link sg-more" onClick={() => setShowStopped(!showStopped)}>{showStopped ? '收起已停止的' : `已停止 ${stoppedN} 个`}</button>
          )}
        </>
      )}
    </div>
  )
}
