import { useEffect, useState, useSyncExternalStore } from 'react'
import type { Project } from './projectdata'
import { TaskReleaseBlock } from './release'
import type { Task } from './taskdata'
import { cls, timeAgo } from './ui'
import './worktree.css'

// 需求工作区（AUTO-07，SPEC-tasks-4.50 到 4.58、SPEC-settings-25）：每个进研发的任务在项目代码库建一个独立 git worktree 和分支 auto/<任务编号>，
// 放在数据目录下的 worktrees/<项目>/<编号>，分一段端口给测试环境用。阶段进「开发中」时自动准备；任务完成、取消或阶段到已上线时自动清理（有没提交的改动时不删、记下原因），
// 分支合并了才删。原型把工作区存在这个文件的内存里，刷新回到种子数据。
// 正式产品：项目插件 internal/plugins/projects/worktrees.go（表 projects_worktrees、projects_worktree_settings），
// 正式前端 frontend/src/plugins/projects/WorktreeSection.tsx、WorktreeSettings.tsx，接口在 core/data/worktrees.ts
// 测试环境与测试报告（AUTO-08，SPEC-tasks-4.63 到 4.70）：工作区卡片下「最近一次测试」，原型用定时器模拟各步推进。
// 正式产品：internal/plugins/projects/testenv.go（表 projects_test_runs）、frontend/src/plugins/projects/TestRunBlock.tsx、core/data/testRuns.ts
// 保留测试环境给人工验收（AUTO-09，SPEC-tasks-4.73 到 4.76、SPEC-settings-25.7）：研发 pipeline 测试通过后环境不回收，
// 「最近一次测试」写「测试环境保留到 X，可访问」和「回收」；到点、阶段离开待验收、任务完成时回收。种子：T-017 待验收，环境保留中。
// 正式产品：internal/plugins/projects/testkeep.go（迁移 0008）
// 发布（AUTO-10，SPEC-tasks-4.77 到 4.81）：「最近一次测试」下面的「最近一次发布」，见 release.tsx

export interface Worktree {
  id: string
  task_id: string
  task_ref: string
  project_id: string
  repo_dir: string
  root: string
  path: string
  branch: string
  base_commit: string
  port_start: number
  port_count: number
  status: 'active' | 'removed'
  last_error: string
  removed_reason: '' | 'task_done' | 'task_cancelled' | 'released' | 'manual'
  branch_deleted: boolean
  /** 原型模拟：工作区里有没提交的改动（不强制清理会被拒） */
  dirty?: boolean
  /** 原型模拟：分支上有没合并的提交（清理时分支保留） */
  ahead?: boolean
  created_at: string
}

export interface WorktreeSettings { port_min: number; port_max: number; port_block: number; env_keep_hours: number }

/** 工作台自己用的端口（生产 7796、测试实例 7807 / 7817 等），范围不能和它重叠 */
export const RESERVED_RANGE = [7700, 7899] as const
export const WORKTREE_DIR = '/Volumes/project/example/pm-workspace/data-dev/worktrees'

const REASON: Record<Exclude<Worktree['removed_reason'], ''>, string> = {
  task_done: '任务完成后自动清理', task_cancelled: '任务取消后自动清理', released: '上线后自动清理', manual: '手动清理',
}

const minsAgo = (m: number) => new Date(Date.now() - m * 60000).toISOString()
const minsLater = (m: number) => new Date(Date.now() + m * 60000).toISOString()
const PMW = '/Volumes/project/example/pm-workspace'

export type TestStepKey = 'build' | 'test_env' | 'test' | 'smoke'
export type TestStepStatus = 'pending' | 'running' | 'passed' | 'failed' | 'skipped' | 'stopped'
export type TestRunStatus = 'running' | 'passed' | 'failed' | 'stopped' | 'interrupted'
export interface TestStep {
  key: TestStepKey
  label: string
  command: string
  status: TestStepStatus
  exit_code: number | null
  duration_ms: number
  timed_out: boolean
  output: string
  error: string
  ready?: string
  started: boolean
}
export interface TestRun {
  id: string
  task_id: string
  status: TestRunStatus
  steps: TestStep[]
  error: string
  url: string
  port: number
  report: boolean
  shots: string[]
  junit: { tests: number; failures: number; errors: number; failed: string[] } | null
  source: 'api' | 'sop'
  started_at: string
  /** 测试环境保留状态（AUTO-09）：空串没保留，kept 保留中，released 保留过、已回收 */
  env_state: '' | 'kept' | 'released'
  env_keep_until: string | null
  env_release_reason: '' | EnvReleaseReason
}

