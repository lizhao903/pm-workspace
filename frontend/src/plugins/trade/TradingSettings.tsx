// 交易设置（TRD-08c，SPEC-trading-11）：实盘开关、评审清单（每项带证据链接）、trade:live 申请、停用插件；证据抽屉。
// 交互照原型 web-next/src/trading.tsx 的 SettingsView，口径以后端为准（web-next/docs/spec/trading.md「正式前端」）：
// - 评审项的条件、证据、评审结论都由后端现算和记录（GET /api/trade/live），前端不算；
// - 确认评审、申请 trade:live、打开开关只接受用户本人在界面上的操作（前端写请求带 X-Actor-Source: ui），Agent 和接口代为提交后端 403；
// - trade:live 走内核的单独申请（二次确认输入插件名）；评审没通过时后端不同意授予；
// - 实盘下单（TRD-08d）还没上线：开关打开后实盘账户照样只读，页面上写明。
import { useState } from 'react'
import { useNavigate } from 'react-router'
import { deactivatePlugin } from '../../core/plugin'
import {
  QueryState, TRADE_PLUGIN_ID, errorText, evidenceKind, useConfirmLiveCheck, useDisablePlugins, useGrantTradeLive, useRevokeLiveCheck,
  useRevokeTradeLive, useSetLiveSwitch, useTradeAudit, useTradeLiveGate, useTradeRecons,
  type TradeLiveGate, type TradeLiveCheck, type TradeLiveEvidence,
} from '../../core/data'
import { Button, Drawer, ErrorState, LoadingState, Switch, cls } from '../../core/ui'
import { fmtTime, num } from './tradingModel'

export type SettingsGo = 'accounts' | 'risk' | 'runs' | 'orders'

const RECORD_ACTION: Record<string, string> = {
  confirm: '确认', revoke: '撤回', pass: '评审通过', reopen: '评审回到未通过', denied: '拒绝代为提交',
}

export function SettingsView({ onView, onEvidence }: { onView: (v: SettingsGo) => void; onEvidence: (ev: TradeLiveEvidence) => void }) {
  const gate = useTradeLiveGate()
  return (
    <QueryState query={gate} errorTitle="实盘评审没取到">
      {(g) => (
        <div className="tr-risk">
          <LiveSwitchSec g={g} />
          <ReviewSec g={g} onView={onView} onEvidence={onEvidence} />
          <GrantSec g={g} />
          <DisableSec onView={onView} />
          <RecordsSec g={g} />
        </div>
      )}
    </QueryState>
  )
}

/* ---------- 实盘开关（11.1 到 11.3） ---------- */

function LiveSwitchSec({ g }: { g: TradeLiveGate }) {
  const sw = useSetLiveSwitch()
  const why = g.blockers.length ? g.blockers.join('；') : null
  return (
    <section className={cls('tr-sec', g.enabled && 'tr-sec-live')}>
      <div className="tr-sec-title">实盘<span className="tr-hint">开了以后实盘账户才能下单、改单撤单、平仓、部署和启动；没开时实盘账户只读同步</span></div>
      <div className="tr-live-head">
        <span className="tr-rule-text">
          <b>{g.enabled ? '实盘已开启' : '只开模拟盘'}</b>
          <span className={cls('tr-small', why && !g.enabled ? 'danger-text' : 'faint')}>
            {g.enabled
              ? `${g.changed_at ? fmtTime(g.changed_at) : ''} 由 ${g.changed_by || '-'} 打开；关掉后实盘账户回到只读`
              : why ? `不能打开：${why}` : '评审和 trade:live 都齐了，可以打开'}
          </span>
          {!g.enabled && g.off_reason && <span className="faint tr-small">上次关掉：{g.off_reason}{g.changed_at ? `（${fmtTime(g.changed_at)}）` : ''}</span>}
        </span>
        <Switch checked={g.enabled} disabled={sw.isPending || (!g.enabled && !g.can_enable)} title={!g.enabled && why ? why : g.enabled ? '关掉实盘' : '打开实盘'}
          aria-label="实盘开关" onCheckedChange={(v) => sw.mutate(v)} />
      </div>
      <div className="tr-inline-msg tr-inline-warn"><span>{g.note}</span></div>
      {sw.error && <div className="tr-inline-msg tr-inline-bad" role="alert"><span>{errorText(sw.error)}</span></div>}
    </section>
  )
}

/* ---------- 评审清单（11.4 到 11.7） ---------- */

