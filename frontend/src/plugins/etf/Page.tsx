// 宽基监控页（ETF-01b，SPEC-etf-1 到 SPEC-etf-3）：没有二级菜单，顶部三个标签：份额与资金流、异动、规则。
// 标签记在 ?tab=（flows 默认 / anomalies / rules），刷新和分享链接都回到同一个标签。
// 只读公开数据：页面上的写操作只有立即采集、确认或忽略命中、改规则，没有任何交易相关的动作。
import { useState } from 'react'
import { useSearchParams } from 'react-router'
import {
  errorText, useAckEtfAnomaly, useCollectEtf, useEtfAnomalies, useEtfDaily, useEtfFunds, useEtfMetrics, useEtfRules, usePatchEtfRule,
  type EtfAnomaly, type EtfAnomalyStatus, type EtfFund, type EtfRule, type EtfSeverity,
} from '../../core/data'
import { Button, EmptyState, ErrorState, LoadingState, PageTitle, Pill, Switch, Tag, cls } from '../../core/ui'
import {
  BASIS, SCOPES, SEVERITY, STATUS, REVIEW_PENDING, buildRows, fmtMoney, fmtPct, fmtShares, ruleCond, scopeText, sparkPoints, streakText,
  summarize, type FundRow,
} from './model'
import { RuleDrawer } from './RuleDrawer'
import './etf.css'

type Tab = 'flows' | 'anomalies' | 'rules'
const TABS: { key: Tab; label: string }[] = [
  { key: 'flows', label: '份额与资金流' },
  { key: 'anomalies', label: '异动' },
  { key: 'rules', label: '规则' },
]

/** 取数起点：往前 45 个自然日，大约 30 个交易日，够画趋势 */
function fromDay(): string {
  const d = new Date(Date.now() - 45 * 86400000)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export default function Page() {
  const [search, setSearch] = useSearchParams()
  const raw = search.get('tab')
  const tab: Tab = raw === 'anomalies' || raw === 'rules' ? raw : 'flows'
  const open = useEtfAnomalies({ status: 'open' })
  const openCount = open.data?.length ?? 0
  const collect = useCollectEtf()
  const [note, setNote] = useState('')
  const [newRule, setNewRule] = useState(false)

  const onTab = (t: Tab) => {
    const next = new URLSearchParams(search)
    if (t === 'flows') next.delete('tab')
    else next.set('tab', t)
    setSearch(next, { replace: true })
  }

  const runCollect = () => {
    setNote('')
    collect.mutate(undefined, {
      onSuccess: (r) => setNote(`已采集 ${r.date || '最近交易日'}：${r.upserted} 只宽基的份额与行情、${r.indexes} 条跟踪指数行情，算完指标，${
        r.new_hits ? `新增 ${r.new_hits} 条异动，已发通知` : '没有新的异动'}${r.errors.length ? `；${r.errors[0]}` : ''}`),
      onError: (e) => setNote(`采集失败：${errorText(e)}`),
    })
  }

  return (
    <section className="etf-page">
      <PageTitle desc="宽基 ETF 的份额与资金流、异动提醒和规则；只读公开数据"
        actions={tab === 'rules'
          ? <Button size="sm" variant="primary" onClick={() => setNewRule(true)}>新建规则</Button>
          : <Button size="sm" disabled={collect.isPending} onClick={runCollect}>{collect.isPending ? '采集中' : '立即采集'}</Button>}>
        宽基监控
      </PageTitle>
      {note && (
        <div className="etf-note" role="status">
          <span>{note}</span>
          <Button size="sm" onClick={() => setNote('')}>知道了</Button>
        </div>
      )}
      <div className="etf-tabs" role="tablist" aria-label="宽基监控">
        {TABS.map((t) => (
          <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} className={cls(tab === t.key && 'on')} onClick={() => onTab(t.key)}
            title={t.key === 'anomalies' && openCount > 0 ? `${openCount} 条异动未处理` : undefined}>
            {t.label}
            {t.key === 'anomalies' && openCount > 0 && <span className="etf-tab-n" aria-label={`${openCount} 条未处理`}>{openCount}</span>}
          </button>
        ))}
      </div>
      {tab === 'flows' && <FlowsTab openCount={openCount} onOpenAnomalies={() => onTab('anomalies')} />}
      {tab === 'anomalies' && <AnomaliesTab />}
      {tab === 'rules' && <RulesTab creating={newRule} onCreated={() => setNewRule(false)} />}
    </section>
  )
}

