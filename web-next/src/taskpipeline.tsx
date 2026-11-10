// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 任务详情的「流水线」（AUTO-12，SPEC-sop-16）：一条需求从接收到上线的流水线时间线。
// 上面是卡点（等人、失败、超时、超出上限暂停，能直接处理）和预算用量，中间是每个阶段累计耗时，下面按时间排：
// 阶段变化（task.stage_log）、SOP 执行开始、每一步的耗时、轮次和重试。点执行、步骤去 SOP 运行页。
// 正式前端在 frontend/src/plugins/sop/Pipeline.tsx（SOP 插件登记的任务详情标签），阶段变化取审计 kind=stage，SOP 部分走 GET /api/sop/pipeline/{id}
import { useEffect, useState, type CSSProperties } from 'react'
import {
  RUN_STATUS, STEP_STATUS, budgetKey, claudeUsage, isHeld, isQueued, runShow, type Governance, type RunAction, type RunStep, type SopRun,
} from './sopflow'
import { stageLabel } from './taskstage'
import type { Task } from './taskdata'
import { cls } from './ui'

function Pill({ label, color }: { label: string; color: string }) {
  return <span className="pill" style={{ '--c': color } as CSSProperties}><span className="pill-dot" />{label}</span>
}

const MIN = 60_000
/** 耗时的写法，同正式前端 pipelineModel.durationText */
export function durationText(ms: number): string {
  if (!Number.isFinite(ms) || ms < MIN) return '不到 1 分钟'
  if (ms < 60 * MIN) return `${Math.floor(ms / MIN)} 分钟`
  if (ms < 24 * 60 * MIN) {
    const h = Math.floor(ms / (60 * MIN))
    const m = Math.floor((ms % (60 * MIN)) / MIN)
    return m ? `${h} 小时 ${m} 分` : `${h} 小时`
  }
  const d = Math.floor(ms / (24 * 60 * MIN))
  const h = Math.floor((ms % (24 * 60 * MIN)) / (60 * MIN))
  return h ? `${d} 天 ${h} 小时` : `${d} 天`
}

/** 等人的阶段：今日「待我处理」也按它列（SPEC-today-1.30） */
export const WAITING_STAGES = ['confirm_project', 'need_human', 'accepting']

/** 等人的步骤怎么说 */
export function waitOf(run: SopRun, i: number): { label: string; action: string; danger: boolean } | null {
  const s = run.steps[i]
  const def = run.sop.steps[i]
  if (run.stopped) return null
  if (isHeld(s)) return { label: '超出上限暂停', action: '去放行', danger: true }
  if (s.status === 'paused') return { label: '等确认输入', action: '去确认', danger: false }
  if (s.status === 'review') return def.kind === 'decide' ? { label: '等人工判断', action: '去判断', danger: false } : { label: '等人工检查', action: '去检查', danger: false }
  if (s.status === 'failed') return /超时/.test(s.error ?? '') ? { label: '超时', action: '去处理', danger: true } : { label: '失败', action: '去处理', danger: true }
  return null
}

/** 跟这条需求有关的执行：关联到任务的，或输入里 task_id 是它的（研发 pipeline） */
export const taskRuns = (task: Task, runs: SopRun[]) => runs.filter((r) => r.object_id === task.id || r.input.task_id === task.id)

function tags(s: RunStep): string[] {
  const out: string[] = []
  if ((s.round ?? 0) > 1) out.push(`第 ${s.round} 轮`)
  const retries = s.attempts - Math.max(s.round ?? 0, 1)
  if (retries > 0) out.push(`重试 ${retries} 次`)
  if ((s.loops ?? 0) > 0) out.push(`已退回 ${s.loops} 轮`)
  if (isHeld(s)) out.push('超出上限暂停')
  else if (s.hold?.released) out.push('超限后已放行')
  if (isQueued(s)) out.push(s.queue?.slot === 'claude_code' ? '排队等 Claude Code' : '排队等模型')
  return out
}

