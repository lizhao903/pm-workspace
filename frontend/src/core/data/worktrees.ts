// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 需求级 git worktree（AUTO-07）：项目插件给进研发的任务在代码库建独立 worktree 和分支 auto/<任务 ref>，放在数据目录下，
// 并分一段端口给测试环境用。任务完成、取消或阶段到已上线时后端自动清理；这里是任务详情「工作区」和设置里端口范围用的接口。
// 契约见 docs/api-contract.md「项目插件 / 工作区」。变化时后端发 projects.worktree_changed，项目插件入口据此标脏缓存。
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { request, requestList } from '../api'

export type Worktree = {
  id: string
  task_id: string
  task_ref: string
  project_id: string
  /** 代码库所在 git 仓库的根目录 */
  repo_dir: string
  /** 档案里的代码库目录相对仓库根的路径，通常为空 */
  sub_dir: string
  /** worktree 目录 */
  root: string
  /** 执行用的目录（root 加 sub_dir），SOP 里 {{worktree.path}} */
  path: string
  branch: string
  base_commit: string
  port_start: number
  port_end: number
  port_count: number
  /** active 在用；removed 已清理，端口已归还 */
  status: 'active' | 'removed'
  /** 最近一次清理失败的原因（有没提交的改动等），成功后清空 */
  last_error: string
  removed_reason: '' | 'task_done' | 'task_cancelled' | 'released' | 'manual'
  /** 清理时分支已合并、一起删了 */
  branch_deleted: boolean
  /** 目录现在还在（在用时有意义） */
  exists: boolean
  /** 准备时复用了已有的 */
  reused?: boolean
  created_at: string
  updated_at: string
  removed_at: string | null
}

export type WorktreeSettings = {
  port_min: number
  port_max: number
  port_block: number
  /** 测试通过后保留测试环境给人工验收的默认时长（小时，1 到 168，AUTO-09） */
  env_keep_hours: number
  /** 工作台自己用的端口，范围不能和它重叠 */
  reserved: [number, number]
  /** 在用的工作区数 */
  active: number
  /** 工作区放在哪（数据目录下的 worktrees/） */
  dir: string
}

export type WorktreeSettingsPatch = Partial<Pick<WorktreeSettings, 'port_min' | 'port_max' | 'port_block' | 'env_keep_hours'>>

/** 测试环境保留时长的上限（小时），同后端 */
export const MAX_ENV_KEEP_HOURS = 168

export const REMOVED_REASON: Record<Exclude<Worktree['removed_reason'], ''>, string> = {
  task_done: '任务完成后自动清理',
  task_cancelled: '任务取消后自动清理',
  released: '上线后自动清理',
  manual: '手动清理',
}

const BASE = '/api/projects/worktrees'
const SETTINGS = '/api/projects/worktree-settings'

export const worktreeApi = {
  ofTask: async (taskId: string, signal?: AbortSignal) =>
    (await requestList<Worktree>(`${BASE}?task_id=${encodeURIComponent(taskId)}`, { signal })).data,
  prepare: (taskId: string) => request<Worktree>('POST', BASE, { body: { task_id: taskId } }),
  cleanup: (id: string, force: boolean) => request<Worktree>('POST', `${BASE}/${encodeURIComponent(id)}/cleanup`, { body: { force } }),
  settings: (signal?: AbortSignal) => request<WorktreeSettings>('GET', SETTINGS, { signal }),
  saveSettings: (body: WorktreeSettingsPatch) => request<WorktreeSettings>('PATCH', SETTINGS, { body }),
}

export const worktreeKeys = {
  all: ['worktrees'] as const,
  ofTask: (taskId: string) => ['worktrees', 'task', taskId] as const,
  settings: ['worktrees', '*settings'] as const,
}

/** 一条任务的工作区，新的在前；第一条是在用的（如果有） */
export function useTaskWorktrees(taskId: string, opts?: { refetchInterval?: number | false }) {
  return useQuery({
    queryKey: worktreeKeys.ofTask(taskId),
    queryFn: ({ signal }) => worktreeApi.ofTask(taskId, signal),
    refetchInterval: opts?.refetchInterval,
  })
}

export function usePrepareWorktree(taskId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => worktreeApi.prepare(taskId),
    onSettled: () => void qc.invalidateQueries({ queryKey: worktreeKeys.all }),
  })
}

export function useCleanupWorktree() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, force }: { id: string; force: boolean }) => worktreeApi.cleanup(id, force),
    onSettled: () => void qc.invalidateQueries({ queryKey: worktreeKeys.all }),
  })
}

export function useWorktreeSettings() {
  return useQuery({ queryKey: worktreeKeys.settings, queryFn: ({ signal }) => worktreeApi.settings(signal) })
}

export function useSaveWorktreeSettings() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: WorktreeSettingsPatch) => worktreeApi.saveSettings(body),
    onSuccess: (s) => qc.setQueryData(worktreeKeys.settings, s),
  })
}

/** 端口范围的前端检查：只挡明显不对的，细的交给后端（原样显示它的 400） */
export function portRangeError(min: number, max: number, block: number, reserved: readonly [number, number]): string | undefined {
  if (![min, max, block].every(Number.isInteger)) return '填整数'
  if (min < 1024 || max > 65535 || min > max) return '端口要在 1024 到 65535 之间，起点不能大于终点'
  if (block < 1 || block > 100) return '每段 1 到 100 个'
  if (max - min + 1 < block) return `范围放不下一段 ${block} 个端口`
  if (min <= reserved[1] && reserved[0] <= max) return `不能和工作台自己用的 ${reserved[0]}–${reserved[1]} 重叠`
  return undefined
}

/** 工作区一行说明：在用、清理失败、已清理 */
export function worktreeState(w: Worktree): { tone: 'ok' | 'warn' | 'muted'; text: string } {
  if (w.status === 'removed') {
    const why = w.removed_reason ? REMOVED_REASON[w.removed_reason] : '已清理'
    return { tone: 'muted', text: `${why}，分支${w.branch_deleted ? '已合并、一起删了' : '保留'}` }
  }
  if (w.last_error) return { tone: 'warn', text: `清理没成功：${w.last_error}` }
  if (!w.exists) return { tone: 'warn', text: '目录不在了，再点「准备工作区」会按原分支重建' }
  return { tone: 'ok', text: '在用' }
}