export type EnvReleaseReason = 'expired' | 'accepted' | 'stage_changed' | 'task_done' | 'worktree_removed' | 'rerun' | 'manual' | 'exited' | 'restart' | 'plugin_stopped'
export const ENV_RELEASE_LABEL: Record<EnvReleaseReason, string> = {
  expired: '保留时间到了', accepted: '验收通过', stage_changed: '验收结束', task_done: '任务完成或取消', worktree_removed: '工作区清理了',
  rerun: '又跑了一次测试', manual: '手动回收', exited: '测试环境自己退出了', restart: '工作台重启过', plugin_stopped: '项目插件停用或工作台关闭',
}

const STEP_LABEL: Record<TestStepKey, string> = { build: '构建', test_env: '起测试环境', test: '测试', smoke: '冒烟' }
export const TEST_STATUS_LABEL: Record<TestRunStatus, string> = { running: '在跑', passed: '通过', failed: '没通过', stopped: '已停止', interrupted: '没跑完' }
const STEP_STATUS_LABEL: Record<TestStepStatus, string> = { pending: '等着', running: '在跑', passed: '通过', failed: '没通过', skipped: '跳过', stopped: '已停止' }

const seedStep = (key: TestStepKey, command: string, over: Partial<TestStep> = {}): TestStep => ({
  key, label: STEP_LABEL[key], command, status: 'passed', exit_code: 0, duration_ms: 4200, timed_out: false, output: '', error: '', started: true, ...over,
})

let state: { list: Worktree[]; settings: WorktreeSettings; tests: TestRun[] } = {
  tests: [
    { id: 'tr_dev1', task_id: 'tk_dev1', status: 'failed', error: '测试：退出码 1', url: 'http://127.0.0.1:7910', port: 7910, report: true, source: 'sop',
      started_at: minsAgo(50), shots: ['export-large-tenant.png'], junit: { tests: 46, failures: 1, errors: 0, failed: ['export › 大租户分批导出不超时'] },
      steps: [
        seedStep('build', 'make build', { duration_ms: 38200, output: 'go build -o pmw ./cmd/pmw\nnpm --prefix frontend run build\n✓ built in 9.81s' }),
        seedStep('test_env', './pmw --addr :7910 --data /data/test-reports/pj_pmw/T-015/tr_dev1/out/data', { exit_code: null, duration_ms: 2100, ready: 'GET http://127.0.0.1:7910/api/health 回 2xx、3xx', output: 'listening on :7910' }),
        seedStep('test', 'go test ./... && npm --prefix frontend test', { status: 'failed', exit_code: 1, duration_ms: 96400, error: '退出码 1',
          output: '--- FAIL: TestExportLargeTenant (300.02s)\n    runner_test.go:88: export did not finish in 300s\nFAIL\tinternal/export\t300.4s' }),
        seedStep('smoke', 'curl -fsS http://127.0.0.1:7910/api/health', { status: 'skipped', exit_code: null, duration_ms: 0, started: false }),
      ], env_state: '', env_keep_until: null, env_release_reason: '' },
    // T-017 待验收：研发 pipeline 跑通了测试，测试环境保留给人工验收
    { id: 'tr_dev3', task_id: 'tk_dev3', status: 'passed', error: '', url: 'http://127.0.0.1:7920', port: 7920, report: true, source: 'sop',
      started_at: minsAgo(70), shots: ['dept-cache.png'], junit: { tests: 31, failures: 0, errors: 0, failed: [] },
      steps: [
        seedStep('build', 'make build', { duration_ms: 41800, output: '✓ built in 10.2s' }),
        seedStep('test_env', './server --port 7920', { exit_code: null, duration_ms: 1800, ready: 'GET http://127.0.0.1:7920/healthz 回 2xx、3xx', output: 'listening on :7920' }),
        seedStep('test', 'go test ./...', { duration_ms: 52300, output: 'ok\tinternal/perm\t3.1s' }),
        seedStep('smoke', 'curl -fsS http://127.0.0.1:7920/healthz', { duration_ms: 300, output: 'ok' }),
      ], env_state: 'kept', env_keep_until: minsLater(60 * 23), env_release_reason: '' },
  ],
  settings: { port_min: 7900, port_max: 8899, port_block: 10, env_keep_hours: 24 },
  list: [
    { id: 'wt_dev2', task_id: 'tk_dev2', task_ref: 'T-016', project_id: 'pj_pmw', repo_dir: PMW, root: `${WORKTREE_DIR}/pj_pmw/T-016`, path: `${WORKTREE_DIR}/pj_pmw/T-016`,
      branch: 'auto/T-016', base_commit: '4ae8545c1d', port_start: 7900, port_count: 10, status: 'active', last_error: '', removed_reason: '', branch_deleted: false,
      ahead: true, created_at: minsAgo(45) },
    { id: 'wt_dev1', task_id: 'tk_dev1', task_ref: 'T-015', project_id: 'pj_pmw', repo_dir: PMW, root: `${WORKTREE_DIR}/pj_pmw/T-015`, path: `${WORKTREE_DIR}/pj_pmw/T-015`,
      branch: 'auto/T-015', base_commit: '3fb77ce9a0', port_start: 7910, port_count: 10, status: 'active',
      last_error: '工作区里有没提交的改动，没有删：提交或丢弃后再清理，确认不要了就强制清理', removed_reason: '', branch_deleted: false,
      dirty: true, ahead: true, created_at: minsAgo(60 * 6) },
    { id: 'wt_dev3', task_id: 'tk_dev3', task_ref: 'T-017', project_id: 'pj_perm', repo_dir: '/Volumes/project/perm-center', root: `${WORKTREE_DIR}/pj_perm/T-017`,
      path: `${WORKTREE_DIR}/pj_perm/T-017`, branch: 'auto/T-017', base_commit: '9c1e07b2aa', port_start: 7920, port_count: 10, status: 'active', last_error: '',
      removed_reason: '', branch_deleted: false, ahead: true, created_at: minsAgo(60 * 3) },
  ],
}
const subs = new Set<() => void>()
const set = (next: typeof state) => { state = next; subs.forEach((f) => f()) }
const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f) } }
export const useWorktrees = () => useSyncExternalStore(subscribe, () => state)

