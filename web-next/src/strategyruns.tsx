import { useState } from 'react'
import { PageTitle } from './topbar'
import { cls, timeAgo } from './ui'
import { RUN_STATUS, UP, DOWN, instOf, type RunStatus, type Strategy, type StrategyRun, type TradeAccount } from './tradedata'
import { SearchSelect } from './searchselect'

// 策略的运行记录：每次部署到实盘或模拟盘算一次运行，停了也留着，方便回看这个策略真实跑出来怎么样
// 运行本身在「交易 / 策略运行」里启停，这里只看

const tone = (x: number) => (x > 0 ? UP : x < 0 ? DOWN : 'var(--muted)')
const money = (x: number) => `${x > 0 ? '+' : ''}${x.toLocaleString('en-US', { maximumFractionDigits: 2 })}`
const dur = (from: string, to?: string) => {
  const d = ((to ? new Date(to).getTime() : Date.now()) - new Date(from).getTime()) / 86400000
  return d >= 1 ? `${Math.floor(d)} 天` : `${Math.max(1, Math.round(d * 24))} 小时`
}
const endOf = (r: StrategyRun) => (r.status === 'stopped' ? r.stopped_at ?? r.logs[r.logs.length - 1]?.at : undefined)

function RunPill({ s }: { s: RunStatus }) {
  return <span className="pill" style={{ '--c': RUN_STATUS[s].color } as React.CSSProperties}><span className="pill-dot" />{RUN_STATUS[s].label}</span>
}

/** 编辑页侧栏：这个策略跑过几次、现在在不在跑、累计盈亏 */
export function StrategyRunsPanel({ st, runs, accounts, onOpenAll, onDeploy }: {
  st: Strategy; runs: StrategyRun[]; accounts: TradeAccount[]
  onOpenAll: () => void; onDeploy: () => void
}) {
  const mine = runs.filter((r) => r.strategy_id === st.id).sort((a, b) => b.started_at.localeCompare(a.started_at))
  const live = mine.filter((r) => r.status === 'running' || r.status === 'paused')
  const total = mine.reduce((n, r) => n + r.pnl, 0)
  return (
    <section className="hook-sec">
      <div className="sg-sec-head">
        <span className="field-group-title">运行记录</span>
        <span className="spacer" />
        {mine.length > 0 && <button className="act act-quiet" onClick={onOpenAll}>全部 {mine.length} 次</button>}
      </div>
      {!mine.length ? (
        <div className="mount-empty">还没部署过。回测满意后点「部署」，到实盘或模拟盘跑起来，记录会出现在这里。<button className="link-btn" onClick={onDeploy}>部署</button></div>
      ) : (
        <>
          <div className="sg-mini">
            <div><span className="stat-label">运行中</span><span className="sg-num">{live.length}</span></div>
            <div><span className="stat-label">累计盈亏</span><span className="sg-num" style={{ color: tone(total) }}>{money(total)}</span></div>
            <div><span className="stat-label">出过异常</span><span className="sg-num">{mine.filter((r) => r.status === 'error').length}</span></div>
          </div>
          <div className="sr-mini-list">
            {mine.slice(0, 4).map((r) => {
              const acc = accounts.find((a) => a.id === r.account_id)
              return (
                <button key={r.id} className="sr-mini" onClick={onOpenAll}>
                  <RunPill s={r.status} />
                  <span className="ellipsis">{acc?.name ?? '已删除的账户'}{acc?.paper ? '' : ' · 实盘'}</span>
                  <span className="spacer" />
                  <span className="sg-num" style={{ color: tone(r.pnl) }}>{money(r.pnl)}</span>
                </button>
              )
            })}
          </div>
        </>
      )}
    </section>
  )
}

