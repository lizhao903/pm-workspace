// 分诊建议：消息抽屉、组抽屉里的「分诊建议」一节，和列表行「已分诊」小标的悬停摘要。
// 执行列表（GET /api/sop/runs?input_key=message_id）只有每步状态，不带输出；建议、项目、任务要读执行详情
// （GET /api/sop/runs/{id}，分流套分诊时再读子执行），只在抽屉里这一节显示、或悬停小标时才取，列表不逐行取。
// 取结论的规则在 triageSummary（按节点类型和输出字段认，不认步骤 key）。详情缓存在 SOP 执行的键下，执行一变跟着刷。
import { useEffect, useRef, useState } from 'react'
import { errorText, useSopRun, type ImMessage, type SopRun } from '../../core/data'
import { cls } from '../../core/ui'
import { shortTime } from './model'
import { triageTag } from './triageModel'
import { attemptChildId, attemptStatus, summarizeTriage, triageBrief, verdictTone, type TriageAttempt, type TriageSummary } from './triageSummary'

const ACTIVE_POLL_MS = 5_000
const pollWhileActive = (q: { state: { data?: SopRun } }) => (q.state.data && ['running', 'waiting'].includes(q.state.data.status) ? ACTIVE_POLL_MS : false)

/** 一次分诊的结论：取顶层执行和最近一个子执行的详情（enabled 为假时不取） */
function useTriageSummary(a: TriageAttempt | null | undefined, enabled = true) {
  const on = enabled && !!a
  const top = useSopRun(on ? a!.top.id : null, { refetchInterval: pollWhileActive })
  // 子执行优先按列表里挂上的取（和顶层并行取）；列表里没有时看顶层详情里子流程步骤记的 child_run_id
  const fromDetail = top.data?.steps.filter((s) => s.child_run_id).map((s) => s.child_run_id!).pop() ?? null
  const childId = attemptChildId(a) ?? fromDetail
  const child = useSopRun(on ? childId : null, { refetchInterval: pollWhileActive })
  const summary: TriageSummary | null = top.data ? summarizeTriage(top.data, child.data ? [child.data] : []) : null
  return { summary, loading: on && (top.isPending || (!!childId && child.isPending)), error: top.error ?? child.error }
}

type Acts = {
  onOpenRun: (id: string) => void
  onOpenTask: (id: string) => void
}

/** 一次分诊的结论块 */
function SummaryView({ s, onOpenRun, onOpenTask }: Acts & { s: TriageSummary }) {
  return (
    <div className="im-tri-card">
      <div className="im-tri-head">
        <span className={cls('im-state', `im-tri-${verdictTone(s.verdict)}`)}>{s.label}</span>
        {s.reason && <span className="im-muted">{s.reason}</span>}
        {s.step && <span className="im-muted">{s.verdict === 'failed' ? `「${s.step}」` : s.step}</span>}
      </div>
      {s.verdict === 'failed' && <div className="im-err" role="alert">{s.error}</div>}
      {s.advice && <div className="im-tri-advice" aria-label="处理建议">{s.advice}</div>}
      <dl className="im-tri-meta">
        {(s.project || s.routeLabel || s.by) && (
          <>
            <dt>项目</dt>
            <dd>
              {s.project ? <>{s.project.name}{s.project.ref && s.project.ref !== s.project.name && <span className="im-muted"> {s.project.ref}</span>}</> : (s.routeLabel || '没归项目')}
              {s.by && <span className="im-muted" title={s.by.why}> · {s.by.how}{s.by.why && `（${s.by.why}）`}</span>}
            </dd>
          </>
        )}
        {s.tasks.length > 0 && (
          <>
            <dt>任务</dt>
            <dd>
              {s.tasks.map((t) => (
                <button key={t.id} type="button" className="im-tri-link" title={t.title} onClick={() => onOpenTask(t.id)}>
                  {t.ref || '任务'}{t.title && <span className="im-muted"> {t.title}</span>}
                </button>
              ))}
            </dd>
          </>
        )}
        <dt>流程</dt>
        <dd>{s.flow}{s.subFlow && s.subFlow !== s.flow && <span className="im-muted"> → {s.subFlow}</span>}</dd>
        <dt>时间</dt>
        <dd>{shortTime(s.started_at)}{s.ended_at && <span className="im-muted"> 开始，{shortTime(s.ended_at)} 结束</span>}</dd>
      </dl>
      <div className="im-act-row">
        <button type="button" className="im-act" onClick={() => onOpenRun(s.runId)}>查看执行</button>
        {s.childId && <button type="button" className="im-act im-act-quiet" onClick={() => onOpenRun(s.childId)}>查看分诊子执行</button>}
      </div>
    </div>
  )
}

