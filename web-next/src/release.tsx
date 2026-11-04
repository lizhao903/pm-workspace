import { useEffect, useState, useSyncExternalStore } from 'react'
import type { ProfileCommand, ProfileCommandKey } from './projectdata'
import type { Task } from './taskdata'
import { cls, timeAgo } from './ui'
import type { Worktree } from './worktree'

// 发布（AUTO-10，SPEC-tasks-4.77 到 4.81）：工作区里「最近一次测试」下面的「最近一次发布」。
// 发布由 SOP「发布 pipeline」发起：准备段（审批前，版本号与更新日志、打包）跑完停在「等上线审批」，审批走 SOP 的人工节点；
// 批准后上线段跑发布前检查、发布、线上冒烟，没过自动回滚。原型的 SOP 没有插件节点，这里用「阶段进待发布」模拟发布 pipeline 起准备段，
// 定时器推进到「等上线审批」，能「作废」；上线段原型不演示（看规格 4.78、4.80）。数据存在这个文件的内存里，刷新即清空，没有种子。
// 正式产品：internal/plugins/projects/release.go（表 projects_releases）、frontend/src/plugins/projects/ReleaseBlock.tsx、core/data/releases.ts

type StepKey = 'version' | 'package' | 'preflight' | 'release' | 'prod_smoke' | 'rollback'
type StepStatus = 'pending' | 'running' | 'passed' | 'failed' | 'skipped' | 'stopped'
type Status = 'running' | 'prepared' | 'released' | 'failed' | 'rolled_back' | 'rollback_failed' | 'stopped' | 'interrupted' | 'cancelled'
type Phase = 'prepare' | 'deploy'

interface Step { key: StepKey; label: string; phase: Phase; command: string; status: StepStatus; exit_code: number | null; duration_ms: number; output: string; error: string; started: boolean }
export interface Release {
  id: string
  task_id: string
  status: Status
  phase: Phase
  version: string
  changelog: string
  steps: Step[]
  error: string
  rollback_state: '' | 'done' | 'failed' | 'unavailable'
  source: 'api' | 'sop'
  started_at: string
  report: boolean
}

const LABEL: Record<StepKey, string> = { version: '版本号与更新日志', package: '打包', preflight: '发布前检查', release: '发布', prod_smoke: '线上冒烟', rollback: '回滚' }
const STATUS_LABEL: Record<Status, string> = {
  running: '进行中', prepared: '等上线审批', released: '已上线', failed: '没成功', rolled_back: '已回滚', rollback_failed: '回滚失败', stopped: '已停止', interrupted: '没跑完', cancelled: '已作废',
}
const STEP_STATUS: Record<StepStatus, string> = { pending: '等着', running: '在跑', passed: '通过', failed: '没通过', skipped: '跳过', stopped: '已停止' }
const ROLLBACK: Record<'done' | 'failed' | 'unavailable', string> = { done: '已自动回滚', failed: '自动回滚也没成功，请马上人工处理', unavailable: '档案里没有回滚命令，没有回滚，请人工处理' }

let state: Release[] = []
const subs = new Set<() => void>()
const set = (next: Release[]) => { state = next; subs.forEach((f) => f()) }
const useReleases = () => useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f) }, () => state)
const patch = (id: string, f: (r: Release) => Release) => set(state.map((r) => (r.id === id ? f(r) : r)))
const timers = new Map<string, ReturnType<typeof setTimeout>>()

/** 模拟发布 pipeline 的「准备发布」：只跑版本号与打包，审批后的几步定下来、等着 */
function prepare(task: Task, commands: Partial<Record<ProfileCommandKey, ProfileCommand>>) {
  const keys = (['version', 'package', 'preflight', 'release', 'prod_smoke', 'rollback'] as const).filter((k) => commands[k]?.command.trim())
  if (!commands.release?.command.trim()) return
  const version = `v1.${Math.floor(Date.now() / 60000) % 100}.0`
  const r: Release = {
    id: `rel_${Math.random().toString(36).slice(2, 8)}`, task_id: task.id, status: 'running', phase: 'prepare', version: '', changelog: '', error: '', rollback_state: '',
    source: 'sop', started_at: new Date().toISOString(), report: false,
    steps: keys.map((k) => ({ key: k, label: LABEL[k], phase: k === 'version' || k === 'package' ? 'prepare' : 'deploy', command: commands[k]!.command, status: 'pending',
      exit_code: null, duration_ms: 0, output: '', error: '', started: false })),
  }
  set(state.map((x) => (x.task_id === task.id && x.status === 'prepared' ? { ...x, status: 'cancelled', error: '又准备了一次发布，这次作废' } : x)))
  set([r, ...state])
  const prep = r.steps.map((s, i) => [s, i] as const).filter(([s]) => s.phase === 'prepare').map(([, i]) => i)
  const advance = (n: number) => {
    const cur = state.find((x) => x.id === r.id)
    if (!cur || cur.status !== 'running') return
    if (n >= prep.length) {
      patch(r.id, (x) => ({ ...x, status: 'prepared', report: true, version, changelog: `- ${task.title}` }))
      return
    }
    const i = prep[n]
    patch(r.id, (x) => ({ ...x, steps: x.steps.map((s, j) => (j === i ? { ...s, status: 'running', started: true } : s)) }))
    timers.set(r.id, setTimeout(() => {
      patch(r.id, (x) => ({ ...x, steps: x.steps.map((s, j) => (j === i ? { ...s, status: 'passed', exit_code: 0, duration_ms: 1200, output: s.key === 'version' ? version : 'done' } : s)) }))
      advance(n + 1)
    }, 1200))
  }
  timers.set(r.id, setTimeout(() => advance(0), 300))
}

