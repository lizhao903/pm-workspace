// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { useEffect, useRef, useState } from 'react'
import type { Message } from './data'
import { focusIndex, runShow, runStatus, STEP_STATUS, type Json, type RunStep, type Sop, type SopRun, type SopStepDef } from './sopflow'
import { cls } from './ui'

/*
 * IM 消息页的批量分诊和处理队列（SPEC-messages-1.51~1.53）。
 * 分诊 = 给一条消息发起一次 SOP 执行，输入里带 message_id；执行按 input.message_id 关联消息。
 * 正式产品走 SOP 插件的 POST /api/sop/flows/{id}/runs/batch（按 message_id 跳过已跑过的）和 GET /api/sop/runs?input_key=message_id。
 */

/** 一次批量发起最多几条（同正式产品 SOP_BATCH_MAX）；更多时自动分批 */
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
 * 一次分诊的结论（SPEC-messages-2.44）。正式产品从执行详情取（分流套分诊时再取子执行，见 frontend/src/plugins/im/triageSummary.ts，判定档次与依据写法已对齐），原型的执行就带着每步输出。
 * 原则：结论由流程里的「判断」决定，建议只是附带内容，不能单独决定结论。不认步骤 key，按节点类型和输出字段认，从上往下第一档成立的就是结论：
 *   1. 跑没跑完：失败、等确认、执行中、终止。
 *   2. 路由步骤：判断范围里做完的分类器、条件分支，从后往前第一个「选的那一路读得出要处理还是忽略」的（读那一路的名字：
 *      需要、要处理、跟进、yes… 是要处理；不需要、忽略、不用、跳过、no… 是忽略）定结论。条件分支选了「已忽略」一路（如「已经忽略了吗」）是「已忽略，未判断」。
 *   3. 建了任务（做完的创建任务节点有 output.task）：要处理。
 *   4. 输出字段：need = yes 要处理，need = no 可忽略；im_mark_message 标了 ignore（output.marked.state）可忽略。
 *   5. 路由步骤选了读不出要不要处理的一路：结论就写那一路的名字。
 *   6. 都没有：没得出结论。
 * 依据（basis）写定结论的那一步：「<步骤名>」选了「<那一路>」（<route_reason>），或建了任务、输出 need、标了已忽略。
 * 建议：输出里的 advice；没有时取做完的 AI 节点配置的输出字段，但 SKIP 这类「不处理」暗号不算建议；结论是可忽略、已忽略时不带建议。
 * project、task 输出是归到的项目、建的任务
 */