/** 取详情并显示一次分诊；还没取到时显示列表里有的状态 */
function AttemptView({ a, ...acts }: Acts & { a: TriageAttempt }) {
  const { summary, loading, error } = useTriageSummary(a)
  if (summary) return <SummaryView s={summary} {...acts} />
  if (error) return <div className="im-err" role="alert">分诊详情没读出来：{errorText(error)}</div>
  return <div className="im-muted">{loading ? '读取分诊结果…' : ''}</div>
}

const STATUS_TEXT: Record<string, string> = { running: '分诊中', waiting: '等确认', done: '已完成', failed: '失败', stopped: '已终止' }

/** 历史分诊：默认收起，展开后列每一次，点了切过去看那一次 */
function History({ attempts, pick, onPick }: { attempts: TriageAttempt[]; pick: number; onPick: (i: number) => void }) {
  const [open, setOpen] = useState(false)
  if (attempts.length < 2) return null
  return (
    <div className="im-tri-history">
      <button type="button" className="im-tri-link" aria-expanded={open} onClick={() => setOpen((x) => !x)}>
        {open ? '收起历史' : `共分诊 ${attempts.length} 次，看历史`}
      </button>
      {open && (
        <div role="list" aria-label="历史分诊" className="im-tri-hlist">
          {attempts.map((a, i) => (
            <button key={a.top.id} type="button" role="listitem" className={cls('im-tri-hrow', i === pick && 'sel')} aria-current={i === pick || undefined}
              onClick={() => onPick(i)}>
              <span>{shortTime(a.top.started_at)}</span>
              <span className="ellipsis">{a.top.flow_name}</span>
              <span className="im-muted">{STATUS_TEXT[attemptStatus(a)] ?? attemptStatus(a)}{i === 0 ? ' · 最近一次' : ''}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * 消息抽屉的「分诊建议」：最近一次分诊的结论、处理建议原文、项目和判定方式、建的任务、时间、流程，「查看执行」进 SOP 运行页；
 * 分诊过多次能展开历史切换。没分诊过时给「发起分诊」（同批量分诊的弹窗，只带这条）。focus 时滚到这一节
 */
export function TriageSection({ attempts, focus, onStart, ...acts }: Acts & {
  attempts: TriageAttempt[]
  focus?: boolean
  onStart: () => void
}) {
  const [pick, setPick] = useState(0)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => { if (focus) ref.current?.scrollIntoView?.({ block: 'start', behavior: 'smooth' }) }, [focus])
  const a = attempts[Math.min(pick, attempts.length - 1)]
  return (
    <div ref={ref} className={cls('im-tri-sec', focus && 'im-tri-focus')} aria-label="分诊建议" role="region">
      <div className="im-section">分诊建议</div>
      {a ? (
        <>
          <AttemptView key={a.top.id} a={a} {...acts} />
          <History attempts={attempts} pick={pick} onPick={setPick} />
        </>
      ) : (
        <div className="im-act-row">
          <span className="im-muted">还没分诊过</span>
          <button type="button" className="im-act" onClick={onStart}>发起分诊</button>
        </div>
      )}
    </div>
  )
}

/**
 * 组抽屉的「分诊建议」：组里分诊过的消息，最新的那条展开看结论，其余一行（时间、正文开头、状态），点了展开那条；
 * 一条都没分诊过时给「发起分诊」（带整组）
 */
export function GroupTriageSection({ msgs, attemptsOf, onStart, ...acts }: Acts & {
  msgs: readonly ImMessage[]
  attemptsOf: (id: string) => TriageAttempt[]
  onStart: () => void
}) {
  const hit = [...msgs].sort((x, y) => y.at.localeCompare(x.at)).filter((m) => attemptsOf(m.id).length > 0)
  const [openId, setOpenId] = useState<string | null>(null)
  const cur = hit.find((m) => m.id === openId) ?? hit[0]
  return (
    <div className="im-tri-sec" aria-label="分诊建议" role="region">
      <div className="im-section">分诊建议{hit.length > 0 && ` · ${hit.length} 条分诊过`}</div>
      {!hit.length ? (
        <div className="im-act-row">
          <span className="im-muted">这组还没分诊过</span>
          <button type="button" className="im-act" onClick={onStart}>发起分诊</button>
        </div>
      ) : hit.map((m) => {
        const as = attemptsOf(m.id)
        if (m.id === cur.id) {
          return (
            <div key={m.id} className="im-tri-gitem">
              {hit.length > 1 && <div className="im-muted">{shortTime(m.at)} · {m.text.replace(/\s+/g, ' ').slice(0, 30)}</div>}
              <TriageAttempts attempts={as} {...acts} />
            </div>
          )
        }
        const tag = triageTag({ status: attemptStatus(as[0]) })
        return (
          <button key={m.id} type="button" className="im-tri-hrow" onClick={() => setOpenId(m.id)} title="展开这条的分诊建议">
            <span>{shortTime(m.at)}</span>
            <span className="ellipsis">{m.text.replace(/\s+/g, ' ').slice(0, 40)}</span>
            {tag && <span className={cls('im-state', `im-tri-${tag.tone}`)}>{tag.label}</span>}
          </button>
        )
      })}
    </div>
  )
}

/** 一条消息的分诊（最近一次 + 历史），组抽屉里用 */
function TriageAttempts({ attempts, ...acts }: Acts & { attempts: TriageAttempt[] }) {
  const [pick, setPick] = useState(0)
  const a = attempts[Math.min(pick, attempts.length - 1)]
  return (
    <>
      <AttemptView key={a.top.id} a={a} {...acts} />
      <History attempts={attempts} pick={pick} onPick={setPick} />
    </>
  )
}

/**
 * 列表行上的分诊小标。已分诊的悬停时才去取详情，title 写结论和建议前 80 字，点了打开消息抽屉定位到「分诊建议」；
 * 分诊中、等确认、失败的点了打开处理队列（那里能看排队、终止、重试）
 */
export function TriageTagButton({ attempt, onOpenAdvice, onOpenQueue }: {
  attempt: TriageAttempt | undefined
  onOpenAdvice: () => void
  onOpenQueue: () => void
}) {
  const [hover, setHover] = useState(false)
  const status = attempt ? attemptStatus(attempt) : undefined
  const tag = triageTag(status ? { status } : undefined)
  const done = status === 'done'
  const { summary, error } = useTriageSummary(attempt, done && hover)
  if (!attempt || !tag) return null
  const flow = attempt.top.flow_name
  const title = !done ? `${flow}：打开处理队列`
    : summary ? `${triageBrief(summary)}\n${flow}：点击查看分诊建议`
      : error ? `${flow}：分诊详情没读出来，点击查看` : `${flow}：读取分诊建议…`
  return (
    <button type="button" className={cls('im-state', `im-tri-${tag.tone}`)} title={title}
      onMouseEnter={() => setHover(true)} onFocus={() => setHover(true)}
      onClick={(e) => { e.stopPropagation(); if (done) onOpenAdvice(); else onOpenQueue() }} onKeyDown={(e) => e.stopPropagation()}>{tag.label}</button>
  )
}
