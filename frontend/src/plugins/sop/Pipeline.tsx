// 任务详情的「流水线」标签（AUTO-12，SPEC-sop-16）：一条需求从接收到上线的流水线时间线。
// 上面是卡点（等人、失败、超时、超出上限暂停，能直接处理）和预算用量，中间是阶段条（每个阶段累计耗时），下面是按时间排的时间线：
// 阶段变化（审计 kind=stage）、SOP 执行开始、每一步的耗时和轮次、重试。点执行、步骤去 SOP 执行页，「返回」回到这个标签。
import { useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate } from 'react-router'
import {
  errorText, isApiError, useEventsLive, useSopPipeline, useSopRunAction, useStageHistory, type SopRunAction, type SopWaitingItem,
} from '../../core/data'
import type { ObjectSectionProps } from '../../core/plugin'
import { Button, ErrorState, LoadingState, Pill, cls } from '../../core/ui'
import { runLook, runStepLook } from './model'
import { WAIT_TEXT, backToPipeline, durationText, runPath, stageSpans, stageTotals, timelineRows, type TimelineRow } from './pipelineModel'
import './sop.css'

const POLL_MS = 30_000
const ACTIVE_POLL_MS = 5_000

/** 卡点的一条：说明加能直接做的动作（放行、重试、判断、通过），其余去执行页 */
function Blocker({ b, busy, onAct, onOpen }: { b: SopWaitingItem; busy: boolean; onAct: (a: SopRunAction) => void; onOpen: () => void }) {
  const look = WAIT_TEXT[b.wait] ?? WAIT_TEXT.review
  const step = b.step_key
  return (
    <div className={cls('sop-pl-block', look.tone === 'danger' && 'bad')} data-wait={b.wait}>
      <div className="sop-pl-block-text">
        <b>{look.label}</b>
        <span>{b.step_name} · {b.flow_name}</span>
        {b.reason && b.wait !== 'review' && b.wait !== 'decide' && <span className="sop-pl-why">{b.reason}</span>}
      </div>
      <div className="sop-act-row">
        {b.wait === 'hold' && <Button variant="primary" size="sm" disabled={busy} onClick={() => onAct({ kind: 'confirm-input', step })}>放行这一次</Button>}
        {(b.wait === 'failed' || b.wait === 'timeout') && <Button variant="primary" size="sm" disabled={busy} onClick={() => onAct({ kind: 'retry', step })}>重试</Button>}
        {b.wait === 'decide' && (b.cases ?? []).map((c, n) => (
          <Button key={c.key} variant={n === 0 ? 'primary' : 'outline'} size="sm" disabled={busy} onClick={() => onAct({ kind: 'route', step, route: c.key })}>走「{c.label}」</Button>
        ))}
        {b.wait === 'review' && <Button variant="primary" size="sm" disabled={busy} onClick={() => onAct({ kind: 'approve', step })}>通过</Button>}
        <Button size="sm" onClick={onOpen}>去执行页</Button>
      </div>
    </div>
  )
}