/** 范围检查，同正式前端 portRangeError（后端也挡） */
export function portRangeError(min: number, max: number, block: number): string | null {
  if (![min, max, block].every(Number.isInteger)) return '填整数'
  if (min < 1024 || max > 65535 || min > max) return '端口要在 1024 到 65535 之间，起点不能大于终点'
  if (block < 1 || block > 100) return '每段 1 到 100 个'
  if (max - min + 1 < block) return `范围放不下一段 ${block} 个端口`
  if (min <= RESERVED_RANGE[1] && RESERVED_RANGE[0] <= max) return `不能和工作台自己用的 ${RESERVED_RANGE[0]}–${RESERVED_RANGE[1]} 重叠`
  return null
}

/** 准备：已有在用的直接复用；没有就按范围找第一段没被占的端口 */
export function prepareWorktree(task: Task, codeDir: string): { ok: true; w: Worktree } | { ok: false; error: string } {
  const cur = state.list.find((w) => w.task_id === task.id && w.status === 'active')
  if (cur) return { ok: true, w: cur }
  if (!codeDir) return { ok: false, error: '项目还没设代码库目录：到项目的档案里填' }
  const branch = `auto/${task.ref}`
  const used = state.list.filter((w) => w.status === 'active')
  const taken = used.find((w) => w.branch === branch)
  if (taken) return { ok: false, error: `分支 ${branch} 已经被 ${taken.root} 的 worktree 检出着：先在那里切到别的分支或删掉那个 worktree` }
  const s = state.settings
  let port = 0
  for (let lo = s.port_min; lo + s.port_block - 1 <= s.port_max; lo += s.port_block) {
    if (!used.some((w) => lo <= w.port_start + w.port_count - 1 && w.port_start <= lo + s.port_block - 1)) { port = lo; break }
  }
  if (!port) return { ok: false, error: `端口范围 ${s.port_min}–${s.port_max} 里没有空闲的端口段了：清理不用的工作区，或到设置里放宽范围` }
  const root = `${WORKTREE_DIR}/${task.project_id}/${task.ref}`
  const w: Worktree = {
    id: `wt_${Math.random().toString(36).slice(2, 8)}`, task_id: task.id, task_ref: task.ref, project_id: task.project_id ?? '', repo_dir: codeDir,
    root, path: root, branch, base_commit: Math.random().toString(16).slice(2, 12), port_start: port, port_count: s.port_block, status: 'active',
    last_error: '', removed_reason: '', branch_deleted: false, created_at: new Date().toISOString(),
  }
  set({ ...state, list: [w, ...state.list] })
  return { ok: true, w }
}

