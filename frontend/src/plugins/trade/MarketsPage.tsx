// 行情页（TRD-02b）：左自选、中 K 线、右盘口与数据源；另一个标签是期权（数据源未接）。
// 交互照原型 web-next/src/markets.tsx（MarketsPage、WatchPanel、KChart、SymbolHead、BookPanel、OptionBoard），规格 web-next/docs/spec/markets.md。
// 价格全部来自后端：实时价走 /api/trade/stream（连不上退回轮询），K 线走 /api/trade/klines。
// 交易所取不到时后端给缓存、标 stale，这里照实显示「缓存 · 数据时间」，价格停住不跳；没有行情源的市场显示「数据源未接」，不造价格。
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as RPointerEvent, type ReactNode } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import {
  useAddWatchlist, usePatchWatchlist, useRemoveWatchlist, useTradeInstrument, useTradeInstrumentSearch, useTradeKlines, useTradeLive,
  useTradeSources, useTradeWatchlists,
  type TradeBook, type TradeDataStatus, type TradeFunding, type TradeInstrument, type TradeInterval, type TradeLive, type TradeMarket,
  type TradeQuote, type TradeSource, type TradeWatchlist,
} from '../../core/data'
import { Button, EmptyState, IconButton, IconClose, IconSearch, LoadingState, PageTitle, SearchSelect, cls } from '../../core/ui'
import './markets.css'
import {
  DOWN, INTERVALS, KIND_SHORT, MARKETS, STATUS_LABEL, UP, boll, codeOf, digitsFor, fmtBarTime, fmtClock, fmtNum, fmtPct, fmtPrice, fmtSpan,
  fmtVol, guessInstrument, macd, rsi, signColor, sma, toBars, withLive, type Bar,
} from './model'

const VIEW = 140
const GROUP_CHIPS_MAX = 6
const DEFAULT_SYMBOLS = ['BINANCE:BTCUSDT', 'BINANCE:ETHUSDT', 'BINANCE:BTCUSDT.P', 'OKX:BTC-USDT-SWAP']

function useNow(ms = 1000) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(t)
  }, [ms])
  return now
}

function useSize<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(([e]) => setSize({ w: Math.floor(e.contentRect.width), h: Math.floor(e.contentRect.height) }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, size] as const
}

/** 标的静态信息：标的表里有就用，没有按 symbol 推 */
function useInst(symbol: string): TradeInstrument {
  const q = useTradeInstrument(symbol)
  return q.data ?? guessInstrument(symbol)
}

const Dot = ({ m }: { m: TradeMarket }) => <span className="mk-dot" style={{ background: MARKETS[m].color }} />
const KindTag = ({ i }: { i: TradeInstrument }) => (i.kind === 'spot' ? null : <span className="mk-kind">{KIND_SHORT[i.kind] ?? i.kind}</span>)

/** 数据状态点：实时、缓存、加载中、取不到、数据源未接 */
function StatusDot({ status, title }: { status: TradeDataStatus | 'unsupported'; title?: string }) {
  const s = status === 'unsupported' ? 'no_source' : status
  return <span className={cls('mk-st', `mk-st-${s}`)} title={title}><i />{STATUS_LABEL[s]}</span>
}

/* ---------- 左栏：自选 ---------- */

type MarketFilter = TradeMarket | 'all'

function WatchRow({ symbol, on, quote, filter, onPick, onRemove }: {
  symbol: string; on: boolean; quote?: TradeQuote; filter: MarketFilter; onPick: () => void; onRemove: () => void
}) {
  const i = useInst(symbol)
  if (filter !== 'all' && i.market !== filter) return null
  const has = !!quote && quote.last > 0 && (quote.status === 'live' || quote.status === 'stale')
  const digits = digitsFor(i, quote?.last ?? 0)
  return (
    <div role="button" tabIndex={0} className={cls('mk-row', on && 'on')} onClick={onPick} onKeyDown={(e) => { if (e.key === 'Enter') onPick() }}>
      <div className="mk-row-main">
        <span className="mk-row-name"><Dot m={i.market} /><span className="ellipsis">{i.name}</span><KindTag i={i} /></span>
        <span className="mk-row-sub"><span className="mk-code ellipsis">{codeOf(symbol)}</span>
          {quote?.status === 'stale' && <span className="mk-sess mk-sess-pre" title={quote.error}>缓存</span>}
        </span>
      </div>
      {has ? (
        <div className="mk-row-px">
          <span className="mk-row-last">{fmtPrice(quote.last, digits)}</span>
          <span className={cls('mk-row-pct', quote.status === 'stale' && 'is-stale')} style={{ background: quote.change_pct >= 0 ? UP : DOWN }}>{fmtPct(quote.change_pct)}</span>
        </div>
      ) : (
        <div className="mk-row-px">
          <span className="mk-na" title={quote?.error}>{quote ? STATUS_LABEL[quote.status] : STATUS_LABEL.loading}</span>
        </div>
      )}
      <button className="mk-row-x" title="移出自选" aria-label="移出自选" onClick={(e) => { e.stopPropagation(); onRemove() }}><IconClose size={10} /></button>
    </div>
  )
}

