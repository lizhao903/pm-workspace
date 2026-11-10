// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 流水线视图和待我处理的纯函数（AUTO-12，SPEC-sop-16、SPEC-today-1.30）。
// 时间线 = 阶段变化（审计 kind=stage）+ 跟这条需求有关的 SOP 执行和步骤（GET /api/sop/pipeline/{id}），按时间排；
// 阶段耗时 = 这次进入到下一次变化（当前阶段算到现在）；卡点 = 等人、失败、超时、超出上限暂停的步骤。
import {
  WAITING_STAGES, taskStageLabel, type SopPipeline, type SopPipelineStep, type SopWaitKind, type SopWaitingItem, type StageChange, type WorkObject,
} from '../../core/data'
import type { TodayItem, TodayTone } from '../../core/plugin'

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

/** 耗时的写法：不到 1 分钟、N 分钟、N 小时 M 分、N 天 M 小时 */
export function durationText(ms: number): string {
  if (!Number.isFinite(ms) || ms < MIN) return '不到 1 分钟'
  if (ms < HOUR) return `${Math.floor(ms / MIN)} 分钟`
  if (ms < DAY) {
    const h = Math.floor(ms / HOUR)
    const m = Math.floor((ms % HOUR) / MIN)
    return m ? `${h} 小时 ${m} 分` : `${h} 小时`
  }
  const d = Math.floor(ms / DAY)
  const h = Math.floor((ms % DAY) / HOUR)
  return h ? `${d} 天 ${h} 小时` : `${d} 天`
}

/** 一段阶段：从进入到离开（当前阶段 end 为空，耗时算到 now） */
export type StageSpan = { stage: string; label: string; start: string; end?: string; ms: number; current: boolean; waiting: boolean }

/** 阶段变化（早的在前）切成一段一段；清掉阶段（to 为空）的那段不算 */
export function stageSpans(changes: readonly StageChange[], now: number): StageSpan[] {
  const sorted = [...changes].sort((a, b) => a.at.localeCompare(b.at))
  const out: StageSpan[] = []
  sorted.forEach((c, i) => {
    if (!c.to) return
    const next = sorted[i + 1]
    const end = next?.at
    const ms = (end ? Date.parse(end) : now) - Date.parse(c.at)
    out.push({ stage: c.to, label: taskStageLabel(c.to), start: c.at, end, ms: Math.max(0, ms), current: !next, waiting: WAITING_STAGES.includes(c.to) })
  })
  return out
}

/** 每个阶段累计耗时（同一阶段进出多次加起来），按第一次进入的先后 */
export function stageTotals(spans: readonly StageSpan[]): { stage: string; label: string; ms: number; times: number; current: boolean }[] {
  const out: { stage: string; label: string; ms: number; times: number; current: boolean }[] = []
  for (const s of spans) {
    const g = out.find((x) => x.stage === s.stage)
    if (g) { g.ms += s.ms; g.times++; g.current ||= s.current }
    else out.push({ stage: s.stage, label: s.label, ms: s.ms, times: 1, current: s.current })
  }
  return out
}

/** 步骤上的标记：第几轮、重试几次（不含被退回重做的轮次）、退回几轮、超出上限、排队 */
export function stepTags(s: SopPipelineStep): string[] {
  const tags: string[] = []
  if ((s.round ?? 0) > 1) tags.push(`第 ${s.round} 轮`)
  // 每被退回一轮 attempts 也会加 1，重试次数要扣掉轮次
  const retries = s.attempts - Math.max(s.round ?? 0, 1)
  if (retries > 0) tags.push(`重试 ${retries} 次`)
  if ((s.loops ?? 0) > 0) tags.push(`已退回 ${s.loops} 轮`)
  if (s.hold && !s.hold.released) tags.push('超出上限暂停')
  else if (s.hold?.released) tags.push('超限后已放行')
  if (s.status === 'running' && s.queue) tags.push(s.queue.slot === 'claude_code' ? '排队等 Claude Code' : '排队等模型')
  return tags
}

