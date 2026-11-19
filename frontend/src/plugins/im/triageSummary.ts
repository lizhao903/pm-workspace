// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 分诊建议（消息抽屉、组抽屉的「分诊建议」一节，列表行「已分诊」小标的悬停摘要）的纯函数。
// 一次分诊 = 一条顶层执行 + 它起的子执行（例如「消息分流」用 subflow 节点跑「消息分诊」）；按输入 message_id 查到的执行列表里两者都在，
// 子执行带 parent_run_id，这里先按它把同一次分诊归到一起（triageAttempts），再从执行详情（GET /api/sop/runs/{id}）里取结论。
// 取结论不认步骤 key，按节点类型和输出字段认，两种流程形状（分流套分诊、直接分诊）都适用（SPEC-messages-2.44）。
// 原则：结论由流程里的「判断」决定，建议只是附带内容，不能单独决定结论。从上往下，第一档成立的就是结论：
//   1. 跑没跑完：失败、等确认、执行中、终止；
//   2. 路由步骤：判断范围里做完的分类器、条件分支，从后往前第一个「选的那一路读得出要处理还是忽略」的定结论
//      （读那一路的名字，没配名字读 key；先认忽略类，「不需要」里也有「需要」）；条件分支选了「已忽略」一路是「已忽略，未判断」；
//   3. 建了任务（做完的 task 节点有 output.task）：要处理；
//   4. 输出字段：need = yes 要处理，need = no 可忽略；im_mark_message 标了 ignore（output.marked.state）可忽略；
//   5. 有路由步骤但选的那一路读不出：结论写那一路的名字；
//   6. 都没有：没得出结论。
//   依据（basis）写定结论的那一档那一步，抽屉里写成「依据：…」（SPEC-messages-2.41）。
//   建议：输出里的 advice（或 subflow.output.advice），没有时取做完的 ai 节点配置的输出字段，但 SKIP、NONE、无、不处理这类暗号不算；
//     结论是可忽略、已忽略时不带建议。
//   项目：做完的 im_set_project 节点的 output.project；判定方式看往上最近一个做完的分类器（按内容）或条件分支（规则看群名的算按群名）；
//     没有归项目但子流程前有路由的（如分到「非项目」），写那一路的名字；
//   任务：做完的 task 节点的 output.task。
// 判断范围（分类器、条件分支、失败步骤）优先看子执行：分流执行里的项目分类器不算分诊结论。
import type { SopInputRun, SopJson, SopRun, SopRunStep, SopStepDef } from '../../core/data'

/** 一次分诊：顶层执行和它起的子执行（最近的在前） */
export type TriageAttempt = { top: SopInputRun; children: SopInputRun[] }

/** 悬停摘要截多少字 */
export const ADVICE_BRIEF = 80

const byStartDesc = (a: { started_at: string }, b: { started_at: string }) => b.started_at.localeCompare(a.started_at)

/**
 * 按消息把执行归成一次次分诊，最近的在前：父执行也在列表里的子执行挂到父执行下；
 * 父执行不在列表里（父流程输入没带 message_id）的子执行自己算一次
 */
export function triageAttempts(runs: readonly SopInputRun[]): Map<string, TriageAttempt[]> {
  const ids = new Set(runs.map((r) => r.id))
  const kids = new Map<string, SopInputRun[]>()
  for (const r of runs) {
    if (r.parent_run_id && ids.has(r.parent_run_id)) kids.set(r.parent_run_id, [...(kids.get(r.parent_run_id) ?? []), r])
  }
  const out = new Map<string, TriageAttempt[]>()
  for (const r of [...runs].sort(byStartDesc)) {
    if (!r.input_value || (r.parent_run_id && ids.has(r.parent_run_id))) continue
    const a = { top: r, children: (kids.get(r.id) ?? []).sort(byStartDesc) }
    out.set(r.input_value, [...(out.get(r.input_value) ?? []), a])
  }
  return out
}

/**
 * 一次分诊整体的状态：有失败（没重跑过）的算失败，再看等确认、执行中；顶层终止了算终止，否则完成。
 * 子执行做完、父执行还在建任务时算执行中
 */