function WatchPanel({ watchlists, wl, setWlId, symbol, quotes, onPick }: {
  watchlists: TradeWatchlist[]
  wl: TradeWatchlist | undefined
  setWlId: (id: string) => void
  symbol: string
  quotes: Record<string, TradeQuote>
  onPick: (s: string) => void
}) {
  const [mf, setMf] = useState<MarketFilter>('all')
  const [q, setQ] = useState('')
  const [renaming, setRenaming] = useState<string | null>(null)
  const [name, setName] = useState('')
  const add = useAddWatchlist()
  const patch = usePatchWatchlist()
  const remove = useRemoveWatchlist()
  const search = useTradeInstrumentSearch(q)
  const results = (search.data ?? []).filter((i) => mf === 'all' || i.market === mf)

  const addSymbol = (s: string) => {
    if (!wl || wl.symbols.includes(s)) return
    patch.mutate({ id: wl.id, symbols: [...wl.symbols, s] })
    setQ('')
  }
  const removeSymbol = (s: string) => { if (wl) patch.mutate({ id: wl.id, symbols: wl.symbols.filter((x) => x !== s) }) }
  const newGroup = () => {
    const n = `新自选组 ${watchlists.length + 1}`
    add.mutate({ name: n }, { onSuccess: (w) => { setWlId(w.id); setRenaming(w.id); setName(n) } })
  }
  const commitName = () => {
    const id = renaming
    const n = name.trim()
    if (id && n) patch.mutate({ id, name: n })
    setRenaming(null)
  }
  const delGroup = () => {
    if (!wl || watchlists.length <= 1) return
    const rest = watchlists.filter((w) => w.id !== wl.id)
    remove.mutate(wl.id)
    setWlId(rest[0].id)
    setRenaming(null)
  }

  const many = watchlists.length > GROUP_CHIPS_MAX
  const chips = many ? watchlists.filter((w, k) => k < 3 || w.id === wl?.id) : watchlists

  if (!watchlists.length) {
    return (
      <div className="mk-watch">
        <div className="mk-empty">
          还没有自选组
          <div><Button variant="outline" size="sm" disabled={add.isPending} onClick={() => add.mutate({ name: '核心关注', symbols: DEFAULT_SYMBOLS }, { onSuccess: (w) => setWlId(w.id) })}>
            建一组：BTC、ETH 现货和永续
          </Button></div>
        </div>
      </div>
    )
  }

  return (
    <div className="mk-watch">
      <div className="mk-groups">
        {chips.map((w) => (
          <button key={w.id} className={cls('chip', w.id === wl?.id && 'chip-on')} onClick={() => setWlId(w.id)}
            onDoubleClick={() => { setRenaming(w.id); setName(w.name) }} title={`${w.name}（双击改名）`}>
            <span className="mk-group-name">{w.name}</span><span className="seg-n">{w.symbols.length}</span>
          </button>
        ))}
        {many && (
          <SearchSelect value="" placeholder={`全部 ${watchlists.length} 组`} searchPlaceholder="搜自选组" className="mk-group-more"
            options={watchlists.map((w) => ({ value: w.id, label: w.name, hint: `${w.symbols.length} 个` }))}
            onChange={(id) => { if (id) setWlId(id) }} />
        )}
        <IconButton size="sm" label="新建自选组" onClick={newGroup}>
          <svg viewBox="0 0 16 16" width="12" height="12"><path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
        </IconButton>
        {wl && (
          <IconButton size="sm" label="重命名当前组" onClick={() => { setRenaming(wl.id); setName(wl.name) }}>
            <svg viewBox="0 0 16 16" width="12" height="12"><path d="M3 13h2.5L13 5.5 10.5 3 3 10.5V13Z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" /></svg>
          </IconButton>
        )}
      </div>
      {renaming && (
        <div className="mk-rename">
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="自选组名称" aria-label="自选组名称"
            onKeyDown={(e) => { if (e.key === 'Enter') commitName(); if (e.key === 'Escape') setRenaming(null) }} />
          <Button variant="primary" size="sm" disabled={!name.trim()} onClick={commitName}>保存</Button>
          {watchlists.length > 1 && <Button size="sm" onClick={delGroup} title="删除这个自选组">删除组</Button>}
          <Button size="sm" onClick={() => setRenaming(null)}>取消</Button>
        </div>
      )}
      <div className="mk-seg mk-seg-sm mk-mf">
        {([['all', '全部'], ['crypto', '数币'], ['cn', 'A 股'], ['hk', '港股'], ['us', '美股']] as [MarketFilter, string][]).map(([k, l]) => (
          <button key={k} className={cls(mf === k && 'on')} onClick={() => setMf(k)}>{l}</button>
        ))}
      </div>
      <div className="mk-search-wrap">
        <div className="search search-sm">
          <IconSearch size={13} />
          <input placeholder="搜标的加入当前组" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') setQ('') }} />
          {q && <button className="search-clear" onClick={() => setQ('')} title="清空" aria-label="清空"><IconClose size={10} /></button>}
        </div>
        {q.trim() && (
          <div className="mk-results">
            {search.isLoading && <div className="mk-results-empty">搜索中</div>}
            {!search.isLoading && !results.length && <div className="mk-results-empty">没有匹配的标的（标的表每天从行情源同步一次）</div>}
            {results.map((i) => {
              const inList = !!wl?.symbols.includes(i.symbol)
              return (
                <button key={i.symbol} className="mk-result" disabled={inList} onClick={() => addSymbol(i.symbol)}>
                  <Dot m={i.market} />
                  <span className="mk-result-text"><span className="ellipsis">{i.name}</span><span className="mk-code ellipsis">{i.symbol} · {i.venue}</span></span>
                  <KindTag i={i} />
                  <span className={cls('mk-result-act', inList && 'faint')}>{inList ? '已在组内' : '添加'}</span>
                </button>
              )
            })}
          </div>
        )}
      </div>
      <div className="mk-list">
        {!wl?.symbols.length && <div className="mk-empty">这一组还是空的，上面搜一个加进来</div>}
        {wl?.symbols.map((s) => (
          <WatchRow key={s} symbol={s} on={s === symbol} quote={quotes[s]} filter={mf} onPick={() => onPick(s)} onRemove={() => removeSymbol(s)} />
        ))}
      </div>
    </div>
  )
}

