import { useEffect, useRef, useState } from 'react'
import type { Message } from './data'
import { focusIndex, runStatus, STEP_STATUS, type Json, type RunStep, type Sop, type SopRun, type SopStepDef } from './sopflow'
import { cls } from './ui'

/*
 * IM 消息页的批量分诊和处理队列（SPEC-messages-1.51~1.53）。
 * 分诊 = 给一条消息发起一次 SOP 执行，输入里带 message_id；执行按 input.message_id 关联消息。
 * 正式产品走 SOP 插件的 POST /api/sop/flows/{id}/runs/batch（按 message_id 跳过已跑过的）和 GET /api/sop/runs?input_key=message_id。
 */

/** 一次批量分诊最多几条（同正式产品） */
export const TRIAGE_MAX = 200
/** 处理队列「最近结束」一段几条 */
const QUEUE_RECENT = 20

const msgIdOf = (r: SopRun) => (typeof r.input.message_id === 'string' ? r.input.message_id : '')

/** 能拿来分诊的流程：触发方式是 IM 的在前，再列输入字段里有 message_id 的其他流程 */
export function triageSops(sops: Sop[]): Sop[] {
  const byName = (a: Sop, b: Sop) => a.name.localeCompare(b.name, 'zh-CN')
  return [...sops.filter((s) => s.trigger === 'im').sort(byName), ...sops.filter((s) => s.trigger !== 'im' && s.fields.some((f) => f.key === 'message_id')).sort(byName)]
}

/** 按消息分诊的执行（输入带 message_id 的） */
export const triageRuns = (runs: SopRun[]) => runs.filter((r) => !!msgIdOf(r))

/** 每条消息最近一次分诊执行 */
export function latestTriage(runs: SopRun[]): Map<string, SopRun> {
  const out = new Map<string, SopRun>()
  for (const r of [...triageRuns(runs)].sort((a, b) => b.started_at - a.started_at)) if (!out.has(msgIdOf(r))) out.set(msgIdOf(r), r)
  return out
}

const isActive = (r: SopRun) => ['running', 'waiting'].includes(runStatus(r))
export const activeTriage = (runs: SopRun[]) => triageRuns(runs).filter(isActive)

/**
 * 消息行上的分诊小标：分诊中、分诊等确认、已分诊、分诊失败；终止了的不标。
 * 已分诊的悬停写结论和建议前 80 字，点了打开消息抽屉定位到「分诊建议」（SPEC-messages-1.53）；其余点了打开处理队列
 */
export function TriageTag({ run, onClick, onOpenAdvice }: { run: SopRun | undefined; onClick: () => void; onOpenAdvice: () => void }) {
  if (!run) return null
  const st = runStatus(run)
  const t = ({ running: ['分诊中', 'run'], waiting: ['分诊等确认', 'wait'], done: ['已分诊', 'ok'], failed: ['分诊失败', 'bad'] } as Record<string, [string, string]>)[st]
  if (!t) return null
  const done = st === 'done'
  return (
    <button className={cls('msg-tri', `msg-tri-${t[1]}`)} title={done ? `${triageBrief(triageSummary(run))}\n${run.sop.name}：点击查看分诊建议` : `${run.sop.name}：打开处理队列`}
      onClick={(e) => { e.stopPropagation(); if (done) onOpenAdvice(); else onClick() }}>{t[0]}</button>
  )
}

/* ---------- 分诊建议（SPEC-messages-1.53、2.41~2.44、4.10） ---------- */

/**
 * 一次分诊的结论。正式产品从执行详情取（分流套分诊时再取子执行，见 frontend/src/plugins/im/triageSummary.ts），原型的执行就带着每步输出。
 * 不认步骤 key，按节点类型和输出字段认：advice（或 ai 节点配置的输出字段）是建议；need=yes 或有建议是要处理；marked.state=ignore 是可忽略；
 * 分类器选的那一类；只有条件分支选了「已忽略」一路的是「已忽略，未判断」；project、task 输出是归到的项目、建的任务
 */
