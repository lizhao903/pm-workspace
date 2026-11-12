// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { useEffect, useMemo, useRef, useState } from 'react'
import './etf.css'
import { PageTitle } from './topbar'
import { cls } from './ui'
import {
  BASIS, ETF_FUNDS, METRICS, METRIC_KEYS, OPERATORS, SCOPE, SEVERITY, STATUS, allMetrics, buildDataset, condText, evaluateDay,
  fundOf, seedEvents, seedRules,
  type EtfAnomaly, type EtfMetrics, type EtfRule, type EventStatus, type MetricKey, type RuleOperator, type RuleScope, type Severity,
} from './etfdata'

// 宽基监控（SPEC-etf）：份额与资金流、异动、规则三个标签，没有二级菜单。
// 数据都在本页 state 里：「立即采集」把演示数据往后推一个交易日，算这天的指标并按当前规则判定（同后端采集后的流程）。

type Tab = 'flow' | 'events' | 'rules'
const TABS: { key: Tab; label: string }[] = [
  { key: 'flow', label: '份额与资金流' },
  { key: 'events', label: '异动' },
  { key: 'rules', label: '规则' },
]

const UP = 'var(--trade-up, #d4372c)'
const DOWN = 'var(--trade-down, #1f9d55)'
const signColor = (v: number) => (v > 0 ? UP : v < 0 ? DOWN : undefined)
const pct = (v: number, d = 2) => `${v > 0 ? '+' : ''}${v.toFixed(d)}%`
const yi = (v: number) => `${v > 0 ? '+' : ''}${(v / 1e8).toFixed(2)}`
const hm = (iso: string) => iso ? `${iso.slice(5, 10)} ${iso.slice(11, 16)}` : ''

/** 样本不足的格子：显示「—」，悬停提示原因 */
function Na() { return <span className="faint" title="样本不足">—</span> }

function SevPill({ s }: { s: Severity }) {
  return <span className="pill" style={{ '--c': SEVERITY[s].color } as React.CSSProperties}><span className="pill-dot" />{SEVERITY[s].label}</span>
}

function ReviewTag() {
  return <span className="etf-tag etf-tag-warn" title="份额单日变动超过 10% 且没有放量配合，疑似分红、拆分或份额折算">待核</span>
}