/* ---------- 份额与资金流（SPEC-etf-1） ---------- */

function FlowsTab({ openCount, onOpenAnomalies }: { openCount: number; onOpenAnomalies: () => void }) {
  const [from] = useState(fromDay)
  const funds = useEtfFunds()
  const daily = useEtfDaily(from)
  const metrics = useEtfMetrics(from)
  if (funds.isPending || daily.isPending || metrics.isPending) return <LoadingState />
  if (funds.isError || daily.isError || metrics.isError) {
    return <ErrorState title="宽基数据没加载出来" error={errorText(funds.error ?? daily.error ?? metrics.error)}
      onRetry={() => { void funds.refetch(); void daily.refetch(); void metrics.refetch() }} />
  }
  const { date, rows } = buildRows(funds.data, daily.data, metrics.data)
  if (!funds.data.length || !date) {
    return <EmptyState title="还没有采集到数据" desc="每天收盘后自动采集一次，也可以点右上「立即采集」" />
  }
  const sum = summarize(rows)
  return (
    <>
      <div className="etf-summary">
        <div><span>最新交易日</span><b>{date}</b></div>
        <div><span>合计估算净流入</span><b className={cls(sum.inflow > 0 && 'up', sum.inflow < 0 && 'down')}>{fmtMoney(sum.inflow)}</b></div>
        <div><span>净流入 / 净流出</span><b>{sum.up} 只 / {sum.down} 只</b></div>
        <button type="button" className="etf-sum-link" onClick={onOpenAnomalies}>
          <span>未处理异动</span><b className={cls(openCount > 0 && 'etf-alert')}>{openCount} 条</b>
        </button>
      </div>
      <div className="etf-scroll">
        <table className="etf-table">
          <thead>
            <tr>
              <th>ETF</th><th>跟踪指数</th><th className="num">收盘</th><th className="num">份额</th><th className="num">份额变动</th>
              <th className="num">估算净流入</th><th>连续</th><th className="num">量比</th><th className="num">折溢价</th>
              <th className="num" title="近 20 个交易日 ETF 和指数日收益差的年化标准差">跟踪误差</th><th>近 30 日份额</th>
            </tr>
          </thead>
          <tbody>{rows.map((r) => <FundLine key={r.fund.symbol} row={r} />)}</tbody>
        </table>
      </div>
      <p className="etf-faint etf-foot">
        份额是 T+1 披露，按数据源给的日期落库。折溢价有 IOPV 用 IOPV，没有用单位净值。量比是当日成交额比之前 20 个交易日均额（不含当日），
        跟踪误差看近 20 个交易日，历史分位要 60 个交易日，样本不够显示「—」、不判定。标红加粗的是越过内置规则默认阈值的数。
      </p>
    </>
  )
}

const SHORT = '样本不足'

/** 越过内置规则默认阈值的格子标红加粗（SPEC-etf-1.7）：固定按内置阈值，不跟着用户改的规则变 */
const HOT = { amount_ratio: 2, premium_discount: 0.5, tracking_error: 1 }
const hot = (v: number | null | undefined, th: number, abs = false) => v != null && (abs ? Math.abs(v) : v) > th && 'etf-hot'