export type TimelineRow =
  | { kind: 'stage'; key: string; at: string; label: string; from: string; ms: number; current: boolean; waiting: boolean }
  | { kind: 'run'; key: string; at: string; runId: string; label: string; status: string; sub: boolean; end?: string }
  /** waiting：停在等人（待确认、待处理），ms 是从开始等（超出上限的从暂停时）到现在 */
  | { kind: 'step'; key: string; at: string; runId: string; step: SopPipelineStep; ms: number; tags: string[]; flow: string; waiting: boolean }

/** 没开始过的、没走到的分支不进时间线 */
const started = (s: SopPipelineStep) => !!s.started_at && s.status !== 'bypassed' && s.status !== 'pending'

/** 合成时间线：阶段变化、执行开始、步骤开始，按时间早的在前；同一时刻阶段在前、再执行、再步骤 */
export function timelineRows(changes: readonly StageChange[], p: SopPipeline | undefined, now: number): TimelineRow[] {
  const rows: TimelineRow[] = []
  const spans = stageSpans(changes, now)
  const sorted = [...changes].sort((a, b) => a.at.localeCompare(b.at))
  for (const c of sorted) {
    const span = spans.find((s) => s.start === c.at && s.stage === c.to)
    rows.push({
      kind: 'stage', key: `st-${c.id}`, at: c.at, label: c.to ? taskStageLabel(c.to) : '清掉阶段', from: c.from ? taskStageLabel(c.from) : '',
      ms: span?.ms ?? 0, current: !!span?.current, waiting: !!span?.waiting,
    })
  }
  for (const r of p?.runs ?? []) {
    rows.push({ kind: 'run', key: `run-${r.id}`, at: r.started_at, runId: r.id, label: r.flow_name, status: r.status, sub: !!r.parent_run_id, end: r.ended_at })
    for (const s of r.steps) {
      if (!started(s)) continue
      const waiting = s.status === 'paused' || s.status === 'review'
      const from = waiting && s.hold && !s.hold.released ? s.hold.since : s.started_at!
      const end = s.ended_at && !waiting ? Date.parse(s.ended_at) : now
      rows.push({
        kind: 'step', key: `sp-${r.id}-${s.key}`, at: s.started_at!, runId: r.id, step: s, flow: r.flow_name,
        ms: Math.max(0, end - Date.parse(from)), tags: stepTags(s), waiting,
      })
    }
  }
  const order = { stage: 0, run: 1, step: 2 }
  return rows.map((r, i) => [r, i] as const)
    .sort((a, b) => a[0].at.localeCompare(b[0].at) || order[a[0].kind] - order[b[0].kind] || a[1] - b[1])
    .map(([r]) => r)
}

/** 等人的种类怎么说、点了做什么 */
export const WAIT_TEXT: Record<SopWaitKind, { label: string; action: string; tone: TodayTone }> = {
  review: { label: '等人工检查', action: '去检查', tone: 'warn' },
  decide: { label: '等人工判断', action: '去判断', tone: 'warn' },
  agent: { label: '等确认工具调用', action: '去确认', tone: 'warn' },
  confirm: { label: '等确认输入', action: '去确认', tone: 'warn' },
  hold: { label: '超出上限暂停', action: '去放行', tone: 'danger' },
  failed: { label: '失败', action: '去处理', tone: 'danger' },
  timeout: { label: '超时', action: '去处理', tone: 'danger' },
}

/** 阶段等人时的说法和动作（待确认项目、需人工、待验收） */
export const STAGE_WAIT: Record<string, { label: string; action: string }> = {
  confirm_project: { label: '等确认归到哪个项目', action: '去选项目' },
  need_human: { label: '流程转人工，等你裁决', action: '去裁决' },
  accepting: { label: '等你验收', action: '去验收' },
}

