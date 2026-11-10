// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import './markets.css'
import { PageTitle } from './topbar'
import { cls, timeAgo } from './ui'
import {
  ALERT_COND, DOWN, INSTRUMENTS, MARKETS, OPTION_EXPIRIES, OPTION_UNDERLYINGS, SESSION_LABEL, UP,
  bars, fmtPct, fmtPrice, instOf, optionChain, prevClose, priceAt, sessionOf,
  type AlertCond, type AlertEvent, type AlertNotify, type MarketKey, type PriceAlert, type SessionState, type Watchlist,
} from './tradedata'
import { condFits, condValue, fmtCondValue } from './alertcheck'
import { newId } from './ids'
import { SearchSelect } from './searchselect'
import { SymbolPicker } from './symbolpick'

// 盯盘：市场时段、盯盘墙（迷你分时）、提醒规则、触发记录
// checkAlerts 是纯函数（alertcheck.ts），主会话每 5 秒调用一次，负责写 last_fired_at 和追加触发记录
// 页面本身不跟秒走：时钟、盯盘墙、规则的「当前值」各自订阅下面的共用时钟，规则行和触发记录都是 memo

/* ---------- 共用的秒级时钟 ---------- */

const clock = { now: Date.now(), subs: new Set<() => void>(), timer: 0 }
function subscribeClock(fn: () => void) {
  clock.subs.add(fn)
  if (!clock.timer) {
    clock.now = Date.now()
    clock.timer = window.setInterval(() => { clock.now = Date.now(); clock.subs.forEach((f) => f()) }, 1000)
  }
  return () => {
    clock.subs.delete(fn)
    if (!clock.subs.size) { window.clearInterval(clock.timer); clock.timer = 0 }
  }
}
const noSub = () => () => {}
const readClock = () => clock.now
/** on 为 false 时不订阅，停在上次渲染的时刻 */
function useClock(on = true) { return useSyncExternalStore(on ? subscribeClock : noSub, readClock) }

/** 元素在不在可视区附近；不在的规则行不跟着时钟算当前值 */
function useNearView<T extends Element>() {
  const ref = useRef<T>(null)
  const [near, setNear] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const io = new IntersectionObserver(([e]) => setNear(e.isIntersecting), { rootMargin: '200px 0px' })
    io.observe(el)
    return () => io.disconnect()
  }, [])
  return [ref, near] as const
}

// 判定逻辑在 alertcheck.ts（纯函数，后端照它移植并对拍）；这里转出去给 App.tsx、markets.tsx 用
export { checkAlerts, condFits, fundingRate } from './alertcheck'

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