function FundLine({ row }: { row: FundRow }) {
  const { fund, daily: d, metrics: m } = row
  const review = m?.review_flag === REVIEW_PENDING
  const basis = m?.premium_basis || d?.premium_basis || ''
  return (
    <tr>
      <td><span className="etf-sym">{fund.symbol}</span> {fund.name}</td>
      <td>{fund.track_index} <span className="etf-sym">{fund.underlying}</span></td>
      <td className="num">
        {d ? <>{d.price.toFixed(3)} <span className={cls('etf-chg', d.change_pct > 0 && 'up', d.change_pct < 0 && 'down')}>{fmtPct(d.change_pct)}</span></> : '—'}
      </td>
      <td className="num">{d ? fmtShares(d.shares) : '—'}</td>
      <td className="num" title={m?.share_change_pct == null ? SHORT : undefined}>
        {fmtPct(m?.share_change_pct)}
        {review && <span className="etf-review" title="份额单日变动超过 10% 且没有放量配合，疑似分红、拆分或份额折算"><Tag>待核</Tag></span>}
      </td>
      <td className={cls('num', (m?.net_inflow ?? 0) > 0 && 'up', (m?.net_inflow ?? 0) < 0 && 'down')} title={m?.net_inflow == null ? SHORT : undefined}>
        {m?.net_inflow == null ? '—' : fmtMoney(m.net_inflow)}
      </td>
      <td className={cls(m && m.inflow_streak > 0 && 'up', m && m.inflow_streak < 0 && 'down')}>{m ? streakText(m.inflow_streak) : '—'}</td>
      <td className={cls('num', hot(m?.amount_ratio, HOT.amount_ratio))} title={m?.amount_ratio == null ? '样本不足：之前不到 20 个交易日' : undefined}>
        {m?.amount_ratio == null ? '—' : m.amount_ratio.toFixed(2)}
      </td>
      <td className={cls('num', hot(m?.premium_discount, HOT.premium_discount, true))}
        title={m?.premium_discount == null ? '口径不可用：没有 IOPV 也没有净值' : `按${BASIS[basis as keyof typeof BASIS] ?? ''}算`}>
        {fmtPct(m?.premium_discount, 3)}
        {basis && <span className="etf-basis">{BASIS[basis as keyof typeof BASIS]}</span>}
      </td>
      <td className={cls('num', hot(m?.tracking_error, HOT.tracking_error))} title={m?.tracking_error == null ? '样本不足：不到 20 个交易日或缺指数行情' : '近 20 日年化'}>
        {fmtPct(m?.tracking_error, 2, false)}
      </td>
      <td><Spark vals={row.trend} /></td>
    </tr>
  )
}

function Spark({ vals }: { vals: number[] }) {
  const pts = sparkPoints(vals, 96, 24)
  if (!pts) return <span className="etf-faint">—</span>
  const up = vals[vals.length - 1] >= vals[0]
  return (
    <svg className={cls('etf-spark', up ? 'up' : 'down')} width="96" height="24" viewBox="0 0 96 24" role="img" aria-label={`近 ${vals.length} 天份额${up ? '增加' : '减少'}`}>
      <polyline points={pts} fill="none" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  )
}

/* ---------- 异动（SPEC-etf-2） ---------- */

const STATUS_SEGS: { key: EtfAnomalyStatus | ''; label: string }[] = [
  { key: 'open', label: STATUS.open }, { key: 'acked', label: STATUS.acked }, { key: 'ignored', label: STATUS.ignored }, { key: '', label: '全部' },
]
const SEV_SEGS: { key: EtfSeverity | ''; label: string }[] = [
  { key: '', label: '全部' }, ...(['critical', 'warn', 'info'] as const).map((k) => ({ key: k, label: SEVERITY[k].label })),
]

/** 分段按钮：每段后面是条数 */
function Seg<K extends string>({ label, segs, value, counts, onChange }: {
  label: string
  segs: { key: K; label: string }[]
  value: K
  counts: (k: K) => number
  onChange: (k: K) => void
}) {
  return (
    <span className="etf-seg" role="group" aria-label={label}>
      {segs.map((x) => (
        <button key={x.key || 'all'} type="button" aria-pressed={value === x.key} className={cls(value === x.key && 'on')} onClick={() => onChange(x.key)}>
          {x.label}<span className="seg-n">{counts(x.key)}</span>
        </button>
      ))}
    </span>
  )
}