export type TriageSummary = {
  verdict: 'handle' | 'ignore' | 'skipped' | 'other' | 'running' | 'waiting' | 'failed' | 'stopped'
  label: string; reason: string; advice: string; step: string; error: string
  project: string; tasks: string[]
}
const txt = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
const objOf = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? v as Json : null)
export function triageSummary(r: SopRun): TriageSummary {
  const ss = r.steps.map((s, i) => ({ s, d: r.sop.steps[i] as SopStepDef | undefined }))
  const done = ss.filter((x) => x.s.status === 'done')
  const last = (k: string) => done.map((x) => x.s.output?.[k] ?? objOf(objOf(x.s.output?.subflow)?.output)?.[k]).filter((v) => v !== undefined).pop()
  const aiOut = done.filter((x) => x.d?.kind === 'ai' && x.d.config?.output).map((x) => txt(x.s.output?.[x.d!.config!.output])).filter(Boolean).pop() ?? ''
  const advice = txt(last('advice')) || aiOut
  const marked = txt(objOf(last('marked'))?.state)
  const routed = (k: string) => done.filter((x) => x.d?.kind === k && x.s.route)
  const cl = routed('classifier').pop()
  const dc = routed('decide').pop()
  const caseOf = (x: { s: RunStep; d?: SopStepDef }) => x.d?.cases?.find((c) => c.key === x.s.route)?.label ?? x.s.route ?? ''
  const p = objOf(last('project'))
  const tasks = done.filter((x) => x.d?.kind === 'task').map((x) => txt(objOf(x.s.output?.task)?.ref)).filter(Boolean)
  const base = { advice, project: p ? txt(p.name) || txt(p.ref) : '', tasks, step: '', error: '', reason: '' }
  const st = runStatus(r)
  const name = (x: { s: RunStep; d?: SopStepDef }) => x.d?.name ?? x.s.key
  if (st === 'failed') { const f = ss.find((x) => x.s.status === 'failed'); return { ...base, verdict: 'failed', label: '分诊失败', step: f ? name(f) : '', error: f?.s.error ?? '执行失败' } }
  if (st === 'waiting') { const w = ss.find((x) => x.s.status === 'paused' || x.s.status === 'review'); return { ...base, verdict: 'waiting', label: '分诊等确认', step: w ? name(w) : '' } }
  if (st === 'running') { const c = ss.find((x) => x.s.status === 'running'); return { ...base, verdict: 'running', label: '分诊中', step: c ? `${name(c)} · ${c.s.queue ? `排队中，前面 ${c.s.queue.ahead} 个` : '执行中'}` : '' } }
  if (st === 'stopped') return { ...base, verdict: 'stopped', label: '已终止', reason: '中途终止，没跑完' }
  const why = cl?.s.route_reason ?? ''
  if (txt(last('need')) === 'yes' || advice) return { ...base, verdict: 'handle', label: '要处理', reason: why }
  if (marked === 'ignore') return { ...base, verdict: 'ignore', label: '可忽略', reason: [why, '已标为已忽略'].filter(Boolean).join('；') }
  if (cl) {
    const k = `${cl.s.route} ${caseOf(cl)}`
    if (/ignore|忽略/i.test(k)) return { ...base, verdict: 'ignore', label: '可忽略', reason: why }
    if (/handle|处理/i.test(k)) return { ...base, verdict: 'handle', label: '要处理', reason: why }
    return { ...base, verdict: 'other', label: caseOf(cl), reason: why }
  }
  if (dc && /忽略|ignore/i.test(`${dc.s.route} ${caseOf(dc)}`)) return { ...base, verdict: 'skipped', label: '已忽略，未判断', reason: dc.s.route_reason ?? '' }
  return { ...base, verdict: 'other', label: dc ? caseOf(dc) : '没得出结论', reason: dc?.s.route_reason ?? '' }
}

/** 悬停摘要：结论 + 建议前 80 字（没有建议写理由） */
export function triageBrief(s: TriageSummary, max = 80) {
  const body = (s.advice || s.reason).replace(/\s+/g, ' ').trim()
  return body ? `${s.label}：${body.length > max ? `${body.slice(0, max)}…` : body}` : s.label
}