export function attemptStatus(a: TriageAttempt): SopInputRun['status'] {
  const all = [a.top, ...a.children]
  if (all.some((r) => r.status === 'failed' && !r.relaunched_to)) return 'failed'
  if (all.some((r) => r.status === 'waiting')) return 'waiting'
  if (all.some((r) => r.status === 'running')) return 'running'
  if (a.top.status === 'stopped' || a.top.status === 'failed') return a.top.status
  return 'done'
}

/** 一次分诊里要取详情的子执行：最近的那个 */
export const attemptChildId = (a: TriageAttempt | null | undefined) => a?.children[0]?.id ?? null

export type TriageVerdict = 'handle' | 'ignore' | 'skipped' | 'other' | 'none' | 'running' | 'waiting' | 'failed' | 'stopped'

export type TriageSummary = {
  verdict: TriageVerdict
  /** 结论的说法：要处理、可忽略、已忽略，未判断、分诊中…… */
  label: string
  /**
   * 依据：定结论的那一步，抽屉里写成「依据：…」——「<步骤名>」选了「<那一路>」（<route_reason>）、「<步骤名>」建了任务 T-1、
   * 「<步骤名>」输出 need = yes、「<步骤名>」把消息标为已忽略；跑没跑完那一档、没得出结论时为空
   */
  basis: string
  advice: string
  /** 归到的项目；routeLabel 是没归项目时选中那一路的名字（如「非项目」）；都没有说明流程里没有这一步 */
  project: { id: string; ref: string; name: string } | null
  routeLabel: string
  /** 判定方式：按群名、按内容、按规则；why 是那一步的 route_reason */
  by: { how: string; why: string } | null
  tasks: { id: string; ref: string; title: string }[]
  /** 结论旁边的灰字：进行中、等确认时的当前步骤；失败时失败的步骤（原因在 error）；终止、没得出结论的说明 */
  step: string
  error: string
  flow: string
  /** 子执行的流程名（分流套分诊时是分诊流程） */
  subFlow: string
  started_at: string
  ended_at: string
  runId: string
  childId: string
}

type Step = SopRunStep & { def: SopStepDef | undefined }

const steps = (r: SopRun): Step[] => {
  const defs = new Map(r.flow.steps.map((d) => [d.key, d]))
  return r.steps.map((s) => ({ ...s, def: defs.get(s.key) }))
}
const kindOf = (s: Step) => s.def?.kind ?? ''
const nameOf = (s: Step) => s.def?.name || s.key
const obj = (v: unknown): SopJson | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as SopJson : null)
const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
const isRoute = (s: Step) => (kindOf(s) === 'classifier' || kindOf(s) === 'decide') && s.status === 'done' && !!s.route
const caseLabel = (s: Step) => s.def?.cases?.find((c) => c.key === s.route)?.label || s.route || ''

/** 一个输出字段：自己的，或子流程节点带回的 subflow.output 里的 */
function field(out: SopJson | null, key: string): unknown {
  if (!out) return undefined
  if (out[key] !== undefined) return out[key]
  return obj(obj(out.subflow)?.output)?.[key]
}

/** 做完的步骤里这个字段最后的值（输出是逐步累积的，后面的步骤也带着） */
function lastField(ss: readonly Step[], key: string): unknown {
  let v: unknown
  for (const s of ss) if (s.status === 'done') { const x = field(s.output, key); if (x !== undefined) v = x }
  return v
}

/** AI 输出里表示「不处理」的暗号，不当建议（生产里转任务流程的 AI 节点回 SKIP） */
const NOOP_RE = /^(skip|skipped|ignore|none|no|n\/a|null|无|不处理|忽略|跳过)$/i

/** 建议：advice 字段；没有时取最后一个做完的 ai 节点配置的输出字段，是「不处理」暗号时不算 */
function adviceOf(ss: readonly Step[]): string {
  const a = text(lastField(ss, 'advice'))
  if (a) return a
  for (const s of [...ss].reverse()) {
    const key = s.def?.config?.output
    if (kindOf(s) === 'ai' && s.status === 'done' && key) {
      const v = text(s.output?.[key])
      if (v) return NOOP_RE.test(v.replace(/[\s。.！!]+$/, '')) ? '' : v
    }
  }
  return ''
}

/** 路由那一路读起来是忽略、要处理；先认忽略（「不需要」里也有「需要」） */
const IGNORE_RE = /忽略|不需要|不用|不处理|无需|无关|跳过|^否$|^no$|ignore|skip|drop/i
const HANDLE_RE = /处理|需要|跟进|要我|建任务|^是$|^yes$|handle|need|todo/i

