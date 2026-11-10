// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 盯盘页（TRD-03b）：市场时段、盯盘墙、提醒规则、触发记录、提醒抽屉。
// 交互照原型 web-next/src/monitor.tsx（MonitorPage、SessionCards、Wall、RulesPanel、EventsPanel、AlertDrawer），规格 web-next/docs/spec/monitor.md。
// 判定只在后端（TRD-03a，每 2 秒一轮，页面关着也提醒）：规则的「当前值」取后端上一轮算的，触发记录随 trade.alert_fired 实时刷新，
// 前端不自己判定。盯盘墙的价格走行情推送（/api/trade/stream），迷你分时是 1 分钟 K 线，没有行情源的市场照实写「未接行情源」。
import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import {
  errorText, useRearmTradeAlert, usePatchTradeAlert, useReadTradeAlertEvents, useTradeAlertEvents, useTradeAlertFired, useTradeAlertValues, useTradeAlerts,
  useTradeInstrumentMap, useTradeKlines, useTradeLive, useTradeWatchlists,
  type TradeAlert, type TradeAlertEvent, type TradeAlertFired, type TradeAlertValue, type TradeInstrument, type TradeQuote, type TradeWatchlist,
} from '../../core/data'
import { Button, ErrorState, IconClose, IconSearch, LoadingState, PageTitle, SearchSelect, Switch, cls } from '../../core/ui'
import './markets.css'
import './monitor.css'
import { AlertDrawer } from './MonitorDrawer'
import { useImConnectors } from './useImConnectors'
import { DOWN, MARKETS, UP, digitsFor, fmtPct, fmtPrice, guessInstrument, toBars, withLive } from './model'
import {
  ALERT_COND, MARKET_TZ, NOTIFY_LABEL, RULE_FILTERS, SESSION_LABEL, condFits, dayLabel, fmtAlertValue, fmtSessionSpan, fmtThreshold, isPriceCond,
  ruleIn, ruleMatches, sessionOf, sessionPlan, timeAgo, type RuleFilter, type SessionState,
} from './monitorModel'

const ANOMALY = 0.01
const RULE_PAGE = 50
const EV_FIRST = 20
const EV_STEP = 50
const PREFS_KEY = 'pmw.trade.monitor'

function useNow(ms = 1000) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(t)
  }, [ms])
  return now
}

/** 盯盘墙选的自选组和网格大小，按浏览器记住（只是偏好，读不到就用默认） */
function usePrefs() {
  const [p, setP] = useState<{ wl: string; size: 2 | 3 | 4 }>(() => {
    try {
      const v = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as { wl?: string; size?: number }
      return { wl: typeof v.wl === 'string' ? v.wl : '', size: v.size === 2 || v.size === 4 ? v.size : 3 }
    } catch {
      return { wl: '', size: 3 }
    }
  })
  const save = (next: Partial<typeof p>) => setP((x) => {
    const v = { ...x, ...next }
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(v)) } catch { /* 存不了就算了 */ }
    return v
  })
  return [p, save] as const
}

/** 提醒触发时响一声（规则选了「声音」时）；浏览器不让放就算了 */
function beep() {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctx) return
    const ctx = new Ctx()
    const o = ctx.createOscillator()
    const g = ctx.createGain()
    o.frequency.value = 880
    g.gain.setValueAtTime(0.0001, ctx.currentTime)
    g.gain.exponentialRampToValueAtTime(0.2, ctx.currentTime + 0.02)
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.4)
    o.connect(g).connect(ctx.destination)
    o.start()
    o.stop(ctx.currentTime + 0.42)
    o.onended = () => void ctx.close()
  } catch {
    // 没有声音设备或被浏览器拦了
  }
}

const instOf = (map: Record<string, TradeInstrument>, s: string) => map[s] ?? guessInstrument(s)

/* ---------- 市场时段 ---------- */

const SESSION_COLOR: Record<SessionState, string> = { open: 'var(--ok)', pre: 'var(--warn)', post: 'var(--warn)', break: 'var(--warn)', closed: 'var(--faint)' }
const SessionPill = ({ s }: { s: SessionState }) => <span className="mo-pill" style={{ '--c': SESSION_COLOR[s] } as React.CSSProperties}><i />{SESSION_LABEL[s]}</span>