function Row({ r, onOpen }: { r: TimelineRow; onOpen: (runId: string) => void }) {
  const time = new Date(r.at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  if (r.kind === 'stage') {
    return (
      <li className={cls('sop-pl-row', 'stage', r.waiting && r.current && 'attn')}>
        <span className="sop-pl-time">{time}</span>
        <span className="sop-pl-dot" />
        <span className="sop-pl-main">阶段{r.from ? `：${r.from} → ` : '：'}<b>{r.label}</b></span>
        <span className="sop-pl-dur">{r.current ? `已停留 ${durationText(r.ms)}` : `停留 ${durationText(r.ms)}`}</span>
      </li>
    )
  }
  if (r.kind === 'run') {
    const look = runLook(r.status)
    return (
      <li className="sop-pl-row run">
        <span className="sop-pl-time">{time}</span>
        <span className="sop-pl-dot" />
        <button type="button" className="sop-pl-main sop-pl-link" onClick={() => onOpen(r.runId)}>
          {r.sub ? '子流程' : '执行'}「{r.label}」开始
        </button>
        <Pill label={look.label} color={look.color} />
      </li>
    )
  }
  const look = runStepLook(r.step)
  return (
    <li className={cls('sop-pl-row', 'step', (r.step.status === 'failed' || (r.step.hold && !r.step.hold.released)) && 'bad')}>
      <span className="sop-pl-time">{time}</span>
      <span className="sop-pl-dot" />
      <button type="button" className="sop-pl-main sop-pl-link" onClick={() => onOpen(r.runId)} title={r.flow}>
        {r.step.name}
        {r.tags.map((t) => <span key={t} className="sop-pl-tag">{t}</span>)}
        {r.step.error && <span className="sop-pl-why">{r.step.error}</span>}
      </button>
      <span className="sop-pl-dur">{r.waiting ? `已等 ${durationText(r.ms)}` : durationText(r.ms)}</span>
      <Pill label={look.label} color={look.color} />
    </li>
  )
}

export default function Pipeline({ object, returnTo }: ObjectSectionProps) {
  const navigate = useNavigate()
  const { pathname, search } = useLocation()
  const live = useEventsLive()
  const history = useStageHistory(object.id)
  const pipe = useSopPipeline(object.id, {
    refetchInterval: (q) => (live ? false : q.state.data?.runs.some((r) => !r.ended_at) ? ACTIVE_POLL_MS : POLL_MS),
  })
  const act = useSopRunAction()
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(t)
  }, [])

  const changes = useMemo(() => history.data ?? [], [history.data])
  const rows = useMemo(() => timelineRows(changes, pipe.data, now), [changes, pipe.data, now])
  const totals = useMemo(() => stageTotals(stageSpans(changes, now)), [changes, now])
  const back = backToPipeline(returnTo ?? `${pathname}${search}`)
  const openRun = (id: string) => navigate(runPath(id), { state: { back } })
  const p = pipe.data
  const budget = p?.budget
  // 审计没接上时阶段那部分拿不到，SOP 部分照常
  const noAudit = history.isError && isApiError(history.error, 'internal')

  return (
    <section className="sop-pl" aria-label="流水线" data-section="pipeline">
      <div className="sop-obj-head">
        <span className="sop-obj-title">流水线</span>
        <span className="sop-obj-hint">阶段变化、自动执行的每一步和卡点，按时间排</span>
      </div>

      {act.isError && <div className="sop-settings-err" role="alert">没处理成：{errorText(act.error)}</div>}
      {p && p.blockers.length > 0 && (
        <div className="sop-pl-blocks" aria-label="卡点">
          {p.blockers.map((b) => (
            <Blocker key={`${b.run_id}-${b.step_key}`} b={b} busy={act.isPending}
              onAct={(a) => act.mutate({ runId: b.run_id, action: a })} onOpen={() => openRun(b.run_id)} />
          ))}
        </div>
      )}

      {budget && (budget.claude_runs > 0 || p!.runs.length > 0) && (
        <div className="sop-pl-budget" aria-label="预算">
          Claude Code 已跑 <b>{budget.claude_runs}</b> 次{budget.max_runs ? ` / 上限 ${budget.max_runs} 次` : '（不限次数）'}
          {'，累计 '}<b>{budget.claude_minutes}</b> 分钟{budget.max_minutes ? ` / 上限 ${budget.max_minutes} 分钟` : '（不限时长）'}
        </div>
      )}

      {totals.length > 0 && (
        <div className="sop-pl-stages" aria-label="阶段耗时">
          {totals.map((t) => (
            <div key={t.stage} className={cls('sop-pl-stage', t.current && 'cur')}>
              <span className="sop-pl-stage-name">{t.label}{t.times > 1 && <span className="sop-pl-tag">{t.times} 次</span>}</span>
              <span className="sop-pl-stage-ms">{durationText(t.ms)}</span>
            </div>
          ))}
        </div>
      )}

      {(history.isPending || pipe.isPending) && <LoadingState />}
      {history.isError && !noAudit && <ErrorState compact error={`阶段变化没加载出来：${errorText(history.error)}`} onRetry={() => void history.refetch()} />}
      {noAudit && <div className="sop-obj-empty">这个工作台没开审计，看不到阶段变化，只列自动执行</div>}
      {pipe.isError && <ErrorState compact error={`自动执行没加载出来：${errorText(pipe.error)}`} onRetry={() => void pipe.refetch()} />}
      {!history.isPending && !pipe.isPending && !rows.length && !history.isError && !pipe.isError && (
        <div className="sop-obj-empty">这条需求还没进流水线：没有阶段变化，也没有自动执行</div>
      )}
      {rows.length > 0 && (
        <ol className="sop-pl-list" aria-label="时间线">
          {rows.map((r) => <Row key={r.key} r={r} onOpen={openRun} />)}
        </ol>
      )}
    </section>
  )
}
