import { useEffect, useMemo, useRef, useState } from 'react'
import './markets.css'
import { PageTitle } from './topbar'
import { cls, timeAgo } from './ui'
import {
  ALERT_COND, DOWN, INSTRUMENTS, MARKETS, OPTION_EXPIRIES, OPTION_UNDERLYINGS, SESSION_LABEL, UP,
  bars, fmtPct, fmtPrice, greeks, instOf, optionChain, prevClose, priceAt, sessionOf, useNow,
  type AlertCond, type AlertEvent, type AlertNotify, type Instrument, type MarketKey, type PriceAlert, type SessionState, type Watchlist,
} from './tradedata'
import { newId } from './ids'

// 盯盘：市场时段、盯盘墙（迷你分时）、提醒规则、触发记录
// checkAlerts 是纯函数，主会话每 5 秒调用一次，负责写 last_fired_at 和追加触发记录

const TAU = Math.PI * 2
function hashStr(s: string) { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0 }

/** 模拟资金费率（单位 %，每 8 小时结算一次的费率）；只有永续有，其它返回 0。看盘页显示的也是它 */
export function fundingRate(symbol: string, at = Date.now()): number {
  const i = instOf(symbol)
  if (!i || i.kind !== 'perp') return 0
  const h = hashStr(symbol)
  const t = at / 3600000
  const v = 0.012
    + 0.03 * Math.sin(TAU * (t / 9 + (h % 100) / 100))
    + 0.018 * Math.sin(TAU * (t / 1.7 + (h % 37) / 37))
    + 0.006 * Math.sin(TAU * (t / 0.25 + (h % 13) / 13))
  return Math.round(v * 10000) / 10000
}

/** 条件是否适用于这个标的 */
export function condFits(cond: AlertCond, i: Instrument | undefined) {
  if (!i) return false
  const k = ALERT_COND[cond].kinds
  if (k && !k.includes(i.kind)) return false
  if (cond === 'limit_near' && !i.limit) return false
  return true
}

/** 按条件的单位算当前值：价格、涨跌幅 %、量比、资金费率 %、IV %、距涨跌停 % */
function condValue(cond: AlertCond, symbol: string, at: number): number | null {
  const i = instOf(symbol)
  if (!condFits(cond, i)) return null
  const last = priceAt(symbol, at)
  switch (cond) {
    case 'price_above': case 'price_below': return last
    case 'pct_above': case 'pct_below': {
      const prev = prevClose(symbol, at)
      const pct = prev ? ((last - prev) / prev) * 100 : 0
      return cond === 'pct_above' ? pct : -pct
    }
    case 'volume_spike': {
      const xs = bars(symbol, '1m', 21, at)
      const avg = xs.slice(0, -1).reduce((s, b) => s + Math.abs(b.v), 0) / Math.max(1, xs.length - 1)
      return avg ? Math.abs(xs[xs.length - 1].v) / avg : 0
    }
    case 'funding_above': return fundingRate(symbol, at)
    case 'iv_above': return greeks(i!, at).iv * 100
    case 'limit_near': {
      const prev = prevClose(symbol, at)
      const up = prev * (1 + i!.limit!), down = prev * (1 - i!.limit!)
      return (Math.min(up - last, last - down) / prev) * 100
    }
  }
}

function hit(cond: AlertCond, v: number, th: number) {
  if (cond === 'price_below' || cond === 'limit_near') return v <= th
  return v >= th
}

function fmtCondValue(cond: AlertCond, symbol: string, v: number) {
  if (cond === 'price_above' || cond === 'price_below') return fmtPrice(symbol, v)
  if (cond === 'volume_spike') return `${v.toFixed(2)} 倍`
  if (cond === 'funding_above') return `${v.toFixed(4)}%`
  return `${v.toFixed(2)}%`
}