function SessionCards() {
  const now = useNow(1000)
  const minute = Math.floor(now / 60000) * 60000
  const plans = useMemo(() => (['cn', 'hk', 'us'] as const).map((m) => [m, sessionPlan(m, minute)] as const), [minute])
  const clock = (tz?: string) => new Intl.DateTimeFormat('zh-CN', { timeZone: tz, hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(now))
  const localTz = Intl.DateTimeFormat().resolvedOptions().timeZone
  return (
    <div className="mo-sessions">
      <div className="mo-sess mo-sess-local">
        <div className="mo-sess-head"><span className="mo-sess-name">本机时间</span></div>
        <div className="mo-sess-clock">{clock()}</div>
        <div className="mo-sess-sub ellipsis">{localTz}</div>
      </div>
      <div className="mo-sess">
        <div className="mo-sess-head"><span className="mk-dot" style={{ background: MARKETS.crypto.color }} /><span className="mo-sess-name">{MARKETS.crypto.label}</span><span className="spacer" /><SessionPill s="open" /></div>
        <div className="mo-sess-clock">{clock('UTC')}<span className="mo-sess-tz">UTC</span></div>
        <div className="mo-sess-sub">7x24 不休市</div>
      </div>
      {plans.map(([m, p]) => {
        const s = sessionOf(m, now)
        const text = s === 'open'
          ? p.change ? `距${p.change.s === 'break' ? '午休' : '收盘'} ${fmtSessionSpan(p.change.at - now)}` : ''
          : p.open ? `距开盘 ${fmtSessionSpan(p.open - now)}` : ''
        return (
          <div key={m} className="mo-sess">
            <div className="mo-sess-head"><span className="mk-dot" style={{ background: MARKETS[m].color }} /><span className="mo-sess-name">{MARKETS[m].label}</span><span className="spacer" /><SessionPill s={s} /></div>
            <div className="mo-sess-clock">{clock(MARKET_TZ[m].tz)}<span className="mo-sess-tz">{MARKET_TZ[m].city}</span></div>
            <div className="mo-sess-sub">{text}</div>
          </div>
        )
      })}
    </div>
  )
}

/* ---------- 盯盘墙 ---------- */

function WallCell({ symbol, inst, quote, onOpen }: { symbol: string; inst: TradeInstrument; quote: TradeQuote | undefined; onOpen: () => void }) {
  const kq = useTradeKlines(symbol, '1m', 120)
  const bars = useMemo(() => withLive(toBars(kq.data?.data ?? []), quote, '1m'), [kq.data, quote])
  const status = quote?.status ?? 'loading'
  const noSource = status === 'no_source' || kq.data?.meta.status === 'no_source'
  const has = !!quote && quote.last > 0
  const last = has ? quote.last : bars[bars.length - 1]?.c ?? 0
  const digits = digitsFor(inst.digits >= 0 ? inst : undefined, last)
  const pct = quote?.change_pct ?? 0
  const p5 = bars.length > 5 ? bars[bars.length - 6].c : 0
  const d5 = p5 && last ? (last - p5) / p5 : 0
  const stopped = status === 'stale' || status === 'error'
  const hot = !stopped && has && Math.abs(d5) >= ANOMALY
  const color = pct >= 0 ? UP : DOWN
  const pts = bars.map((b) => b.c)
  const lo = Math.min(...pts), hi = Math.max(...pts), span = hi - lo || 1
  const path = pts.length > 1 ? pts.map((p, k) => `${k ? 'L' : 'M'}${((k / (pts.length - 1)) * 120).toFixed(2)},${(38 - ((p - lo) / span) * 34).toFixed(2)}`).join('') : ''
  return (
    <button className={cls('mo-cell', hot && 'mo-cell-hot', stopped && 'mo-cell-stopped')} onClick={onOpen} title="打开图表">
      <div className="mo-cell-head">
        <span className="mk-dot" style={{ background: MARKETS[inst.market].color }} />
        <span className="mo-cell-name ellipsis">{inst.name}</span>
        {hot && <span className="mo-hot-tag">异动 {fmtPct(d5)} / 5 分</span>}
        {stopped && <span className="mo-stop-tag" title={quote?.error}>行情已停</span>}
      </div>
      {noSource ? (
        <div className="mo-cell-na">未接行情源</div>
      ) : (
        <>
          <div className="mo-cell-px">
            <span className="mo-cell-last" style={{ color: has ? color : undefined }}>{has ? fmtPrice(last, digits) : '-'}</span>
            {has && <span className="mo-cell-pct" style={{ color }}>{fmtPct(pct)}</span>}
          </div>
          <svg className="mo-spark" viewBox="0 0 120 40" preserveAspectRatio="none" aria-hidden="true">
            {path && <path d={`${path}L120,40L0,40Z`} style={{ fill: color, opacity: 0.08 }} />}
            {path && <path d={path} fill="none" style={{ stroke: color }} strokeWidth="1.4" vectorEffect="non-scaling-stroke" />}
          </svg>
        </>
      )}
    </button>
  )
}

function Wall({ wl, size, insts, onOpenChart }: { wl: TradeWatchlist; size: 2 | 3 | 4; insts: Record<string, TradeInstrument>; onOpenChart: (s: string) => void }) {
  const cells = useMemo(() => wl.symbols.slice(0, size * size), [wl.symbols, size])
  const live = useTradeLive(cells, '')
  return (
    <div className={cls('mo-wall', `mo-wall-${size}`)}>
      {Array.from({ length: size * size }, (_, k) => cells[k]
        ? <WallCell key={cells[k]} symbol={cells[k]} inst={instOf(insts, cells[k])} quote={live.quotes[cells[k]]} onOpen={() => onOpenChart(cells[k])} />
        : <div key={`e${k}`} className="mo-cell mo-cell-empty">空位</div>)}
    </div>
  )
}

/* ---------- 提醒规则 ---------- */

const VALUE_SHORT: Record<string, string> = { no_source: '未接行情源', loading: '加载中', stale: '行情已停', error: '取不到', unavailable: '取不到', unsupported: '-' }

function CurValue({ a, v, digits }: { a: TradeAlert; v: TradeAlertValue | undefined; digits: number }) {
  if (!a.enabled) return <span className="mo-r-cur faint">-</span>
  if (!v) return <span className="mo-r-cur faint">加载中</span>
  if (v.status === 'ok' && v.value !== null) return <span className="mo-r-cur">{fmtAlertValue(a.cond, v.value, digits)}</span>
  return <span className="mo-r-cur faint" title={v.error}>{VALUE_SHORT[v.status] ?? '-'}</span>
}

const AlertRow = memo(function AlertRow({ a, inst, v, sel, imName, onOpen, onToggle, onRearm }: {
  a: TradeAlert; inst: TradeInstrument; v: TradeAlertValue | undefined; sel: boolean; imName?: string
  onOpen: (a: TradeAlert) => void
  onToggle: (a: TradeAlert, on: boolean) => void
  onRearm: (a: TradeAlert) => void
}) {
  const fits = condFits(a.cond, inst)
  const spent = !a.repeat && !!a.last_fired_at
  const digits = digitsFor(inst.digits >= 0 ? inst : undefined, v?.price || a.value)
  return (
    <div className={cls('mo-rrow', !a.enabled && 'is-off', sel && 'sel')} onClick={() => onOpen(a)} role="row">
      <span className="mo-r-sym">
        <span className="mo-r-name"><span className="mk-dot" style={{ background: MARKETS[inst.market].color }} /><span className="ellipsis">{inst.name}</span></span>
        {a.note && <span className="mo-r-note ellipsis">{a.note}</span>}
      </span>
      <span className="mo-r-cond">{ALERT_COND[a.cond].label} <b>{fmtThreshold(a, digits)}</b> <span className="faint">{isPriceCond(a.cond) ? '' : ALERT_COND[a.cond].unit}</span>{!fits && <span className="mo-bad">不适用</span>}</span>
      <CurValue a={a} v={v} digits={digits} />
      <span className="mo-r-notify">{a.notify.map((n) => <span key={n} className="tag">{n === 'im' ? `IM${imName ? `：${imName}` : ''}` : NOTIFY_LABEL[n]}</span>)}</span>
      <span className="mo-r-rep">{a.repeat ? `重复 · 冷却 ${a.cooldown_min} 分` : '单次'}</span>
      <span className="mo-r-last">
        {a.last_fired_at ? <span title={new Date(a.last_fired_at).toLocaleString('zh-CN')}>{timeAgo(a.last_fired_at)}</span> : <span className="faint">未触发</span>}
        {spent && <button className="mo-rearm" onClick={(e) => { e.stopPropagation(); onRearm(a) }} title="单次提醒已经响过，清掉触发记录重新检查">重新上膛</button>}
      </span>
      <span className="mo-r-sw" onClick={(e) => e.stopPropagation()}>
        <Switch aria-label={a.enabled ? '停用' : '启用'} title={a.enabled ? '停用' : '启用'} checked={a.enabled} onCheckedChange={(on) => onToggle(a, on)} />
      </span>
    </div>
  )
})

function RulesPanel({ alerts, insts, values, selId, imNames, onOpen, onNew }: {
  alerts: TradeAlert[]; insts: Record<string, TradeInstrument>; values: Record<string, TradeAlertValue>; selId: string | null
  imNames: Record<string, string>
  onOpen: (a: TradeAlert) => void
  onNew: () => void
}) {
  const [f, setF] = useState<RuleFilter>('all')
  const [q, setQ] = useState('')
  const [limit, setLimit] = useState(RULE_PAGE)
  const [err, setErr] = useState('')
  const patch = usePatchTradeAlert()
  const rearm = useRearmTradeAlert()
  const rows = useMemo(() => alerts.filter((a) => ruleIn(a, f) && ruleMatches(a, instOf(insts, a.symbol).name, q)), [alerts, f, q, insts])
  const shown = rows.slice(0, limit)
  const live = useRef({ patch, rearm })
  useEffect(() => { live.current = { patch, rearm } })
  const onToggle = useCallback((a: TradeAlert, on: boolean) => {
    setErr('')
    live.current.patch.mutate({ id: a.id, enabled: on }, { onError: (e) => setErr(`${a.symbol}：${errorText(e)}`) })
  }, [])
  const onRearm = useCallback((a: TradeAlert) => {
    setErr('')
    live.current.rearm.mutate(a.id, { onError: (e) => setErr(`${a.symbol}：${errorText(e)}`) })
  }, [])
  const setFilter = (k: RuleFilter) => { setF(k); setLimit(RULE_PAGE) }
  return (
    <section className="mo-section mo-rules">
      <div className="mo-toolbar"><span className="mo-h">提醒规则</span><span className="list-count">{alerts.length}</span><span className="spacer" /><Button size="sm" onClick={onNew}>新建提醒</Button></div>
      {err && <div className="field-err mo-err" role="alert">{err}</div>}
      {!alerts.length ? <div className="mk-empty">还没有提醒。价格上穿下穿、涨跌幅、放量、资金费率、隐含波动率、接近涨跌停都能盯</div> : (
        <>
          <div className="mo-toolbar mo-rules-bar">
            <div className="mk-seg mk-seg-sm">
              {RULE_FILTERS.map(([k, l]) => <button key={k} className={cls(f === k && 'on')} onClick={() => setFilter(k)}>{l}<span className="seg-n">{alerts.filter((a) => ruleIn(a, k)).length}</span></button>)}
            </div>
            <span className="spacer" />
            <div className="search search-sm mo-rules-search">
              <IconSearch size={13} />
              <input placeholder="搜标的、代码、备注" aria-label="搜提醒" value={q} onChange={(e) => { setQ(e.target.value); setLimit(RULE_PAGE) }}
                onKeyDown={(e) => { if (e.key === 'Escape' && q) { e.stopPropagation(); setQ('') } }} />
              {q && <button className="search-clear" title="清空" aria-label="清空" onClick={() => setQ('')}><IconClose size={10} /></button>}
            </div>
          </div>
          {!rows.length ? <div className="mk-empty">没有匹配的提醒</div> : (
            <div className="mo-table" role="table">
              <div className="mo-rrow mo-th" role="row"><span>标的</span><span>条件</span><span>当前值</span><span>通知</span><span>触发方式</span><span>上次触发</span><span>启用</span></div>
              {shown.map((a) => (
                <AlertRow key={a.id} a={a} inst={instOf(insts, a.symbol)} v={values[a.id]} sel={selId === a.id}
                  imName={a.notify.includes('im') ? imNames[a.im_connector] : undefined} onOpen={onOpen} onToggle={onToggle} onRearm={onRearm} />
              ))}
            </div>
          )}
          {rows.length > limit && <button className="mo-more" onClick={() => setLimit(limit + RULE_PAGE)}>再显示 {Math.min(RULE_PAGE, rows.length - limit)} 条<span className="faint">（共 {rows.length} 条）</span></button>}
        </>
      )}
    </section>
  )
}

/* ---------- 触发记录 ---------- */

const EventsPanel = memo(function EventsPanel({ insts, onOpenChart }: { insts: Record<string, TradeInstrument>; onOpenChart: (s: string) => void }) {
  const [limit, setLimit] = useState(EV_FIRST)
  const q = useTradeAlertEvents(limit)
  const read = useReadTradeAlertEvents()
  const events = q.data?.data ?? []
  const total = q.data?.total ?? 0
  const unread = q.data?.unread ?? 0
  const rest = total - events.length
  const open = (e: TradeAlertEvent) => {
    if (!e.read) read.mutate([e.id])
    onOpenChart(e.symbol)
  }
  return (
    <section className="mo-section mo-events">
      <div className="mo-toolbar">
        <span className="mo-h">触发记录</span>{unread > 0 && <span className="mo-unread">{unread} 条未读</span>}
        <span className="spacer" />
        <Button size="sm" disabled={!unread || read.isPending} onClick={() => read.mutate(undefined)}>全部已读</Button>
      </div>
      {q.isLoading ? <LoadingState /> : q.isError && !q.data ? <ErrorState title="触发记录读不出来" error={q.error} onRetry={() => void q.refetch()} /> : !events.length ? <div className="mk-empty">提醒触发后记在这里</div> : (
        <ol className="mo-timeline">
          {events.map((e, k) => {
            const day = dayLabel(e.at)
            const i = instOf(insts, e.symbol)
            return (
              <Fragment key={e.id}>
                {(k === 0 || dayLabel(events[k - 1].at) !== day) && <li className="mo-ev-day">{day}</li>}
                <li className={cls('mo-ev', !e.read && 'unread')}>
                  <span className="mo-ev-dot" />
                  <button className="mo-ev-body" title="打开图表" onClick={() => open(e)}>
                    <span className="mo-ev-text">{e.text}</span>
                    {e.note && <span className="mo-ev-note">{e.note}</span>}
                    <span className="mo-ev-meta">
                      <span title={new Date(e.at).toLocaleString('zh-CN')}>{timeAgo(e.at)}</span>
                      <span>触发价 {fmtPrice(e.price, digitsFor(i.digits >= 0 ? i : undefined, e.price))}</span>
                      {e.im_status === 'unavailable' && <span className="mo-im-na" title={e.im_error}>IM 未推送</span>}
                      <span className="link">看图表</span>
                    </span>
                  </button>
                </li>
              </Fragment>
            )
          })}
        </ol>
      )}
      {rest > 0 && <button className="mo-more" onClick={() => setLimit(limit + EV_STEP)}>更早的 {rest} 条<span className="faint">（每次再显示 {Math.min(EV_STEP, rest)} 条）</span></button>}
    </section>
  )
})

/* ---------- 页面 ---------- */

export default function MonitorPage() {
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const wq = useTradeWatchlists()
  const aq = useTradeAlerts()
  const vq = useTradeAlertValues()
  const ims = useImConnectors()
  const [prefs, setPrefs] = usePrefs()
  // 行情页「设提醒」带 ?new=alert&symbol= 过来：打开时直接是新建抽屉，参数随后去掉（同一次只处理一次）
  const [drawer, setDrawer] = useState<{ id: string | null; symbol: string; key: number } | null>(() =>
    params.get('new') === 'alert' && params.get('symbol') ? { id: null, symbol: params.get('symbol') ?? '', key: Date.now() } : null)
  const watchlists = useMemo(() => wq.data ?? [], [wq.data])
  const alerts = useMemo(() => aq.data ?? [], [aq.data])
  const wl = watchlists.find((w) => w.id === prefs.wl) ?? watchlists[0]
  const size = prefs.size
  const symbols = useMemo(() => [...alerts.map((a) => a.symbol), ...(wl?.symbols.slice(0, size * size) ?? [])], [alerts, wl, size])
  const insts = useTradeInstrumentMap(symbols)
  const values = useMemo(() => Object.fromEntries((vq.data ?? []).map((v) => [v.alert_id, v])), [vq.data])
  const imNames = useMemo(() => Object.fromEntries(ims.map((c) => [c.id, c.name])), [ims])

  const hasReq = params.get('new') === 'alert'
  useEffect(() => {
    if (hasReq) setParams((p) => { p.delete('new'); p.delete('symbol'); return p }, { replace: true })
  }, [hasReq, setParams])

  useTradeAlertFired((e: TradeAlertFired) => { if (e.notify?.includes('sound')) beep() })

  const openChart = useCallback((s: string) => void navigate(`/markets?${new URLSearchParams({ symbol: s })}`), [navigate])
  const openRule = useCallback((a: TradeAlert) => setDrawer({ id: a.id, symbol: a.symbol, key: Date.now() }), [])
  const defaultSymbol = wl?.symbols[0] ?? 'BINANCE:BTCUSDT'
  const openNew = () => setDrawer({ id: null, symbol: defaultSymbol, key: Date.now() })
  const editing = drawer?.id ? alerts.find((a) => a.id === drawer.id) ?? null : null

  return (
    <section className="mo-page">
      <PageTitle count={`${alerts.filter((a) => a.enabled).length} 条提醒启用中`} desc="市场时段、盯盘墙、价格提醒和触发记录"
        actions={<Button variant="primary" onClick={openNew}>新建提醒</Button>}>盯盘</PageTitle>

      <SessionCards />

      <section className="mo-section">
        <div className="mo-toolbar">
          <span className="mo-h">盯盘墙</span>
          {wl && (
            <SearchSelect value={wl.id} onChange={(id) => { if (id) setPrefs({ wl: id }) }} searchPlaceholder="搜自选组" aria-label="自选组"
              options={watchlists.map((w) => ({ value: w.id, label: w.name, hint: `${w.symbols.length} 个` }))} />
          )}
          <div className="mk-seg mk-seg-sm">
            {([2, 3, 4] as const).map((n) => <button key={n} className={cls(size === n && 'on')} onClick={() => setPrefs({ size: n })}>{n}x{n}</button>)}
          </div>
          <span className="spacer" />
          <span className="faint mo-legend">5 分钟涨跌超过 1% 的格子会描边</span>
        </div>
        {wq.isLoading ? <LoadingState /> : !wl ? <div className="mk-empty">还没有自选组，到「行情」里建一个</div> : <Wall wl={wl} size={size} insts={insts} onOpenChart={openChart} />}
        {wl && wl.symbols.length > size * size && <div className="mo-sub">这组有 {wl.symbols.length} 个标的，只显示前 {size * size} 个，换更大的网格看全</div>}
      </section>

      <div className="mo-cols">
        {aq.isLoading ? <LoadingState /> : aq.isError && !aq.data
          ? <ErrorState title="提醒规则读不出来" error={aq.error} onRetry={() => void aq.refetch()} />
          : <RulesPanel alerts={alerts} insts={insts} values={values} selId={drawer?.id ?? null} imNames={imNames} onOpen={openRule} onNew={openNew} />}
        <EventsPanel insts={insts} onOpenChart={openChart} />
      </div>

      {drawer && (drawer.id === null || editing) && (
        <AlertDrawer key={drawer.key} alert={editing} symbol={drawer.symbol} onClose={() => setDrawer(null)} />
      )}
    </section>
  )
}
