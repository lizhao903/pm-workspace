import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from 'react'
import './markets.css'
import { fundingRate, SessionPill, fmtSpan } from './monitor'
import { PageTitle } from './topbar'
import { cls } from './ui'
import {
  DOWN, INST_KIND, INSTRUMENTS, INTERVALS, MARKETS, OPTION_EXPIRIES, OPTION_UNDERLYINGS, SESSION_LABEL, UP,
  bars, fmtPct, fmtPrice, greeks, instOf, optionChain, orderBook, prevClose, priceAt, quoteOf, round, sessionOf, useNow,
  type BarInterval, type Instrument, type MarketKey, type Watchlist,
} from './tradedata'
import { newId } from './ids'

// 行情：左自选、中 K 线、右盘口与成交；另一个标签是期权 T 型报价
// K 线历史按 (标的, 周期, 分钟) 缓存，最后一根每秒用 bars(...,1,now) 单独现算

const TOTAL = 200
const VIEW = 140
const p2 = (n: number) => String(n).padStart(2, '0')
function hashStr(s: string) { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0 }
const code = (symbol: string) => symbol.slice(symbol.indexOf(':') + 1)
const fmtVol = (v: number) => (v >= 1e8 ? `${(v / 1e8).toFixed(2)} 亿` : v >= 1e4 ? `${(v / 1e4).toFixed(2)} 万` : v >= 100 ? v.toFixed(0) : v.toFixed(2))
const fmtNum = (x: number) => { const a = Math.abs(x); return a >= 100 ? x.toFixed(1) : a >= 1 ? x.toFixed(2) : a >= 0.001 ? x.toFixed(4) : x === 0 ? '0' : x.toExponential(2) }
const fmtStrike = (k: number) => String(Number(k.toPrecision(10)))
const daysTo = (iso: string, at: number) => Math.max(0, Math.ceil((new Date(iso).getTime() - at) / 86400000))
const signColor = (x: number) => (x > 0 ? UP : x < 0 ? DOWN : 'var(--muted)')
const FUNDING_MS = 8 * 3600000

/* ---------- 指标 ---------- */

function sma(xs: number[], n: number) {
  const out: number[] = []
  let s = 0
  xs.forEach((x, i) => { s += x; if (i >= n) s -= xs[i - n]; out.push(i >= n - 1 ? s / n : NaN) })
  return out
}
function ema(xs: number[], n: number) {
  const k = 2 / (n + 1)
  const out: number[] = []
  xs.forEach((x, i) => out.push(i === 0 ? x : x * k + out[i - 1] * (1 - k)))
  return out
}
function boll(xs: number[], n = 20, m = 2) {
  const mid = sma(xs, n)
  const up: number[] = [], low: number[] = []
  xs.forEach((_, i) => {
    if (i < n - 1) { up.push(NaN); low.push(NaN); return }
    let v = 0
    for (let j = i - n + 1; j <= i; j++) v += (xs[j] - mid[i]) ** 2
    const sd = Math.sqrt(v / n)
    up.push(mid[i] + m * sd); low.push(mid[i] - m * sd)
  })
  return { mid, up, low }
}
function macd(xs: number[]) {
  const a = ema(xs, 12), b = ema(xs, 26)
  const dif = xs.map((_, i) => a[i] - b[i])
  const dea = ema(dif, 9)
  return { dif, dea, hist: dif.map((d, i) => 2 * (d - dea[i])) }
}
function rsi(xs: number[], n = 14) {
  const out: number[] = [NaN]
  let g = 0, l = 0
  for (let i = 1; i < xs.length; i++) {
    const d = xs[i] - xs[i - 1]
    const up = Math.max(d, 0), dn = Math.max(-d, 0)
    if (i <= n) { g += up / n; l += dn / n; out.push(i === n ? (l ? 100 - 100 / (1 + g / l) : 100) : NaN); continue }
    g = (g * (n - 1) + up) / n; l = (l * (n - 1) + dn) / n
    out.push(l ? 100 - 100 / (1 + g / l) : 100)
  }
  return out
}

/* ---------- 小部件 ---------- */

function useSize<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setSize({ w: Math.floor(e.contentRect.width), h: Math.floor(e.contentRect.height) }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, size] as const
}

const KindTag = ({ i }: { i: Instrument }) => (i.kind === 'spot' ? null : <span className="mk-kind">{INST_KIND[i.kind].short}</span>)
const Dot = ({ m }: { m: MarketKey }) => <span className="mk-dot" style={{ background: MARKETS[m].color }} />
const IconX = ({ s = 10 }: { s?: number }) => <svg viewBox="0 0 16 16" width={s} height={s}><path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>

/* ---------- 左栏：自选 ---------- */

type MarketFilter = MarketKey | 'all'