/** 近 30 日份额迷你折线 */
function Spark({ vals }: { vals: number[] }) {
  if (vals.length < 2) return <Na />
  const min = Math.min(...vals)
  const max = Math.max(...vals)
  const w = 96
  const h = 24
  const pts = vals.map((v, i) => `${((i / (vals.length - 1)) * w).toFixed(1)},${(max === min ? h / 2 : h - 2 - ((v - min) / (max - min)) * (h - 4)).toFixed(1)}`).join(' ')
  const color = vals[vals.length - 1] >= vals[0] ? UP : DOWN
  return (
    <svg className="etf-spark" viewBox={`0 0 ${w} ${h}`} width={w} height={h} aria-label="近 30 日份额趋势">
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.4" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  )
}

export function EtfPage() {
  const [extra, setExtra] = useState(0)
  const ds = useMemo(() => buildDataset(extra), [extra])
  const metrics = useMemo(() => allMetrics(ds), [ds])
  const [rules, setRules] = useState<EtfRule[]>(seedRules)
  const [events, setEvents] = useState<EtfAnomaly[]>(() => { const d = buildDataset(0); return seedEvents(d, allMetrics(d)) })
  const [tab, setTab] = useState<Tab>('flow')
  const [notice, setNotice] = useState('')
  const [drawer, setDrawer] = useState<{ id: string | null; key: number } | null>(null)
  const seqRef = useRef(0)
  const latest = ds.days[ds.days.length - 1]
  const open = events.filter((e) => e.status === 'open').length

  // 「立即采集」：往后推一个交易日，用推出来的数据算这天的指标、按当前规则判定
  const collect = () => {
    const next = buildDataset(extra + 1)
    const m = allMetrics(next)
    const day = next.days[next.days.length - 1]
    const r = evaluateDay(day, m, rules, events, () => `eae_new${++seqRef.current}`)
    setExtra(extra + 1)
    setEvents(r.events)
    setNotice(`已采集 ${day}：${ETF_FUNDS.length} 只宽基的份额与行情、跟踪指数行情，算完指标${r.fresh ? `，新增 ${r.fresh} 条异动，已发通知` : '，没有新的异动'}`)
  }
  const setStatus = (id: string, status: EventStatus) => setEvents((xs) => xs.map((e) => (e.id === id
    ? { ...e, status, handled_at: status === 'open' ? '' : new Date().toISOString() } : e)))
  const saveRule = (r: EtfRule) => {
    setRules((xs) => (xs.some((x) => x.id === r.id) ? xs.map((x) => (x.id === r.id ? r : x)) : [...xs, r]))
    setDrawer(null)
  }

  return (
    <div className="page page-fill etf-page">
      <PageTitle desc="宽基 ETF 的份额与资金流、异动提醒和规则；只读公开数据"
        actions={tab === 'rules'
          ? <button className="btn btn-primary" onClick={() => setDrawer({ id: null, key: Date.now() })}>新建规则</button>
          : <button className="btn btn-primary" onClick={collect}>立即采集</button>}>宽基监控</PageTitle>

      <div className="np-tabs vd-mtabs etf-tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t.key} role="tab" aria-selected={tab === t.key} className={cls(tab === t.key && 'on')}
            title={t.key === 'events' && open ? `${open} 条异动未处理` : undefined} onClick={() => setTab(t.key)}>
            {t.label}
            {t.key === 'events' && open > 0 && <span className="vd-mtab-n">{open}</span>}
          </button>
        ))}
      </div>

      {notice && (
        <div className="etf-notice">
          <span>{notice}</span><span className="spacer" />
          <button className="act act-quiet" onClick={() => setNotice('')}>知道了</button>
        </div>
      )}

      {tab === 'flow' && <FlowTab latest={latest} ds={ds} metrics={metrics} open={open} onOpenEvents={() => setTab('events')} />}
      {tab === 'events' && <EventsTab events={events} onStatus={setStatus} />}
      {tab === 'rules' && <RulesTab rules={rules} onPatch={(id, p) => setRules((xs) => xs.map((x) => (x.id === id ? { ...x, ...p, updated_at: new Date().toISOString() } : x)))}
        onEdit={(id) => setDrawer({ id, key: Date.now() })} selId={drawer?.id ?? null} />}

      {drawer && <RuleDrawer key={drawer.key} rule={rules.find((r) => r.id === drawer.id) ?? null} onClose={() => setDrawer(null)} onSave={saveRule} />}
    </div>
  )
}

/* ---------- 份额与资金流 ---------- */