/** SOP 执行页地址 */
export const runPath = (runId: string) => `/sop/runs/${encodeURIComponent(runId)}`
/** 任务详情的流水线标签 */
export const pipelinePath = (taskId: string) => `/tasks?t=${encodeURIComponent(taskId)}&tab=pipeline`

const stageOfTask = (t: WorkObject) => (typeof t.props?.stage === 'string' ? t.props.stage : '')

/**
 * 今日「待我处理」（SPEC-today-1.30）：SOP 里等人的步骤，加上停在等人阶段（待确认项目、需人工、待验收）的任务。
 * 同一个需求已经有等人的步骤时，阶段那条不重复列（步骤那条的说明里带上任务和阶段）。
 * 步骤点了去执行页处理；阶段点了打开任务的流水线标签
 */
export function waitingTodayItems(steps: readonly SopWaitingItem[], tasks: readonly WorkObject[]): { total: number; items: TodayItem[] } {
  const byId = new Map(tasks.map((t) => [t.id, t]))
  const items: TodayItem[] = steps.map((w) => {
    const t = w.task_id ? byId.get(w.task_id) : undefined
    const look = WAIT_TEXT[w.wait] ?? WAIT_TEXT.review
    const st = t ? stageOfTask(t) : ''
    const who = t ? `${t.ref} ${t.title}${st ? ` · ${taskStageLabel(st)}` : ''}` : w.run_title
    const why = w.wait === 'decide' || w.wait === 'review' || w.wait === 'confirm' ? look.label : `${look.label}：${w.reason}`
    return {
      id: `sop-${w.run_id}-${w.step_key}`, tone: look.tone, title: `${w.step_name} · ${w.flow_name}`, sub: `${who} · ${why}`,
      at: w.since, action: look.action, to: runPath(w.run_id), rank: w.wait === 'hold' ? -1 : 0,
    }
  })
  for (const t of stageWaitTasks(steps, tasks)) {
    const st = stageOfTask(t)
    const look = STAGE_WAIT[st]
    items.push({
      id: `stage-${t.id}`, tone: st === 'need_human' ? 'danger' : 'warn', title: `${t.ref} ${t.title}`,
      sub: `${taskStageLabel(st)} · ${look.label}`, at: t.updated_at, action: look.action, to: pipelinePath(t.id),
    })
  }
  return { total: items.length, items }
}

/**
 * 停在等人阶段、又没有等人的 SOP 步骤算到它头上的任务（今日「待我处理」和 SOP「待我处理」共用这一个口径，TSK-0486）。
 * 同一个需求已经有等人的步骤时不重复列，处理入口在步骤那条
 */
export function stageWaitTasks(steps: readonly SopWaitingItem[], tasks: readonly WorkObject[]): WorkObject[] {
  const covered = new Set(steps.map((w) => w.task_id).filter(Boolean))
  return tasks.filter((t) => !!STAGE_WAIT[stageOfTask(t)] && !covered.has(t.id))
}

/** 阶段任务一行的说法：阶段名、等什么、动作、颜色（需人工红，其余橙） */
export function stageWaitLook(t: WorkObject): { stage: string; label: string; action: string; danger: boolean } {
  const st = stageOfTask(t)
  const look = STAGE_WAIT[st] ?? { label: '', action: '去处理' }
  return { stage: taskStageLabel(st), label: look.label, action: look.action, danger: st === 'need_human' }
}

/** 从流水线标签去执行页后「返回」回到哪：宿主给的地址（或当前地址）带上 ?tab=pipeline */
export function backToPipeline(back: string): string {
  const i = back.indexOf('?')
  const path = i < 0 ? back : back.slice(0, i)
  const q = new URLSearchParams(i < 0 ? '' : back.slice(i + 1))
  q.set('tab', 'pipeline')
  return `${path}?${q.toString()}`
}
