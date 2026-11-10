// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 发布（AUTO-10）：项目插件在任务的工作区上按项目档案的命令分两段跑。
// 准备段（上线审批前）：版本号与更新日志、打包，只在工作区里跑，不碰生产，跑完停在 prepared 等审批；
// 上线段（审批后）：发布前检查（备份与密钥核对）、发布、线上冒烟，发布或冒烟没过自动回滚。
// 这里是任务详情「工作区」下「最近一次发布」用的接口；审批走 SOP「发布 pipeline」的人工节点，界面不直接批准。
// 契约见 docs/api-contract.md「项目插件 / 发布」。变化时后端发 projects.release_changed，项目插件入口据此标脏缓存。
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { request, requestList } from '../api'

export type ReleaseStepKey = 'version' | 'package' | 'preflight' | 'release' | 'prod_smoke' | 'rollback'
export type ReleaseStepStatus = 'pending' | 'running' | 'passed' | 'failed' | 'skipped' | 'stopped'
export type ReleaseStatus = 'running' | 'prepared' | 'released' | 'failed' | 'rolled_back' | 'rollback_failed' | 'stopped' | 'interrupted' | 'cancelled'
/** prepare 是上线审批前（版本号、打包），deploy 是审批后（发布前检查、发布、线上冒烟、回滚） */
export type ReleasePhase = 'prepare' | 'deploy'
/** 回滚情况：空串不需要；done 已回滚；failed 回滚没成；unavailable 要回滚但档案里没有回滚命令 */
export type RollbackState = '' | 'done' | 'failed' | 'unavailable'

export type ReleaseStep = {
  key: ReleaseStepKey
  label: string
  phase: ReleasePhase
  /** 换过占位的命令 */
  command: string
  dir: string
  timeout_sec: number
  status: ReleaseStepStatus
  exit_code: number | null
  duration_ms: number
  timed_out: boolean
  /** 输出尾部，最多 60 行、4000 字节 */
  output: string
  error: string
  started_at: string | null
  finished_at: string | null
}

export type Release = {
  id: string
  task_id: string
  task_ref: string
  project_id: string
  worktree_id: string
  workdir: string
  status: ReleaseStatus
  phase: ReleasePhase
  /** 版本号（version 那步写的），没有为空串 */
  version: string
  changelog: string
  steps: ReleaseStep[]
  failed_step: string
  error: string
  rollback_state: RollbackState
  run_dir: string
  report_path: string
  artifact_ids: string[]
  source: 'api' | 'sop'
  approved_at: string | null
  /** 审批来源：sop:<执行 id> 或 api */
  approved_by: string
  sop_run_id: string
  started_at: string
  finished_at: string | null
  updated_at: string
}

const BASE = '/api/projects/releases'
const runPath = (id: string) => `${BASE}/runs/${encodeURIComponent(id)}`

export const releaseApi = {
  ofTask: async (taskId: string, signal?: AbortSignal) =>
    (await requestList<Release>(`${BASE}?task_id=${encodeURIComponent(taskId)}&limit=5`, { signal })).data,
  /** 在跑的停下；准备好等审批的作废 */
  stop: (id: string) => request<Release>('POST', `${runPath(id)}/stop`),
}

/** 报告原文（纯文本给浏览器看），新标签页打开 */
export const releaseReportUrl = (id: string) => `${runPath(id)}/report`

export const releaseKeys = {
  all: ['releases'] as const,
  ofTask: (taskId: string) => ['releases', 'task', taskId] as const,
}

/** 一条任务最近的几次发布，新的在前 */
export function useTaskReleases(taskId: string, opts?: { refetchInterval?: number | false | ((rows: Release[] | undefined) => number | false) }) {
  const every = opts?.refetchInterval
  return useQuery({
    queryKey: releaseKeys.ofTask(taskId),
    queryFn: ({ signal }) => releaseApi.ofTask(taskId, signal),
    refetchInterval: typeof every === 'function' ? (q) => every(q.state.data) : every,
  })
}

export function useStopRelease() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => releaseApi.stop(id),
    onSettled: () => void qc.invalidateQueries({ queryKey: releaseKeys.all }),
  })
}

export const RELEASE_STATUS_LABEL: Record<ReleaseStatus, string> = {
  running: '进行中', prepared: '等上线审批', released: '已上线', failed: '没成功', rolled_back: '已回滚',
  rollback_failed: '回滚失败', stopped: '已停止', interrupted: '没跑完', cancelled: '已作废',
}

export const RELEASE_PHASE_LABEL: Record<ReleasePhase, string> = { prepare: '审批前', deploy: '审批后' }

export const ROLLBACK_LABEL: Record<Exclude<RollbackState, ''>, string> = {
  done: '已自动回滚', failed: '自动回滚也没成功，请马上人工处理', unavailable: '档案里没有回滚命令，没有回滚，请人工处理',
}

/** 状态的色调：已上线绿；没成功、回滚类红；在跑蓝；等审批黄；其余灰 */
export function releaseTone(s: ReleaseStatus): 'ok' | 'bad' | 'run' | 'warn' | 'muted' {
  if (s === 'released') return 'ok'
  if (s === 'failed' || s === 'rolled_back' || s === 'rollback_failed') return 'bad'
  if (s === 'running') return 'run'
  if (s === 'prepared') return 'warn'
  return 'muted'
}

/** 一次发布的一句话：在跑写正在哪一步；等审批写明审批前不动生产；没成功写原因和回滚情况 */
export function releaseSummary(r: Release): string {
  const v = r.version ? `版本 ${r.version}` : '没有版本号'
  if (r.status === 'running') {
    const cur = r.steps.find((s) => s.status === 'running')
    return cur ? `正在${cur.label}` : r.phase === 'deploy' ? '正在上线' : '正在准备发布'
  }
  if (r.status === 'prepared') return `${v} 已打包。等上线审批：审批前不跑发布前检查、发布、线上冒烟`
  if (r.status === 'released') return `${v} 已上线，线上冒烟通过`
  const rb = r.rollback_state ? `；${ROLLBACK_LABEL[r.rollback_state]}` : ''
  if (r.status === 'failed' && r.phase === 'deploy' && !r.rollback_state) return `${r.error || '没成功'}；还没动生产`
  return `${r.error || RELEASE_STATUS_LABEL[r.status]}${rb}`
}