function FlowTab({ latest, ds, metrics, open, onOpenEvents }: {
  latest: string
  ds: ReturnType<typeof buildDataset>
  metrics: Map<string, EtfMetrics[]>
  open: number
  onOpenEvents: () => void
}) {
  const rows = ETF_FUNDS.map((f) => {
    const series = ds.daily.filter((d) => d.symbol === f.symbol)
    const ms = metrics.get(f.symbol) ?? []
    return { f, d: series[series.length - 1], m: ms[ms.length - 1], trend: series.slice(-30).map((x) => x.shares) }
  })
  const inflow = rows.reduce((s, r) => s + (r.m.net_inflow ?? 0), 0)
  const ins = rows.filter((r) => (r.m.net_inflow ?? 0) > 0).length
  const outs = rows.filter((r) => (r.m.net_inflow ?? 0) < 0).length
  return (
    <>
      <div className="etf-summary">
        <div className="etf-stat"><span className="etf-stat-k">最新交易日</span><span className="etf-stat-v">{latest}</span></div>
        <div className="etf-stat"><span className="etf-stat-k">合计估算净流入</span><span className="etf-stat-v" style={{ color: signColor(inflow) }}>{yi(inflow)} 亿元</span></div>
        <div className="etf-stat"><span className="etf-stat-k">净流入 / 净流出</span><span className="etf-stat-v"><span style={{ color: UP }}>{ins}</span> / <span style={{ color: DOWN }}>{outs}</span> 只</span></div>
        <button className="etf-stat etf-stat-btn" onClick={onOpenEvents}><span className="etf-stat-k">未处理异动</span><span className={cls('etf-stat-v', open > 0 && 'danger-text')}>{open} 条</span></button>
      </div>
      <div className="etf-scroll">
        <table className="etf-table">
          <thead>
            <tr>
              <th>ETF</th><th>跟踪指数</th><th className="num">收盘</th><th className="num">份额（亿份）</th><th className="num">份额变动</th>
              <th className="num">估算净流入（亿元）</th><th>连续</th><th className="num">量比</th><th className="num">折溢价</th>
              <th className="num" title="近 20 个交易日 ETF 和指数日收益差的年化标准差">跟踪误差</th><th>近 30 日份额</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ f, d, m, trend }) => (
              <tr key={f.symbol}>
                <td><div className="etf-name"><span className="etf-code">{f.symbol}</span><span>{f.name}</span></div></td>
                <td className="muted">{f.track_index}<span className="faint etf-sub">{f.underlying}</span></td>
                <td className="num">{d.price.toFixed(3)}<span className="etf-sub" style={{ color: signColor(d.change_pct) }}>{pct(d.change_pct)}</span></td>
                <td className="num">{(d.shares / 1e8).toFixed(2)}</td>
                <td className="num">
                  {m.share_change_pct === null ? <Na /> : <span style={{ color: signColor(m.share_change_pct) }}>{pct(m.share_change_pct)}</span>}
                  {m.review_flag === 'pending_review' && <> <ReviewTag /></>}
                </td>
                <td className="num">{m.net_inflow === null ? <Na /> : <span style={{ color: signColor(m.net_inflow) }}>{yi(m.net_inflow)}</span>}</td>
                <td>{m.inflow_streak > 0 ? <span style={{ color: UP }}>流入 {m.inflow_streak} 天</span>
                  : m.inflow_streak < 0 ? <span style={{ color: DOWN }}>流出 {-m.inflow_streak} 天</span> : <span className="faint">—</span>}</td>
                <td className="num">{m.amount_ratio === null ? <Na /> : <span className={cls(m.amount_ratio > 2 && 'etf-hot')}>{m.amount_ratio.toFixed(2)}</span>}</td>
                <td className="num">{m.premium_discount === null ? <span className="faint" title="没有 IOPV 也没有净值">—</span>
                  : <span className={cls(Math.abs(m.premium_discount) > 0.5 && 'etf-hot')}>{pct(m.premium_discount)}</span>}
                  <span className="faint etf-sub">{BASIS[m.premium_basis]}</span></td>
                <td className="num">{m.tracking_error === null ? <Na /> : <span className={cls(m.tracking_error > 1 && 'etf-hot')}>{m.tracking_error.toFixed(2)}%</span>}</td>
                <td><Spark vals={trend} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="list-sub">份额按源返回的日期落库（份额是 T+1 披露）；折溢价有 IOPV 用 IOPV，没有用单位净值；量比是当日成交额比之前 20 个交易日均额；跟踪误差要 20 个交易日、历史分位要 60 个交易日，不够显示「—」。</div>
    </>
  )
}

/* ---------- 异动 ---------- */

const SEV_FILTERS: [Severity | 'all', string][] = [['all', '全部'], ['critical', '严重'], ['warn', '警告'], ['info', '提示']]
const STATUS_FILTERS: [EventStatus | 'all', string][] = [['open', '未处理'], ['acked', '已确认'], ['ignored', '已忽略'], ['all', '全部']]

