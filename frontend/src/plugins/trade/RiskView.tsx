// 风控（SPEC-trading-10，TRD-06b）：当日亏损、规则、一键全停、熔断记录。规则和熔断都在后端强制（TRD-06a），
// 这里改规则（PATCH /api/trade/risk，离开输入框生效）、发起一键全停、看熔断记录；解除熔断在熔断条上，要写原因。
import { useState } from 'react'
import {
  errorText, usePatchTradeRisk, useTradeHalts,
  type TradeRisk, type TradeRiskRules,
} from '../../core/data'
import { Button, ErrorState, LoadingState, cls } from '../../core/ui'
import { fmtTime, signedUsd, tone, usd } from './tradingModel'

type Q<T> = { data: T | undefined; isPending: boolean; isError: boolean; error: unknown; refetch: () => unknown }

const RULES: { k: keyof TradeRiskRules; label: string; unit: string; desc: string; max?: number }[] = [
  { k: 'daily_loss_pct', label: '单日最大亏损', unit: '% 权益', desc: '当日亏损（已实现加未实现，UTC 0 点重置）到总权益的这个比例，自动熔断：停所有策略、撤所有挂单、禁止新开仓', max: 100 },
  { k: 'max_order_value', label: '单笔最大金额', unit: 'USD', desc: '开仓单金额超过这个数直接拦截；平仓不受限' },
  { k: 'max_position_pct', label: '单标的最大仓位', unit: '% 账户权益', desc: '下单后同一账户里这个标的的市值占比不能超过它', max: 100 },
  { k: 'max_leverage', label: '合约最大杠杆', unit: '倍', desc: '永续、交割期货下单时的杠杆上限，开平仓都查' },
  { k: 'confirm_above', label: '二次确认阈值', unit: 'USD', desc: '手动单（含平仓）金额超过它，提交前要再确认一次；部署的单不要' },
]