/* ---------- 中间：标的头 ---------- */

const Item = ({ k, v, c }: { k: string; v: ReactNode; c?: string }) => (
  <span className="mk-hi"><span className="mk-hi-k">{k}</span><span className="mk-hi-v" style={c ? { color: c } : undefined}>{v}</span></span>
)

function SymbolHead({ i, quote, funding, now }: { i: TradeInstrument; quote?: TradeQuote; funding: TradeFunding | null; now: number }) {
  const id = (
    <div className="mk-head-id">
      <div className="mk-head-name"><Dot m={i.market} /><span className="ellipsis">{i.name}</span><KindTag i={i} /></div>
      <div className="mk-code">{i.symbol} · {i.venue} · {MARKETS[i.market].currency}</div>
    </div>
  )
  if (!quote || quote.status === 'no_source' || !(quote.last > 0)) {
    const st = quote?.status ?? 'loading'
    return (
      <div className="mk-head">
        {id}
        <div className="mk-head-na">
          <b>{st === 'no_source' ? '数据源未接' : st === 'error' ? '取不到行情' : '加载中'}</b>
          <span className="faint">{st === 'no_source' ? `${MARKETS[i.market].label}的行情源还没接，不显示价格` : quote?.error}</span>
        </div>
      </div>
    )
  }
  const d = digitsFor(i, quote.last)
  const color = quote.status === 'live' ? signColor(quote.change) : 'var(--muted)'
  const fr = funding && funding.status !== 'unsupported' && funding.status !== 'no_source' && funding.next_time ? funding : null
  return (
    <div className="mk-head">
      {id}
      <div className="mk-head-px">
        <span className="mk-last" style={{ color }}>{fmtPrice(quote.last, d)}</span>
        <span className="mk-chg" style={{ color }}>{quote.change >= 0 ? '+' : ''}{fmtPrice(quote.change, d)} {fmtPct(quote.change_pct)}</span>
      </div>
      <div className="mk-head-items">
        <Item k="24h 高" v={fmtPrice(quote.high_24h, d)} />
        <Item k="24h 低" v={fmtPrice(quote.low_24h, d)} />
        <Item k="24h 量" v={fmtVol(quote.volume_24h)} />
        <Item k="24h 开" v={fmtPrice(quote.open_24h, d)} />
        {i.kind === 'perp' && fr && <>
          <Item k="资金费率" v={`${fr.rate >= 0 ? '+' : ''}${(fr.rate * 100).toFixed(4)}%`} c={signColor(fr.rate)} />
          <Item k="下次结算" v={fmtSpan(new Date(fr.next_time).getTime() - now)} />
        </>}
        <span className="mk-hi">
          <span className="mk-hi-k">数据时间</span>
          <span className="mk-hi-v"><StatusDot status={quote.status} title={quote.error} /> {fmtClock(quote.at || quote.fetched_at, now)}</span>
        </span>
      </div>
    </div>
  )
}

/* ---------- 中间：K 线 ---------- */

type SubKind = 'vol' | 'macd' | 'rsi'
type Overlay = { ma5: boolean; ma20: boolean; ma60: boolean; boll: boolean }
const MA_COLOR = { ma5: '#e8a317', ma20: '#7a4fd6', ma60: '#0c8599' }
const BOLL_COLOR = '#8a8578'