/** 清理：不强制时有改动被拒、原因记在 last_error；分支没有没合并的提交才一起删 */
export function cleanupWorktree(id: string, reason: Exclude<Worktree['removed_reason'], ''>, force: boolean): string | null {
  const w = state.list.find((x) => x.id === id)
  if (!w || w.status !== 'active') return null
  // 删之前先回收保留在这个工作区上的测试环境（AUTO-09），删没删成都回收
  releaseTaskEnv(w.task_id, reason === 'task_done' || reason === 'task_cancelled' ? 'task_done' : reason === 'released' ? 'accepted' : 'worktree_removed')
  if (w.dirty && !force) {
    const msg = '工作区里有没提交的改动，没有删：提交或丢弃后再清理，确认不要了就强制清理'
    set({ ...state, list: state.list.map((x) => (x.id === id ? { ...x, last_error: msg } : x)) })
    return msg
  }
  set({ ...state, list: state.list.map((x) => (x.id === id ? { ...x, status: 'removed', removed_reason: reason, branch_deleted: !x.ahead, last_error: '', dirty: false } : x)) })
  return null
}

export function saveWorktreeSettings(s: WorktreeSettings) { set({ ...state, settings: s }) }

/* ---------- 测试（AUTO-08） ---------- */

type CommandLike = { command: string; ready?: string }
const timers = new Map<string, ReturnType<typeof setTimeout>>()
const patchTest = (id: string, f: (r: TestRun) => TestRun) => set({ ...state, tests: state.tests.map((r) => (r.id === id ? f(r) : r)) })

/** 起一次测试：按档案的构建、起测试环境、测试、冒烟依次推进（原型每步 1.2 秒）；T-016 的「测试」这一步通过，别的任务也都通过 */
export function startTest(task: Task, w: Worktree, commands: Partial<Record<TestStepKey, CommandLike>>): string | null {
  if (state.tests.some((r) => r.task_id === task.id && r.status === 'running')) return `任务 ${task.ref} 的测试正在跑：等它跑完或先停掉`
  // 上次保留的测试环境占着同一段端口，先回收（AUTO-09）
  releaseTaskEnv(task.id, 'rerun')
  const keys = (['build', 'test_env', 'test', 'smoke'] as const).filter((k) => commands[k]?.command.trim())
  if (!keys.length) return '项目档案里没有构建、测试、起测试环境、冒烟命令：先到项目的档案里填'
  const port = w.port_start
  const sub = (c: string) => c.replace(/\{\{\s*PORT\s*\}\}/g, String(port))
  const r: TestRun = {
    id: `tr_${Math.random().toString(36).slice(2, 8)}`, task_id: task.id, status: 'running', error: '', port, report: false, shots: [], junit: null, source: 'api',
    url: commands.test_env ? `http://127.0.0.1:${port}` : '', started_at: new Date().toISOString(), env_state: '', env_keep_until: null, env_release_reason: '',
    steps: keys.map((k) => ({ key: k, label: STEP_LABEL[k], command: sub(commands[k]!.command), status: 'pending', exit_code: null, duration_ms: 0, timed_out: false,
      output: '', error: '', started: false, ready: k === 'test_env' ? (commands[k]!.ready ? `GET http://127.0.0.1:${port}${commands[k]!.ready} 回 2xx、3xx` : `端口 ${port} 能连上`) : undefined })),
  }
  set({ ...state, tests: [r, ...state.tests] })
  const advance = (i: number) => {
    const cur = state.tests.find((x) => x.id === r.id)
    if (!cur || cur.status !== 'running') return
    if (i >= cur.steps.length) {
      patchTest(r.id, (x) => ({ ...x, status: 'passed', report: true, junit: x.steps.some((s) => s.key === 'test') ? { tests: 12, failures: 0, errors: 0, failed: [] } : null }))
      return
    }
    patchTest(r.id, (x) => ({ ...x, steps: x.steps.map((s, j) => (j === i ? { ...s, status: 'running', started: true } : s)) }))
    timers.set(r.id, setTimeout(() => {
      patchTest(r.id, (x) => ({ ...x, steps: x.steps.map((s, j) => (j === i ? { ...s, status: 'passed', exit_code: s.key === 'test_env' ? null : 0, duration_ms: 1200,
        output: s.key === 'test_env' ? `listening on :${port}` : s.key === 'test' ? 'ok\tinternal/...\t0.8s\n✓ 12 passed' : 'done' } : s)) }))
      advance(i + 1)
    }, 1200))
  }
  timers.set(r.id, setTimeout(() => advance(0), 300))
  return null
}