/** 路由步骤选的那一路读起来是要处理、可忽略，条件分支选了「已忽略」一路是已忽略未判断；都不像为空。读那一路的名字，没配名字读 key */
function routeVerdict(s: Step): 'handle' | 'ignore' | 'skipped' | '' {
  const l = caseLabel(s)
  if (kindOf(s) === 'decide' && /已忽略|已经忽略/.test(l)) return 'skipped'
  if (IGNORE_RE.test(l)) return 'ignore'
  if (HANDLE_RE.test(l)) return 'handle'
  return ''
}

const VERDICT_LABEL = { handle: '要处理', ignore: '可忽略', skipped: '已忽略，未判断' } as const

/** 路由步骤的依据：「<步骤名>」选了「<那一路>」（<route_reason>） */
const said = (s: Step) => `「${nameOf(s)}」选了「${caseLabel(s)}」${s.route_reason ? `（${s.route_reason}）` : ''}`

/** 往上（after、branch.of）找最近一个做完的分类器、条件分支 */
function nearestRoute(ss: readonly Step[], from: Step): Step | null {
  const byKey = new Map(ss.map((s) => [s.key, s]))
  const seen = new Set<string>([from.key])
  let layer = [from]
  while (layer.length) {
    const next: Step[] = []
    for (const s of layer) {
      const ups = [...(s.def?.after ?? []), ...(s.def?.branch ? [s.def.branch.of] : [])]
      for (const k of ups) {
        const u = byKey.get(k)
        if (!u || seen.has(k)) continue
        seen.add(k)
        if (isRoute(u)) return u
        if (u.status === 'done') next.push(u)
      }
    }
    layer = next
  }
  return null
}

function routeHow(s: Step): string {
  if (kindOf(s) === 'classifier') return '按内容'
  return /conversation|群/.test(s.def?.rule ?? '') ? '按群名' : '按规则'
}

const STEP_STATE: Record<string, string> = { running: '执行中', paused: '等确认输入', review: '等人检查' }

/**
 * 从一次分诊的执行详情里取结论：top 是顶层执行，children 是它起的子执行（取到了的，最近的在前）
 */