function ReviewSec({ g, onView, onEvidence }: { g: TradeLiveGate; onView: (v: SettingsGo) => void; onEvidence: (ev: TradeLiveEvidence) => void }) {
  const confirm = useConfirmLiveCheck()
  const revoke = useRevokeLiveCheck()
  const busy = confirm.isPending || revoke.isPending
  const err = confirm.error ?? revoke.error
  const passed = g.review.status === 'passed'
  return (
    <section className="tr-sec">
      <div className="tr-sec-title">评审清单<span className="tr-hint">每项都由你本人确认；条件没满足的不能确认；Agent 和接口代为确认会被拒绝并记审计</span></div>
      <div className={cls('tr-inline-msg', passed ? 'tr-inline-ok' : 'tr-inline-warn')}>
        <span>
          <b>评审结论：{passed ? '通过' : '未通过'}</b>
          {passed ? `${g.review.at ? fmtTime(g.review.at) : ''}，评审人 ${g.review.reviewer ?? '-'}` : `还差 ${g.review.missing.length} 项：${g.review.missing.join('、')}`}
        </span>
      </div>
      {err && <div className="tr-inline-msg tr-inline-bad" role="alert"><span>{errorText(err)}</span></div>}
      <div className="tr-rules">
        {g.checks.map((c) => <CheckRow key={c.key} c={c} busy={busy} passed={passed} onView={onView} onEvidence={onEvidence}
          onConfirm={() => confirm.mutate({ key: c.key })} onRevoke={() => revoke.mutate(c.key)} />)}
      </div>
    </section>
  )
}

function CheckRow({ c, busy, passed, onView, onEvidence, onConfirm, onRevoke }: {
  c: TradeLiveCheck; busy: boolean; passed: boolean
  onView: (v: SettingsGo) => void; onEvidence: (ev: TradeLiveEvidence) => void; onConfirm: () => void; onRevoke: () => void
}) {
  const done = !!c.confirmed_at
  const go = c.go as SettingsGo | undefined
  return (
    <div className="tr-rule tr-check" aria-label={c.label}>
      <span className={cls('tr-dot', done ? 'ok' : !c.ok && 'bad')} />
      <div className="tr-rule-text">
        <b>{c.label}</b>
        <span className="faint tr-small">{c.desc}</span>
        <span className={cls('tr-small', c.ok ? 'tr-muted' : 'danger-text')}>{c.text}</span>
        {c.evidence.length > 0 && (
          <span className="tr-evidence">
            <span className="faint tr-small">证据：</span>
            {c.evidence.map((ev) => (
              <button key={ev.href + ev.label} type="button" className="tr-link tr-small" title={ev.href} onClick={() => onEvidence(ev)}>{ev.label}</button>
            ))}
          </span>
        )}
        {done && c.confirmed && c.confirmed.text !== c.text && <span className="faint tr-small">确认时：{c.confirmed.text}</span>}
      </div>
      <div className="tr-rule-input tr-check-act">
        {done ? (
          <>
            <span className="tr-ok tr-small">已确认 · {fmtTime(c.confirmed_at)} · {c.reviewer}</span>
            <Button size="sm" disabled={busy} title={passed ? '撤回后评审回到未通过，trade:live 一并收回、实盘关掉' : '撤回这一项'} onClick={onRevoke}>撤回</Button>
          </>
        ) : (
          <>
            {!c.ok && go && <Button size="sm" onClick={() => onView(go)}>去处理</Button>}
            <Button size="sm" variant="primary" disabled={!c.ok || busy} title={c.ok ? undefined : c.text} onClick={onConfirm}>确认通过</Button>
          </>
        )}
      </div>
    </div>
  )
}

/* ---------- trade:live（11.8 到 11.11） ---------- */