/** 手动停止：当前步骤记已停止，后面的跳过，测试环境回收 */
export function stopTest(id: string) {
  clearTimeout(timers.get(id))
  patchTest(id, (x) => x.status !== 'running' ? x : ({ ...x, status: 'stopped', error: '手动停止', report: true,
    steps: x.steps.map((s) => (s.status === 'running' ? { ...s, status: 'stopped', error: '手动停止' } : s.status === 'pending' ? { ...s, status: 'skipped' } : s)) }))
}

/** 回收保留着的测试环境（AUTO-09）：手动、再跑一次、阶段离开待验收、任务完成、工作区清理 */
export function releaseEnv(id: string, reason: EnvReleaseReason) {
  patchTest(id, (x) => (x.env_state === 'kept' ? { ...x, env_state: 'released', env_release_reason: reason } : x))
}
export function releaseTaskEnv(taskId: string, reason: EnvReleaseReason) {
  state.tests.filter((r) => r.task_id === taskId && r.env_state === 'kept').forEach((r) => releaseEnv(r.id, reason))
}

const fmtUntil = (iso: string) => new Date(iso).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })

const tone = (s: TestRunStatus | TestStepStatus) => (s === 'passed' ? 'ok' : s === 'failed' ? 'bad' : s === 'running' ? 'run' : 'muted')
const dur = (ms: number) => (ms < 1000 ? `${ms} 毫秒` : ms < 60_000 ? `${(ms / 1000).toFixed(1)} 秒` : `${Math.floor(ms / 60_000)} 分 ${Math.floor((ms % 60_000) / 1000)} 秒`)

function testSummary(r: TestRun): string {
  if (r.status === 'running') { const c = r.steps.find((s) => s.status === 'running'); return c ? `正在${c.label}` : '正在准备' }
  const n = r.junit ? r.junit.failures + r.junit.errors : 0
  const cases = r.junit ? `，${r.junit.tests} 个用例${n ? `、${n} 个没通过` : ''}` : ''
  if (r.status === 'passed') return `全部通过${cases}`
  if (r.status === 'failed') return `${r.error || '没通过'}${cases}`
  return r.error || TEST_STATUS_LABEL[r.status]
}