function EventsTab({ events, onStatus }: { events: EtfAnomaly[]; onStatus: (id: string, s: EventStatus) => void }) {
  const [sev, setSev] = useState<Severity | 'all'>('all')
  const [st, setSt] = useState<EventStatus | 'all'>('open')
  const byStatus = events.filter((e) => st === 'all' || e.status === st)
  const rows = byStatus.filter((e) => sev === 'all' || e.severity === sev)
    .sort((a, b) => b.date.localeCompare(a.date) || SEVERITY[a.severity].rank - SEVERITY[b.severity].rank || a.symbol.localeCompare(b.symbol))
  return (
    <>
      <div className="toolbar">
        <div className="seg seg-sm">
          {STATUS_FILTERS.map(([k, l]) => <button key={k} className={cls(st === k && 'on')} onClick={() => setSt(k)}>{l}<span className="seg-n">{events.filter((e) => k === 'all' || e.status === k).length}</span></button>)}
        </div>
        <div className="seg seg-sm">
          {SEV_FILTERS.map(([k, l]) => <button key={k} className={cls(sev === k && 'on')} onClick={() => setSev(k)}>{l}<span className="seg-n">{byStatus.filter((e) => k === 'all' || e.severity === k).length}</span></button>)}
        </div>
      </div>
      {!events.length ? <div className="mount-empty">还没有异动。每天采集后按规则判定，命中的会出现在这里并发通知</div>
        : !rows.length ? <div className="mount-empty">没有符合条件的异动<button className="act act-quiet" onClick={() => { setSev('all'); setSt('all') }}>清除筛选</button></div> : (
          <div className="etf-events">
            {rows.map((e) => (
              <div key={e.id} className={cls('etf-ev', e.status !== 'open' && 'is-done')}>
                <span className="etf-ev-date">{e.date}</span>
                <SevPill s={e.severity} />
                <div className="etf-ev-main">
                  <div className="etf-ev-title">
                    <span className="etf-code">{e.symbol}</span><span>{e.fund_name}</span><span className="faint">·</span><span>{e.rule_name}</span>
                    {e.flag === 'pending_review' && <ReviewTag />}
                  </div>
                  <div className="etf-ev-detail muted">{e.detail}</div>
                </div>
                <div className="etf-ev-acts">
                  {e.status === 'open' ? (
                    <>
                      <button className="btn btn-outline etf-btn-sm" onClick={() => onStatus(e.id, 'acked')}>确认</button>
                      <button className="btn btn-ghost etf-btn-sm" onClick={() => onStatus(e.id, 'ignored')}>忽略</button>
                    </>
                  ) : (
                    <>
                      <span className="faint">{STATUS[e.status]} {hm(e.handled_at)}</span>
                      <button className="act act-quiet" onClick={() => onStatus(e.id, 'open')}>撤回</button>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
    </>
  )
}

/* ---------- 规则 ---------- */

function scopeText(r: EtfRule) {
  if (r.scope === 'symbol') { const f = fundOf(r.scope_value); return `${r.scope_value}${f ? ` ${f.name}` : ''}` }
  if (r.scope === 'index') { const f = ETF_FUNDS.find((x) => x.underlying === r.scope_value || x.track_index === r.scope_value); return `跟踪 ${f?.track_index ?? r.scope_value}` }
  return '全部'
}

function RulesTab({ rules, selId, onPatch, onEdit }: { rules: EtfRule[]; selId: string | null; onPatch: (id: string, p: Partial<EtfRule>) => void; onEdit: (id: string) => void }) {
  return (
    <>
      <div className="etf-scroll">
        <table className="etf-table etf-rules">
          <thead><tr><th>名称</th><th>条件</th><th>范围</th><th>严重度</th><th>启用</th><th /></tr></thead>
          <tbody>
            {rules.map((r) => (
              <tr key={r.id} className={cls(!r.enabled && 'is-off', selId === r.id && 'sel')}>
                <td>{r.name}{r.builtin && <span className="etf-tag">内置</span>}</td>
                <td>{condText(r)}</td>
                <td className="muted">{scopeText(r)}</td>
                <td><SevPill s={r.severity} /></td>
                <td>
                  <label className="switch-line" title={r.enabled ? '停用' : '启用'}>
                    <input type="checkbox" checked={r.enabled} onChange={(e) => onPatch(r.id, { enabled: e.target.checked })} /><span className="switch" />
                  </label>
                </td>
                <td className="num"><button className="act act-quiet" onClick={() => onEdit(r.id)}>编辑</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="list-sub">规则改动从下一次采集起生效；内置的 7 条不能删，可以改阈值、停用。样本不足的指标不判定。</div>
    </>
  )
}

type Draft = Omit<EtfRule, 'threshold' | 'window_days'> & { threshold: string }

function RuleDrawer({ rule, onClose, onSave }: { rule: EtfRule | null; onClose: () => void; onSave: (r: EtfRule) => void }) {
  const now = new Date().toISOString()
  const [d, setD] = useState<Draft>(() => rule ? { ...rule, threshold: String(rule.threshold) }
    : { id: `ear_new${Date.now().toString(36)}`, name: '', scope: 'all', scope_value: '', metric: 'share_change_pct', operator: 'abs_gt', threshold: '',
      severity: 'warn', enabled: true, builtin: false, created_at: now, updated_at: now })
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeRef.current() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  const num = Number(d.threshold)
  const thOk = d.threshold.trim() !== '' && Number.isFinite(num)
  const scopeOk = d.scope === 'all' || d.scope_value.trim() !== ''
  const ok = d.name.trim() !== '' && thOk && scopeOk
  const indexes = [...new Map(ETF_FUNDS.map((f) => [f.underlying, f.track_index])).entries()]
  const save = () => {
    if (!ok) return
    onSave({ ...d, name: d.name.trim(), threshold: num, scope_value: d.scope === 'all' ? '' : d.scope_value, window_days: METRICS[d.metric].window, updated_at: new Date().toISOString() })
  }
  const unit = METRICS[d.metric].unit
  return (
    <aside className="drawer etf-drawer">
      <div className="drawer-head">
        <span className="drawer-kicker">{rule ? '编辑规则' : '新建规则'}</span>
        <div className="spacer" />
        <button className="icon-btn" onClick={onClose} title="关闭 (Esc)">
          <svg viewBox="0 0 16 16" width="14" height="14"><path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
        </button>
      </div>
      <div className="drawer-body form">
        <label className="field"><span className="field-label">名称{rule?.builtin && <span className="field-hint">内置规则</span>}</span>
          <input value={d.name} maxLength={50} placeholder="例如：沪深300 份额骤变" onChange={(e) => setD({ ...d, name: e.target.value })} />
          {!d.name.trim() && d.threshold !== '' && <span className="field-err">名称必填</span>}
        </label>
        <label className="field"><span className="field-label">指标<span className="field-hint">窗口 {METRICS[d.metric].window} 个交易日</span></span>
          <select value={d.metric} onChange={(e) => setD({ ...d, metric: e.target.value as MetricKey })}>
            {METRIC_KEYS.map((k) => <option key={k} value={k}>{METRICS[k].label}{METRICS[k].unit ? `（${METRICS[k].unit}）` : ''}</option>)}
          </select>
        </label>
        <div className="field-row">
          <label className="field"><span className="field-label">比较</span>
            <select value={d.operator} onChange={(e) => setD({ ...d, operator: e.target.value as RuleOperator })}>
              {(Object.keys(OPERATORS) as RuleOperator[]).map((o) => <option key={o} value={o}>{OPERATORS[o]}</option>)}
            </select>
          </label>
          <label className="field"><span className="field-label">阈值<span className="field-hint">{unit || '0-100'}</span></span>
            <input inputMode="decimal" className={cls(d.threshold.trim() !== '' && !thOk && 'bad')} value={d.threshold} placeholder={unit}
              onChange={(e) => setD({ ...d, threshold: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter') save() }} />
          </label>
        </div>
        {d.metric === 'inflow_streak' && <div className="faint etf-hint">连续流入记正数、流出记负数，例如流出 3 天用「≤ -3」</div>}
        <div className="field-row">
          <label className="field"><span className="field-label">范围</span>
            <select value={d.scope} onChange={(e) => setD({ ...d, scope: e.target.value as RuleScope, scope_value: '' })}>
              {(Object.keys(SCOPE) as RuleScope[]).map((s) => <option key={s} value={s}>{SCOPE[s]}</option>)}
            </select>
          </label>
          {d.scope === 'symbol' && (
            <label className="field"><span className="field-label">ETF</span>
              <select value={d.scope_value} onChange={(e) => setD({ ...d, scope_value: e.target.value })}>
                <option value="">选一只</option>
                {ETF_FUNDS.map((f) => <option key={f.symbol} value={f.symbol}>{f.symbol} {f.name}</option>)}
              </select>
            </label>
          )}
          {d.scope === 'index' && (
            <label className="field"><span className="field-label">跟踪指数</span>
              <select value={d.scope_value} onChange={(e) => setD({ ...d, scope_value: e.target.value })}>
                <option value="">选一个</option>
                {indexes.map(([code, name]) => <option key={code} value={code}>{name} {code}</option>)}
              </select>
            </label>
          )}
        </div>
        {!scopeOk && <span className="field-err">选了范围就要选{d.scope === 'symbol' ? '一只 ETF' : '一个跟踪指数'}</span>}
        <div className="field"><span className="field-label">严重度</span>
          <div className="seg seg-full">
            {(['info', 'warn', 'critical'] as Severity[]).map((s) => <button key={s} className={cls(d.severity === s && 'on')} onClick={() => setD({ ...d, severity: s })}>{SEVERITY[s].label}</button>)}
          </div>
        </div>
        <label className="switch-row">
          <span><span>启用</span><span className="switch-hint">停用后保留规则，不再判定</span></span>
          <span className="switch-line"><input type="checkbox" checked={d.enabled} onChange={(e) => setD({ ...d, enabled: e.target.checked })} /><span className="switch" /></span>
        </label>
      </div>
      <div className="drawer-foot">
        <div className="spacer" />
        <button className="btn btn-outline" onClick={onClose}>取消</button>
        <button className="btn btn-primary" disabled={!ok} onClick={save}>保存</button>
      </div>
    </aside>
  )
}