function SessionCards() {
  const now = useClock()
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

/** 提醒能选的标的：全部标的按市场排，加上各标的第二个到期日的平值认购 / 认沽；当前标的不在里面时放最前 */
function symbolChoices(extra: string) {
  const opts = OPTION_UNDERLYINGS.flatMap((u) => { const ch = optionChain(u, OPTION_EXPIRIES[1], 11); const mid = ch[ch.length >> 1]; return mid ? [mid.call, mid.put] : [] })
  const all = [...(Object.keys(MARKETS) as MarketKey[]).flatMap((m) => INSTRUMENTS.filter((x) => x.market === m)), ...opts]
  const ex = instOf(extra)
  return ex && !all.some((x) => x.symbol === extra) ? [ex, ...all] : all
}

type Draft = Omit<PriceAlert, 'id' | 'created_at' | 'value'> & { value: string }

/** 推 IM 的连接器；不是已连接的在下拉里标出来，选了给提示（SPEC-monitor-0.2） */
type ImConn = { id: string; name: string; status?: string }
const CONN_STATUS: Record<string, string> = { connecting: '连接中', error: '异常', paused: '已暂停', disconnected: '已断开' }

function AlertDrawer({ alert, symbol, imConnectors, onClose, onSave, onDelete }: {
  alert: PriceAlert | null
  symbol: string
  imConnectors: ImConn[]
  onClose: () => void
  onSave: (d: Omit<PriceAlert, 'id' | 'created_at'>) => void
  onDelete: () => void
}) {
  const [d, setD] = useState<Draft>(() => alert
    ? { ...alert, value: String(alert.value) }
    : { symbol, cond: 'price_above', value: '', repeat: false, cooldown_min: 30, notify: ['app'], im_connector: imConnectors[0]?.id, enabled: true, note: '' })
  const [confirmDel, setConfirmDel] = useState(false)
  const now = useClock()
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeRef.current() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  const pool = useMemo(() => symbolChoices(d.symbol), [d.symbol])
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
        <div className="field"><span className="field-label">标的<span className="field-hint">期权只列平值</span></span>
          <SymbolPicker value={d.symbol} onChange={setSymbol} pool={pool} side={inst ? <span>{fmtPrice(d.symbol, priceAt(d.symbol, now))}</span> : undefined} />
        </div>
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
          {isPrice(d.cond) && <span className="faint">价格在阈值{d.cond === 'price_above' ? '上方' : '下方'}时就算满足</span>}
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
                  {imConnectors.map((c) => <option key={c.id} value={c.id}>{c.status && c.status !== 'connected' ? `${c.name}（${CONN_STATUS[c.status] ?? c.status}）` : c.name}</option>)}
                </select>
                {(() => { const c = imConnectors.find((x) => x.id === d.im_connector); return c?.status && c.status !== 'connected' ? <span className="field-hint-line">这个连接器现在{CONN_STATUS[c.status] ?? c.status}，提醒推不出去</span> : null })()}
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

/* ---------- 盯盘墙：自己订阅时钟 ---------- */

function Wall({ wl, size, onOpenChart }: { wl: Watchlist; size: 2 | 3 | 4; onOpenChart: (symbol: string) => void }) {
  const now = useClock()
  const cells = wl.symbols.slice(0, size * size)
  return (
    <div className={cls('mo-wall', `mo-wall-${size}`)}>
      {Array.from({ length: size * size }, (_, k) => cells[k]
        ? <WallCell key={cells[k]} symbol={cells[k]} now={now} onOpen={() => onOpenChart(cells[k])} />
        : <div key={`e${k}`} className="mo-cell mo-cell-empty">空位</div>)}
    </div>
  )
}

/* ---------- 提醒规则 ---------- */

type RuleFilter = 'all' | 'on' | 'fired' | 'off'
const RULE_FILTERS: [RuleFilter, string][] = [['all', '全部'], ['on', '启用'], ['fired', '已触发'], ['off', '停用']]
const ruleIn = (a: PriceAlert, f: RuleFilter) => f === 'all' || (f === 'on' ? a.enabled : f === 'off' ? !a.enabled : !!a.last_fired_at)
/** 规则先露这么多条 */
const RULE_PAGE = 50

/** 当前值：只有启用、并且在可视区附近的规则跟着时钟算 */
function CurValue({ a }: { a: PriceAlert }) {
  const [ref, near] = useNearView<HTMLSpanElement>()
  const now = useClock(a.enabled && near)
  const v = condValue(a.cond, a.symbol, now)
  return <span ref={ref} className="mo-r-cur">{v === null ? '-' : fmtCondValue(a.cond, a.symbol, v)}</span>
}

const AlertRow = memo(function AlertRow({ a, sel, imName, onOpen, onPatch }: {
  a: PriceAlert; sel: boolean; imName?: string
  onOpen: (a: PriceAlert) => void
  onPatch: (id: string, p: Partial<PriceAlert>) => void
}) {
  const i = instOf(a.symbol)
  const fits = condFits(a.cond, i)
  const spent = !a.repeat && !!a.last_fired_at
  return (
    <div className={cls('mo-rrow', !a.enabled && 'is-off', sel && 'sel')} onClick={() => onOpen(a)}>
      <span className="mo-r-sym">
        <span className="mo-r-name"><span className="mk-dot" style={{ background: i ? MARKETS[i.market].color : 'var(--faint)' }} /><span className="ellipsis">{i?.name ?? a.symbol}</span></span>
        {a.note && <span className="mo-r-note ellipsis">{a.note}</span>}
      </span>
      <span className="mo-r-cond">{ALERT_COND[a.cond].label} <b>{isPrice(a.cond) ? fmtPrice(a.symbol, a.value) : a.value}</b> <span className="faint">{isPrice(a.cond) ? '' : ALERT_COND[a.cond].unit}</span>{!fits && <span className="state state-bad">不适用</span>}</span>
      <CurValue a={a} />
      <span className="mo-r-notify">{a.notify.map((n) => <span key={n} className="tag">{n === 'im' ? `IM${imName ? `：${imName}` : ''}` : NOTIFY_LABEL[n]}</span>)}</span>
      <span className="mo-r-rep">{a.repeat ? `重复 · 冷却 ${a.cooldown_min} 分` : '单次'}</span>
      <span className="mo-r-last">
        {a.last_fired_at ? <span title={new Date(a.last_fired_at).toLocaleString('zh-CN')}>{timeAgo(a.last_fired_at)}</span> : <span className="faint">未触发</span>}
        {spent && <button className="act act-quiet mo-rearm" onClick={(e) => { e.stopPropagation(); onPatch(a.id, { last_fired_at: undefined }) }} title="单次提醒已经响过，清掉触发记录重新检查">重新上膛</button>}
      </span>
      <span className="mo-r-sw" onClick={(e) => e.stopPropagation()}>
        <label className="switch-line" title={a.enabled ? '停用' : '启用'}>
          <input type="checkbox" checked={a.enabled} onChange={(e) => onPatch(a.id, { enabled: e.target.checked })} /><span className="switch" />
        </label>
      </span>
    </div>
  )
})

function RulesPanel({ alerts, selId, imConnectors, onOpen, onPatch, onNew }: {
  alerts: PriceAlert[]; selId: string | null
  imConnectors: ImConn[]
  onOpen: (a: PriceAlert) => void
  onPatch: (id: string, p: Partial<PriceAlert>) => void
  onNew: () => void
}) {
  const [f, setF] = useState<RuleFilter>('all')
  const [q, setQ] = useState('')
  const [limit, setLimit] = useState(RULE_PAGE)
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const rows = useMemo(() => alerts.filter((a) => {
    if (!ruleIn(a, f)) return false
    if (!words.length) return true
    const hay = `${instOf(a.symbol)?.name ?? ''} ${a.symbol} ${a.note} ${ALERT_COND[a.cond].label}`.toLowerCase()
    return words.every((w) => hay.includes(w))
  }), [alerts, f, words.join(' ')])
  const shown = rows.slice(0, limit)
  const connName = (id?: string) => imConnectors.find((c) => c.id === id)?.name
  const setFilter = (k: RuleFilter) => { setF(k); setLimit(RULE_PAGE) }
  return (
    <section className="mo-section mo-rules">
      <div className="toolbar"><span className="mo-h">提醒规则</span><span className="list-count">{alerts.length}</span><span className="spacer" /><button className="act" onClick={onNew}>新建提醒</button></div>
      {!alerts.length ? <div className="mount-empty">还没有提醒。价格上穿下穿、涨跌幅、放量、资金费率、隐含波动率、接近涨跌停都能盯</div> : (
        <>
          <div className="toolbar mo-rules-bar">
            <div className="seg seg-sm">
              {RULE_FILTERS.map(([k, l]) => <button key={k} className={cls(f === k && 'on')} onClick={() => setFilter(k)}>{l}<span className="seg-n">{alerts.filter((a) => ruleIn(a, k)).length}</span></button>)}
            </div>
            <span className="spacer" />
            <div className="search search-sm mo-rules-search">
              <svg viewBox="0 0 16 16" width="13" height="13"><circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
              <input placeholder="搜标的、代码、备注" value={q} onChange={(e) => { setQ(e.target.value); setLimit(RULE_PAGE) }} onKeyDown={(e) => { if (e.key === 'Escape' && q) { e.stopPropagation(); setQ('') } }} />
              {q && <button className="search-clear" title="清空" onClick={() => setQ('')}><svg viewBox="0 0 16 16" width="10" height="10"><path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg></button>}
            </div>
          </div>
          {!rows.length ? <div className="mount-empty">没有匹配的提醒</div> : (
            <div className="mo-table">
              <div className="mo-rrow mo-th"><span>标的</span><span>条件</span><span>当前值</span><span>通知</span><span>触发方式</span><span>上次触发</span><span>启用</span></div>
              {shown.map((a) => <AlertRow key={a.id} a={a} sel={selId === a.id} imName={a.notify.includes('im') ? connName(a.im_connector) : undefined} onOpen={onOpen} onPatch={onPatch} />)}
            </div>
          )}
          {rows.length > limit && <button className="act act-quiet mo-more" onClick={() => setLimit(limit + RULE_PAGE)}>再显示 {Math.min(RULE_PAGE, rows.length - limit)} 条<span className="faint">（共 {rows.length} 条）</span></button>}
        </>
      )}
    </section>
  )
}

/* ---------- 触发记录：按天分段，先露 20 条 ---------- */

const EV_FIRST = 20
const EV_STEP = 50
function dayLabel(iso: string) {
  const d = new Date(iso)
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const diff = Math.round((today.getTime() - new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()) / 86400000)
  if (diff === 0) return '今天'
  if (diff === 1) return '昨天'
  return d.getFullYear() === today.getFullYear() ? `${d.getMonth() + 1} 月 ${d.getDate()} 日` : `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日`
}

const EventsPanel = memo(function EventsPanel({ events, onRead, onReadAll, onOpenChart }: {
  events: AlertEvent[]
  onRead: (id: string) => void
  onReadAll: () => void
  onOpenChart: (symbol: string) => void
}) {
  const [limit, setLimit] = useState(EV_FIRST)
  const sorted = useMemo(() => [...events].sort((a, b) => b.at.localeCompare(a.at)), [events])
  const unread = events.filter((e) => !e.read).length
  const shown = sorted.slice(0, limit)
  const rest = sorted.length - shown.length
  return (
    <section className="mo-section mo-events">
      <div className="toolbar">
        <span className="mo-h">触发记录</span>{unread > 0 && <span className="mo-unread">{unread} 条未读</span>}
        <span className="spacer" />
        <button className="act act-quiet" disabled={!unread} onClick={onReadAll}>全部已读</button>
      </div>
      {!sorted.length ? <div className="mount-empty">提醒触发后记在这里</div> : (
        <ol className="mo-timeline">
          {shown.map((e, k) => {
            const i = instOf(e.symbol)
            const day = dayLabel(e.at)
            return (
              <Fragment key={e.id}>
                {(k === 0 || dayLabel(shown[k - 1].at) !== day) && <li className="mo-ev-day">{day}</li>}
                <li className={cls('mo-ev', !e.read && 'unread')}>
                  <span className="mo-ev-dot" />
                  <button className="mo-ev-body" title="打开图表" onClick={() => { if (!e.read) onRead(e.id); onOpenChart(e.symbol) }}>
                    <span className="mo-ev-text">{e.text}</span>
                    <span className="mo-ev-meta">
                      <span title={new Date(e.at).toLocaleString('zh-CN')}>{timeAgo(e.at)}</span>
                      <span>触发价 {i ? fmtPrice(e.symbol, e.price) : e.price}</span>
                      <span className="link">看图表</span>
                    </span>
                  </button>
                </li>
              </Fragment>
            )
          })}
        </ol>
      )}
      {rest > 0 && <button className="act act-quiet mo-more" onClick={() => setLimit(limit + EV_STEP)}>更早的 {rest} 条<span className="faint">（每次再显示 {Math.min(EV_STEP, rest)} 条）</span></button>}
    </section>
  )
})

/* ---------- 页面 ---------- */

export function MonitorPage({ alerts, events, watchlists, imConnectors, onAlerts, onEvents, onOpenChart, newRequest }: {
  alerts: PriceAlert[]; events: AlertEvent[]; watchlists: Watchlist[]
  imConnectors: ImConn[]
  onAlerts: (fn: (xs: PriceAlert[]) => PriceAlert[]) => void
  onEvents: (fn: (xs: AlertEvent[]) => AlertEvent[]) => void
  onOpenChart: (symbol: string) => void
  /** 外部要求新建某标的的提醒，n 变化即打开新建抽屉 */
  newRequest: { symbol: string; n: number } | null
}) {
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

  // 回调走 ref，给 memo 的规则行和触发记录传稳定的函数
  const live = useRef({ onAlerts, onEvents, onOpenChart })
  useEffect(() => { live.current = { onAlerts, onEvents, onOpenChart } })
  const patch = useCallback((id: string, p: Partial<PriceAlert>) => live.current.onAlerts((xs) => xs.map((a) => (a.id === id ? { ...a, ...p } : a))), [])
  const openRule = useCallback((a: PriceAlert) => setDrawer({ id: a.id, symbol: a.symbol, key: Date.now() }), [])
  const openChart = useCallback((s: string) => live.current.onOpenChart(s), [])
  const readOne = useCallback((id: string) => live.current.onEvents((xs) => xs.map((x) => (x.id === id ? { ...x, read: true } : x))), [])
  const readAll = useCallback(() => live.current.onEvents((xs) => xs.map((e) => (e.read ? e : { ...e, read: true }))), [])

  const defaultSymbol = wl?.symbols[0] ?? INSTRUMENTS[0].symbol
  const openNew = () => setDrawer({ id: null, symbol: defaultSymbol, key: Date.now() })
  const editing = drawer?.id ? alerts.find((a) => a.id === drawer.id) ?? null : null

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

  return (
    <div className="page page-fill mo-page">
      <PageTitle count={`${alerts.filter((a) => a.enabled).length} 条提醒启用中`} desc="市场时段、盯盘墙、价格提醒和触发记录"
        actions={<button className="btn btn-primary" onClick={openNew}>新建提醒</button>}>盯盘</PageTitle>

      <SessionCards />

      <section className="mo-section">
        <div className="toolbar">
          <span className="mo-h">盯盘墙</span>
          {wl && (
            <SearchSelect value={wl.id} onChange={(id) => { if (id) setWlId(id) }} searchPlaceholder="搜自选组" aria-label="自选组"
              options={watchlists.map((w) => ({ value: w.id, label: w.name, hint: `${w.symbols.length} 个` }))} />
          )}
          <div className="seg seg-sm">
            {([2, 3, 4] as const).map((n) => <button key={n} className={cls(size === n && 'on')} onClick={() => setSize(n)}>{n}x{n}</button>)}
          </div>
          <span className="spacer" />
          <span className="faint mo-legend">5 分钟涨跌超过 1% 的格子会描边</span>
        </div>
        {!wl ? <div className="mount-empty">还没有自选组，到「行情」里建一个</div> : <Wall wl={wl} size={size} onOpenChart={openChart} />}
        {wl && wl.symbols.length > size * size && <div className="list-sub">这组有 {wl.symbols.length} 个标的，只显示前 {size * size} 个，换更大的网格看全</div>}
      </section>

      <div className="mo-cols">
        <RulesPanel alerts={alerts} selId={drawer?.id ?? null} imConnectors={imConnectors} onOpen={openRule} onPatch={patch} onNew={openNew} />
        <EventsPanel events={events} onRead={readOne} onReadAll={readAll} onOpenChart={openChart} />
      </div>

      {drawer && (
        <AlertDrawer key={drawer.key} alert={editing} symbol={drawer.symbol} imConnectors={imConnectors}
          onClose={() => setDrawer(null)} onSave={save} onDelete={remove} />
      )}
    </div>
  )
}