/** 处理时间：月-日 时:分（本机时区） */
function handledText(at: string): string {
  const d = new Date(at)
  if (Number.isNaN(d.getTime())) return ''
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function AnomaliesTab() {
  const [severity, setSeverity] = useState<EtfSeverity | ''>('')
  const [status, setStatus] = useState<EtfAnomalyStatus | ''>('open')
  // 一次取全部，在本地按状态、严重度筛，分段上的条数才算得出来
  const all = useEtfAnomalies({})
  const ack = useAckEtfAnomaly()
  const [err, setErr] = useState('')
  const act = (a: EtfAnomaly, st: EtfAnomalyStatus) => {
    setErr('')
    ack.mutate({ id: a.id, status: st }, { onError: (e) => setErr(errorText(e)) })
  }
  if (all.isPending) return <LoadingState />
  if (all.isError) return <ErrorState title="异动没加载出来" error={errorText(all.error)} onRetry={() => void all.refetch()} />
  const byStatus = all.data.filter((a) => !status || a.status === status)
  const list = byStatus.filter((a) => !severity || a.severity === severity)
  return (
    <>
      <div className="etf-filters">
        <Seg label="状态" segs={STATUS_SEGS} value={status} onChange={setStatus}
          counts={(k) => (k ? all.data.filter((a) => a.status === k).length : all.data.length)} />
        <Seg label="严重度" segs={SEV_SEGS} value={severity} onChange={setSeverity}
          counts={(k) => (k ? byStatus.filter((a) => a.severity === k).length : byStatus.length)} />
        {err && <span className="field-err" role="alert">{err}</span>}
      </div>
      {!all.data.length ? (
        <EmptyState title="还没有异动" desc="每天采集后按规则判定，命中的会出现在这里并发通知" />
      ) : !list.length ? (
        <EmptyState title="没有符合条件的异动" action={<Button size="sm" onClick={() => { setSeverity(''); setStatus('') }}>清除筛选</Button>} />
      ) : (
        <ul className="etf-events">
          {list.map((a) => (
            <li key={a.id} className={cls('etf-event', a.status !== 'open' && 'done')}>
              <span className="etf-date">{a.date}</span>
              <Pill label={SEVERITY[a.severity]?.label ?? a.severity} color={SEVERITY[a.severity]?.color} />
              <span className="etf-ev-main">
                <b><span className="etf-sym">{a.symbol}</span> {a.fund_name || a.symbol} · {a.rule_name}</b>
                <span className="etf-ev-detail">{a.detail}</span>
              </span>
              {a.flag === REVIEW_PENDING && <Tag>待核</Tag>}
              <span className="etf-ev-acts">
                {a.status === 'open' ? (
                  <>
                    <Button size="sm" variant="outline" disabled={ack.isPending} onClick={() => act(a, 'acked')}>确认</Button>
                    <Button size="sm" disabled={ack.isPending} onClick={() => act(a, 'ignored')}>忽略</Button>
                  </>
                ) : (
                  <>
                    <span className="etf-faint">{STATUS[a.status]} {handledText(a.handled_at)}</span>
                    <Button size="sm" disabled={ack.isPending} onClick={() => act(a, 'open')}>撤回</Button>
                  </>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </>
  )
}

/* ---------- 规则（SPEC-etf-3） ---------- */

function RulesTab({ creating, onCreated }: { creating: boolean; onCreated: () => void }) {
  const rules = useEtfRules()
  const funds = useEtfFunds()
  const patch = usePatchEtfRule()
  const [editing, setEditing] = useState<EtfRule | 'new' | null>(null)
  const [err, setErr] = useState('')
  if (rules.isPending) return <LoadingState />
  if (rules.isError) return <ErrorState title="规则没加载出来" error={errorText(rules.error)} onRetry={() => void rules.refetch()} />
  const fundList: EtfFund[] = funds.data ?? []
  const toggle = (r: EtfRule, on: boolean) => {
    setErr('')
    patch.mutate({ id: r.id, patch: { enabled: on } }, { onError: (e) => setErr(errorText(e)) })
  }
  return (
    <>
      <div className="etf-filters">
        {err && <span className="field-err" role="alert">{err}</span>}
      </div>
      <div className="etf-scroll">
        <table className="etf-table">
          <thead><tr><th>名称</th><th>条件</th><th>范围</th><th>严重度</th><th>启用</th><th /></tr></thead>
          <tbody>
            {rules.data.map((r) => (
              <tr key={r.id} className={cls(!r.enabled && 'off')}>
                <td>{r.name}{r.builtin && <span className="etf-basis">内置</span>}</td>
                <td>{ruleCond(r)}</td>
                <td>{r.scope === 'all' ? SCOPES.all : scopeText(r, fundList)}</td>
                <td><Pill label={SEVERITY[r.severity]?.label ?? r.severity} color={SEVERITY[r.severity]?.color} /></td>
                <td><Switch aria-label={`启用 ${r.name}`} checked={r.enabled} disabled={patch.isPending} onCheckedChange={(on) => toggle(r, on)} /></td>
                <td><Button size="sm" onClick={() => setEditing(r)}>编辑</Button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="etf-faint etf-foot">规则改动从下一次采集起生效；内置的 7 条不能删，可以改阈值、停用。样本不足的指标不判定。</p>
      {(editing || creating) && (
        <RuleDrawer rule={creating || editing === 'new' ? null : editing} funds={fundList} onClose={() => { setEditing(null); onCreated() }} />
      )}
    </>
  )
}