/** 工作区卡片下的「最近一次测试」（SPEC-tasks-4.63 起） */
function TaskTestBlock({ task, active, commands, hasLast }: { task: Task; active?: Worktree; commands: Partial<Record<TestStepKey, CommandLike>>; hasLast: boolean }) {
  const { tests } = useWorktrees()
  const last = tests.find((r) => r.task_id === task.id)
  const [err, setErr] = useState('')
  const canRun = !!active
  if (!last && !canRun) return null
  if (!hasLast && !last && !canRun) return null
  const runnable = (['build', 'test_env', 'test', 'smoke'] as const).some((k) => commands[k]?.command.trim())
  const running = last?.status === 'running'
  const report = () => alert('正式产品新标签页打开报告原文（Markdown）：GET /api/projects/tests/runs/<id>/report')
  return (
    <div className="wtt" role="group" aria-label="最近一次测试">
      <div className="wtt-head">
        <span className="field-group-title">最近一次测试</span>
        {last && <span className={cls('wtt-badge', tone(last.status))}>{TEST_STATUS_LABEL[last.status]}</span>}
        {last && <span className="list-sub">{timeAgo(last.started_at)}{last.source === 'sop' ? '，SOP 发起' : ''}</span>}
        <span className="wtt-actions">
          {last?.report && !running && <button className="act act-quiet" onClick={report}>看报告</button>}
          {running && last && <button className="btn btn-danger btn-sm" onClick={() => stopTest(last.id)}>停止</button>}
          {!running && canRun && runnable && active && (
            <button className="btn btn-outline btn-sm" onClick={() => setErr(startTest(task, active, commands) ?? '')}>{last ? '再跑一次' : '运行测试'}</button>
          )}
        </span>
      </div>
      {!last && <span className="list-sub">{runnable ? '还没跑过：按项目档案的命令构建、起测试环境、跑测试和冒烟，跑完写报告、回收环境' : '项目档案里还没填构建、测试、起测试环境或冒烟命令，到项目的档案里填'}</span>}
      {last && (
        <>
          <div className={cls('wtt-summary', tone(last.status))}>{testSummary(last)}</div>
          <ol className="wtt-steps">
            {last.steps.map((s) => {
              const bits = [s.exit_code !== null ? `退出码 ${s.exit_code}` : '', s.started && s.status !== 'running' ? dur(s.duration_ms) : '', s.timed_out ? '超时' : ''].filter(Boolean)
              return (
                <li key={s.key} className="wtt-step">
                  <div className="wtt-step-line">
                    <span className="wtt-step-label">{s.label}</span>
                    <span className={cls('wtt-step-state', tone(s.status))}>{STEP_STATUS_LABEL[s.status]}</span>
                    {bits.length > 0 && <span className="list-sub">{bits.join('，')}</span>}
                    <code className="wtt-cmd" title={s.command}>{s.command}</code>
                  </div>
                  {s.error && s.status !== 'passed' && <div className={cls('wtt-step-err', tone(s.status))}>{s.error}</div>}
                  {s.ready && s.status === 'running' && <div className="list-sub">等就绪：{s.ready}</div>}
                  {s.output && <details className="wtt-out"><summary>输出尾部</summary><pre>{s.output}</pre></details>}
                </li>
              )
            })}
          </ol>
          {last.url && last.env_state === 'kept' && (
            <div className="wtt-env kept" role="status" aria-label="保留的测试环境">
              <span>测试环境保留到 {last.env_keep_until ? fmtUntil(last.env_keep_until) : '验收结束'}，可访问：<a className="wtt-link" href={last.url} target="_blank" rel="noreferrer">{last.url}</a></span>
              <span className="list-sub">验收结束或到点自动回收</span>
              <button className="btn btn-outline btn-sm" onClick={() => releaseEnv(last.id, 'manual')}>回收</button>
            </div>
          )}
          {last.url && last.env_state !== 'kept' && (
            <div className="list-sub">测试环境 <code>{last.url}</code>{running ? '（跑完自动回收）'
              : last.env_state === 'released' && last.env_release_reason ? `（已回收：${ENV_RELEASE_LABEL[last.env_release_reason]}）` : '（已回收）'}</div>
          )}
          {last.junit && last.junit.failed.length > 0 && (
            <div className="wtt-failed"><span className="list-sub">没通过的用例：</span><ul>{last.junit.failed.map((n) => <li key={n}>{n}</li>)}</ul></div>
          )}
          {last.shots.length > 0 && <div className="wtt-shots"><span className="list-sub">截图 {last.shots.length} 张：</span>{last.shots.map((n) => <span key={n} className="wtt-link">{n}</span>)}</div>}
        </>
      )}
      {err && <div className="field-err" role="alert">测试没起来：{err}</div>}
    </div>
  )
}

type ProjectLike = Pick<Project, 'id' | 'root'> & Partial<Pick<Project, 'profile'>>