export function summarizeTriage(top: SopRun, children: readonly SopRun[] = []): TriageSummary {
  const topSteps = steps(top)
  const child = children[0]
  const childSteps = child ? steps(child) : []
  // 判断范围：有子执行看子执行，没有看自己
  const scope = child ? childSteps : topSteps
  const all = [...topSteps, ...childSteps]

  const advice = adviceOf(childSteps) || adviceOf(topSteps)

  // 项目
  const setStep = topSteps.filter((s) => kindOf(s) === 'im_set_project' && s.status === 'done').pop()
  const p = obj(setStep?.output?.project)
  const project = p ? { id: text(p.id), ref: text(p.ref), name: text(p.name) || text(p.ref) } : null
  let routeLabel = ''
  let byStep = setStep ? nearestRoute(topSteps, setStep) : null
  if (!setStep && child) {
    const sub = topSteps.find((s) => kindOf(s) === 'subflow' && s.child_run_id === child.id)
      ?? topSteps.filter((s) => kindOf(s) === 'subflow' && s.status !== 'bypassed' && s.status !== 'pending').pop()
    byStep = sub ? nearestRoute(topSteps, sub) : null
    if (byStep) routeLabel = caseLabel(byStep)
  }
  const by = byStep ? { how: routeHow(byStep), why: byStep.route_reason ?? '' } : null

  const taskSteps = all.filter((s) => kindOf(s) === 'task' && s.status === 'done' && text(obj(s.output?.task)?.id))
  const tasks = taskSteps.map((s) => {
    const t = obj(s.output?.task)!
    return { id: text(t.id), ref: text(t.ref), title: text(t.title) }
  })

  const base = {
    advice, project, routeLabel, by, tasks, step: '', error: '', basis: '',
    flow: top.flow_name, subFlow: child?.flow_name ?? '', started_at: top.started_at, ended_at: top.ended_at ?? '',
    runId: top.id, childId: child?.id ?? '',
  }

  // 失败、进行中、终止先说；子执行优先
  const failed = [...childSteps, ...topSteps].find((s) => s.status === 'failed')
  const runs = child ? [child, top] : [top]
  if (failed || runs.some((r) => r.status === 'failed')) {
    return { ...base, verdict: 'failed', label: '分诊失败', step: failed ? nameOf(failed) : '', error: failed?.error || '执行失败' }
  }
  const waiting = [...childSteps, ...topSteps].find((s) => s.status === 'paused' || s.status === 'review')
  if (waiting || runs.some((r) => r.status === 'waiting')) {
    return { ...base, verdict: 'waiting', label: '分诊等确认', step: waiting ? `${nameOf(waiting)} · ${STEP_STATE[waiting.status]}` : '' }
  }
  if (runs.some((r) => r.status === 'running')) {
    const cur = [...childSteps, ...topSteps].find((s) => s.status === 'running')
    return { ...base, verdict: 'running', label: '分诊中', step: cur ? `${nameOf(cur)} · ${cur.queue ? `排队中，前面 ${cur.queue.ahead} 个` : '执行中'}` : '' }
  }
  if (top.status === 'stopped' || child?.status === 'stopped') return { ...base, verdict: 'stopped', label: '已终止', step: '中途终止，没跑完' }

  // 跑完了：可忽略、已忽略时不带建议
  const quiet = { ...base, advice: '' }
  // 2. 路由步骤：判断范围里从后往前第一个读得出要处理还是忽略的
  const routes = scope.filter(isRoute)
  const hit = [...routes].reverse().find((s) => routeVerdict(s))
  if (hit) {
    const v = routeVerdict(hit) as keyof typeof VERDICT_LABEL
    return { ...(v === 'handle' ? base : quiet), verdict: v, label: VERDICT_LABEL[v], basis: said(hit) }
  }
  // 3. 建了任务
  if (taskSteps.length) {
    const refs = tasks.map((t) => t.ref || t.title).filter(Boolean).join('、')
    return { ...base, verdict: 'handle', label: '要处理', basis: `「${nameOf(taskSteps[taskSteps.length - 1])}」建了任务${refs ? ` ${refs}` : ''}` }
  }
  // 4. 输出字段：need（子执行优先），im_mark_message 标了 ignore
  const needSteps = child && lastField(childSteps, 'need') !== undefined ? childSteps : topSteps
  const need = text(lastField(needSteps, 'need')).toLowerCase()
  // 输出逐步累积，第一个带着这个值的就是输出它的那一步
  const needAt = needSteps.find((s) => s.status === 'done' && text(field(s.output, 'need')).toLowerCase() === need)
  const needBasis = `${needAt ? `「${nameOf(needAt)}」` : ''}输出 need = ${need}`
  if (need === 'yes') return { ...base, verdict: 'handle', label: '要处理', basis: needBasis }
  if (need === 'no') return { ...quiet, verdict: 'ignore', label: '可忽略', basis: needBasis }
  const mk = all.filter((s) => kindOf(s) === 'im_mark_message' && s.status === 'done' && text(obj(s.output?.marked)?.state) === 'ignore').pop()
  if (mk) return { ...quiet, verdict: 'ignore', label: '可忽略', basis: `「${nameOf(mk)}」把消息标为已忽略` }
  // 5. 路由选了读不出的一路
  const lr = routes[routes.length - 1]
  if (lr) return { ...base, verdict: 'other', label: caseLabel(lr), basis: said(lr) }
  // 6. 没得出结论
  return { ...base, verdict: 'none', label: '没得出结论', step: '流程跑完了，但没有判断要不要处理的步骤' }
}

/** 列表小标悬停的一段：结论 + 建议前 80 字（没有建议时写依据，再没有写结论旁边的说明） */
export function triageBrief(s: TriageSummary, max = ADVICE_BRIEF): string {
  const body = (s.advice || s.basis || s.step).replace(/\s+/g, ' ').trim()
  const cut = body.length > max ? `${body.slice(0, max)}…` : body
  return cut ? `${s.label}：${cut}` : s.label
}

/** 结论的颜色档：要处理是醒目色，失败红，进行中、等确认同列表小标，其余灰 */
export function verdictTone(v: TriageVerdict): 'ok' | 'run' | 'wait' | 'bad' | 'mute' {
  switch (v) {
    case 'handle': return 'ok'
    case 'running': return 'run'
    case 'waiting': return 'wait'
    case 'failed': return 'bad'
    default: return 'mute'
  }
}
