// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 分诊建议（消息抽屉、组抽屉的「分诊建议」一节，列表行「已分诊」小标的悬停摘要）的纯函数。
// 一次分诊 = 一条顶层执行 + 它起的子执行（例如「消息分流」用 subflow 节点跑「消息分诊」）；按输入 message_id 查到的执行列表里两者都在，
// 子执行带 parent_run_id，这里先按它把同一次分诊归到一起（triageAttempts），再从执行详情（GET /api/sop/runs/{id}）里取结论。
// 取结论不认步骤 key，按节点类型和输出字段认，两种流程形状（分流套分诊、直接分诊）都适用：
//   建议：输出里的 advice（或 subflow.output.advice），没有时取 ai 节点自己配置的输出字段；
//   要处理：输出 need = yes、有建议，或分类器选了「处理」那类；可忽略：im_mark_message 标了 ignore，或分类器选了「忽略」那类；
//   已忽略未判断：判断范围里没有分类器跑过，只有条件分支选了一路（如「已经忽略了吗」）；
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

export type TriageVerdict = 'handle' | 'ignore' | 'skipped' | 'other' | 'running' | 'waiting' | 'failed' | 'stopped'

export type TriageSummary = {
  verdict: TriageVerdict
  /** 结论的说法：要处理、可忽略、已忽略，未判断、分诊中…… */
  label: string
  /** 为什么这么判：分类器、条件分支的 route_reason；忽略时补一句「已标为已忽略」 */
  reason: string
  advice: string
  /** 归到的项目；routeLabel 是没归项目时选中那一路的名字（如「非项目」）；都没有说明流程里没有这一步 */
  project: { id: string; ref: string; name: string } | null
  routeLabel: string
  /** 判定方式：按群名、按内容、按规则；why 是那一步的 route_reason */
  by: { how: string; why: string } | null
  tasks: { id: string; ref: string; title: string }[]
  /** 进行中、等确认时的当前步骤；失败时失败的步骤和原因 */
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
const caseLabel = (s: Step) => s.def?.cases?.find((c) => c.key === s.route)?.label ?? s.route ?? ''

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

/** 建议：advice 字段；没有时取做完的 ai 节点配置的输出字段 */
function adviceOf(ss: readonly Step[]): string {
  const a = text(lastField(ss, 'advice'))
  if (a) return a
  for (const s of [...ss].reverse()) {
    const key = s.def?.config?.output
    if (kindOf(s) === 'ai' && s.status === 'done' && key) { const v = text(s.output?.[key]); if (v) return v }
  }
  return ''
}

/** 分类器选的那一类读起来是要处理还是可忽略；都不像为空 */
function routeVerdict(s: Step): 'handle' | 'ignore' | '' {
  const k = `${s.route ?? ''} ${caseLabel(s)}`
  if (/ignore|skip|drop|忽略|不用|无关/i.test(k)) return 'ignore'
  if (/handle|need|todo|处理|跟进|要我/i.test(k)) return 'handle'
  return ''
}

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
  const need = text(lastField(childSteps, 'need') ?? lastField(topSteps, 'need')).toLowerCase() === 'yes'
  const marked = all.filter((s) => kindOf(s) === 'im_mark_message' && s.status === 'done').map((s) => text(obj(s.output?.marked)?.state)).pop() ?? ''
  const cls = scope.filter((s) => kindOf(s) === 'classifier' && isRoute(s)).pop()
  const lastDecide = scope.filter((s) => kindOf(s) === 'decide' && isRoute(s)).pop()

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

  const tasks = all.filter((s) => kindOf(s) === 'task' && s.status === 'done').flatMap((s) => {
    const t = obj(s.output?.task)
    return t && text(t.id) ? [{ id: text(t.id), ref: text(t.ref), title: text(t.title) }] : []
  })

  const base = {
    advice, project, routeLabel, by, tasks, step: '', error: '',
    flow: top.flow_name, subFlow: child?.flow_name ?? '', started_at: top.started_at, ended_at: top.ended_at ?? '',
    runId: top.id, childId: child?.id ?? '',
  }

  // 失败、进行中、终止先说；子执行优先
  const failed = [...childSteps, ...topSteps].find((s) => s.status === 'failed')
  const runs = child ? [child, top] : [top]
  if (failed || runs.some((r) => r.status === 'failed')) {
    return { ...base, verdict: 'failed', label: '分诊失败', reason: '', step: failed ? nameOf(failed) : '', error: failed?.error || '执行失败' }
  }
  const waiting = [...childSteps, ...topSteps].find((s) => s.status === 'paused' || s.status === 'review')
  if (waiting || runs.some((r) => r.status === 'waiting')) {
    return { ...base, verdict: 'waiting', label: '分诊等确认', reason: '', step: waiting ? `${nameOf(waiting)} · ${STEP_STATE[waiting.status]}` : '' }
  }
  if (runs.some((r) => r.status === 'running')) {
    const cur = [...childSteps, ...topSteps].find((s) => s.status === 'running')
    return { ...base, verdict: 'running', label: '分诊中', reason: '', step: cur ? `${nameOf(cur)} · ${cur.queue ? `排队中，前面 ${cur.queue.ahead} 个` : '执行中'}` : '' }
  }
  if (top.status === 'stopped' || child?.status === 'stopped') return { ...base, verdict: 'stopped', label: '已终止', reason: '中途终止，没跑完' }

  // 跑完了：结论
  const clsReason = cls?.route_reason ?? ''
  if (need || advice) return { ...base, verdict: 'handle', label: '要处理', reason: clsReason }
  if (marked === 'ignore') return { ...base, verdict: 'ignore', label: '可忽略', reason: [clsReason, '已标为已忽略'].filter(Boolean).join('；') }
  if (cls) {
    const v = routeVerdict(cls)
    if (v === 'handle') return { ...base, verdict: 'handle', label: '要处理', reason: clsReason }
    if (v === 'ignore') return { ...base, verdict: 'ignore', label: '可忽略', reason: clsReason }
    return { ...base, verdict: 'other', label: caseLabel(cls), reason: clsReason }
  }
  if (lastDecide) {
    const l = caseLabel(lastDecide)
    const skipped = /忽略|ignore|skip/i.test(`${lastDecide.route} ${l}`)
    return { ...base, verdict: skipped ? 'skipped' : 'other', label: skipped ? '已忽略，未判断' : l, reason: lastDecide.route_reason ?? '' }
  }
  return { ...base, verdict: 'other', label: '没得出结论', reason: '流程跑完了，但没有判断要不要处理的步骤' }
}

/** 列表小标悬停的一段：结论 + 建议前 80 字（没有建议时写理由） */
export function triageBrief(s: TriageSummary, max = ADVICE_BRIEF): string {
  const body = (s.advice || s.reason).replace(/\s+/g, ' ').trim()
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