/** 任务抽屉基础信息末尾的「工作区」（SPEC-tasks-4.50 起）。没有工作区又没挂项目时整块不显示 */
export function TaskWorktreeBlock({ task, projects }: { task: Task; projects: ProjectLike[] }) {
  const { list } = useWorktrees()
  const mine = list.filter((w) => w.task_id === task.id)
  const active = mine.find((w) => w.status === 'active')
  const last = active ?? mine[0]
  const project = projects.find((p) => p.id === task.project_id)
  const codeDir = project ? (project.profile?.code_dir || project.root) : ''
  const [confirm, setConfirm] = useState<'normal' | 'force' | null>(null)
  const [err, setErr] = useState('')
  const [copied, setCopied] = useState(false)

  // 任务完成、取消或阶段到已上线：自动清理（不强制），正式产品是后端订阅 object.status_changed、object.stage_changed
  const closed = task.status === 'done' ? 'task_done' : task.status === 'cancelled' ? 'task_cancelled' : task.stage === 'released' ? 'released' : null
  // 保留的测试环境：阶段离开待验收（验收通过进待发布 / 已上线，或退回）、任务完成取消时回收（正式产品是后端订阅阶段、状态事件）
  const stage = task.stage
  useEffect(() => {
    if (stage && stage !== 'accepting' && stage !== 'testing') releaseTaskEnv(task.id, stage === 'releasing' || stage === 'released' ? 'accepted' : 'stage_changed')
    if (task.status === 'done' || task.status === 'cancelled') releaseTaskEnv(task.id, 'task_done')
  }, [stage, task.status, task.id])
  useEffect(() => {
    if (closed && active && !active.last_error) cleanupWorktree(active.id, closed, false)
  }, [closed, active])
  // 阶段进「开发中」：自动准备（正式产品是后端订阅 object.stage_changed，准备不了的只记日志）
  const developing = task.stage === 'developing'
  useEffect(() => {
    if (developing && !active && codeDir && !closed) prepareWorktree(task, codeDir)
  }, [developing, active, codeDir, closed, task])

  if (!last && !task.project_id) return null
  const on = last?.status === 'active'
  const clean = (force: boolean) => {
    if (!last) return
    setErr(cleanupWorktree(last.id, 'manual', force) ?? '')
    setConfirm(null)
  }
  const copy = (p: string) => {
    navigator.clipboard?.writeText(p).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) }, () => {})
  }
  const st = !last ? null : last.status === 'removed'
    ? { tone: 'muted', text: `${last.removed_reason ? REASON[last.removed_reason] : '已清理'}，分支${last.branch_deleted ? '已合并、一起删了' : '保留'}` }
    : last.last_error ? { tone: 'warn', text: `清理没成功：${last.last_error}` } : { tone: 'ok', text: '在用' }

  return (
    <section className="dev-sec wt" aria-label="工作区">
      <div className="mount-head">
        <span className="field-group-title">工作区</span>
        <span className="field-hint">这条任务专用的 git worktree 和分支，Claude Code 在里面改代码</span>
      </div>
      {last && st && (
        <div className={cls('wt-card', !on && 'off')}>
          <dl className="wt-grid">
            <dt>目录</dt>
            <dd className="wt-path"><code title={last.path}>{last.path}</code>{on && <button className="act act-quiet" onClick={() => copy(last.path)}>{copied ? '已复制' : '复制'}</button>}</dd>
            <dt>分支</dt>
            <dd><code>{last.branch}</code><span className="list-sub">（从 {last.base_commit.slice(0, 7)} 拉出，{timeAgo(last.created_at)}准备）</span></dd>
            <dt>端口</dt>
            <dd>{on ? <>{last.port_start}–{last.port_start + last.port_count - 1}<span className="list-sub">（{last.port_count} 个，测试环境用）</span></> : <span className="list-sub">已归还</span>}</dd>
            <dt>状态</dt>
            <dd className={cls('wt-state', st.tone)}>{st.text}</dd>
          </dl>
          {on && !confirm && (
            <div className="act-row">
              {last.last_error
                ? <button className="btn btn-danger btn-sm" onClick={() => setConfirm('force')}>强制清理</button>
                : <button className="btn btn-outline btn-sm" onClick={() => setConfirm('normal')}>清理工作区</button>}
              <span className="list-sub">任务完成、取消或上线后会自动清理</span>
            </div>
          )}
          {on && confirm && (
            <div className={cls('wt-confirm', confirm === 'force' && 'danger')} role="alertdialog" aria-label={confirm === 'force' ? '强制清理这个工作区？' : '清理这个工作区？'}>
              <b>{confirm === 'force' ? '强制清理这个工作区？' : '清理这个工作区？'}</b>
              <ul>
                {confirm === 'force' ? <li>目录 {last.root} 里没提交的改动会丢掉</li> : <li>删掉目录 {last.root}</li>}
                <li>分支 {last.branch} 已合并就一起删，没合并保留</li>
                <li>归还端口 {last.port_start}–{last.port_start + last.port_count - 1}</li>
              </ul>
              <span className="list-sub">{confirm === 'force' ? '已经提交到分支上的内容不受影响。' : '有没提交的改动时不会删，会提示你。'}</span>
              <div className="act-row">
                <button className="btn btn-ghost btn-sm" onClick={() => setConfirm(null)}>取消</button>
                <button className={cls('btn btn-sm', confirm === 'force' ? 'btn-danger' : 'btn-primary')} onClick={() => clean(confirm === 'force')}>{confirm === 'force' ? '强制清理' : '清理'}</button>
              </div>
            </div>
          )}
          {err && <div className="field-err" role="alert">清理没成功：{err}</div>}
        </div>
      )}
      {(last || task.project_id) && <TaskTestBlock task={task} active={active} commands={project?.profile?.commands ?? {}} hasLast={!!last} />}
      {(last || task.project_id) && <TaskReleaseBlock task={task} active={active} commands={project?.profile?.commands ?? {}} />}
      {!active && task.project_id && (
        <div className="act-row wt-prep">
          {codeDir
            ? <span className="list-sub">{last ? '要接着改就再准备一个' : '还没准备'}：在代码库 <code>{codeDir}</code> 拉分支建 worktree</span>
            : <span className="list-sub">项目还没设代码库目录，到项目的档案里填</span>}
          {codeDir && <button className="btn btn-outline btn-sm" onClick={() => { const r = prepareWorktree(task, codeDir); setErr(r.ok ? '' : r.error) }}>准备工作区</button>}
          {err && !last && <div className="field-err" role="alert">没准备好：{err}</div>}
        </div>
      )}
    </section>
  )
}