function alertText(a: PriceAlert, v: number) {
  const name = instOf(a.symbol)?.name ?? a.symbol
  const th = a.cond === 'price_above' || a.cond === 'price_below' ? fmtPrice(a.symbol, a.value) : String(a.value)
  switch (a.cond) {
    case 'price_above': return `${name} 价格 ${fmtPrice(a.symbol, v)}，上穿 ${th}`
    case 'price_below': return `${name} 价格 ${fmtPrice(a.symbol, v)}，下穿 ${th}`
    case 'pct_above': return `${name} 涨幅 ${v.toFixed(2)}%，超过 ${th}%`
    case 'pct_below': return `${name} 跌幅 ${v.toFixed(2)}%，超过 ${th}%`
    case 'volume_spike': return `${name} 1 分钟成交量是 20 根均量的 ${v.toFixed(2)} 倍，超过 ${th} 倍`
    case 'funding_above': return `${name} 资金费率 ${v.toFixed(4)}%，高于 ${th}%`
    case 'iv_above': return `${name} 隐含波动率 ${v.toFixed(1)}%，高于 ${th}%`
    case 'limit_near': return `${name} 距涨跌停 ${v.toFixed(2)}%，在 ${th}% 以内`
  }
}

/** 纯函数：给定时刻哪些提醒该触发 */
export function checkAlerts(alerts: PriceAlert[], at: number): { alert: PriceAlert; text: string; price: number }[] {
  const out: { alert: PriceAlert; text: string; price: number }[] = []
  for (const a of alerts) {
    if (!a.enabled) continue
    const i = instOf(a.symbol)
    if (!condFits(a.cond, i)) continue
    if (a.last_fired_at) {
      // 单次提醒触发过就不再响；重复提醒要过了冷却
      if (!a.repeat) continue
      if (at - new Date(a.last_fired_at).getTime() < Math.max(0, a.cooldown_min) * 60000) continue
    }
    const v = condValue(a.cond, a.symbol, at)
    if (v === null || !Number.isFinite(v) || !hit(a.cond, v, a.value)) continue
    out.push({ alert: a, text: alertText(a, v), price: priceAt(a.symbol, at) })
  }
  return out
}

/* ---------- 市场时段 ---------- */

const TZ_CITY: Record<MarketKey, string> = { crypto: 'UTC', cn: '上海', hk: '香港', us: '纽约' }
const STEP = 300000
/** 下一次时段变化、下一次开盘；时段边界都在 5 分钟整点上 */
function sessionPlan(m: MarketKey, at: number) {
  const cur = sessionOf(m, at)
  let change: { s: SessionState; at: number } | null = null
  let open: number | null = cur === 'open' ? at : null
  let t = Math.floor(at / STEP) * STEP + STEP
  for (let k = 0; k < 1600 && (!change || open === null); k++, t += STEP) {
    const s = sessionOf(m, t)
    if (!change && s !== cur) change = { s, at: t }
    if (open === null && s === 'open') open = t
  }
  return { change, open }
}
export function fmtSpan(ms: number) {
  const m = Math.max(0, Math.ceil(ms / 60000))
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60
  if (d) return `${d} 天 ${h} 小时`
  if (h) return `${h} 小时 ${String(mm).padStart(2, '0')} 分`
  return `${mm} 分钟`
}
const SESSION_COLOR: Record<SessionState, string> = { open: 'var(--ok)', pre: 'var(--warn)', post: 'var(--warn)', break: 'var(--warn)', closed: 'var(--faint)' }
export const SessionPill = ({ s }: { s: SessionState }) => <span className="pill" style={{ '--c': SESSION_COLOR[s] } as React.CSSProperties}><span className="pill-dot" />{SESSION_LABEL[s]}</span>

function SessionCards({ now }: { now: number }) {
  const minute = Math.floor(now / 60000) * 60000
  const plans = useMemo(() => (['cn', 'hk', 'us'] as MarketKey[]).map((m) => [m, sessionPlan(m, minute)] as const), [minute])
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
          ? p.change ? `距${p.change.s === 'break' ? '午休' : '收盘'} ${fmtSpan(p.change.at - now)}` : ''
          : p.open ? `距开盘 ${fmtSpan(p.open - now)}` : ''
        return (
          <div key={m} className="mo-sess">
            <div className="mo-sess-head"><span className="mk-dot" style={{ background: MARKETS[m].color }} /><span className="mo-sess-name">{MARKETS[m].label}</span><span className="spacer" /><SessionPill s={s} /></div>
            <div className="mo-sess-clock">{clock(MARKETS[m].tz)}<span className="mo-sess-tz">{TZ_CITY[m]}</span></div>
            <div className="mo-sess-sub">{text}</div>
          </div>
        )
      })}
    </div>
  )
}