function KChart({ data, digits, interval, ov, sub, msg }: { data: Bar[]; digits: number; interval: TradeInterval; ov: Overlay; sub: SubKind; msg?: ReactNode }) {
  const [wrapRef, { w, h }] = useSize<HTMLDivElement>()
  const [hover, setHover] = useState<{ i: number; y: number } | null>(null)
  const ind = useMemo(() => {
    const c = data.map((b) => b.c)
    return { ma5: sma(c, 5), ma20: sma(c, 20), ma60: sma(c, 60), boll: boll(c), macd: macd(c), rsi: rsi(c), vma: sma(data.map((b) => b.v), 5) }
  }, [data])
  const px = (p: number) => fmtPrice(p, digits)

  const off = Math.max(0, data.length - VIEW)
  const view = data.slice(off)
  const axisW = 66
  const timeH = 20
  const plotW = Math.max(10, w - axisW)
  const avail = Math.max(60, h - timeH)
  const mainH = Math.round(avail * 0.72)
  const cw = plotW / VIEW
  const bw = Math.max(1, Math.min(cw * 0.7, cw - 1))
  const x = (k: number) => (k + 0.5) * cw

  let lo = Infinity
  let hi = -Infinity
  view.forEach((b, k) => {
    lo = Math.min(lo, b.l)
    hi = Math.max(hi, b.h)
    const j = k + off
    for (const key of ['ma5', 'ma20', 'ma60'] as const) if (ov[key] && Number.isFinite(ind[key][j])) { lo = Math.min(lo, ind[key][j]); hi = Math.max(hi, ind[key][j]) }
    if (ov.boll && Number.isFinite(ind.boll.up[j])) { lo = Math.min(lo, ind.boll.low[j]); hi = Math.max(hi, ind.boll.up[j]) }
  })
  if (!Number.isFinite(lo)) { lo = 0; hi = 1 }
  const pad = (hi - lo) * 0.06 || hi * 0.001 || 1
  lo -= pad
  hi += pad
  const mTop = 22
  const mBot = mainH - 4
  const y = (p: number) => mBot - ((p - lo) / (hi - lo)) * (mBot - mTop)
  const yInv = (py: number) => lo + ((mBot - py) / (mBot - mTop)) * (hi - lo)

  const sTop = mainH + 20
  const sBot = avail - 2
  let slo = 0
  let shi = 1
  if (sub === 'vol') shi = Math.max(1e-9, ...view.map((b) => b.v))
  else if (sub === 'rsi') { slo = 0; shi = 100 }
  else {
    const vals = view.flatMap((_, k) => [ind.macd.dif[k + off], ind.macd.dea[k + off], ind.macd.hist[k + off]]).filter(Number.isFinite)
    const m = Math.max(1e-9, ...vals.map(Math.abs))
    slo = -m
    shi = m
  }
  const sy = (v: number) => sBot - ((v - slo) / (shi - slo || 1)) * (sBot - sTop)
  const syInv = (py: number) => slo + ((sBot - py) / (sBot - sTop)) * (shi - slo)
  const line = (arr: number[], f: (v: number) => number) => {
    let d = ''
    let pen = false
    view.forEach((_, k) => {
      const v = arr[k + off]
      if (!Number.isFinite(v)) { pen = false; return }
      d += `${pen ? 'L' : 'M'}${x(k).toFixed(1)},${f(v).toFixed(1)}`
      pen = true
    })
    return d
  }
  const onMove = (e: RPointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    const mx = e.clientX - r.left
    const my = e.clientY - r.top
    if (mx > plotW || my > avail) { setHover(null); return }
    setHover({ i: Math.max(0, Math.min(view.length - 1, Math.floor(mx / cw))), y: my })
  }

  const hi_ = hover && view[hover.i] ? hover.i : view.length - 1
  const cur = view[hi_]
  const prevBar = view[hi_ - 1] ?? data[off + hi_ - 1]
  const last = view[view.length - 1]
  const priceTicks = Array.from({ length: 5 }, (_, k) => lo + ((hi - lo) * (k + 0.5)) / 5)
  const labelEvery = Math.max(1, Math.ceil(110 / cw))
  const j = hi_ + off
  const lastColor = last && last.c >= last.o ? UP : DOWN

  return (
    <div className="mk-chart" ref={wrapRef}>
      {msg && <div className="mk-chart-msg">{msg}</div>}
      {!msg && w > 0 && h > 0 && cur && (
        <svg width={w} height={h} className="mk-svg" onPointerMove={onMove} onPointerLeave={() => setHover(null)} role="img" aria-label="K 线">
          {priceTicks.map((p) => (
            <g key={p}>
              <line x1={0} x2={plotW} y1={y(p)} y2={y(p)} className="mk-grid" />
              {(!last || Math.abs(y(p) - y(last.c)) > 14) && <text x={plotW + 6} y={y(p) + 4} className="mk-axis">{px(p)}</text>}
            </g>
          ))}
          <line x1={0} x2={w} y1={mainH} y2={mainH} className="mk-sep" />
          <line x1={plotW} x2={plotW} y1={0} y2={avail} className="mk-sep" />
          <line x1={0} x2={w} y1={avail} y2={avail} className="mk-sep" />
          {view.map((b, k) => ((k + off) % labelEvery === 0 && x(k) > 20 && x(k) < plotW - 30
            ? <g key={b.t}><line x1={x(k)} x2={x(k)} y1={0} y2={avail} className="mk-grid" /><text x={x(k)} y={h - 6} textAnchor="middle" className="mk-axis">{fmtBarTime(b.t, interval)}</text></g>
            : null))}
          {ov.boll && <>
            <path d={line(ind.boll.up, y)} fill="none" style={{ stroke: BOLL_COLOR }} strokeWidth="1" strokeDasharray="3 3" />
            <path d={line(ind.boll.mid, y)} fill="none" style={{ stroke: BOLL_COLOR }} strokeWidth="1" />
            <path d={line(ind.boll.low, y)} fill="none" style={{ stroke: BOLL_COLOR }} strokeWidth="1" strokeDasharray="3 3" />
          </>}
          {view.map((b, k) => {
            const up = b.c >= b.o
            const c = up ? UP : DOWN
            const top = y(Math.max(b.o, b.c))
            const bot = y(Math.min(b.o, b.c))
            return (
              <g key={b.t} style={{ stroke: c, fill: up ? 'var(--panel)' : c }}>
                <line x1={x(k)} x2={x(k)} y1={y(b.h)} y2={y(b.l)} strokeWidth="1" />
                <rect x={x(k) - bw / 2} y={top} width={bw} height={Math.max(1, bot - top)} strokeWidth={bw > 3 ? 1 : 0} style={bw <= 3 ? { fill: c } : undefined} />
              </g>
            )
          })}
          {(['ma5', 'ma20', 'ma60'] as const).map((key) => ov[key] && <path key={key} d={line(ind[key], y)} fill="none" style={{ stroke: MA_COLOR[key] }} strokeWidth="1.2" />)}
          {last && <>
            <line x1={0} x2={plotW} y1={y(last.c)} y2={y(last.c)} style={{ stroke: lastColor }} strokeDasharray="2 3" strokeWidth="1" />
            <rect x={plotW + 1} y={y(last.c) - 9} width={axisW - 2} height={18} rx={3} style={{ fill: lastColor }} />
            <text x={plotW + 6} y={y(last.c) + 4} className="mk-axis mk-axis-last">{px(last.c)}</text>
          </>}
          {sub === 'vol' && <>
            {view.map((b, k) => <rect key={b.t} x={x(k) - bw / 2} y={sy(b.v)} width={bw} height={Math.max(0.5, sBot - sy(b.v))} style={{ fill: b.c >= b.o ? UP : DOWN, opacity: 0.6 }} />)}
            <path d={line(ind.vma, sy)} fill="none" style={{ stroke: MA_COLOR.ma5 }} strokeWidth="1" />
          </>}
          {sub === 'macd' && <>
            <line x1={0} x2={plotW} y1={sy(0)} y2={sy(0)} className="mk-grid" />
            {view.map((b, k) => { const v = ind.macd.hist[k + off]; return <rect key={b.t} x={x(k) - bw / 2} y={Math.min(sy(v), sy(0))} width={bw} height={Math.max(0.5, Math.abs(sy(v) - sy(0)))} style={{ fill: v >= 0 ? UP : DOWN, opacity: 0.7 }} /> })}
            <path d={line(ind.macd.dif, sy)} fill="none" style={{ stroke: MA_COLOR.ma5 }} strokeWidth="1.2" />
            <path d={line(ind.macd.dea, sy)} fill="none" style={{ stroke: MA_COLOR.ma20 }} strokeWidth="1.2" />
          </>}
          {sub === 'rsi' && <>
            {[30, 50, 70].map((v) => <line key={v} x1={0} x2={plotW} y1={sy(v)} y2={sy(v)} className="mk-grid" strokeDasharray={v === 50 ? undefined : '3 3'} />)}
            {[30, 70].map((v) => <text key={v} x={plotW + 6} y={sy(v) + 4} className="mk-axis">{v}</text>)}
            <path d={line(ind.rsi, sy)} fill="none" style={{ stroke: MA_COLOR.ma20 }} strokeWidth="1.2" />
          </>}
          <text x={6} y={14} className="mk-legend">
            <tspan className="mk-legend-k">{fmtBarTime(cur.t, interval, true)}</tspan>
            <tspan dx="8" className="mk-legend-k">开</tspan><tspan dx="3">{px(cur.o)}</tspan>
            <tspan dx="8" className="mk-legend-k">高</tspan><tspan dx="3">{px(cur.h)}</tspan>
            <tspan dx="8" className="mk-legend-k">低</tspan><tspan dx="3">{px(cur.l)}</tspan>
            <tspan dx="8" className="mk-legend-k">收</tspan><tspan dx="3" style={{ fill: cur.c >= cur.o ? UP : DOWN }}>{px(cur.c)}</tspan>
            {prevBar && <tspan dx="6" style={{ fill: signColor(cur.c - prevBar.c) }}>{fmtPct((cur.c - prevBar.c) / prevBar.c)}</tspan>}
            <tspan dx="8" className="mk-legend-k">量</tspan><tspan dx="3">{fmtVol(cur.v)}</tspan>
          </text>
          <text x={6} y={mTop + 12} className="mk-legend">
            {(['ma5', 'ma20', 'ma60'] as const).filter((k) => ov[k]).map((k, n) => <tspan key={k} dx={n ? 10 : 0} style={{ fill: MA_COLOR[k] }}>{k.toUpperCase()} {Number.isFinite(ind[k][j]) ? px(ind[k][j]) : '-'}</tspan>)}
            {ov.boll && Number.isFinite(ind.boll.up[j]) && <tspan dx="10" style={{ fill: BOLL_COLOR }}>BOLL {px(ind.boll.mid[j])} / {px(ind.boll.up[j])} / {px(ind.boll.low[j])}</tspan>}
          </text>
          <text x={6} y={mainH + 14} className="mk-legend">
            {sub === 'vol' && <><tspan className="mk-legend-k">成交量</tspan><tspan dx="6">{fmtVol(cur.v)}</tspan><tspan dx="10" style={{ fill: MA_COLOR.ma5 }}>MA5 {fmtVol(ind.vma[j] || 0)}</tspan></>}
            {sub === 'macd' && <><tspan className="mk-legend-k">MACD(12,26,9)</tspan><tspan dx="8" style={{ fill: MA_COLOR.ma5 }}>DIF {fmtNum(ind.macd.dif[j])}</tspan><tspan dx="8" style={{ fill: MA_COLOR.ma20 }}>DEA {fmtNum(ind.macd.dea[j])}</tspan><tspan dx="8" style={{ fill: signColor(ind.macd.hist[j]) }}>柱 {fmtNum(ind.macd.hist[j])}</tspan></>}
            {sub === 'rsi' && <><tspan className="mk-legend-k">RSI(14)</tspan><tspan dx="8" style={{ fill: MA_COLOR.ma20 }}>{Number.isFinite(ind.rsi[j]) ? ind.rsi[j].toFixed(2) : '-'}</tspan></>}
          </text>
          {hover && <g className="mk-cross">
            <line x1={x(hover.i)} x2={x(hover.i)} y1={0} y2={avail} />
            <line x1={0} x2={plotW} y1={hover.y} y2={hover.y} />
            <rect x={plotW + 1} y={hover.y - 9} width={axisW - 2} height={18} rx={3} className="mk-cross-tag" />
            <text x={plotW + 6} y={hover.y + 4} className="mk-axis mk-axis-last">
              {hover.y <= mainH ? px(yInv(hover.y)) : sub === 'vol' ? fmtVol(Math.max(0, syInv(hover.y))) : fmtNum(syInv(hover.y))}
            </text>
            <rect x={Math.min(Math.max(0, x(hover.i) - 52), plotW - 104)} y={avail + 1} width={104} height={timeH - 2} rx={3} className="mk-cross-tag" />
            <text x={Math.min(Math.max(52, x(hover.i)), plotW - 52)} y={h - 6} textAnchor="middle" className="mk-axis mk-axis-last">{fmtBarTime(cur.t, interval, true)}</text>
          </g>}
        </svg>
      )}
    </div>
  )
}