export type TriageSummary = {
  verdict: 'handle' | 'ignore' | 'skipped' | 'other' | 'none' | 'running' | 'waiting' | 'failed' | 'stopped'
  label: string
  /** 为什么是这个结论，抽屉里写成「依据：…」；跑没跑完那一档为空 */
  basis: string
  /** 结论旁边的灰字：执行中、等确认的当前步骤，失败的步骤，终止、没得出结论的说明 */
  step: string
  advice: string; error: string
  project: string; tasks: string[]
}
const txt = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
const objOf = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? v as Json : null)
/** 路由那一路读起来是忽略、要处理；先认忽略（「不需要」里也有「需要」） */
const IGNORE_RE = /忽略|不需要|不用|不处理|无需|无关|跳过|^否$|^no$|ignore|skip|drop/i
const HANDLE_RE = /处理|需要|跟进|要我|建任务|^是$|^yes$|handle|need|todo/i
/** AI 输出里表示「不处理」的暗号，不当建议 */
const NOOP_RE = /^(skip|skipped|ignore|none|no|n\/a|null|无|不处理|忽略|跳过)$/i
type X = { s: RunStep; d?: SopStepDef }
const caseOf = (x: X) => x.d?.cases?.find((c) => c.key === x.s.route)?.label || x.s.route || ''
/** 读那一路的名字；没配名字时读 key */
function routeVerdict(x: X): 'handle' | 'ignore' | 'skipped' | '' {
  const l = caseOf(x)
  if (x.d?.kind === 'decide' && /已忽略|已经忽略/.test(l)) return 'skipped'
  if (IGNORE_RE.test(l)) return 'ignore'
  if (HANDLE_RE.test(l)) return 'handle'
  return ''
}
const LABEL = { handle: '要处理', ignore: '可忽略', skipped: '已忽略，未判断' }
export function triageSummary(r: SopRun): TriageSummary {
  const ss: X[] = r.steps.map((s, i) => ({ s, d: r.sop.steps[i] as SopStepDef | undefined }))
  const done = ss.filter((x) => x.s.status === 'done')
  const name = (x: X) => x.d?.name ?? x.s.key
  const last = (k: string) => done.map((x) => x.s.output?.[k] ?? objOf(objOf(x.s.output?.subflow)?.output)?.[k]).filter((v) => v !== undefined).pop()
  const aiOut = done.filter((x) => x.d?.kind === 'ai' && x.d.config?.output).map((x) => txt(x.s.output?.[x.d!.config!.output])).filter(Boolean).pop() ?? ''
  const advice = txt(last('advice')) || (NOOP_RE.test(aiOut.replace(/[\s。.！!]+$/, '')) ? '' : aiOut)
  const p = objOf(last('project'))
  const taskSteps = done.filter((x) => x.d?.kind === 'task' && txt(objOf(x.s.output?.task)?.ref))
  const tasks = taskSteps.map((x) => txt(objOf(x.s.output?.task)?.ref))
  const base = { advice, project: p ? txt(p.name) || txt(p.ref) : '', tasks, step: '', error: '', basis: '' }
  const st = runStatus(r)
  // 1. 跑没跑完
  if (st === 'failed') { const f = ss.find((x) => x.s.status === 'failed'); return { ...base, verdict: 'failed', label: '分诊失败', step: f ? `「${name(f)}」` : '', error: f?.s.error ?? '执行失败' } }
  if (st === 'waiting') { const w = ss.find((x) => x.s.status === 'paused' || x.s.status === 'review'); return { ...base, verdict: 'waiting', label: '分诊等确认', step: w ? name(w) : '' } }
  if (st === 'running') { const c = ss.find((x) => x.s.status === 'running'); return { ...base, verdict: 'running', label: '分诊中', step: c ? `${name(c)} · ${c.s.queue ? `排队中，前面 ${c.s.queue.ahead} 个` : '执行中'}` : '' } }
  if (st === 'stopped') return { ...base, verdict: 'stopped', label: '已终止', step: '中途终止，没跑完' }
  const quiet = { ...base, advice: '' }
  // 2. 路由步骤：从后往前第一个读得出的
  const routes = done.filter((x) => (x.d?.kind === 'classifier' || x.d?.kind === 'decide') && x.s.route)
  const said = (x: X) => `「${name(x)}」选了「${caseOf(x)}」${x.s.route_reason ? `（${x.s.route_reason}）` : ''}`
  const hit = [...routes].reverse().find((x) => routeVerdict(x))
  if (hit) {
    const v = routeVerdict(hit) as 'handle' | 'ignore' | 'skipped'
    return { ...(v === 'handle' ? base : quiet), verdict: v, label: LABEL[v], basis: said(hit) }
  }
  // 3. 建了任务
  if (taskSteps.length) return { ...base, verdict: 'handle', label: '要处理', basis: `「${name(taskSteps[taskSteps.length - 1])}」建了任务${tasks.length ? ` ${tasks.join('、')}` : ''}` }
  // 4. 输出字段
  const need = txt(last('need')).toLowerCase()
  const needAt = (k: string) => { const x = done.find((y) => txt(y.s.output?.need ?? objOf(objOf(y.s.output?.subflow)?.output)?.need).toLowerCase() === k); return x ? `「${name(x)}」` : '' }
  if (need === 'yes') return { ...base, verdict: 'handle', label: '要处理', basis: `${needAt('yes')}输出 need = yes` }
  if (need === 'no') return { ...quiet, verdict: 'ignore', label: '可忽略', basis: `${needAt('no')}输出 need = no` }
  // 输出逐步累积，第一个带着的就是标的那一步
  const mk = done.find((x) => txt(objOf(x.s.output?.marked)?.state) === 'ignore')
  if (mk) return { ...quiet, verdict: 'ignore', label: '可忽略', basis: `「${name(mk)}」把消息标为已忽略` }
  // 5. 路由选了读不出的一路
  const lr = routes[routes.length - 1]
  if (lr) return { ...base, verdict: 'other', label: caseOf(lr), basis: said(lr) }
  // 6. 没得出结论
  return { ...base, verdict: 'none', label: '没得出结论', step: '流程跑完了，但没有判断要不要处理的步骤' }
}

