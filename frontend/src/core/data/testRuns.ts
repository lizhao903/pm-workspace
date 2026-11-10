// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 测试环境与测试报告（AUTO-08）：项目插件在任务的工作区上按项目档案的命令构建、起临时测试环境、跑测试和冒烟，
// 写 Markdown 报告登记为任务产出，跑完回收环境；要求保留且全部通过时测试环境留给人工验收，到点或验收结束回收（AUTO-09）。
// 这里是任务详情「工作区」下「最近一次测试」用的接口。
// 契约见 docs/api-contract.md「项目插件 / 测试环境」。变化时后端发 projects.test_changed，项目插件入口据此标脏缓存。
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { request, requestList } from '../api'

export type TestStepKey = 'build' | 'test_env' | 'test' | 'smoke'
export type TestStepStatus = 'pending' | 'running' | 'passed' | 'failed' | 'skipped' | 'stopped'
export type TestRunStatus = 'running' | 'passed' | 'failed' | 'stopped' | 'interrupted'
/** 测试环境保留状态：空串没保留（跑完即回收），kept 保留中，released 保留过、已回收 */
export type TestEnvState = '' | 'kept' | 'released'
export type TestEnvReleaseReason = '' | 'expired' | 'accepted' | 'stage_changed' | 'task_done' | 'worktree_removed' | 'rerun' | 'manual'
  | 'exited' | 'restart' | 'plugin_stopped'

export type TestStep = {
  key: TestStepKey
  label: string
  /** 换过占位的命令 */
  command: string
  /** 执行目录（worktree 里） */
  dir: string
  status: TestStepStatus
  /** 没跑、被信号结束、测试环境回收时为 null */
  exit_code: number | null
  duration_ms: number
  timed_out: boolean
  /** 输出尾部，最多 60 行、4000 字节 */
  output: string
  error: string
  /** 只有 test_env：就绪检查的说明 */
  ready?: string
  started_at: string | null
  finished_at: string | null
}

export type JunitSummary = { files: number; tests: number; failures: number; errors: number; skipped: number; failed: string[] }

export type TestRun = {
  id: string
  task_id: string
  task_ref: string
  project_id: string
  worktree_id: string
  workdir: string
  port: number
  port_start: number
  port_end: number
  /** 测试环境地址，档案没有 test_env 时空串；跑完即回收，保留中可访问 */
  url: string
  status: TestRunStatus
  steps: TestStep[]
  failed_step: string
  error: string
  run_dir: string
  report_path: string
  artifact_ids: string[]
  /** 收到的截图，相对报告目录 out/ */
  shots: string[]
  junit: JunitSummary | null
  source: 'api' | 'sop'
  sop_run_id: string
  started_at: string
  finished_at: string | null
  updated_at: string
  env_state: TestEnvState
  /** 保留到什么时候，到点自动回收 */
  env_keep_until: string | null
  env_released_at: string | null
  env_release_reason: TestEnvReleaseReason
}

const BASE = '/api/projects/tests'
const runPath = (id: string) => `${BASE}/runs/${encodeURIComponent(id)}`

export const testRunApi = {
  ofTask: async (taskId: string, signal?: AbortSignal) =>
    (await requestList<TestRun>(`${BASE}?task_id=${encodeURIComponent(taskId)}&limit=5`, { signal })).data,
  start: (taskId: string) => request<TestRun>('POST', BASE, { body: { task_id: taskId } }),
  stop: (id: string) => request<TestRun>('POST', `${runPath(id)}/stop`),
  /** 手动回收保留着的测试环境 */
  release: (id: string) => request<TestRun>('POST', `${runPath(id)}/release`),
}

/** 报告原文（纯文本给浏览器看）、截图的地址，新标签页打开 */
export const testReportUrl = (id: string) => `${runPath(id)}/report`
export const testShotUrl = (id: string, name: string) => `${runPath(id)}/shots/${name.split('/').map(encodeURIComponent).join('/')}`

export const testRunKeys = {
  all: ['test-runs'] as const,
  ofTask: (taskId: string) => ['test-runs', 'task', taskId] as const,
}

/** 一条任务最近的几次测试，新的在前。refetchInterval 可以按当前数据算（跑着时取得勤一些） */
export function useTaskTestRuns(taskId: string, opts?: { refetchInterval?: number | false | ((rows: TestRun[] | undefined) => number | false) }) {
  const every = opts?.refetchInterval
  return useQuery({
    queryKey: testRunKeys.ofTask(taskId),
    queryFn: ({ signal }) => testRunApi.ofTask(taskId, signal),
    refetchInterval: typeof every === 'function' ? (q) => every(q.state.data) : every,
  })
}

export function useStartTestRun(taskId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => testRunApi.start(taskId),
    onSettled: () => void qc.invalidateQueries({ queryKey: testRunKeys.all }),
  })
}

export function useStopTestRun() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => testRunApi.stop(id),
    onSettled: () => void qc.invalidateQueries({ queryKey: testRunKeys.all }),
  })
}

export function useReleaseTestEnv() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => testRunApi.release(id),
    onSettled: () => void qc.invalidateQueries({ queryKey: testRunKeys.all }),
  })
}

/** 保留的测试环境为什么回收了 */
export const ENV_RELEASE_LABEL: Record<Exclude<TestEnvReleaseReason, ''>, string> = {
  expired: '保留时间到了', accepted: '验收通过', stage_changed: '验收结束', task_done: '任务完成或取消', worktree_removed: '工作区清理了',
  rerun: '又跑了一次测试', manual: '手动回收', exited: '测试环境自己退出了', restart: '工作台重启过', plugin_stopped: '项目插件停用或工作台关闭',
}

export const TEST_STATUS_LABEL: Record<TestRunStatus, string> = {
  running: '在跑', passed: '通过', failed: '没通过', stopped: '已停止', interrupted: '没跑完',
}

export const STEP_STATUS_LABEL: Record<TestStepStatus, string> = {
  pending: '等着', running: '在跑', passed: '通过', failed: '没通过', skipped: '跳过', stopped: '已停止',
}

/** 状态的色调：通过绿、没通过红、在跑蓝、停止和没跑完灰 */
export function testTone(s: TestRunStatus | TestStepStatus): 'ok' | 'bad' | 'run' | 'muted' {
  if (s === 'passed') return 'ok'
  if (s === 'failed') return 'bad'
  if (s === 'running') return 'run'
  return 'muted'
}

/** 用时：毫秒、秒（一位小数）、分秒 */
export function durationText(ms: number): string {
  if (ms < 1000) return `${ms} 毫秒`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} 秒`
  return `${Math.floor(ms / 60_000)} 分 ${Math.floor((ms % 60_000) / 1000)} 秒`
}

/** 一次测试的一句话：在跑写正在哪一步；没通过写在哪一步、原因；junit 有用例时带上数目 */
export function testSummary(r: TestRun): string {
  if (r.status === 'running') {
    const cur = r.steps.find((s) => s.status === 'running')
    return cur ? `正在${cur.label}` : '正在准备'
  }
  const cases = r.junit ? `，${r.junit.tests} 个用例${r.junit.failures + r.junit.errors ? `、${r.junit.failures + r.junit.errors} 个没通过` : ''}` : ''
  if (r.status === 'passed') return `全部通过${cases}`
  if (r.status === 'failed') return `${r.error || '没通过'}${cases}`
  return r.error || TEST_STATUS_LABEL[r.status]
}