function ChartArea({ symbol, inst, quote, interval, setInterval_ }: {
  symbol: string; inst: TradeInstrument; quote?: TradeQuote; interval: TradeInterval; setInterval_: (iv: TradeInterval) => void
}) {
  const [ov, setOv] = useState<Overlay>({ ma5: true, ma20: true, ma60: false, boll: false })
  const [sub, setSub] = useState<SubKind>('vol')
  const kq = useTradeKlines(symbol, interval)
  const bars = useMemo(() => withLive(toBars(kq.data?.data ?? []), quote, interval), [kq.data, quote, interval])
  const meta = kq.data?.meta
  const digits = digitsFor(inst, bars[bars.length - 1]?.c ?? quote?.last ?? 0)
  let msg: ReactNode = null
  if (kq.isLoading) msg = '加载 K 线'
  else if (kq.isError) msg = `取不到 K 线：${kq.error instanceof Error ? kq.error.message : ''}`
  else if (meta?.status === 'no_source') msg = `${MARKETS[inst.market].label}的行情源还没接，不显示 K 线`
  else if (meta?.status === 'error') msg = `取不到 K 线：${meta.error}`
  else if (!bars.length) msg = '这个周期还没有 K 线'
  return (
    <>
      <div className="mk-tools">
        <div className="mk-seg mk-seg-sm">
          {INTERVALS.map((iv) => <button key={iv.key} className={cls(interval === iv.key && 'on')} onClick={() => setInterval_(iv.key)}>{iv.label}</button>)}
        </div>
        <ChartTools ov={ov} setOv={setOv} sub={sub} setSub={setSub} />
      </div>
      {meta?.status === 'stale' && <div className="mk-banner">交易所暂时取不到，K 线是缓存（{meta.error}）</div>}
      <KChart data={bars} digits={digits} interval={interval} ov={ov} sub={sub} msg={msg} />
    </>
  )
}