/** 悬停摘要：结论 + 建议前 80 字（没有建议写依据） */
export function triageBrief(s: TriageSummary, max = 80) {
  const body = (s.advice || s.basis || s.step).replace(/\s+/g, ' ').trim()
  return body ? `${s.label}：${body.length > max ? `${body.slice(0, max)}…` : body}` : s.label
}

/**
 * 结论小标（SPEC-messages-2.45）：原消息抽屉「消息列回复」一节里已分诊的回复，在分诊小标后面再跟一个结论（要处理、可忽略……），
 * 颜色同「分诊建议」的结论；悬停「<结论>：<建议前 80 字>」，点了打开那条回复的抽屉并滚到「分诊建议」。没分诊完的不显示
 */
export function TriageVerdictTag({ run, onOpenAdvice }: { run: SopRun | undefined; onOpenAdvice: () => void }) {
  if (!run || runStatus(run) !== 'done') return null
  const s = triageSummary(run)
  return (
    <button className={cls('msg-tri', `msg-tri-${TONE[s.verdict]}`)} title={triageBrief(s)} onClick={(e) => { e.stopPropagation(); onOpenAdvice() }}>{s.label}</button>
  )
}

const TONE: Record<TriageSummary['verdict'], string> = { handle: 'ok', running: 'run', waiting: 'wait', failed: 'bad', ignore: 'mute', skipped: 'mute', other: 'mute', none: 'mute', stopped: 'mute' }
const fmtAt = (t: number) => new Date(t).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })

/** 一条消息的分诊执行，最近的在前 */
export const triageRunsOf = (runs: SopRun[], messageId: string) => triageRuns(runs).filter((r) => msgIdOf(r) === messageId).sort((a, b) => b.started_at - a.started_at)