const TONE: Record<TriageSummary['verdict'], string> = { handle: 'ok', running: 'run', waiting: 'wait', failed: 'bad', ignore: 'mute', skipped: 'mute', other: 'mute', stopped: 'mute' }
const fmtAt = (t: number) => new Date(t).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })

/** 一条消息的分诊执行，最近的在前 */
export const triageRunsOf = (runs: SopRun[], messageId: string) => triageRuns(runs).filter((r) => msgIdOf(r) === messageId).sort((a, b) => b.started_at - a.started_at)

function SummaryCard({ r, onOpenRun }: { r: SopRun; onOpenRun: (id: string) => void }) {
  const s = triageSummary(r)
  return (
    <div className="tri-card">
      <div className="act-row">
        <span className={cls('msg-tri', `msg-tri-${TONE[s.verdict]}`)}>{s.label}</span>
        {s.reason && <span className="muted">{s.reason}</span>}
        {s.step && <span className="muted">{s.verdict === 'failed' ? `「${s.step}」` : s.step}</span>}
      </div>
      {s.verdict === 'failed' && <div className="field-err">{s.error}</div>}
      {s.advice && <div className="tri-advice" aria-label="处理建议">{s.advice}</div>}
      <dl className="tri-meta">
        {s.project && <><dt>项目</dt><dd>{s.project}</dd></>}
        {s.tasks.length > 0 && <><dt>任务</dt><dd>{s.tasks.join('、')}</dd></>}
        <dt>流程</dt><dd>{r.sop.name}</dd>
        <dt>时间</dt><dd>{fmtAt(r.started_at)}{r.ended_at && <span className="muted"> 开始，{fmtAt(r.ended_at)} 结束</span>}</dd>
      </dl>
      <div className="act-row"><button className="act" onClick={() => onOpenRun(r.id)}>查看执行</button></div>
    </div>
  )
}