function ChartTools({ ov, setOv, sub, setSub }: { ov: Overlay; setOv: (o: Overlay) => void; sub: SubKind; setSub: (s: SubKind) => void }) {
  return (
    <>
      <div className="mk-toggles">
        {(['ma5', 'ma20', 'ma60', 'boll'] as const).map((k) => (
          <button key={k} className={cls('mk-tg', ov[k] && 'on')} onClick={() => setOv({ ...ov, [k]: !ov[k] })}
            style={{ '--c': k === 'boll' ? BOLL_COLOR : MA_COLOR[k] } as CSSProperties}>
            <i />{k === 'boll' ? 'BOLL' : k.toUpperCase()}
          </button>
        ))}
      </div>
      <span className="spacer" />
      <div className="mk-seg mk-seg-sm">
        {([['vol', '成交量'], ['macd', 'MACD'], ['rsi', 'RSI']] as [SubKind, string][]).map(([k, l]) => <button key={k} className={cls(sub === k && 'on')} onClick={() => setSub(k)}>{l}</button>)}
      </div>
    </>
  )
}

/* ---------- 右栏：去交易、设提醒、盘口、数据源 ---------- */

function BookPanel({ i, quote, book, source, live, now, onTrade, onNewAlert }: {
  i: TradeInstrument; quote?: TradeQuote; book: TradeBook | null; source?: TradeSource; live: TradeLive; now: number
  onTrade: (side: 'buy' | 'sell') => void; onNewAlert: () => void
}) {
  const d = digitsFor(i, quote?.last ?? book?.bids[0]?.price ?? 0)
  const px = (p: number) => fmtPrice(p, d)
  const cum = (xs: { price: number; size: number }[]) => { let s = 0; return xs.slice(0, 10).map((x) => { s += x.size; return [x.price, x.size, s] as const }) }
  const asks = cum(book?.asks ?? [])
  const bids = cum(book?.bids ?? [])
  const max = Math.max(asks[asks.length - 1]?.[2] ?? 1, bids[bids.length - 1]?.[2] ?? 1)
  const bidSum = bids[bids.length - 1]?.[2] ?? 0
  const askSum = asks[asks.length - 1]?.[2] ?? 0
  const bidPct = bidSum + askSum ? bidSum / (bidSum + askSum) : 0.5
  const sz = (v: number) => (i.market === 'crypto' ? v.toFixed(v >= 100 ? 1 : 3) : fmtVol(v))
  const hasBook = !!book && (book.status === 'live' || book.status === 'stale') && (asks.length > 0 || bids.length > 0)
  const health = source ? live.sources[source.id] ?? source.health : undefined
  const at = quote?.at || quote?.fetched_at || ''
  return (
    <div className="mk-side">
      <div className="mk-trade">
        <button className="mk-buy" onClick={() => onTrade('buy')} title="去交易页下单（只到模拟盘）">买入<span>{book?.asks[0] ? px(book.asks[0].price) : '-'}</span></button>
        <button className="mk-sell" onClick={() => onTrade('sell')} title="去交易页下单（只到模拟盘）">卖出<span>{book?.bids[0] ? px(book.bids[0].price) : '-'}</span></button>
      </div>
      <div className="mk-trade-note">下单去交易页，只到模拟盘</div>
      <Button variant="outline" className="mk-alert-btn" onClick={onNewAlert}>设提醒</Button>

      <div className="mk-box">
        <div className="mk-box-head"><span>盘口</span>{book && book.status !== 'live' && <StatusDot status={book.status} title={book.error} />}<span className="spacer" /><span className="faint">价格</span><span className="faint mk-box-r">数量</span></div>
        {!hasBook ? (
          <div className="mk-empty">{book?.status === 'no_source' || quote?.status === 'no_source' ? '数据源未接' : book?.status === 'error' ? `取不到盘口：${book.error}` : '加载盘口'}</div>
        ) : <>
          <div className="mk-book">
            {[...asks].reverse().map(([p, v, c], k) => (
              <div key={`a${k}`} className="mk-lv">
                <span className="mk-depth" style={{ width: `${(c / max) * 100}%`, background: DOWN }} />
                <span className="mk-lv-k">卖{asks.length - k}</span><span className="mk-lv-p" style={{ color: DOWN }}>{px(p)}</span><span className="mk-lv-v">{sz(v)}</span>
              </div>
            ))}
            <div className="mk-mid">
              <span style={{ color: quote?.status === 'live' ? signColor(quote.change) : 'var(--muted)' }}>{quote && quote.last > 0 ? px(quote.last) : '-'}</span>
              <span className="faint">价差 {asks[0] && bids[0] ? px(asks[0][0] - bids[0][0]) : '-'}</span>
            </div>
            {bids.map(([p, v, c], k) => (
              <div key={`b${k}`} className="mk-lv">
                <span className="mk-depth" style={{ width: `${(c / max) * 100}%`, background: UP }} />
                <span className="mk-lv-k">买{k + 1}</span><span className="mk-lv-p" style={{ color: UP }}>{px(p)}</span><span className="mk-lv-v">{sz(v)}</span>
              </div>
            ))}
          </div>
          <div className="mk-ratio" title={`买卖 ${bids.length} 档挂单量对比`}>
            <span style={{ width: `${bidPct * 100}%`, background: UP }} /><span style={{ width: `${(1 - bidPct) * 100}%`, background: DOWN }} />
          </div>
          <div className="mk-ratio-t"><span style={{ color: UP }}>买 {(bidPct * 100).toFixed(0)}%</span><span style={{ color: DOWN }}>卖 {((1 - bidPct) * 100).toFixed(0)}%</span></div>
        </>}
      </div>

      <div className="mk-box mk-src" aria-label="数据源">
        <div className="mk-box-head"><span>数据源</span></div>
        <div className="mk-kv"><span className="muted">来源</span><span>{source ? `${source.name} 公开行情` : quote?.status === 'no_source' ? '未接' : '-'}</span></div>
        <div className="mk-kv"><span className="muted">状态</span>{quote ? <StatusDot status={quote.status} title={quote.error} /> : <span>-</span>}</div>
        {at && <div className="mk-kv"><span className="muted">数据时间</span><span>{fmtClock(at, now)}（{fmtSpan(now - new Date(at).getTime())}前）</span></div>}
        <div className="mk-kv"><span className="muted">更新方式</span><span>{live.transport === 'sse' ? '推送，每秒' : live.transport === 'poll' ? '轮询，2 秒' : '连接中'}</span></div>
        {health?.status === 'error' && <div className="mk-src-err">交易所异常：{health.error}{health.retry_at ? `，${fmtSpan(new Date(health.retry_at).getTime() - now)}后重试` : ''}</div>}
        {quote?.status === 'stale' && health?.status !== 'error' && quote.error && <div className="mk-src-err">{quote.error}</div>}
      </div>
    </div>
  )
}