function SummaryCard({ r, onOpenRun }: { r: SopRun; onOpenRun: (id: string) => void }) {
  const s = triageSummary(r)
  return (
    <div className="tri-card">
      <div className="act-row">
        <span className={cls('msg-tri', `msg-tri-${TONE[s.verdict]}`)}>{s.label}</span>
        {s.step && <span className="muted">{s.step}</span>}
      </div>
      {s.basis && <div className="tri-basis"><span className="tri-basis-k">依据：</span>{s.basis}</div>}
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

/** 一次批量分诊最多多少条（自动分批前的总数，TSK-0492）；超过不发起。防误操作：每条都会调模型 */
export const TRIAGE_TOTAL_MAX = 1000
/** 原型里每批之间停一下，看得到分批进度（正式产品是等上一批的请求回来） */
const BATCH_GAP_MS = 700

type BatchState = { batches: number; batch: number; started: number; skipped: number; rest: string[]; stopping: boolean; done: boolean; stopped: boolean }

/**
 * 批量分诊条：列表上方展开，挑流程（默认第一个）、「已跑过的也重跑」、发起。
 * 范围：勾了的就是勾选的，没勾就是当前筛选结果全部（scope 写明）。超过 TRIAGE_MAX（200）条按每批 200 条依次发起（TSK-0492），
 * 显示第 k/n 批、已发起、跳过，中途能停止（已发起的保留，剩下的能继续）；超过 TRIAGE_TOTAL_MAX（1000）条不发起。
 * onBatch 发一批（正式产品是一次 POST /api/sop/flows/{id}/runs/batch），回发起、跳过各几条；原型不会失败，失败汇总和重试见正式产品
 * 立即停止（TSK-0717，SPEC-messages-1.66）：这条展开一次生成一个批次，每批都带它（记在执行的 source_ref）；发起中、发完后都能
 * 「立即停止」：停掉这次分诊已发起的全部执行（正式产品 POST /api/sop/runs/stop {batch_id}），之后的批不再发；
 * 发起后留在条上，显示这批执行现在执行中、等你处理、已完成、失败、已停止各几条，停完写停了多少、完成多少，已建出的任务不撤回
 */
export function TriageBar({ sops, runs, targets, scope, onBatch, onStopRuns, onDone, onCancel }: {
  sops: Sop[]; runs: SopRun[]; targets: Message[]
  /** 「勾选的 N 条」或「当前筛选结果全部 N 条」 */
  scope: string
  onBatch: (sopId: string, ids: string[], rerun: boolean, batchId: string) => { started: number; skipped: number }
  /** 立即停止：停这些执行（这次分诊发起的、还在跑的） */
  onStopRuns: (runIds: string[]) => void
  onDone: (r: { started: number; skipped: number }) => void
  onCancel: () => void
}) {
  const list = triageSops(sops)
  const [pick, setPick] = useState('')
  const sopId = pick || list[0]?.id || ''
  const [rerun, setRerun] = useState(false)
  const [st, setSt] = useState<BatchState | null>(null)
  const stopRef = useRef(false)
  // 这次分诊的批次（正式产品前端生成 spb_ 加 16 位，后端校验格式）
  const [batchId] = useState(() => `spb_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`)
  const [halted, setHalted] = useState<number | null>(null)
  const mine = runs.filter((r) => r.source_ref === batchId)
  const count = (k: string) => mine.filter((r) => runShow(r) === k).length
  const live = mine.filter((r) => { const k = runShow(r); return k === 'running' || k === 'waiting' })
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  const done = new Set(triageRuns(runs).filter((r) => r.sop_id === sopId).map(msgIdOf))
  const ran = targets.filter((m) => done.has(m.id)).length
  const over = targets.length > TRIAGE_TOTAL_MAX
  const n = rerun ? targets.length : targets.length - ran
  const batches = Math.ceil(targets.length / TRIAGE_MAX)

  // 逐批发：发一批、停一下再发下一批；停止后不再发，剩下的记在 rest
  const run = (ids: string[], base: { started: number; skipped: number }) => {
    const chunks: string[][] = []
    for (let i = 0; i < ids.length; i += TRIAGE_MAX) chunks.push(ids.slice(i, i + TRIAGE_MAX))
    stopRef.current = false
    let acc = { ...base }
    const step = (i: number) => {
      if (stopRef.current) { setSt((x) => x && { ...x, stopped: true, done: true, stopping: false, rest: chunks.slice(i).flat() }); return }
      const r = onBatch(sopId, chunks[i], rerun, batchId)
      acc = { started: acc.started + r.started, skipped: acc.skipped + r.skipped }
      const last = i === chunks.length - 1
      setSt({ batches: chunks.length, batch: i + 1, ...acc, rest: [], stopping: stopRef.current && !last, done: last, stopped: false })
      if (!last) timer.current = window.setTimeout(() => step(i + 1), BATCH_GAP_MS)
      // 一条都没发起（全跳过）直接收起；发起了的留着，能看这批执行、能立即停止（TSK-0717）
      else if (chunks.length === 1 && !base.started && !base.skipped && !acc.started) onDone(acc)
    }
    setSt({ batches: chunks.length, batch: 0, ...acc, rest: [], stopping: false, done: false, stopped: false })
    timer.current = window.setTimeout(() => step(0), chunks.length > 1 ? BATCH_GAP_MS : 0)
  }

  if (st) {
    const pct = st.batches ? Math.round((st.batch / st.batches) * 100) : 100
    const head = !st.done ? `第 ${Math.min(st.batch + 1, st.batches)}/${st.batches} 批发起中${st.stopping ? '，这批发完后停止' : ''}`
      : st.stopped ? `已停止：发完 ${st.batch}/${st.batches} 批，剩 ${st.rest.length} 条没发起` : `${st.batches} 批都发完了`
    return (
      <div className="msg-triage-bar" aria-live="polite">
        <b>批量分诊</b>
        <span>{head}</span>
        <span className="tri-prog" role="progressbar" aria-label="分批进度" aria-valuemin={0} aria-valuemax={st.batches} aria-valuenow={st.batch}><i style={{ width: `${pct}%` }} /></span>
        <span className="muted">已发起 {st.started} · 跳过 {st.skipped} · 失败 0 · 共 {targets.length} 条</span>
        <span className="spacer" />
        {!st.done && halted === null && <button className="btn btn-outline" disabled={st.stopping} onClick={() => { stopRef.current = true; setSt((x) => x && { ...x, stopping: true }) }}>不再发下一批</button>}
        {(live.length > 0 || !st.done) && halted === null && (
          <button className="btn btn-danger" title="停掉这次分诊已发起的全部执行，后面的批也不再发；已建出的任务不撤回"
            onClick={() => { stopRef.current = true; setHalted(live.length); onStopRuns(live.map((r) => r.id)) }}>立即停止</button>
        )}
        {st.done && st.rest.length > 0 && halted === null && <button className="btn btn-outline" onClick={() => run(st.rest, { started: st.started, skipped: st.skipped })}>继续发起剩下的 {st.rest.length} 条</button>}
        {st.done && <button className="btn btn-primary" onClick={() => onDone({ started: st.started, skipped: st.skipped })}>完成</button>}
        {mine.length > 0 && (
          <span className="tri-runs" aria-label="这次分诊的执行">
            这次分诊的执行：执行中 {count('running')} · 等你处理 {count('waiting')} · 已完成 {count('done')} · 失败 {count('failed')} · 已停止 {count('stopped')}
          </span>
        )}
        {halted !== null && <span className="tri-halted" role="status">已立即停止：停了 {halted} 条，已完成 {count('done')} 条。已建出的任务不会撤回</span>}
      </div>
    )
  }
  return (
    <div className="msg-triage-bar">
      <b>批量分诊</b>
      <span className="muted">{scope}，各发起一次流程</span>
      {list.length ? (
        <select value={sopId} onChange={(e) => setPick(e.target.value)} aria-label="分诊流程">
          {list.map((s) => <option key={s.id} value={s.id}>{s.trigger === 'im' ? `${s.name}（来消息自动跑）` : s.name}</option>)}
        </select>
      ) : <span className="muted">还没有能分诊消息的流程（触发方式是 IM，或输入字段有 message_id）</span>}
      <label className="msg-triage-check"><input type="checkbox" checked={rerun} onChange={(e) => setRerun(e.target.checked)} />已跑过的也重跑</label>
      {!rerun && ran > 0 && <span className="muted">其中 {ran} 条已跑过，会跳过</span>}
      {!over && batches > 1 && <span className="muted">超过一次 {TRIAGE_MAX} 条，按每批 {TRIAGE_MAX} 条分 {batches} 批依次发起</span>}
      {over && <span className="field-err">一次最多分诊 {TRIAGE_TOTAL_MAX} 条，现在有 {targets.length} 条。先勾选，或用状态、渠道、群组、搜索缩小范围</span>}
      <span className="spacer" />
      <button className="btn btn-primary" disabled={over || !sopId || n <= 0} onClick={() => run(targets.map((m) => m.id), { started: 0, skipped: 0 })}>
        发起 {Math.max(0, n)} 次{batches > 1 ? `，分 ${batches} 批` : ''}
      </button>
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