function GrantSec({ g }: { g: TradeLiveGate }) {
  const grant = useGrantTradeLive()
  const revoke = useRevokeTradeLive()
  const [applying, setApplying] = useState(false)
  const [typed, setTyped] = useState('')
  const passed = g.review.status === 'passed'
  const ok = typed.trim() === g.plugin_name
  const submit = () => {
    if (!ok) return
    grant.mutate(typed.trim(), { onSuccess: () => { setApplying(false); setTyped('') } })
  }
  return (
    <section className="tr-sec">
      <div className="tr-sec-title">trade:live 权限<span className="tr-hint">实盘下单，风险最高；安装时不授予，要在这里单独申请</span></div>
      {g.granted ? (
        <div className="tr-act-row">
          <span className="tr-ok">已授予</span>
          <span className="spacer" />
          <Button size="sm" disabled={revoke.isPending} title="收回后实盘开关一起关掉" onClick={() => revoke.mutate()}>收回</Button>
        </div>
      ) : applying ? (
        <div className="tr-apply">
          <span className="danger-text">授予后，打开实盘开关就能用真实资金下单（实盘下单上线后）。输入插件名「{g.plugin_name}」确认：</span>
          <div className="tr-act-row">
            <input className="tr-input tr-apply-input" aria-label="输入插件名确认" value={typed} autoFocus placeholder={g.plugin_name}
              onChange={(e) => setTyped(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') submit() }} />
            <span className="spacer" />
            <Button size="sm" onClick={() => { setApplying(false); setTyped(''); grant.reset() }}>取消</Button>
            <Button size="sm" variant="danger" disabled={!ok || grant.isPending} onClick={submit}>确认申请</Button>
          </div>
        </div>
      ) : (
        <div className="tr-act-row">
          <span className={cls(passed ? 'tr-muted' : 'danger-text')}>{passed ? '未申请' : `评审五项都确认后才能申请，还差 ${g.review.missing.length} 项`}</span>
          <span className="spacer" />
          <Button variant="outline" disabled={!passed} onClick={() => setApplying(true)}>申请 trade:live</Button>
        </div>
      )}
      {(grant.error || revoke.error) && <div className="tr-inline-msg tr-inline-bad" role="alert"><span>{errorText(grant.error ?? revoke.error)}</span></div>}
    </section>
  )
}

/* ---------- 停用插件（11.12 到 11.14） ---------- */

function DisableSec({ onView }: { onView: (v: SettingsGo) => void }) {
  const disable = useDisablePlugins()
  const navigate = useNavigate()
  const [ask, setAsk] = useState(false)
  const off = () => disable.mutate([TRADE_PLUGIN_ID], {
    onSuccess: () => {
      deactivatePlugin(TRADE_PLUGIN_ID)
      void navigate('/settings/plugins')
    },
  })
  return (
    <section className="tr-sec">
      <div className="tr-sec-title">停用插件<span className="tr-hint">停用前必须先一键全停：没有在跑的部署、没有挂单才能停</span></div>
      {disable.error ? (
        <div className="tr-inline-msg tr-inline-bad tr-off-block" role="alert">
          <span><b>不能停用</b>{errorText(disable.error)}</span>
          <Button size="sm" onClick={() => { disable.reset(); setAsk(false) }}>知道了</Button>
          <Button size="sm" variant="danger" onClick={() => { disable.reset(); setAsk(false); onView('risk') }}>去一键全停</Button>
        </div>
      ) : ask ? (
        <div className="tr-act-row">
          <span className="danger-text">确定停用交易插件？行情、盯盘、策略、交易都不再运行；数据保留，重新启用后照常</span>
          <span className="spacer" />
          <Button size="sm" onClick={() => setAsk(false)}>取消</Button>
          <Button size="sm" variant="danger" disabled={disable.isPending} onClick={off}>{disable.isPending ? '停用中…' : '停用'}</Button>
        </div>
      ) : (
        <div className="tr-act-row">
          <span className="tr-muted">停用后行情、盯盘、策略、交易都不再运行；数据保留，重新启用后照常</span>
          <span className="spacer" />
          <Button size="sm" onClick={() => setAsk(true)}>停用交易插件</Button>
        </div>
      )}
    </section>
  )
}

/* ---------- 评审记录 ---------- */

const RECORDS_SHOWN = 8

function RecordsSec({ g }: { g: TradeLiveGate }) {
  const [all, setAll] = useState(false)
  const label = (k?: string) => g.checks.find((c) => c.key === k)?.label ?? k ?? ''
  const rows = all ? g.records : g.records.slice(0, RECORDS_SHOWN)
  return (
    <section className="tr-sec">
      <div className="tr-sec-title">评审记录<span className="tr-hint">确认、撤回、评审结论和被拒绝的代为提交，只追加</span></div>
      {!g.records.length ? <div className="tr-empty-box">还没有评审记录</div> : (
        <div className="tr-list">
          {rows.map((r) => (
            <div key={r.id} className="tr-list-row">
              <span className={cls('tr-dot', r.action === 'denied' ? 'bad' : r.action === 'pass' || r.action === 'confirm' ? 'ok' : '')} />
              <span className="tr-list-main">
                <span>{RECORD_ACTION[r.action] ?? r.action}{r.item ? `「${label(r.item)}」` : ''}</span>
                <span className="tr-muted tr-small">{r.reviewer}（{r.source}）{r.action === 'denied' && typeof r.detail.reason === 'string' ? ` · ${r.detail.reason}` : ''}</span>
              </span>
              <span className="faint tr-small">{fmtTime(r.at)}</span>
            </div>
          ))}
        </div>
      )}
      {g.records.length > RECORDS_SHOWN && (
        <button type="button" className="tr-link" onClick={() => setAll(!all)}>{all ? '收起' : `全部 ${g.records.length} 条`}</button>
      )}
    </section>
  )
}

/* ---------- 证据抽屉：审计查询、对账记录 ---------- */

const AUDIT_ACTION: Record<string, string> = {
  place: '下单', reject: '被拒', risk_block: '风控拦截', modify: '改价', cancel: '撤单', fill: '成交', deploy: '部署', pause: '暂停', resume: '恢复', stop: '停止',
  update: '修改', kill: '一键全停', halt: '熔断', breaker: '自动熔断', release: '解除熔断', create: '新建', delete: '删除', connect: '连接', disconnect: '断开',
  baseline: '建立本地记录', sync_failed: '同步失败', sync_recovered: '同步恢复', key_rejected: 'Key 被拒', recon_diff: '对账差异', recon_resolve: '处理差异',
  recon_auto_resolved: '差异自动关闭',
}
const RECON_STATUS: Record<string, string> = { ok: '一致', diff: '有差异', failed: '失败' }

export function EvidenceDrawer({ ev, onClose }: { ev: TradeLiveEvidence; onClose: () => void }) {
  const k = evidenceKind(ev.href)
  const audit = useTradeAudit(k?.query ?? '', k?.kind === 'audit')
  const recons = useTradeRecons(k?.query ?? '', k?.kind === 'recons')
  return (
    <Drawer open onClose={onClose} kicker={`证据 · ${ev.label}`} aria-label="证据" className="tr-drawer"
      footer={(requestClose) => (
        <>
          <code className="faint tr-small tr-href">GET {ev.href}</code>
          <span className="spacer" />
          <Button onClick={requestClose}>关闭</Button>
        </>
      )}>
      {k?.kind === 'audit' ? (
        audit.data === undefined ? (audit.isError ? <ErrorState compact title="审计没取到" error={errorText(audit.error)} onRetry={() => void audit.refetch()} /> : <LoadingState />)
          : !audit.data.data.length ? <div className="tr-empty-box">没有记录</div> : (
            <div className="form">
              <div className="tr-muted tr-small">共 {audit.data.total} 条，新的在前{audit.data.total > audit.data.data.length ? `，这里列最近 ${audit.data.data.length} 条` : ''}</div>
              <div className="tr-list">
                {audit.data.data.map((a) => (
                  <div key={a.id} className="tr-list-row tr-halt-row">
                    <span className="tag tr-tag-sm tr-tag-first">{AUDIT_ACTION[a.action] ?? a.action}</span>
                    <span className="tr-list-main">
                      <span className="tr-audit-sum">{a.summary}</span>
                      <span className="tr-muted tr-small">来源 {a.origin} · {a.actor}{a.order_id ? ` · 委托 ${a.order_id}` : ''}</span>
                    </span>
                    <span className="faint tr-small">{fmtTime(a.at)}</span>
                  </div>
                ))}
              </div>
            </div>
          )
      ) : k?.kind === 'recons' ? (
        recons.data === undefined ? (recons.isError ? <ErrorState compact title="对账记录没取到" error={errorText(recons.error)} onRetry={() => void recons.refetch()} /> : <LoadingState />)
          : !recons.data.data.length ? <div className="tr-empty-box">还没有对账记录</div> : (
            <div className="form">
              <div className="tr-muted tr-small">共 {recons.data.total} 次，新的在前</div>
              <div className="tr-list">
                {recons.data.data.map((r) => (
                  <div key={r.id} className="tr-list-row">
                    <span className={cls('tr-dot', r.status === 'ok' ? 'ok' : 'bad')} />
                    <span className="tr-list-main">
                      <span>{RECON_STATUS[r.status] ?? r.status} · {r.checked} 项{r.open ? ` · ${r.open} 处差异` : ''}{r.max_pct > 0 ? ` · 最大差 ${num(r.max_pct, 2)}%` : ''}</span>
                      {r.error && <span className="danger-text tr-small">{r.error}</span>}
                    </span>
                    <span className="faint tr-small">{fmtTime(r.at)}</span>
                  </div>
                ))}
              </div>
            </div>
          )
      ) : (
        <div className="tr-empty-box">这条证据在交易页里看：{ev.view ?? ev.href}</div>
      )}
    </Drawer>
  )
}