/** 设置 > 工作区（SPEC-settings-25）：端口范围和每段个数。正式产品是项目插件登记的设置分节（设置 > 插件 > 工作区） */
export function WorktreeSettingsPage() {
  const { settings, list } = useWorktrees()
  const [min, setMin] = useState(String(settings.port_min))
  const [max, setMax] = useState(String(settings.port_max))
  const [block, setBlock] = useState(String(settings.port_block))
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)
  const n = { min: Number(min), max: Number(max), block: Number(block) }
  const bad = portRangeError(n.min, n.max, n.block)
  const changed = n.min !== settings.port_min || n.max !== settings.port_max || n.block !== settings.port_block
  const save = () => {
    if (bad) { setNote({ ok: false, text: `没保存：${bad}` }); return }
    if (!changed) return
    saveWorktreeSettings({ ...settings, port_min: n.min, port_max: n.max, port_block: n.block })
    setNote({ ok: true, text: `已保存：${n.min}–${n.max}，每段 ${n.block} 个，以后准备的工作区按这个分` })
  }
  const edit = (f: (v: string) => void) => (e: { target: { value: string } }) => { f(e.target.value); setNote(null) }
  return (
    <div className="wt-settings">
      <div className="wt-settings-title">工作区端口</div>
      <div className="field">
        <span className="field-label">端口范围和每段个数</span>
        <div className="wt-settings-row">
          <input type="number" inputMode="numeric" aria-label="起始端口" className={cls(changed && bad && 'bad')} value={min} onChange={edit(setMin)} />
          <span className="muted">到</span>
          <input type="number" inputMode="numeric" aria-label="结束端口" className={cls(changed && bad && 'bad')} value={max} onChange={edit(setMax)} />
          <span className="muted">每段</span>
          <input type="number" inputMode="numeric" aria-label="每段端口数" className={cls(changed && bad && 'bad')} value={block} onChange={edit(setBlock)} />
          <span className="muted">个</span>
          <button className="btn btn-outline" disabled={!changed || !!bad} onClick={save}>保存</button>
        </div>
        {note ? <span className={note.ok ? 'ok-text' : 'field-err'}>{note.text}</span>
          : changed && bad ? <span className="field-err">{bad}</span>
          : <span className="field-hint-line">每个在用的工作区分一段端口给测试环境用，清理后归还。不能和工作台自己用的 {RESERVED_RANGE[0]}–{RESERVED_RANGE[1]} 重叠；改了只管以后的分配</span>}
      </div>
      <div className="muted">能分 {bad ? 0 : Math.floor((n.max - n.min + 1) / n.block)} 段，此刻 {list.filter((w) => w.status === 'active').length} 个工作区在用，放在 {WORKTREE_DIR}</div>
      <KeepHours />
    </div>
  )
}

/** 测试环境保留时长（AUTO-09，SPEC-settings-25.7）：单独保存，1 到 168 小时 */
function KeepHours() {
  const { settings } = useWorktrees()
  const [hours, setHours] = useState(String(settings.env_keep_hours))
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)
  const n = Number(hours)
  const bad = !Number.isInteger(n) || n < 1 || n > 168 ? '要是 1 到 168 的整数' : null
  const changed = n !== settings.env_keep_hours
  const save = () => {
    if (bad || !changed) return
    saveWorktreeSettings({ ...settings, env_keep_hours: n })
    setNote({ ok: true, text: `已保存：测试通过后保留 ${n} 小时` })
  }
  return (
    <div className="field">
      <span className="field-label">测试环境保留时长</span>
      <div className="wt-settings-row">
        <input type="number" inputMode="numeric" aria-label="保留小时数" className={cls(changed && bad && 'bad')} value={hours}
          onChange={(e) => { setHours(e.target.value); setNote(null) }} />
        <span className="muted">小时</span>
        <button className="btn btn-outline" disabled={!changed || !!bad} onClick={save}>保存</button>
      </div>
      {note ? <span className={note.ok ? 'ok-text' : 'field-err'}>{note.text}</span>
        : changed && bad ? <span className="field-err">{bad}</span>
        : <span className="field-hint-line">研发 pipeline 测试通过后，测试环境留着给人工验收；到点、验收结束、任务完成或工作区清理时回收</span>}
    </div>
  )
}