function WatchPanel({ watchlists, onWatchlists, wlId, setWlId, symbol, onPick, now }: {
  watchlists: Watchlist[]
  onWatchlists: (fn: (xs: Watchlist[]) => Watchlist[]) => void
  wlId: string
  setWlId: (id: string) => void
  symbol: string
  onPick: (s: string) => void
  now: number
}) {
  const wl = watchlists.find((w) => w.id === wlId) ?? watchlists[0]
  const [mf, setMf] = useState<MarketFilter>('all')
  const [q, setQ] = useState('')
  const [renaming, setRenaming] = useState<string | null>(null)
  const [name, setName] = useState('')
  const sessions = useMemo(() => Object.fromEntries((Object.keys(MARKETS) as MarketKey[]).map((m) => [m, sessionOf(m, now)])), [Math.floor(now / 30000)])

  const kw = q.trim().toLowerCase()
  const results = kw ? INSTRUMENTS.filter((i) => (mf === 'all' || i.market === mf) && `${i.name} ${i.symbol} ${i.venue}`.toLowerCase().includes(kw)).slice(0, 12) : []
  const rows = (wl?.symbols ?? []).map((s) => instOf(s)).filter((i): i is Instrument => !!i && (mf === 'all' || i.market === mf))

  const add = (s: string) => {
    if (!wl) return
    const id = wl.id
    onWatchlists((xs) => xs.map((w) => (w.id === id && !w.symbols.includes(s) ? { ...w, symbols: [...w.symbols, s] } : w)))
    setQ('')
  }
  const remove = (s: string) => { if (!wl) return; const id = wl.id; onWatchlists((xs) => xs.map((w) => (w.id === id ? { ...w, symbols: w.symbols.filter((x) => x !== s) } : w))) }
  const newGroup = () => {
    const id = newId('wl')
    const n = `新自选组 ${watchlists.length + 1}`
    onWatchlists((xs) => [...xs, { id, name: n, symbols: [] }])
    setWlId(id); setRenaming(id); setName(n)
  }
  const commitName = () => {
    const id = renaming, n = name.trim()
    if (id && n) onWatchlists((xs) => xs.map((w) => (w.id === id ? { ...w, name: n } : w)))
    setRenaming(null)
  }
  const delGroup = () => {
    if (!wl || watchlists.length <= 1) return
    const id = wl.id
    const rest = watchlists.filter((w) => w.id !== id)
    onWatchlists((xs) => xs.filter((w) => w.id !== id))
    setWlId(rest[0].id); setRenaming(null)
  }

  return (
    <div className="mk-watch">
      <div className="mk-groups">
        {watchlists.map((w) => (
          <button key={w.id} className={cls('chip', w.id === wl?.id && 'chip-on')} onClick={() => setWlId(w.id)}
            onDoubleClick={() => { setRenaming(w.id); setName(w.name) }} title="双击改名">
            {w.name}<span className="seg-n">{w.symbols.length}</span>
          </button>
        ))}
        <button className="icon-btn icon-btn-sm" title="新建自选组" onClick={newGroup}>
          <svg viewBox="0 0 16 16" width="12" height="12"><path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
        </button>
        {wl && (
          <button className="icon-btn icon-btn-sm" title="重命名当前组" onClick={() => { setRenaming(wl.id); setName(wl.name) }}>
            <svg viewBox="0 0 16 16" width="12" height="12"><path d="M3 13h2.5L13 5.5 10.5 3 3 10.5V13Z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" /></svg>
          </button>
        )}
      </div>
      {renaming && (
        <div className="mk-rename">
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="自选组名称"
            onKeyDown={(e) => { if (e.key === 'Enter') commitName(); if (e.key === 'Escape') setRenaming(null) }} />
          <button className="act act-primary" disabled={!name.trim()} onClick={commitName}>保存</button>
          {watchlists.length > 1 && <button className="act act-quiet" onClick={delGroup} title="删除这个自选组">删除组</button>}
          <button className="act act-quiet" onClick={() => setRenaming(null)}>取消</button>
        </div>
      )}
      <div className="seg seg-sm mk-mf">
        {([['all', '全部'], ['crypto', '数币'], ['cn', 'A 股'], ['hk', '港股'], ['us', '美股']] as [MarketFilter, string][]).map(([k, l]) => (
          <button key={k} className={cls(mf === k && 'on')} onClick={() => setMf(k)}>{l}</button>
        ))}
      </div>
      <div className="mk-search-wrap">
        <div className="search search-sm">
          <svg viewBox="0 0 16 16" width="13" height="13"><circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
          <input placeholder="搜标的加入当前组" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') setQ('') }} />
          {q && <button className="search-clear" onClick={() => setQ('')} title="清空"><IconX /></button>}
        </div>
        {kw && (
          <div className="mk-results">
            {!results.length && <div className="mk-results-empty">没有匹配的标的</div>}
            {results.map((i) => {
              const inList = !!wl?.symbols.includes(i.symbol)
              return (
                <button key={i.symbol} className="mk-result" disabled={inList} onClick={() => add(i.symbol)}>
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
        {!rows.length && <div className="mount-empty">{wl?.symbols.length ? '这个市场没有自选标的' : '这一组还是空的，上面搜一个加进来'}</div>}
        {rows.map((i) => {
          const last = priceAt(i.symbol, now)
          const prev = prevClose(i.symbol, now)
          const pct = prev ? (last - prev) / prev : 0
          const s = sessions[i.market]
          return (
            <div key={i.symbol} role="button" tabIndex={0} className={cls('mk-row', i.symbol === symbol && 'on')} onClick={() => onPick(i.symbol)}
              onKeyDown={(e) => { if (e.key === 'Enter') onPick(i.symbol) }}>
              <div className="mk-row-main">
                <span className="mk-row-name"><Dot m={i.market} /><span className="ellipsis">{i.name}</span><KindTag i={i} /></span>
                <span className="mk-row-sub"><span className="mk-code ellipsis">{code(i.symbol)}</span><span className={cls('mk-sess', `mk-sess-${s}`)}>{SESSION_LABEL[s]}</span></span>
              </div>
              <div className="mk-row-px">
                <span className="mk-row-last">{fmtPrice(i.symbol, last)}</span>
                <span className="mk-row-pct" style={{ background: pct >= 0 ? UP : DOWN }}>{fmtPct(pct)}</span>
              </div>
              <button className="mk-row-x" title="移出自选" onClick={(e) => { e.stopPropagation(); remove(i.symbol) }}><IconX /></button>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/* ---------- 中间：K 线 ---------- */

type SubKind = 'vol' | 'macd' | 'rsi'
type Overlay = { ma5: boolean; ma20: boolean; ma60: boolean; boll: boolean }
const MA_COLOR = { ma5: '#e8a317', ma20: '#7a4fd6', ma60: '#0c8599' }
const BOLL_COLOR = '#8a8578'

function fmtT(t: number, iv: BarInterval, long = false) {
  const d = new Date(t)
  const md = `${p2(d.getMonth() + 1)}-${p2(d.getDate())}`
  const hm = `${p2(d.getHours())}:${p2(d.getMinutes())}`
  if (iv === '1d') return long ? `${d.getFullYear()}-${md}` : md
  if (iv === '1h' || iv === '4h' || long) return `${md} ${hm}`
  return hm
}

function KChart({ symbol, interval, now, ov, sub }: { symbol: string; interval: BarInterval; now: number; ov: Overlay; sub: SubKind }) {
  const [wrapRef, { w, h }] = useSize<HTMLDivElement>()
  const [hover, setHover] = useState<{ i: number; y: number } | null>(null)
  const minute = Math.floor(now / 60000) * 60000
  const hist = useMemo(() => bars(symbol, interval, TOTAL, minute), [symbol, interval, minute])
  const data = useMemo(() => {
    const live = bars(symbol, interval, 1, now)[0]
    if (!live) return hist
    // tradedata 的模拟量偶尔是负数，显示时取绝对值
    return [...hist.filter((b) => b.t < live.t), live].slice(-TOTAL).map((b) => (b.v < 0 ? { ...b, v: -b.v } : b))
  }, [hist, symbol, interval, now])

  const ind = useMemo(() => {
    const c = data.map((b) => b.c)
    return { ma5: sma(c, 5), ma20: sma(c, 20), ma60: sma(c, 60), boll: boll(c), macd: macd(c), rsi: rsi(c), vma: sma(data.map((b) => b.v), 5) }
  }, [data])

  const off = Math.max(0, data.length - VIEW)
  const view = data.slice(off)
  const axisW = 66, timeH = 20
  const plotW = Math.max(10, w - axisW)
  const avail = Math.max(60, h - timeH)
  const mainH = Math.round(avail * 0.72)
  const cw = plotW / VIEW
  const bw = Math.max(1, Math.min(cw * 0.7, cw - 1))
  const x = (k: number) => (k + 0.5) * cw

  // 主图价格范围
  let lo = Infinity, hi = -Infinity
  view.forEach((b, k) => {
    lo = Math.min(lo, b.l); hi = Math.max(hi, b.h)
    const j = k + off
    for (const key of ['ma5', 'ma20', 'ma60'] as const) if (ov[key] && Number.isFinite(ind[key][j])) { lo = Math.min(lo, ind[key][j]); hi = Math.max(hi, ind[key][j]) }
    if (ov.boll && Number.isFinite(ind.boll.up[j])) { lo = Math.min(lo, ind.boll.low[j]); hi = Math.max(hi, ind.boll.up[j]) }
  })
  if (!Number.isFinite(lo)) { lo = 0; hi = 1 }
  const pad = (hi - lo) * 0.06 || hi * 0.001 || 1
  lo -= pad; hi += pad
  const mTop = 22, mBot = mainH - 4
  const y = (p: number) => mBot - ((p - lo) / (hi - lo)) * (mBot - mTop)
  const yInv = (py: number) => lo + ((mBot - py) / (mBot - mTop)) * (hi - lo)

  // 副图范围
  const sTop = mainH + 20, sBot = avail - 2
  let slo = 0, shi = 1
  if (sub === 'vol') shi = Math.max(1, ...view.map((b) => b.v))
  else if (sub === 'rsi') { slo = 0; shi = 100 }
  else {
    const vals = view.flatMap((_, k) => [ind.macd.dif[k + off], ind.macd.dea[k + off], ind.macd.hist[k + off]]).filter(Number.isFinite)
    const m = Math.max(1e-9, ...vals.map(Math.abs))
    slo = -m; shi = m
  }
  const sy = (v: number) => sBot - ((v - slo) / (shi - slo || 1)) * (sBot - sTop)
  const syInv = (py: number) => slo + ((sBot - py) / (sBot - sTop)) * (shi - slo)

  const line = (arr: number[], f: (v: number) => number) => {
    let d = '', pen = false
    view.forEach((_, k) => { const v = arr[k + off]; if (!Number.isFinite(v)) { pen = false; return } d += `${pen ? 'L' : 'M'}${x(k).toFixed(1)},${f(v).toFixed(1)}`; pen = true })
    return d
  }

  const onMove = (e: RPointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    const px = e.clientX - r.left, py = e.clientY - r.top
    if (px > plotW || py > avail) { setHover(null); return }
    setHover({ i: Math.max(0, Math.min(view.length - 1, Math.floor(px / cw))), y: py })
  }

  const hi_ = hover && view[hover.i] ? hover.i : view.length - 1
  const cur = view[hi_]
  const prevBar = view[hi_ - 1] ?? data[off + hi_ - 1]
  const last = view[view.length - 1]
  const ticks = 5
  const priceTicks = Array.from({ length: ticks }, (_, k) => lo + ((hi - lo) * (k + 0.5)) / ticks)
  const labelEvery = Math.max(1, Math.ceil(110 / cw))
  const legendX = 6
  const j = hi_ + off
  const lastColor = last && last.c >= last.o ? UP : DOWN

  return (
    <div className="mk-chart" ref={wrapRef}>
      {w > 0 && h > 0 && cur && (
        <svg width={w} height={h} className="mk-svg" onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
          {/* 网格与价格轴 */}
          {priceTicks.map((p) => (
            <g key={p}>
              <line x1={0} x2={plotW} y1={y(p)} y2={y(p)} className="mk-grid" />
              {(!last || Math.abs(y(p) - y(last.c)) > 14) && <text x={plotW + 6} y={y(p) + 4} className="mk-axis">{fmtPrice(symbol, p)}</text>}
            </g>
          ))}
          <line x1={0} x2={w} y1={mainH} y2={mainH} className="mk-sep" />
          <line x1={plotW} x2={plotW} y1={0} y2={avail} className="mk-sep" />
          <line x1={0} x2={w} y1={avail} y2={avail} className="mk-sep" />
          {view.map((b, k) => ((k + off) % labelEvery === 0 && x(k) > 20 && x(k) < plotW - 30
            ? <g key={b.t}><line x1={x(k)} x2={x(k)} y1={0} y2={avail} className="mk-grid" /><text x={x(k)} y={h - 6} textAnchor="middle" className="mk-axis">{fmtT(b.t, interval)}</text></g>
            : null))}

          {/* 布林带 */}
          {ov.boll && <>
            <path d={line(ind.boll.up, y)} fill="none" style={{ stroke: BOLL_COLOR }} strokeWidth="1" strokeDasharray="3 3" />
            <path d={line(ind.boll.mid, y)} fill="none" style={{ stroke: BOLL_COLOR }} strokeWidth="1" />
            <path d={line(ind.boll.low, y)} fill="none" style={{ stroke: BOLL_COLOR }} strokeWidth="1" strokeDasharray="3 3" />
          </>}

          {/* 蜡烛 */}
          {view.map((b, k) => {
            const up = b.c >= b.o
            const c = up ? UP : DOWN
            const top = y(Math.max(b.o, b.c)), bot = y(Math.min(b.o, b.c))
            return (
              <g key={b.t} style={{ stroke: c, fill: up ? 'var(--panel)' : c }}>
                <line x1={x(k)} x2={x(k)} y1={y(b.h)} y2={y(b.l)} strokeWidth="1" />
                <rect x={x(k) - bw / 2} y={top} width={bw} height={Math.max(1, bot - top)} strokeWidth={bw > 3 ? 1 : 0} style={bw <= 3 ? { fill: c } : undefined} />
              </g>
            )
          })}

          {(['ma5', 'ma20', 'ma60'] as const).map((key) => ov[key] && <path key={key} d={line(ind[key], y)} fill="none" style={{ stroke: MA_COLOR[key] }} strokeWidth="1.2" />)}

          {/* 最新价线 */}
          {last && <>
            <line x1={0} x2={plotW} y1={y(last.c)} y2={y(last.c)} style={{ stroke: lastColor }} strokeDasharray="2 3" strokeWidth="1" />
            <rect x={plotW + 1} y={y(last.c) - 9} width={axisW - 2} height={18} rx={3} style={{ fill: lastColor }} />
            <text x={plotW + 6} y={y(last.c) + 4} className="mk-axis mk-axis-last">{fmtPrice(symbol, last.c)}</text>
          </>}

          {/* 副图 */}
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

          {/* 图例 */}
          <text x={legendX} y={14} className="mk-legend">
            <tspan className="mk-legend-k">{fmtT(cur.t, interval, true)}</tspan>
            <tspan dx="8" className="mk-legend-k">开</tspan><tspan dx="3">{fmtPrice(symbol, cur.o)}</tspan>
            <tspan dx="8" className="mk-legend-k">高</tspan><tspan dx="3">{fmtPrice(symbol, cur.h)}</tspan>
            <tspan dx="8" className="mk-legend-k">低</tspan><tspan dx="3">{fmtPrice(symbol, cur.l)}</tspan>
            <tspan dx="8" className="mk-legend-k">收</tspan><tspan dx="3" style={{ fill: cur.c >= cur.o ? UP : DOWN }}>{fmtPrice(symbol, cur.c)}</tspan>
            {prevBar && <tspan dx="6" style={{ fill: signColor(cur.c - prevBar.c) }}>{fmtPct((cur.c - prevBar.c) / prevBar.c)}</tspan>}
            <tspan dx="8" className="mk-legend-k">量</tspan><tspan dx="3">{fmtVol(cur.v)}</tspan>
          </text>
          <text x={legendX} y={mTop + 12} className="mk-legend">
            {(['ma5', 'ma20', 'ma60'] as const).filter((k) => ov[k]).map((k, n) => <tspan key={k} dx={n ? 10 : 0} style={{ fill: MA_COLOR[k] }}>{k.toUpperCase()} {Number.isFinite(ind[k][j]) ? fmtPrice(symbol, ind[k][j]) : '-'}</tspan>)}
            {ov.boll && Number.isFinite(ind.boll.up[j]) && <tspan dx="10" style={{ fill: BOLL_COLOR }}>BOLL {fmtPrice(symbol, ind.boll.mid[j])} / {fmtPrice(symbol, ind.boll.up[j])} / {fmtPrice(symbol, ind.boll.low[j])}</tspan>}
          </text>
          <text x={legendX} y={mainH + 14} className="mk-legend">
            {sub === 'vol' && <><tspan className="mk-legend-k">成交量</tspan><tspan dx="6">{fmtVol(cur.v)}</tspan><tspan dx="10" style={{ fill: MA_COLOR.ma5 }}>MA5 {fmtVol(ind.vma[j] || 0)}</tspan></>}
            {sub === 'macd' && <><tspan className="mk-legend-k">MACD(12,26,9)</tspan><tspan dx="8" style={{ fill: MA_COLOR.ma5 }}>DIF {fmtNum(ind.macd.dif[j])}</tspan><tspan dx="8" style={{ fill: MA_COLOR.ma20 }}>DEA {fmtNum(ind.macd.dea[j])}</tspan><tspan dx="8" style={{ fill: signColor(ind.macd.hist[j]) }}>柱 {fmtNum(ind.macd.hist[j])}</tspan></>}
            {sub === 'rsi' && <><tspan className="mk-legend-k">RSI(14)</tspan><tspan dx="8" style={{ fill: MA_COLOR.ma20 }}>{Number.isFinite(ind.rsi[j]) ? ind.rsi[j].toFixed(2) : '-'}</tspan></>}
          </text>

          {/* 十字光标 */}
          {hover && <g className="mk-cross">
            <line x1={x(hover.i)} x2={x(hover.i)} y1={0} y2={avail} />
            <line x1={0} x2={plotW} y1={hover.y} y2={hover.y} />
            <rect x={plotW + 1} y={hover.y - 9} width={axisW - 2} height={18} rx={3} className="mk-cross-tag" />
            <text x={plotW + 6} y={hover.y + 4} className="mk-axis mk-axis-last">
              {hover.y <= mainH ? fmtPrice(symbol, yInv(hover.y)) : sub === 'vol' ? fmtVol(Math.max(0, syInv(hover.y))) : fmtNum(syInv(hover.y))}
            </text>
            <rect x={Math.min(Math.max(0, x(hover.i) - 52), plotW - 104)} y={avail + 1} width={104} height={timeH - 2} rx={3} className="mk-cross-tag" />
            <text x={Math.min(Math.max(52, x(hover.i)), plotW - 52)} y={h - 6} textAnchor="middle" className="mk-axis mk-axis-last">{fmtT(cur.t, interval, true)}</text>
          </g>}
        </svg>
      )}
    </div>
  )
}

function SymbolHead({ i, now }: { i: Instrument; now: number }) {
  const q = quoteOf(i.symbol, now)
  const minute = Math.floor(now / 60000) * 60000
  const dayVol = useMemo(() => bars(i.symbol, '15m', 96, minute).reduce((a, b) => a + Math.abs(b.v), 0), [i.symbol, minute])
  const s = sessionOf(i.market, now)
  const color = signColor(q.change)
  const fr = i.kind === 'perp' ? fundingRate(i.symbol, now) : 0
  const nextFund = Math.ceil(now / FUNDING_MS) * FUNDING_MS
  const Item = ({ k, v, c }: { k: string; v: React.ReactNode; c?: string }) => <span className="mk-hi"><span className="mk-hi-k">{k}</span><span className="mk-hi-v" style={c ? { color: c } : undefined}>{v}</span></span>
  return (
    <div className="mk-head">
      <div className="mk-head-id">
        <div className="mk-head-name"><Dot m={i.market} /><span className="ellipsis">{i.name}</span><KindTag i={i} /></div>
        <div className="mk-code">{i.symbol} · {i.venue} · {MARKETS[i.market].currency}</div>
      </div>
      <div className="mk-head-px">
        <span className="mk-last" style={{ color }}>{fmtPrice(i.symbol, q.last)}</span>
        <span className="mk-chg" style={{ color }}>{q.change >= 0 ? '+' : ''}{fmtPrice(i.symbol, q.change)} {fmtPct(q.pct)}</span>
      </div>
      <div className="mk-head-items">
        <Item k="高" v={fmtPrice(i.symbol, q.high)} />
        <Item k="低" v={fmtPrice(i.symbol, q.low)} />
        <Item k={i.market === 'crypto' ? '24h 量' : '日内量'} v={fmtVol(dayVol)} />
        <Item k="昨收" v={fmtPrice(i.symbol, q.prev)} />
        {i.limit && <>
          <Item k="涨停" v={fmtPrice(i.symbol, round(q.prev * (1 + i.limit), i.digits))} c={UP} />
          <Item k="跌停" v={fmtPrice(i.symbol, round(q.prev * (1 - i.limit), i.digits))} c={DOWN} />
        </>}
        {i.kind === 'future' && i.expiry && <>
          <Item k="到期" v={`${i.expiry}（${daysTo(i.expiry, now)} 天）`} />
          <Item k="乘数" v={i.multiplier} />
        </>}
        {i.kind === 'perp' && <>
          <Item k="资金费率" v={`${fr >= 0 ? '+' : ''}${fr.toFixed(4)}%`} c={signColor(fr)} />
          <Item k="下次结算" v={fmtSpan(nextFund - now)} />
        </>}
        <span className="mk-hi"><SessionPill s={s} /></span>
      </div>
    </div>
  )
}

/* ---------- 右栏：盘口、成交、下单 ---------- */

function BookPanel({ i, now, onTrade, onNewAlert }: { i: Instrument; now: number; onTrade: (s: string, side: 'buy' | 'sell') => void; onNewAlert: (s: string) => void }) {
  const book = orderBook(i.symbol, now, 10)
  const last = priceAt(i.symbol, now)
  const cum = (xs: [number, number][]) => { let s = 0; return xs.map(([p, v]) => { s += v; return [p, v, s] as const }) }
  const asks = cum(book.asks), bids = cum(book.bids)
  const max = Math.max(asks[asks.length - 1]?.[2] ?? 1, bids[bids.length - 1]?.[2] ?? 1)
  const sz = (v: number) => (i.market === 'crypto' ? v.toFixed(3) : fmtVol(v))
  const bidSum = bids[bids.length - 1]?.[2] ?? 0, askSum = asks[asks.length - 1]?.[2] ?? 0
  const bidPct = bidSum + askSum ? bidSum / (bidSum + askSum) : 0.5
  // 最近成交：按整秒往前取价，跟前一秒比定方向
  const sec = Math.floor(now / 1000) * 1000
  const trades = Array.from({ length: 16 }, (_, k) => {
    const t = sec - k * 1000
    const p = priceAt(i.symbol, t)
    const pp = priceAt(i.symbol, t - 1000)
    const h = hashStr(`${i.symbol}${t}`)
    const v = i.market === 'crypto' ? ((h % 900) + 5) / 1000 * (i.base > 10000 ? 1 : 20) : ((h % 40) + 1) * i.lot
    return { t, p, v, buy: p >= pp }
  })
  return (
    <div className="mk-side">
      <div className="mk-trade">
        <button className="mk-buy" onClick={() => onTrade(i.symbol, 'buy')}>买入<span>{fmtPrice(i.symbol, book.asks[0]?.[0] ?? last)}</span></button>
        <button className="mk-sell" onClick={() => onTrade(i.symbol, 'sell')}>卖出<span>{fmtPrice(i.symbol, book.bids[0]?.[0] ?? last)}</span></button>
      </div>
      <button className="act mk-alert-btn" onClick={() => onNewAlert(i.symbol)}>设提醒</button>

      <div className="mk-box">
        <div className="mk-box-head"><span>盘口</span><span className="spacer" /><span className="faint">价格</span><span className="faint mk-box-r">数量</span></div>
        <div className="mk-book">
          {[...asks].reverse().map(([p, v, c], k) => (
            <div key={`a${k}`} className="mk-lv">
              <span className="mk-depth" style={{ width: `${(c / max) * 100}%`, background: DOWN }} />
              <span className="mk-lv-k">卖{10 - k}</span><span className="mk-lv-p" style={{ color: DOWN }}>{fmtPrice(i.symbol, p)}</span><span className="mk-lv-v">{sz(v)}</span>
            </div>
          ))}
          <div className="mk-mid"><span style={{ color: signColor(last - prevClose(i.symbol, now)) }}>{fmtPrice(i.symbol, last)}</span><span className="faint">价差 {fmtPrice(i.symbol, round((book.asks[0]?.[0] ?? last) - (book.bids[0]?.[0] ?? last), i.digits))}</span></div>
          {bids.map(([p, v, c], k) => (
            <div key={`b${k}`} className="mk-lv">
              <span className="mk-depth" style={{ width: `${(c / max) * 100}%`, background: UP }} />
              <span className="mk-lv-k">买{k + 1}</span><span className="mk-lv-p" style={{ color: UP }}>{fmtPrice(i.symbol, p)}</span><span className="mk-lv-v">{sz(v)}</span>
            </div>
          ))}
        </div>
        <div className="mk-ratio" title="买卖十档挂单量对比">
          <span style={{ width: `${bidPct * 100}%`, background: UP }} /><span style={{ width: `${(1 - bidPct) * 100}%`, background: DOWN }} />
        </div>
        <div className="mk-ratio-t"><span style={{ color: UP }}>买 {(bidPct * 100).toFixed(0)}%</span><span style={{ color: DOWN }}>卖 {((1 - bidPct) * 100).toFixed(0)}%</span></div>
      </div>

      <div className="mk-box">
        <div className="mk-box-head"><span>最近成交</span></div>
        <div className="mk-ticks">
          {trades.map((x) => {
            const t = new Date(x.t)
            return (
              <div key={x.t} className="mk-tick">
                <span className="faint">{p2(t.getHours())}:{p2(t.getMinutes())}:{p2(t.getSeconds())}</span>
                <span style={{ color: x.buy ? UP : DOWN }}>{fmtPrice(i.symbol, x.p)}</span>
                <span className="mk-lv-v">{sz(x.v)}</span>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

/* ---------- 期权 T 型报价 ---------- */

function OptionBoard({ und, exp, setUnd, setExp, pick, setPick, now }: {
  und: string; exp: string; setUnd: (s: string) => void; setExp: (s: string) => void
  pick: string | null; setPick: (s: string) => void; now: number
}) {
  const chain = useMemo(() => optionChain(und, exp, 11), [und, exp])
  const u = instOf(und)
  const S = priceAt(und, now)
  const atm = chain.reduce((b, r) => (Math.abs(r.strike - S) < Math.abs(b - S) ? r.strike : b), chain[0]?.strike ?? 0)
  const prev = prevClose(und, now)
  const cols = ['价格', 'IV', 'Delta', 'Gamma', 'Theta', 'Vega'] as const
  const cells = (o: Instrument) => {
    const g = greeks(o, now)
    return [fmtPrice(o.symbol, g.price), `${(g.iv * 100).toFixed(1)}%`, g.delta.toFixed(3), fmtNum(g.gamma), fmtNum(g.theta), fmtNum(g.vega)]
  }
  return (
    <div className="mk-opt">
      <div className="mk-opt-bar">
        <div className="mk-opt-und">
          {OPTION_UNDERLYINGS.map((s) => { const i = instOf(s); return i && <button key={s} className={cls('chip', und === s && 'chip-on')} onClick={() => setUnd(s)}><Dot m={i.market} />{i.name}</button> })}
        </div>
        <div className="seg seg-sm">
          {OPTION_EXPIRIES.map((e) => <button key={e} className={cls(exp === e && 'on')} onClick={() => setExp(e)}>{e.slice(2)}<span className="seg-n">{daysTo(e, now)} 天</span></button>)}
        </div>
      </div>
      {u && <div className="mk-opt-info">
        <span>标的 <b>{u.name}</b></span>
        <span style={{ color: signColor(S - prev) }}><b className="mk-opt-s">{fmtPrice(und, S)}</b> {fmtPct(prev ? (S - prev) / prev : 0)}</span>
        <span className="muted">到期 {exp}，剩 {daysTo(exp, now)} 天</span>
        <span className="spacer" />
        <span className="mk-opt-legend"><i className="mk-itm-sw" />实值</span>
        <span className="mk-opt-legend"><i className="mk-atm-sw" />平值</span>
      </div>}
      <div className="mk-tq-wrap">
        <table className="mk-tq">
          <thead>
            <tr><th colSpan={6} className="mk-tq-side">认购 CALL</th><th className="mk-tq-k" /><th colSpan={6} className="mk-tq-side">认沽 PUT</th></tr>
            <tr>{[...cols].reverse().map((c) => <th key={`c${c}`}>{c}</th>)}<th className="mk-tq-k">行权价</th>{cols.map((c) => <th key={`p${c}`}>{c}</th>)}</tr>
          </thead>
          <tbody>
            {chain.map((r) => {
              const cItm = r.strike < S, pItm = r.strike > S
              const cc = cells(r.call), pc = cells(r.put)
              return (
                <tr key={r.strike} className={cls(r.strike === atm && 'mk-atm')}>
                  {[...cc].reverse().map((v, k) => <td key={`c${k}`} className={cls('mk-tq-c', cItm && 'mk-itm', pick === r.call.symbol && 'mk-picked', k === 5 && 'mk-tq-px')} onClick={() => setPick(r.call.symbol)}>{v}</td>)}
                  <td className="mk-tq-k">{fmtStrike(r.strike)}</td>
                  {pc.map((v, k) => <td key={`p${k}`} className={cls('mk-tq-c', pItm && 'mk-itm', pick === r.put.symbol && 'mk-picked', k === 0 && 'mk-tq-px')} onClick={() => setPick(r.put.symbol)}>{v}</td>)}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <div className="list-sub mk-opt-note">报价按简化 Black-Scholes 用标的价现算，无利率；Theta 为每天，Vega 为 IV 每变动 1 个百分点</div>
    </div>
  )
}

function OptionDetail({ symbol, now, onTrade, onNewAlert }: { symbol: string | null; now: number; onTrade: (s: string, side: 'buy' | 'sell') => void; onNewAlert: (s: string) => void }) {
  const o = symbol ? instOf(symbol) : undefined
  if (!o || o.kind !== 'option') return <div className="mk-side"><div className="mount-empty">点 T 型报价里的一格，看这张期权的详情并下单</div></div>
  const g = greeks(o, now)
  const S = priceAt(o.underlying!, now)
  const K = o.strike!
  const intrinsic = Math.max(0, o.right === 'call' ? S - K : K - S)
  const be = o.right === 'call' ? K + g.price : K - g.price
  const Row = ({ k, v, c }: { k: string; v: React.ReactNode; c?: string }) => <div className="mk-kv"><span className="muted">{k}</span><span style={c ? { color: c } : undefined}>{v}</span></div>
  return (
    <div className="mk-side">
      <div className="mk-box mk-od">
        <div className="mk-od-name">{o.name}<span className={cls('mk-kind', o.right === 'call' ? 'mk-kind-call' : 'mk-kind-put')}>{o.right === 'call' ? '认购' : '认沽'}</span></div>
        <div className="mk-code">{o.symbol} · {o.venue}</div>
        <div className="mk-od-px">{fmtPrice(o.symbol, g.price)}<span className="muted">每张 {fmtPrice(o.symbol, g.price * o.multiplier)}</span></div>
        <Row k="标的价" v={fmtPrice(o.underlying!, S)} />
        <Row k="行权价" v={fmtStrike(K)} />
        <Row k="到期" v={`${o.expiry}（${daysTo(o.expiry!, now)} 天）`} />
        <Row k="合约乘数" v={o.multiplier} />
        <Row k="状态" v={intrinsic > 0 ? '实值' : Math.abs(S - K) / S < 0.0125 ? '平值' : '虚值'} />
        <Row k="内在价值" v={fmtPrice(o.symbol, intrinsic)} />
        <Row k="时间价值" v={fmtPrice(o.symbol, Math.max(0, g.price - intrinsic))} />
        <Row k="盈亏平衡" v={fmtPrice(o.symbol, be)} />
        <div className="mk-greeks">
          {([['IV', `${(g.iv * 100).toFixed(1)}%`], ['Delta', g.delta.toFixed(3)], ['Gamma', fmtNum(g.gamma)], ['Theta', fmtNum(g.theta)], ['Vega', fmtNum(g.vega)]] as const).map(([k, v]) => (
            <div key={k} className="mk-greek"><span className="faint">{k}</span><b>{v}</b></div>
          ))}
        </div>
      </div>
      <div className="mk-trade">
        <button className="mk-buy" onClick={() => onTrade(o.symbol, 'buy')}>买入<span>{fmtPrice(o.symbol, g.price)}</span></button>
        <button className="mk-sell" onClick={() => onTrade(o.symbol, 'sell')}>卖出<span>{fmtPrice(o.symbol, g.price)}</span></button>
      </div>
      <button className="act mk-alert-btn" onClick={() => onNewAlert(o.symbol)}>设提醒</button>
    </div>
  )
}

/* ---------- 页面 ---------- */

export function MarketsPage({ watchlists, onWatchlists, focus, onNewAlert, onTrade }: {
  watchlists: Watchlist[]
  onWatchlists: (fn: (xs: Watchlist[]) => Watchlist[]) => void
  /** 外部要求打开某个标的（来自盯盘、持仓），n 变化触发一次 */
  focus: { symbol: string; n: number } | null
  onNewAlert: (symbol: string) => void
  onTrade: (symbol: string, side: 'buy' | 'sell') => void
}) {
  const now = useNow(1000)
  const [tab, setTab] = useState<'chart' | 'option'>('chart')
  const [wlId, setWlId] = useState(watchlists[0]?.id ?? '')
  const [symbol, setSymbol] = useState(() => watchlists[0]?.symbols[0] ?? INSTRUMENTS[0].symbol)
  const [interval, setInterval_] = useState<BarInterval>('15m')
  const [ov, setOv] = useState<Overlay>({ ma5: true, ma20: true, ma60: false, boll: false })
  const [sub, setSub] = useState<SubKind>('vol')
  const [und, setUnd] = useState(OPTION_UNDERLYINGS[0])
  const [exp, setExp] = useState(OPTION_EXPIRIES[1])
  const [pick, setPick] = useState<string | null>(null)
  const [listOpen, setListOpen] = useState(false)

  const handled = useRef<number | null>(null)
  useEffect(() => {
    if (!focus || handled.current === focus.n) return
    handled.current = focus.n
    const i = instOf(focus.symbol)
    if (!i) return
    if (i.kind === 'option') {
      setTab('option'); setUnd(i.underlying!); setExp(i.expiry!); setPick(i.symbol)
    } else {
      setTab('chart'); setSymbol(i.symbol)
      // 不在当前组时，切到包含它的组
      const cur = watchlists.find((w) => w.id === wlId)
      if (!cur?.symbols.includes(i.symbol)) { const g = watchlists.find((w) => w.symbols.includes(i.symbol)); if (g) setWlId(g.id) }
    }
  }, [focus])

  useEffect(() => {
    if (!listOpen) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setListOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [listOpen])

  const inst = instOf(symbol) ?? INSTRUMENTS[0]
  const pickInst = pick ? instOf(pick) : undefined
  const titleSym = tab === 'option' ? pickInst ?? instOf(und) : inst
  const alertSym = tab === 'option' ? pick ?? und : inst.symbol

  return (
    <div className={cls('mk-page', tab === 'option' && 'mk-page-opt')}>
      <PageTitle desc={titleSym ? `${titleSym.name} · ${titleSym.symbol}` : undefined}
        actions={<button className="btn btn-outline" onClick={() => onNewAlert(alertSym)}>设提醒</button>}>行情</PageTitle>
      <div className="mk-top">
        <div className="seg">
          <button className={cls(tab === 'chart' && 'on')} onClick={() => setTab('chart')}>看盘</button>
          <button className={cls(tab === 'option' && 'on')} onClick={() => setTab('option')}>期权</button>
        </div>
        {tab === 'chart' && <button className="btn btn-outline mk-list-toggle" onClick={() => setListOpen(true)}>自选<span className="faint">{watchlists.find((w) => w.id === wlId)?.name}</span></button>}
      </div>

      {tab === 'chart' ? (
        <div className="mk-body">
          {listOpen && <div className="mk-scrim" onClick={() => setListOpen(false)} />}
          <aside className={cls('mk-left', listOpen && 'open')}>
            <div className="mk-left-head"><span>自选</span><span className="spacer" /><button className="icon-btn icon-btn-sm" onClick={() => setListOpen(false)} title="关闭 (Esc)"><IconX s={12} /></button></div>
            <WatchPanel watchlists={watchlists} onWatchlists={onWatchlists} wlId={wlId} setWlId={setWlId} symbol={symbol} now={now}
              onPick={(s) => { setSymbol(s); setListOpen(false) }} />
          </aside>
          <section className="mk-center">
            <SymbolHead i={inst} now={now} />
            <div className="mk-tools">
              <div className="seg seg-sm">
                {(Object.keys(INTERVALS) as BarInterval[]).map((k) => <button key={k} className={cls(interval === k && 'on')} onClick={() => setInterval_(k)}>{INTERVALS[k].label}</button>)}
              </div>
              <div className="mk-toggles">
                {(['ma5', 'ma20', 'ma60', 'boll'] as const).map((k) => (
                  <button key={k} className={cls('mk-tg', ov[k] && 'on')} onClick={() => setOv({ ...ov, [k]: !ov[k] })}
                    style={{ '--c': k === 'boll' ? BOLL_COLOR : MA_COLOR[k] } as React.CSSProperties}>
                    <i />{k === 'boll' ? 'BOLL' : k.toUpperCase()}
                  </button>
                ))}
              </div>
              <span className="spacer" />
              <div className="seg seg-sm">
                {([['vol', '成交量'], ['macd', 'MACD'], ['rsi', 'RSI']] as [SubKind, string][]).map(([k, l]) => <button key={k} className={cls(sub === k && 'on')} onClick={() => setSub(k)}>{l}</button>)}
              </div>
            </div>
            <KChart symbol={inst.symbol} interval={interval} now={now} ov={ov} sub={sub} />
          </section>
          <aside className="mk-right">
            <BookPanel i={inst} now={now} onTrade={onTrade} onNewAlert={onNewAlert} />
          </aside>
        </div>
      ) : (
        <div className="mk-body mk-body-opt">
          <section className="mk-center mk-center-opt">
            <OptionBoard und={und} exp={exp} setUnd={(s) => { setUnd(s); setPick(null) }} setExp={(e) => { setExp(e); setPick(null) }} pick={pick} setPick={setPick} now={now} />
          </section>
          <aside className="mk-right">
            <OptionDetail symbol={pick} now={now} onTrade={onTrade} onNewAlert={onNewAlert} />
          </aside>
        </div>
      )}
    </div>
  )
}