/* ---------- 盯盘墙 ---------- */

const ANOMALY = 0.01
function WallCell({ symbol, now, onOpen }: { symbol: string; now: number; onOpen: () => void }) {
  const i = instOf(symbol)
  const minute = Math.floor(now / 60000) * 60000
  const hist = useMemo(() => bars(symbol, '1m', 120, minute).map((b) => b.c), [symbol, minute])
  if (!i) return <div className="mo-cell mo-cell-empty">{symbol} 已下线</div>
  const last = priceAt(symbol, now)
  const prev = prevClose(symbol, now)
  const pct = prev ? (last - prev) / prev : 0
  const p5 = priceAt(symbol, now - 300000)
  const d5 = p5 ? (last - p5) / p5 : 0
  const hot = Math.abs(d5) >= ANOMALY
  const pts = [...hist.slice(0, -1), last]
  const lo = Math.min(...pts), hi = Math.max(...pts), span = hi - lo || 1
  const path = pts.map((p, k) => `${k ? 'L' : 'M'}${((k / (pts.length - 1)) * 120).toFixed(2)},${(38 - ((p - lo) / span) * 34).toFixed(2)}`).join('')
  const color = pct >= 0 ? UP : DOWN
  return (
    <button className={cls('mo-cell', hot && 'mo-cell-hot')} onClick={onOpen} title="打开图表">
      <div className="mo-cell-head">
        <span className="mk-dot" style={{ background: MARKETS[i.market].color }} />
        <span className="mo-cell-name ellipsis">{i.name}</span>
        {hot && <span className="mo-hot-tag">异动 {fmtPct(d5)} / 5 分</span>}
      </div>
      <div className="mo-cell-px">
        <span className="mo-cell-last" style={{ color }}>{fmtPrice(symbol, last)}</span>
        <span className="mo-cell-pct" style={{ color }}>{fmtPct(pct)}</span>
      </div>
      <svg className="mo-spark" viewBox="0 0 120 40" preserveAspectRatio="none">
        <path d={`${path}L120,40L0,40Z`} style={{ fill: color, opacity: 0.08 }} />
        <path d={path} fill="none" style={{ stroke: color }} strokeWidth="1.4" vectorEffect="non-scaling-stroke" />
      </svg>
    </button>
  )
}

/* ---------- 提醒抽屉 ---------- */

const NOTIFY_LABEL: Record<AlertNotify, string> = { app: '应用内', im: 'IM', sound: '声音' }
const isPrice = (c: AlertCond) => c === 'price_above' || c === 'price_below'

function symbolChoices(extra: string) {
  // 期权取各标的第二个到期日的平值认购 / 认沽
  const opts = OPTION_UNDERLYINGS.flatMap((u) => { const ch = optionChain(u, OPTION_EXPIRIES[1], 11); const mid = ch[ch.length >> 1]; return mid ? [mid.call, mid.put] : [] })
  const groups: { label: string; items: Instrument[] }[] = (Object.keys(MARKETS) as MarketKey[]).map((m) => ({ label: MARKETS[m].label, items: INSTRUMENTS.filter((x) => x.market === m) }))
  groups.push({ label: '期权（平值）', items: opts })
  const all = groups.flatMap((g) => g.items)
  const ex = instOf(extra)
  if (ex && !all.some((x) => x.symbol === extra)) groups.unshift({ label: '当前标的', items: [ex] })
  return groups
}

type Draft = Omit<PriceAlert, 'id' | 'created_at' | 'value'> & { value: string }