/* ---------- 页面 ---------- */

export default function MarketsPage() {
  const now = useNow(1000)
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const wq = useTradeWatchlists()
  const sq = useTradeSources()
  const watchlists = useMemo(() => wq.data ?? [], [wq.data])
  const [tab, setTab] = useState<'chart' | 'option'>('chart')
  const [wlId, setWlId] = useState('')
  const [picked, setPicked] = useState('')
  const [interval, setInterval_] = useState<TradeInterval>('15m')
  const [listOpen, setListOpen] = useState(false)

  const wl = watchlists.find((w) => w.id === wlId) ?? watchlists[0]
  const urlSymbol = params.get('symbol') ?? ''
  const symbol = picked || urlSymbol || wl?.symbols[0] || DEFAULT_SYMBOLS[0]
  const inst = useInst(symbol)
  const visible = useMemo(() => [...new Set([...(wl?.symbols ?? []), symbol])], [wl, symbol])
  const live = useTradeLive(visible, symbol)
  const quote = live.quotes[symbol]
  const source = (sq.data ?? []).find((s) => s.id === quote?.source)

  useEffect(() => {
    if (!listOpen) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setListOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [listOpen])

  const goAlert = () => void navigate(`/monitor?${new URLSearchParams({ symbol, new: 'alert' })}`)
  const goTrade = (side: 'buy' | 'sell') => void navigate(`/trading?${new URLSearchParams({ symbol, side, paper: '1' })}`)

  return (
    <div className={cls('mk-page', tab === 'option' && 'mk-page-opt')}>
      <PageTitle desc={`${inst.name} · ${symbol}`} actions={<Button variant="outline" onClick={goAlert}>设提醒</Button>}>行情</PageTitle>
      <div className="mk-top">
        <div className="mk-seg">
          <button className={cls(tab === 'chart' && 'on')} onClick={() => setTab('chart')}>看盘</button>
          <button className={cls(tab === 'option' && 'on')} onClick={() => setTab('option')}>期权</button>
        </div>
        {tab === 'chart' && <Button variant="outline" className="mk-list-toggle" onClick={() => setListOpen(true)}>自选<span className="faint">{wl?.name}</span></Button>}
      </div>

      {tab === 'chart' ? (
        <div className="mk-body">
          {listOpen && <div className="mk-scrim" onClick={() => setListOpen(false)} />}
          <aside className={cls('mk-left', listOpen && 'open')}>
            <div className="mk-left-head"><span>自选</span><span className="spacer" /><IconButton size="sm" label="关闭 (Esc)" onClick={() => setListOpen(false)}><IconClose size={12} /></IconButton></div>
            {wq.isLoading ? <LoadingState /> : (
              <WatchPanel watchlists={watchlists} wl={wl} setWlId={setWlId} symbol={symbol} quotes={live.quotes}
                onPick={(s) => { setPicked(s); setListOpen(false) }} />
            )}
          </aside>
          <section className="mk-center">
            <SymbolHead i={inst} quote={quote} funding={live.funding} now={now} />
            <ChartArea symbol={symbol} inst={inst} quote={quote} interval={interval} setInterval_={setInterval_} />
          </section>
          <aside className="mk-right">
            <BookPanel i={inst} quote={quote} book={live.book} source={source} live={live} now={now} onTrade={goTrade} onNewAlert={goAlert} />
          </aside>
        </div>
      ) : (
        <div className="mk-body mk-body-opt">
          <section className="mk-center mk-opt-na">
            <EmptyState title="期权数据源未接" desc="期权 T 型报价要接 Deribit、OKX 期权或券商的期权行情，接上之前这里不显示报价，也不用模拟价格" />
          </section>
        </div>
      )}
    </div>
  )
}