export function RiskView({ risk, killing, onKill }: { risk: Q<TradeRisk>; killing: boolean; onKill: () => void }) {
  const [draft, setDraft] = useState<Partial<Record<keyof TradeRiskRules, string>>>({})
  const [confirmKill, setConfirmKill] = useState(false)
  const patch = usePatchTradeRisk()
  const halts = useTradeHalts()
  if (risk.data === undefined) {
    return risk.isError ? <ErrorState title="风控没取到" error={errorText(risk.error)} onRetry={() => void risk.refetch()} /> : <LoadingState />
  }
  const r = risk.data
  const day = r.day
  const val = (k: keyof TradeRiskRules) => draft[k] ?? String(r[k])
  const badOf = (k: keyof TradeRiskRules, max?: number) => {
    const s = draft[k]
    if (s === undefined) return false
    const v = Number(s)
    return !(v > 0) || (max !== undefined && v > max)
  }
  const commit = (k: keyof TradeRiskRules, max?: number) => {
    const s = draft[k]
    if (s === undefined) return
    if (badOf(k, max) || Number(s) === r[k]) {
      if (!badOf(k, max)) setDraft(({ [k]: _drop, ...rest }) => rest)
      return
    }
    patch.mutate({ [k]: Number(s) }, { onSuccess: () => setDraft(({ [k]: _drop, ...rest }) => rest) })
  }
  const pct = day.loss_limit ? Math.min(1, day.loss_used / day.loss_limit) : 0
  return (
    <div className="tr-risk">
      <section className="tr-sec">
        <div className="tr-sec-title">当日亏损<span className="tr-hint">{day.date} UTC · 当日盈亏 / 上限（起始权益 {usd(day.start_equity)} 的 {r.daily_loss_pct}%）</span></div>
        <div className="tr-loss-big">
          <span className="tr-num" style={{ color: tone(day.pnl) }}>{signedUsd(day.pnl, 2)}</span>
          <span className="faint tr-num">已用 {usd(day.loss_used, 2)} / {usd(day.loss_limit, 2)}</span>
          <span className="spacer" />
          <span className={cls('tr-num', pct > 0.8 ? 'danger-text' : 'tr-muted')}>{(pct * 100).toFixed(0)}%</span>
        </div>
        <div className="tr-bar tr-bar-lg" role="progressbar" aria-label="当日亏损进度" aria-valuenow={Math.round(pct * 100)} aria-valuemin={0} aria-valuemax={100}>
          <i className={cls(pct > 0.8 && 'hot')} style={{ width: `${pct * 100}%` }} />
        </div>
        <div className="faint tr-small">
          {day.status === 'stale' ? '有持仓的现价不是实时，这一刻不判定日亏损（数按缓存估）。'
            : day.pnl >= 0 ? '今天还在盈利，不占亏损额度' : pct >= 1 ? '已到上限，触发熔断' : `再亏 ${usd(day.loss_limit - day.loss_used, 2)} 触发熔断`}
        </div>
      </section>

      <section className="tr-sec">
        <div className="tr-sec-title">规则<span className="tr-hint">改完离开输入框生效；每笔下单在后端按这里检查，放宽规则不会自动解除熔断</span></div>
        {patch.error && <div className="tr-inline-msg tr-inline-bad" role="alert"><span>没存上：{errorText(patch.error)}</span></div>}
        <div className="tr-rules">
          {RULES.map((x) => {
            const bad = badOf(x.k, x.max)
            return (
              <div key={x.k} className="tr-rule">
                <div className="tr-rule-text"><b>{x.label}</b><span className="faint tr-small">{x.desc}</span></div>
                <div className="tr-rule-input">
                  <input className={cls('tr-input', bad && 'bad')} inputMode="decimal" aria-label={x.label} aria-invalid={bad || undefined} value={val(x.k)}
                    onChange={(e) => setDraft({ ...draft, [x.k]: e.target.value })}
                    onBlur={() => commit(x.k, x.max)} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }} />
                  <span className="faint tr-small tr-unit">{x.unit}</span>
                </div>
                {bad && <span className="field-err tr-rule-err">要大于 0{x.max ? `，不超过 ${x.max}` : ''}</span>}
              </div>
            )
          })}
        </div>
      </section>

      <section className="tr-sec tr-sec-bad">
        <div className="tr-sec-title">一键全停<span className="tr-hint">停掉所有策略运行、撤掉所有挂单、进入熔断；持仓保留</span></div>
        {confirmKill ? (
          <div className="tr-act-row">
            <span className="danger-text">确定全部停掉？熔断后要手动解除（写原因）才能开新仓</span>
            <span className="spacer" />
            <Button size="sm" onClick={() => setConfirmKill(false)}>取消</Button>
            <Button variant="danger" onClick={() => { setConfirmKill(false); onKill() }}>确认全停</Button>
          </div>
        ) : (
          <div className="tr-act-row">
            <span className="tr-muted">{r.halted ? '当前已在熔断中，再按一次会撤掉熔断后新挂的单' : '行情异常、策略失控时用'}</span>
            <span className="spacer" />
            <Button variant="danger" disabled={killing} onClick={() => setConfirmKill(true)}>{killing ? '全停中…' : '一键全停'}</Button>
          </div>
        )}
      </section>

      <section className="tr-sec">
        <div className="tr-sec-title">熔断记录<span className="tr-hint">最近 200 条</span></div>
        {halts.data === undefined ? (
          halts.isError ? <ErrorState compact title="熔断记录没取到" error={errorText(halts.error)} onRetry={() => void halts.refetch()} /> : <LoadingState />
        ) : !halts.data.length ? <div className="tr-empty-box">还没有熔断过</div> : (
          <div className="tr-list">
            {halts.data.map((h) => (
              <div key={h.id} className="tr-list-row tr-halt-row">
                <span className={cls('tr-dot', h.released_at ? 'off' : 'bad')} />
                <span className="tr-list-main">
                  <span><span className="tag tr-tag-sm tr-tag-first">{h.kind === 'auto' ? '自动' : '手动'}</span>{h.reason}</span>
                  <span className="tr-muted">{fmtTime(h.at)} 触发 · 停掉 {h.runs_stopped} 个部署、撤掉 {h.orders_canceled} 笔挂单{h.released_at ? ` · ${fmtTime(h.released_at)} 解除` : ''}</span>
                  {h.release_reason && <span className="tr-muted">解除原因：{h.release_reason}</span>}
                </span>
                {!h.released_at && <span className="danger-text tr-small">进行中</span>}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