/** 全部运行记录 */
export function StrategyRunsPage({ runs, strategies, accounts, onOpenStrategy, onManage }: {
  runs: StrategyRun[]; strategies: Strategy[]; accounts: TradeAccount[]
  onOpenStrategy: (id: string) => void
  /** 到交易模块里启停这次运行 */
  onManage: (runId: string) => void
}) {
  const [stf, setStf] = useState('')
  const [status, setStatus] = useState<'' | RunStatus>('')
  const [kind, setKind] = useState<'' | 'live' | 'paper'>('')
  const [open, setOpen] = useState<string | null>(null)
  const [showStopped, setShowStopped] = useState(false)
  const accOf = (r: StrategyRun) => accounts.find((a) => a.id === r.account_id)
  // 异常、运行中、暂停的置顶；已停止的折叠成一行，点开再看
  const order: Record<RunStatus, number> = { error: 0, running: 1, paused: 2, stopped: 3 }
  const rows = runs
    .filter((r) => (!stf || r.strategy_id === stf) && (!status || r.status === status) && (!kind || (kind === 'paper') === !!accOf(r)?.paper))
    .sort((a, b) => order[a.status] - order[b.status] || b.started_at.localeCompare(a.started_at))
  const stoppedN = rows.filter((r) => r.status === 'stopped').length
  // 只筛已停止时直接展开
  const foldStopped = status !== 'stopped' && !showStopped
  const shown = foldStopped ? rows.filter((r) => r.status !== 'stopped') : rows
  const total = rows.reduce((n, r) => n + r.pnl, 0)
  const nowRunning = runs.filter((r) => r.status === 'running').length

  return (
    <div className="page page-fill">
      <PageTitle parent="策略" count={runs.length} desc="每次部署到实盘或模拟盘算一次运行，停了的也留着；启停到「交易 / 策略运行」里操作">运行记录</PageTitle>

      <div className="stats sr-stats">
        <div className="stat"><div className="stat-label">运行中</div><div className="stat-value stat-ok">{nowRunning}</div></div>
        <div className="stat"><div className="stat-label">异常</div><div className={cls('stat-value', runs.some((r) => r.status === 'error') && 'stat-danger')}>{runs.filter((r) => r.status === 'error').length}</div></div>
        <div className="stat"><div className="stat-label">筛选结果累计盈亏</div><div className="stat-value" style={{ color: tone(total) }}>{money(total)}</div></div>
        <div className="stat"><div className="stat-label">实盘 / 模拟</div><div className="stat-value">{runs.filter((r) => !accOf(r)?.paper).length} / {runs.filter((r) => accOf(r)?.paper).length}</div></div>
      </div>

      <div className="toolbar">
        <SearchSelect value={stf} noneLabel="全部策略" searchPlaceholder="搜策略名" onChange={setStf} missingLabel={() => '已删除的策略'}
          options={strategies.map((s) => ({ value: s.id, label: s.name || '未命名策略', hint: `${runs.filter((r) => r.strategy_id === s.id).length} 次`, keywords: s.tags.join(' ') }))} />
        <div className={cls('chip chip-select', status && 'chip-on')}>
          <select value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
            <option value="">全部状态</option>
            {(Object.keys(RUN_STATUS) as RunStatus[]).map((k) => <option key={k} value={k}>{RUN_STATUS[k].label}</option>)}
          </select>
        </div>
        <div className="seg seg-sm">
          {([['', '全部'], ['live', '实盘'], ['paper', '模拟盘']] as const).map(([k, l]) => <button key={k} className={cls(kind === k && 'on')} onClick={() => setKind(k)}>{l}</button>)}
        </div>
      </div>

      {!rows.length ? (
        <div className="empty"><div className="empty-title">没有运行记录</div><div className="muted">在策略里点「部署」，跑起来之后这里会有记录</div></div>
      ) : (
        <>
        {shown.length > 0 && <div className="sr-list">
          {shown.map((r) => {
            const st = strategies.find((s) => s.id === r.strategy_id)
            const acc = accOf(r)
            const end = endOf(r)
            const expanded = open === r.id
            return (
              <div key={r.id} className={cls('sr-row', expanded && 'on', r.status === 'error' && 'sr-bad')}>
                <button className="sr-head" onClick={() => setOpen(expanded ? null : r.id)}>
                  <RunPill s={r.status} />
                  <span className="sr-main">
                    <b className="ellipsis">{st?.name ?? '已删除的策略'}</b>
                    <span className="list-sub ellipsis">{acc?.name ?? '已删除的账户'}{acc && <span className={cls('tag', acc.paper ? '' : 'sr-live')}>{acc.paper ? '模拟盘' : '实盘'}</span>} · {r.symbols.map((s) => instOf(s)?.name ?? s).join('、')}</span>
                  </span>
                  <span className="sr-cell"><span className="stat-label">资金</span><span className="sg-num">{r.capital.toLocaleString()}</span></span>
                  <span className="sr-cell"><span className="stat-label">盈亏</span><span className="sg-num" style={{ color: tone(r.pnl) }}>{money(r.pnl)} <small>{((r.pnl / r.capital) * 100).toFixed(2)}%</small></span></span>
                  <span className="sr-cell"><span className="stat-label">{end ? '跑了' : '已运行'}</span><span className="sg-num">{dur(r.started_at, end)}</span></span>
                  <span className="sr-cell sr-when"><span className="stat-label">启动</span><span className="run-muted">{timeAgo(r.started_at)}</span></span>
                </button>
                {expanded && (
                  <div className="sr-body">
                    {r.error && <div className="detail-alert"><span>{r.error}</span></div>}
                    {r.stop_reason && <div className="list-sub">停止原因：{r.stop_reason}</div>}
                    <div className="sr-params">参数：{Object.entries(r.params).map(([k, v]) => `${k} = ${v}`).join('，') || '无'}</div>
                    <ol className="sr-logs">
                      {[...r.logs].reverse().map((l, i) => (
                        <li key={i} className={`sr-log-${l.level}`}><span className="run-muted">{new Date(l.at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>{l.text}</li>
                      ))}
                    </ol>
                    <div className="act-row">
                      {st && <button className="act" onClick={() => onOpenStrategy(st.id)}>打开策略</button>}
                      {r.status !== 'stopped' && <button className="act act-primary" onClick={() => onManage(r.id)}>到交易里管理</button>}
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>}
        {stoppedN > 0 && status !== 'stopped' && (
          <button className="act act-quiet sr-more" onClick={() => setShowStopped(!showStopped)}>{showStopped ? '收起已停止的' : `已停止 ${stoppedN} 个`}</button>
        )}
        </>
      )}
    </div>
  )
}