/** 停止（在跑）或作废（等审批） */
function stop(id: string) {
  clearTimeout(timers.get(id))
  patch(id, (x) => {
    if (x.status === 'running') {
      return { ...x, status: 'stopped', error: '手动停止', report: true,
        steps: x.steps.map((s) => (s.status === 'running' ? { ...s, status: 'stopped', error: '手动停止' } : s.status === 'pending' ? { ...s, status: 'skipped' } : s)) }
    }
    if (x.status === 'prepared') return { ...x, status: 'cancelled', error: '手动作废，没有上线', steps: x.steps.map((s) => (s.status === 'pending' ? { ...s, status: 'skipped' } : s)) }
    return x
  })
}

const tone = (s: Status | StepStatus) => (s === 'released' || s === 'passed' ? 'ok' : s === 'failed' || s === 'rolled_back' || s === 'rollback_failed' ? 'bad'
  : s === 'running' ? 'run' : s === 'prepared' ? 'warn' : 'muted')

function summary(r: Release): string {
  const v = r.version ? `版本 ${r.version}` : '没有版本号'
  if (r.status === 'running') { const c = r.steps.find((s) => s.status === 'running'); return c ? `正在${c.label}` : r.phase === 'deploy' ? '正在上线' : '正在准备发布' }
  if (r.status === 'prepared') return `${v} 已打包。等上线审批：审批前不跑发布前检查、发布、线上冒烟`
  if (r.status === 'released') return `${v} 已上线，线上冒烟通过`
  if (r.status === 'failed' && r.phase === 'deploy' && !r.rollback_state) return `${r.error || '没成功'}；还没动生产`
  return `${r.error || STATUS_LABEL[r.status]}${r.rollback_state ? `；${ROLLBACK[r.rollback_state]}` : ''}`
}

/** 工作区里「最近一次发布」（SPEC-tasks-4.77 起）。阶段进「待发布」且工作区在用时模拟发布 pipeline 起准备段；没有发布记录时整块不显示 */
export function TaskReleaseBlock({ task, active, commands }: { task: Task; active?: Worktree; commands: Partial<Record<ProfileCommandKey, ProfileCommand>> }) {
  const list = useReleases()
  const last = list.find((r) => r.task_id === task.id)
  const releasing = task.stage === 'releasing'
  const [hint, setHint] = useState(false)
  useEffect(() => {
    if (releasing && active && !state.some((r) => r.task_id === task.id && (r.status === 'running' || r.status === 'prepared'))) prepare(task, commands)
  }, [releasing, active, task, commands])
  if (!last) return null
  const running = last.status === 'running'
  const prepared = last.status === 'prepared'
  return (
    <div className="wtt" role="group" aria-label="最近一次发布">
      <div className="wtt-head">
        <span className="field-group-title">最近一次发布</span>
        <span className={cls('wtt-badge', tone(last.status))}>{STATUS_LABEL[last.status]}</span>
        {last.version && <code>{last.version}</code>}
        <span className="list-sub">{timeAgo(last.started_at)}{last.source === 'sop' ? '，SOP 发起' : ''}</span>
        <span className="wtt-actions">
          {last.report && !running && <button className="act act-quiet" onClick={() => setHint(!hint)}>看报告</button>}
          {(running || prepared) && <button className={cls('btn btn-sm', running ? 'btn-danger' : 'btn-outline')} onClick={() => stop(last.id)}>{running ? '停止' : '作废'}</button>}
        </span>
      </div>
      <div className={cls('wtt-summary', tone(last.status))}>{summary(last)}</div>
      {hint && <div className="list-sub">正式产品新标签页打开发布报告原文：GET /api/projects/releases/runs/{'{release_id}'}/report</div>}
      {(['prepare', 'deploy'] as const).map((ph) => {
        const steps = last.steps.filter((s) => s.phase === ph)
        if (!steps.length) return null
        return (
          <div key={ph} className="wtr-phase">
            <span className="wtr-phase-title">{ph === 'prepare' ? '审批前' : '审批后'}</span>
            <ol className="wtt-steps">
              {steps.map((s) => {
                const bits = [s.exit_code !== null ? `退出码 ${s.exit_code}` : '', s.started && s.status !== 'running' ? `${(s.duration_ms / 1000).toFixed(1)} 秒` : ''].filter(Boolean)
                return (
                  <li key={s.key} className="wtt-step">
                    <div className="wtt-step-line">
                      <span className="wtt-step-label">{s.label}</span>
                      <span className={cls('wtt-step-state', tone(s.status))}>{STEP_STATUS[s.status]}</span>
                      {bits.length > 0 && <span className="list-sub">{bits.join('，')}</span>}
                      <code className="wtt-cmd" title={s.command}>{s.command}</code>
                    </div>
                    {s.error && s.status !== 'passed' && <div className={cls('wtt-step-err', tone(s.status))}>{s.error}</div>}
                    {s.output && <details className="wtt-out"><summary>输出尾部</summary><pre>{s.output}</pre></details>}
                  </li>
                )
              })}
            </ol>
          </div>
        )
      })}
      {last.changelog && <details className="wtt-out"><summary>更新日志</summary><pre>{last.changelog}</pre></details>}
    </div>
  )
}