type Row =
  | { kind: 'stage'; at: number; key: string; label: string; from: string; ms: number; current: boolean; waiting: boolean }
  | { kind: 'run'; at: number; key: string; run: SopRun }
  | { kind: 'step'; at: number; key: string; run: SopRun; i: number; ms: number }

export function TaskPipelineBlock({ task, runs, gov, onAct, onOpenRun }: {
  task: Task
  runs: SopRun[]
  gov: Governance
  onAct: (runId: string, a: RunAction) => void
  onOpenRun: (id: string) => void
}) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(t)
  }, [])
  const mine = taskRuns(task, runs)
  const log = [...(task.stage_log ?? [])].sort((a, b) => a.at.localeCompare(b.at))
  const spans = log.map((c, n) => {
    const end = log[n + 1] ? Date.parse(log[n + 1].at) : now
    return { ...c, ms: Math.max(0, end - Date.parse(c.at)), current: !log[n + 1] }
  })
  const totals: { stage: string; ms: number; times: number; current: boolean }[] = []
  for (const s of spans) {
    if (!s.to) continue
    const g = totals.find((x) => x.stage === s.to)
    if (g) { g.ms += s.ms; g.times++; g.current ||= s.current } else totals.push({ stage: s.to, ms: s.ms, times: 1, current: s.current })
  }
  const rows: Row[] = [
    ...spans.map((s, n) => ({ kind: 'stage' as const, at: Date.parse(s.at), key: `st${n}`, label: s.to ? stageLabel(s.to) : '清掉阶段', from: s.from ? stageLabel(s.from) : '', ms: s.ms, current: s.current, waiting: WAITING_STAGES.includes(s.to) })),
    ...mine.flatMap((r) => [
      { kind: 'run' as const, at: r.started_at, key: `r-${r.id}`, run: r },
      ...r.steps.map((s, i) => ({ s, i })).filter(({ s }) => s.started_at && s.status !== 'pending' && s.status !== 'bypassed')
        .map(({ s, i }) => ({ kind: 'step' as const, at: s.started_at!, key: `s-${r.id}-${i}`, run: r, i, ms: (s.ended_at ?? now) - s.started_at! })),
    ]),
  ].sort((a, b) => a.at - b.at || ({ stage: 0, run: 1, step: 2 })[a.kind] - ({ stage: 0, run: 1, step: 2 })[b.kind])
  const blockers = mine.flatMap((r) => r.steps.map((_, i) => ({ r, i, w: waitOf(r, i) })).filter((x) => x.w))
  const keys = [...new Set(mine.flatMap((r) => r.steps.map((_, i) => i).filter((i) => r.sop.steps[i].kind === 'claude_code').map((i) => budgetKey(r, i))))]
  const used = keys.reduce((acc, k) => { const u = claudeUsage(runs, k, now); return { runs: acc.runs + u.runs, minutes: acc.minutes + u.minutes } }, { runs: 0, minutes: 0 })
  const time = (t: number) => new Date(t).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })

  return (
    <section className="pl" aria-label="流水线">
      <div className="pl-head"><b>流水线</b><span className="muted">阶段变化、自动执行的每一步和卡点，按时间排</span></div>
      {blockers.length > 0 && (
        <div className="pl-blocks" aria-label="卡点">
          {blockers.map(({ r, i, w }) => {
            const s = r.steps[i]
            const def = r.sop.steps[i]
            return (
              <div key={`${r.id}-${i}`} className={cls('pl-block', w!.danger && 'bad')}>
                <div className="pl-block-text">
                  <b>{w!.label}</b>
                  <span>{def.name} · {r.sop.name}</span>
                  {(s.hold?.reason || s.error) && <span className="muted pl-why">{isHeld(s) ? s.hold!.reason : s.error}</span>}
                </div>
                <div className="pl-acts">
                  {isHeld(s) && <button className="btn btn-primary" onClick={() => onAct(r.id, { kind: 'confirm-input', step: i })}>放行这一次</button>}
                  {s.status === 'failed' && <button className="btn btn-primary" onClick={() => onAct(r.id, { kind: 'retry', step: i })}>重试</button>}
                  {s.status === 'review' && def.kind === 'decide' && (def.cases ?? []).map((c, n) => (
                    <button key={c.key} className={cls('btn', n === 0 ? 'btn-primary' : 'btn-outline')} onClick={() => onAct(r.id, { kind: 'route', step: i, route: c.key })}>走「{c.label}」</button>
                  ))}
                  {s.status === 'review' && def.kind !== 'decide' && <button className="btn btn-primary" onClick={() => onAct(r.id, { kind: 'approve', step: i })}>通过</button>}
                  <button className="btn" onClick={() => onOpenRun(r.id)}>去执行页</button>
                </div>
              </div>
            )
          })}
        </div>
      )}
      {mine.length > 0 && (
        <div className="pl-budget muted" aria-label="预算">
          Claude Code 已跑 <b>{used.runs}</b> 次{gov.task_max_claude_runs ? ` / 上限 ${gov.task_max_claude_runs} 次` : '（不限次数）'}
          {'，累计 '}<b>{used.minutes}</b> 分钟{gov.task_max_claude_minutes ? ` / 上限 ${gov.task_max_claude_minutes} 分钟` : '（不限时长）'}
        </div>
      )}
      {totals.length > 0 && (
        <div className="pl-stages" aria-label="阶段耗时">
          {totals.map((t) => (
            <div key={t.stage} className={cls('pl-stage', t.current && 'cur')}>
              <span className="pl-stage-name">{stageLabel(t.stage)}{t.times > 1 && <span className="pl-tag">{t.times} 次</span>}</span>
              <span className="muted">{durationText(t.ms)}</span>
            </div>
          ))}
        </div>
      )}
      {!rows.length && <div className="pl-empty muted">这条需求还没进流水线：没有阶段变化，也没有自动执行</div>}
      {rows.length > 0 && (
        <ol className="pl-list" aria-label="时间线">
          {rows.map((x) => {
            if (x.kind === 'stage') return (
              <li key={x.key} className={cls('pl-row stage', x.waiting && x.current && 'attn')}>
                <span className="pl-time">{time(x.at)}</span><span className="pl-dot" />
                <span className="pl-main">阶段{x.from ? `：${x.from} → ` : '：'}<b>{x.label}</b></span>
                <span className="pl-dur">{x.current ? `已停留 ${durationText(x.ms)}` : `停留 ${durationText(x.ms)}`}</span>
              </li>
            )
            if (x.kind === 'run') {
              const st = RUN_STATUS[runShow(x.run)]
              return (
                <li key={x.key} className="pl-row run">
                  <span className="pl-time">{time(x.at)}</span><span className="pl-dot" />
                  <button className="pl-main pl-link" onClick={() => onOpenRun(x.run.id)}>执行「{x.run.sop.name}」开始</button>
                  <Pill {...st} />
                </li>
              )
            }
            const s = x.run.steps[x.i]
            const look = isHeld(s) ? { label: '超出上限', color: '#c0392b' } : isQueued(s) ? { label: '排队中', color: '#7a7668' } : STEP_STATUS[s.status]
            return (
              <li key={x.key} className={cls('pl-row step', (s.status === 'failed' || isHeld(s)) && 'bad')}>
                <span className="pl-time">{time(x.at)}</span><span className="pl-dot" />
                <button className="pl-main pl-link" onClick={() => onOpenRun(x.run.id)} title={x.run.sop.name}>
                  {x.run.sop.steps[x.i].name}
                  {tags(s).map((t) => <span key={t} className="pl-tag">{t}</span>)}
                  {s.error && <span className="muted pl-why">{s.error}</span>}
                </button>
                <span className="pl-dur">{s.status === 'paused' || s.status === 'review' ? `已等 ${durationText(now - (s.hold?.since ?? s.started_at!))}` : durationText(x.ms)}</span>
                <Pill {...look} />
              </li>
            )
          })}
        </ol>
      )}
    </section>
  )
}