function AlertDrawer({ alert, symbol, imConnectors, now, onClose, onSave, onDelete }: {
  alert: PriceAlert | null
  symbol: string
  imConnectors: { id: string; name: string }[]
  now: number
  onClose: () => void
  onSave: (d: Omit<PriceAlert, 'id' | 'created_at'>) => void
  onDelete: () => void
}) {
  const [d, setD] = useState<Draft>(() => alert
    ? { ...alert, value: String(alert.value) }
    : { symbol, cond: 'price_above', value: '', repeat: false, cooldown_min: 30, notify: ['app'], im_connector: imConnectors[0]?.id, enabled: true, note: '' })
  const [confirmDel, setConfirmDel] = useState(false)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeRef.current() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  const groups = useMemo(() => symbolChoices(d.symbol), [d.symbol])
  const inst = instOf(d.symbol)
  const conds = (Object.keys(ALERT_COND) as AlertCond[]).filter((c) => condFits(c, inst))
  const cur = condValue(d.cond, d.symbol, now)
  const num = Number(d.value)
  const valueOk = d.value.trim() !== '' && Number.isFinite(num)
  const imOk = !d.notify.includes('im') || !!d.im_connector
  const ok = valueOk && imOk && d.notify.length > 0 && !!inst

  const setSymbol = (s: string) => {
    const i = instOf(s)
    setD({ ...d, symbol: s, cond: condFits(d.cond, i) ? d.cond : 'price_above', value: '' })
  }
  const toggleNotify = (n: AlertNotify) => setD({ ...d, notify: d.notify.includes(n) ? d.notify.filter((x) => x !== n) : [...d.notify, n] })
  const fill = () => {
    if (cur === null) return
    const v = isPrice(d.cond) ? fmtPrice(d.symbol, cur).replace(/,/g, '') : d.cond === 'funding_above' ? cur.toFixed(4) : cur.toFixed(2)
    setD({ ...d, value: v })
  }
  const save = () => {
    if (!ok) return
    const { value: _v, ...rest } = d
    onSave({ ...rest, value: num, cooldown_min: Math.max(0, Number(d.cooldown_min) || 0), im_connector: d.notify.includes('im') ? d.im_connector : undefined })
  }

  return (
    <aside className="drawer mo-drawer">
      <div className="drawer-head">
        <span className="drawer-kicker">{alert ? '编辑提醒' : '新建提醒'}</span>
        <div className="spacer" />
        <button className="icon-btn" onClick={onClose} title="关闭 (Esc)">
          <svg viewBox="0 0 16 16" width="14" height="14"><path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
        </button>
      </div>
      <div className="drawer-body form">
        <label className="field"><span className="field-label">标的</span>
          <select value={d.symbol} onChange={(e) => setSymbol(e.target.value)}>
            {groups.map((g) => (
              <optgroup key={g.label} label={g.label}>
                {g.items.map((x) => <option key={x.symbol} value={x.symbol}>{x.name}（{x.symbol}）</option>)}
              </optgroup>
            ))}
          </select>
        </label>
        <div className="field-row">
          <label className="field"><span className="field-label">条件<span className="field-hint">按品种过滤</span></span>
            <select value={d.cond} onChange={(e) => setD({ ...d, cond: e.target.value as AlertCond, value: '' })}>
              {conds.map((c) => <option key={c} value={c}>{ALERT_COND[c].label}</option>)}
            </select>
          </label>
          <label className="field"><span className="field-label">阈值<span className="field-hint">{ALERT_COND[d.cond].unit}</span></span>
            <input inputMode="decimal" className={cls(d.value.trim() !== '' && !valueOk && 'bad')} value={d.value} placeholder={ALERT_COND[d.cond].unit}
              onChange={(e) => setD({ ...d, value: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter') save() }} />
          </label>
        </div>
        <div className="mo-cur">
          <span className="muted">当前值</span>
          <span className="mo-cur-v">{cur === null ? '-' : fmtCondValue(d.cond, d.symbol, cur)}</span>
          {d.cond === 'pct_below' && <span className="faint">跌幅按正数填，例如 4 表示跌 4%</span>}
          {d.cond === 'limit_near' && <span className="faint">离涨停或跌停的距离，占昨收的百分比</span>}
          <span className="spacer" />
          <button className="act act-quiet" disabled={cur === null} onClick={fill}>填入当前值</button>
        </div>

        <section className="field-group">
          <div className="field-group-title">通知方式</div>
          <div className="act-row">
            {(Object.keys(NOTIFY_LABEL) as AlertNotify[]).map((n) => (
              <label key={n} className="check check-lg"><input type="checkbox" checked={d.notify.includes(n)} onChange={() => toggleNotify(n)} />{NOTIFY_LABEL[n]}</label>
            ))}
          </div>
          {d.notify.includes('im') && (
            imConnectors.length ? (
              <label className="field"><span className="field-label">推送到</span>
                <select value={d.im_connector ?? ''} onChange={(e) => setD({ ...d, im_connector: e.target.value || undefined })}>
                  <option value="">选一个 IM 连接器</option>
                  {imConnectors.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </label>
            ) : <div className="mount-empty">还没有可用的 IM 连接器，到 设置 &gt; 连接器 里接一个</div>
          )}
          {!d.notify.length && <span className="field-err">至少选一种通知方式</span>}
        </section>

        <section className="field-group">
          <div className="field-group-title">触发方式</div>
          <div className="seg seg-full">
            <button className={cls(!d.repeat && 'on')} onClick={() => setD({ ...d, repeat: false })}>单次：触发后停止</button>
            <button className={cls(d.repeat && 'on')} onClick={() => setD({ ...d, repeat: true })}>重复：满足就提醒</button>
          </div>
          {d.repeat && (
            <label className="field"><span className="field-label">冷却<span className="field-hint">两次提醒至少间隔多少分钟</span></span>
              <input inputMode="numeric" value={String(d.cooldown_min)} onChange={(e) => setD({ ...d, cooldown_min: Number(e.target.value.replace(/\D/g, '')) || 0 })} />
            </label>
          )}
          <label className="switch-row">
            <span><span>启用</span><span className="switch-hint">停用后保留规则，不再检查</span></span>
            <span className="switch-line"><input type="checkbox" checked={d.enabled} onChange={(e) => setD({ ...d, enabled: e.target.checked })} /><span className="switch" /></span>
          </label>
        </section>

        <label className="field"><span className="field-label">备注<span className="field-hint">触发时一起显示，写打算怎么处理</span></span>
          <textarea rows={3} value={d.note} onChange={(e) => setD({ ...d, note: e.target.value })} />
        </label>
      </div>
      <div className="drawer-foot">
        {alert && (confirmDel
          ? <><span className="danger-text">确认删除？</span><button className="btn btn-danger" onClick={onDelete}>删除</button><button className="btn btn-ghost" onClick={() => setConfirmDel(false)}>算了</button></>
          : <button className="btn btn-ghost" onClick={() => setConfirmDel(true)}>删除</button>)}
        <div className="spacer" />
        <button className="btn btn-outline" onClick={onClose}>取消</button>
        <button className="btn btn-primary" disabled={!ok} onClick={save}>保存</button>
      </div>
    </aside>
  )
}

/* ---------- 页面 ---------- */

export function MonitorPage({ alerts, events, watchlists, imConnectors, onAlerts, onEvents, onOpenChart, newRequest }: {
  alerts: PriceAlert[]; events: AlertEvent[]; watchlists: Watchlist[]
  imConnectors: { id: string; name: string }[]
  onAlerts: (fn: (xs: PriceAlert[]) => PriceAlert[]) => void
  onEvents: (fn: (xs: AlertEvent[]) => AlertEvent[]) => void
  onOpenChart: (symbol: string) => void
  /** 外部要求新建某标的的提醒，n 变化即打开新建抽屉 */
  newRequest: { symbol: string; n: number } | null
}) {
  const now = useNow(1000)
  const [wlId, setWlId] = useState(watchlists[0]?.id ?? '')
  const wl = watchlists.find((w) => w.id === wlId) ?? watchlists[0]
  const [size, setSize] = useState<2 | 3 | 4>(3)
  const [drawer, setDrawer] = useState<{ id: string | null; symbol: string; key: number } | null>(null)
  const handled = useRef<number | null>(null)
  useEffect(() => {
    if (!newRequest || handled.current === newRequest.n) return
    handled.current = newRequest.n
    setDrawer({ id: null, symbol: newRequest.symbol, key: Date.now() })
  }, [newRequest])

  const defaultSymbol = wl?.symbols[0] ?? INSTRUMENTS[0].symbol
  const openNew = () => setDrawer({ id: null, symbol: defaultSymbol, key: Date.now() })
  const editing = drawer?.id ? alerts.find((a) => a.id === drawer.id) ?? null : null
  const connName = (id?: string) => imConnectors.find((c) => c.id === id)?.name

  const save = (x: Omit<PriceAlert, 'id' | 'created_at'>) => {
    if (editing) {
      // 单次提醒改了条件就重新上膛
      const changed = editing.symbol !== x.symbol || editing.cond !== x.cond || editing.value !== x.value
      const next: PriceAlert = { ...editing, ...x, last_fired_at: changed && !x.repeat ? undefined : editing.last_fired_at }
      onAlerts((xs) => xs.map((a) => (a.id === next.id ? next : a)))
    } else {
      const a: PriceAlert = { ...x, id: newId('al'), created_at: new Date().toISOString() }
      onAlerts((xs) => [a, ...xs])
    }
    setDrawer(null)
  }
  const remove = () => {
    if (!editing) return
    const id = editing.id
    onAlerts((xs) => xs.filter((a) => a.id !== id))
    setDrawer(null)
  }
  const patch = (id: string, p: Partial<PriceAlert>) => onAlerts((xs) => xs.map((a) => (a.id === id ? { ...a, ...p } : a)))

  const sortedEvents = [...events].sort((a, b) => b.at.localeCompare(a.at))
  const unread = events.filter((e) => !e.read).length
  const cells = wl ? wl.symbols.slice(0, size * size) : []

  return (
    <div className="page page-fill mo-page">
      <PageTitle count={`${alerts.filter((a) => a.enabled).length} 条提醒启用中`} desc="市场时段、盯盘墙、价格提醒和触发记录"
        actions={<button className="btn btn-primary" onClick={openNew}>新建提醒</button>}>盯盘</PageTitle>

      <SessionCards now={now} />

      <section className="mo-section">
        <div className="toolbar">
          <span className="mo-h">盯盘墙</span>
          <label className="chip chip-select chip-on">
            <select value={wl?.id ?? ''} onChange={(e) => setWlId(e.target.value)}>
              {watchlists.map((w) => <option key={w.id} value={w.id}>{w.name}（{w.symbols.length}）</option>)}
            </select>
          </label>
          <div className="seg seg-sm">
            {([2, 3, 4] as const).map((n) => <button key={n} className={cls(size === n && 'on')} onClick={() => setSize(n)}>{n}x{n}</button>)}
          </div>
          <span className="spacer" />
          <span className="faint mo-legend">5 分钟涨跌超过 1% 的格子会描边</span>
        </div>
        {!wl ? <div className="mount-empty">还没有自选组，到「行情」里建一个</div> : (
          <div className={cls('mo-wall', `mo-wall-${size}`)}>
            {Array.from({ length: size * size }, (_, k) => cells[k]
              ? <WallCell key={cells[k]} symbol={cells[k]} now={now} onOpen={() => onOpenChart(cells[k])} />
              : <div key={`e${k}`} className="mo-cell mo-cell-empty">空位</div>)}
          </div>
        )}
        {wl && wl.symbols.length > size * size && <div className="list-sub">这组有 {wl.symbols.length} 个标的，只显示前 {size * size} 个，换更大的网格看全</div>}
      </section>

      <div className="mo-cols">
        <section className="mo-section mo-rules">
          <div className="toolbar"><span className="mo-h">提醒规则</span><span className="list-count">{alerts.length}</span><span className="spacer" /><button className="act" onClick={openNew}>新建提醒</button></div>
          {!alerts.length ? <div className="mount-empty">还没有提醒。价格上穿下穿、涨跌幅、放量、资金费率、隐含波动率、接近涨跌停都能盯</div> : (
            <div className="mo-table">
              <div className="mo-rrow mo-th"><span>标的</span><span>条件</span><span>当前值</span><span>通知</span><span>触发方式</span><span>上次触发</span><span>启用</span></div>
              {alerts.map((a) => {
                const i = instOf(a.symbol)
                const v = condValue(a.cond, a.symbol, now)
                const fits = condFits(a.cond, i)
                const spent = !a.repeat && !!a.last_fired_at
                return (
                  <div key={a.id} className={cls('mo-rrow', !a.enabled && 'is-off', drawer?.id === a.id && 'sel')} onClick={() => setDrawer({ id: a.id, symbol: a.symbol, key: Date.now() })}>
                    <span className="mo-r-sym">
                      <span className="mo-r-name"><span className="mk-dot" style={{ background: i ? MARKETS[i.market].color : 'var(--faint)' }} /><span className="ellipsis">{i?.name ?? a.symbol}</span></span>
                      {a.note && <span className="mo-r-note ellipsis">{a.note}</span>}
                    </span>
                    <span className="mo-r-cond">{ALERT_COND[a.cond].label} <b>{isPrice(a.cond) ? fmtPrice(a.symbol, a.value) : a.value}</b> <span className="faint">{isPrice(a.cond) ? '' : ALERT_COND[a.cond].unit}</span>{!fits && <span className="state state-bad">不适用</span>}</span>
                    <span className="mo-r-cur">{v === null ? '-' : fmtCondValue(a.cond, a.symbol, v)}</span>
                    <span className="mo-r-notify">{a.notify.map((n) => <span key={n} className="tag">{n === 'im' ? `IM${connName(a.im_connector) ? `：${connName(a.im_connector)}` : ''}` : NOTIFY_LABEL[n]}</span>)}</span>
                    <span className="mo-r-rep">{a.repeat ? `重复 · 冷却 ${a.cooldown_min} 分` : '单次'}</span>
                    <span className="mo-r-last">
                      {a.last_fired_at ? <span title={new Date(a.last_fired_at).toLocaleString('zh-CN')}>{timeAgo(a.last_fired_at)}</span> : <span className="faint">未触发</span>}
                      {spent && <button className="act act-quiet mo-rearm" onClick={(e) => { e.stopPropagation(); patch(a.id, { last_fired_at: undefined }) }} title="单次提醒已经响过，清掉触发记录重新检查">重新上膛</button>}
                    </span>
                    <span className="mo-r-sw" onClick={(e) => e.stopPropagation()}>
                      <label className="switch-line" title={a.enabled ? '停用' : '启用'}>
                        <input type="checkbox" checked={a.enabled} onChange={(e) => patch(a.id, { enabled: e.target.checked })} /><span className="switch" />
                      </label>
                    </span>
                  </div>
                )
              })}
            </div>
          )}
        </section>

        <section className="mo-section mo-events">
          <div className="toolbar">
            <span className="mo-h">触发记录</span>{unread > 0 && <span className="mo-unread">{unread} 条未读</span>}
            <span className="spacer" />
            <button className="act act-quiet" disabled={!unread} onClick={() => onEvents((xs) => xs.map((e) => (e.read ? e : { ...e, read: true })))}>全部已读</button>
          </div>
          {!sortedEvents.length ? <div className="mount-empty">提醒触发后记在这里</div> : (
            <ol className="mo-timeline">
              {sortedEvents.map((e) => {
                const i = instOf(e.symbol)
                return (
                  <li key={e.id} className={cls('mo-ev', !e.read && 'unread')}>
                    <span className="mo-ev-dot" />
                    <button className="mo-ev-body" title="打开图表" onClick={() => { if (!e.read) onEvents((xs) => xs.map((x) => (x.id === e.id ? { ...x, read: true } : x))); onOpenChart(e.symbol) }}>
                      <span className="mo-ev-text">{e.text}</span>
                      <span className="mo-ev-meta">
                        <span title={new Date(e.at).toLocaleString('zh-CN')}>{timeAgo(e.at)}</span>
                        <span>触发价 {i ? fmtPrice(e.symbol, e.price) : e.price}</span>
                        <span className="link">看图表</span>
                      </span>
                    </button>
                  </li>
                )
              })}
            </ol>
          )}
        </section>
      </div>

      {drawer && (
        <AlertDrawer key={drawer.key} alert={editing} symbol={drawer.symbol} imConnectors={imConnectors} now={now}
          onClose={() => setDrawer(null)} onSave={save} onDelete={remove} />
      )}
    </div>
  )
}