function RunsWithHistory({ list, onOpenRun }: { list: SopRun[]; onOpenRun: (id: string) => void }) {
  const [pick, setPick] = useState(0)
  const [open, setOpen] = useState(false)
  const r = list[Math.min(pick, list.length - 1)]
  return (
    <>
      <SummaryCard key={r.id} r={r} onOpenRun={onOpenRun} />
      {list.length > 1 && (
        <div className="tri-history">
          <button className="tri-link" onClick={() => setOpen((x) => !x)}>{open ? '收起历史' : `共分诊 ${list.length} 次，看历史`}</button>
          {open && (
            <div className="tri-hlist">
              {list.map((x, i) => (
                <button key={x.id} className={cls('tri-hrow', i === pick && 'sel')} onClick={() => setPick(i)}>
                  <span>{fmtAt(x.started_at)}</span><span className="ellipsis">{x.sop.name}</span>
                  <span className="muted">{RUN_STATE[runStatus(x)]}{i === 0 ? ' · 最近一次' : ''}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </>
  )
}

/**
 * 消息抽屉的「分诊建议」：最近一次的结论、建议原文、项目、任务、流程、时间，「查看执行」；多次能展开历史。
 * 没分诊过时「发起分诊」（原型直接用第一条分诊流程发起；正式产品弹出选流程的确认框）
 */
export function TriageAdvice({ runs, focus, onOpenRun, onStart }: { runs: SopRun[]; focus?: boolean; onOpenRun: (id: string) => void; onStart: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => { if (focus) ref.current?.scrollIntoView({ block: 'start', behavior: 'smooth' }) }, [focus])
  return (
    <div ref={ref} className={cls('tri-sec', focus && 'tri-focus')}>
      <div className="section-label">分诊建议</div>
      {runs.length ? <RunsWithHistory list={runs} onOpenRun={onOpenRun} /> : (
        <div className="act-row"><span className="muted">还没分诊过</span><button className="act" onClick={onStart}>发起分诊</button></div>
      )}
    </div>
  )
}

/** 组抽屉的「分诊建议」：分诊过的消息里最新那条展开，其余一行，点了展开那条；一条都没分诊过时「发起分诊」带整组 */
export function GroupTriageAdvice({ msgs, runs, onOpenRun, onStart }: { msgs: Message[]; runs: SopRun[]; onOpenRun: (id: string) => void; onStart: () => void }) {
  const hit = [...msgs].sort((a, b) => b.at.localeCompare(a.at)).map((m) => ({ m, list: triageRunsOf(runs, m.id) })).filter((x) => x.list.length)
  const [openId, setOpenId] = useState<string | null>(null)
  const cur = hit.find((x) => x.m.id === openId) ?? hit[0]
  return (
    <div className="tri-sec">
      <div className="section-label">分诊建议{hit.length > 0 && ` · ${hit.length} 条分诊过`}</div>
      {!hit.length ? (
        <div className="act-row"><span className="muted">这组还没分诊过</span><button className="act" onClick={onStart}>发起分诊</button></div>
      ) : hit.map((x) => (x.m.id === cur.m.id ? (
        <div key={x.m.id} className="tri-gitem">
          {hit.length > 1 && <div className="muted">{fmtAt(new Date(x.m.at).getTime())} · {x.m.text.replace(/\s+/g, ' ').slice(0, 30)}</div>}
          <RunsWithHistory list={x.list} onOpenRun={onOpenRun} />
        </div>
      ) : (
        <button key={x.m.id} className="tri-hrow tri-hrow-solo" onClick={() => setOpenId(x.m.id)}>
          <span>{fmtAt(new Date(x.m.at).getTime())}</span><span className="ellipsis">{x.m.text.replace(/\s+/g, ' ').slice(0, 40)}</span>
          <span className="muted">{RUN_STATE[runStatus(x.list[0])]}</span>
        </button>
      )))}
    </div>
  )
}

/**
 * 批量分诊条：列表上方展开，挑流程（默认第一个）、「已跑过的也重跑」、发起。
 * 原型列表没有勾选，范围是当前筛选结果全部；超过 TRIAGE_MAX 条不发起，提示先缩小范围
 */
export function TriageBar({ sops, runs, targets, onStart, onCancel }: {
  sops: Sop[]; runs: SopRun[]; targets: Message[]
  onStart: (sopId: string, rerun: boolean) => void; onCancel: () => void
}) {
  const list = triageSops(sops)
  const [pick, setPick] = useState('')
  const sopId = pick || list[0]?.id || ''
  const [rerun, setRerun] = useState(false)
  const done = new Set(triageRuns(runs).filter((r) => r.sop_id === sopId).map(msgIdOf))
  const ran = targets.filter((m) => done.has(m.id)).length
  const over = targets.length > TRIAGE_MAX
  const n = rerun ? targets.length : targets.length - ran
  return (
    <div className="msg-triage-bar">
      <b>批量分诊</b>
      <span className="muted">当前筛选结果全部 {targets.length} 条，各发起一次流程</span>
      {list.length ? (
        <select value={sopId} onChange={(e) => setPick(e.target.value)} aria-label="分诊流程">
          {list.map((s) => <option key={s.id} value={s.id}>{s.trigger === 'im' ? `${s.name}（来消息自动跑）` : s.name}</option>)}
        </select>
      ) : <span className="muted">还没有能分诊消息的流程（触发方式是 IM，或输入字段有 message_id）</span>}
      <label className="msg-triage-check"><input type="checkbox" checked={rerun} onChange={(e) => setRerun(e.target.checked)} />已跑过的也重跑</label>
      {!rerun && ran > 0 && <span className="muted">其中 {ran} 条已跑过，会跳过</span>}
      {over && <span className="field-err">一次最多 {TRIAGE_MAX} 条，先用状态、渠道、群组、搜索缩小范围</span>}
      <span className="spacer" />
      <button className="btn btn-primary" disabled={over || !sopId || n <= 0} onClick={() => onStart(sopId, rerun)}>发起 {Math.max(0, n)} 次</button>
      <button className="btn btn-ghost" onClick={onCancel}>取消</button>
    </div>
  )
}

const RUN_STATE: Record<string, string> = { running: '执行中', waiting: '等人处理', done: '已完成', failed: '失败', stopped: '已终止' }

function waitFor(ms: number) {
  const m = Math.floor(ms / 60000)
  return m < 1 ? '不到 1 分钟' : m < 60 ? `${m} 分钟` : m < 1440 ? `${Math.floor(m / 60)} 小时` : `${Math.floor(m / 1440)} 天`
}

/** 处理队列抽屉：进行中（先来的在上）和最近结束 20 条；终止、全部终止（二次确认）、失败的重试；点行打开 SOP 执行 */
export function QueueDrawer({ runs, messages, onClose, onOpenRun, onOpenMessage, onStop, onRetry }: {
  runs: SopRun[]; messages: Message[]
  onClose: () => void; onOpenRun: (id: string) => void; onOpenMessage: (id: string) => void
  onStop: (ids: string[]) => void; onRetry: (id: string, step: number) => void
}) {
  const all = triageRuns(runs)
  const active = all.filter(isActive).sort((a, b) => a.started_at - b.started_at)
  const recent = all.filter((r) => !isActive(r)).sort((a, b) => (b.ended_at ?? b.started_at) - (a.ended_at ?? a.started_at)).slice(0, QUEUE_RECENT)
  const [confirm, setConfirm] = useState(false)
  const now = Date.now()
  const row = (r: SopRun) => {
    const m = messages.find((x) => x.id === msgIdOf(r))
    const i = focusIndex(r)
    const s = r.steps[i]
    const st = runStatus(r)
    const stepText = s ? `${r.sop.steps[i]?.name ?? s.key} · ${s.queue ? `排队中，前面 ${s.queue.ahead} 个` : STEP_STATUS[s.status].label}` : ''
    return (
      <div key={r.id} className="q-row">
        <button className="q-main" onClick={() => onOpenRun(r.id)} title="打开 SOP 执行">
          <span className="q-msg">{m ? <><b>{m.sender_name}</b><span className="muted"> · {m.conversation || '私聊'}</span> {m.text.replace(/\s+/g, ' ').slice(0, 40)}</> : <span className="muted">消息 {msgIdOf(r)}</span>}</span>
          <span className="q-meta">
            <span>{r.sop.name}</span><span>{stepText}</span>
            <span className={cls('msg-tri', st === 'failed' && 'msg-tri-bad')}>{st === 'running' && r.steps.some((x) => x.queue) ? '排队中' : RUN_STATE[st]}</span>
            <span>{isActive(r) ? `已等 ${waitFor(now - r.started_at)}` : waitFor(now - (r.ended_at ?? r.started_at)) + '前'}</span>
          </span>
        </button>
        <span className="q-acts">
          {m && <button className="act act-quiet" onClick={() => onOpenMessage(m.id)}>看消息</button>}
          {isActive(r) && <button className="act" onClick={() => onStop([r.id])}>终止</button>}
          {st === 'failed' && s?.status === 'failed' && <button className="act" onClick={() => onRetry(r.id, i)}>重试</button>}
        </span>
      </div>
    )
  }
  return (
    <aside className="drawer">
      <div className="drawer-head">
        <span className="drawer-kicker">处理队列</span>
        <span className="spacer" />
        {active.length > 0 && <button className="btn btn-outline" onClick={() => setConfirm(true)}>全部终止</button>}
        <button className="icon-btn" onClick={onClose} aria-label="关闭">×</button>
      </div>
      <div className="drawer-body">
        {confirm && (
          <div className="q-confirm">
            <span>进行中的 {active.length} 条分诊执行都会停下，做完的步骤不会撤回，终止后不能接着跑。</span>
            <button className="btn btn-danger" onClick={() => { onStop(active.map((r) => r.id)); setConfirm(false) }}>终止 {active.length} 条</button>
            <button className="btn btn-ghost" onClick={() => setConfirm(false)}>取消</button>
          </div>
        )}
        <div className="section-label">进行中 {active.length}</div>
        {active.length ? <div className="q-list">{active.map(row)}</div> : <div className="muted">没有进行中的分诊</div>}
        <div className="section-label">最近结束</div>
        {recent.length ? <div className="q-list">{recent.map(row)}</div> : <div className="muted">还没有跑完的分诊</div>}
      </div>
    </aside>
  )
}
