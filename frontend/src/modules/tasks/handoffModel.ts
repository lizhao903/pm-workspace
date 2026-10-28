// 交给 Claude Code（DEV-09）的纯函数：默认工作目录、请求体、运行中的那条。
import type { RunRequest, TaskRun } from '../../core/api'
import { runFinished } from '../../core/api/taskRuns'
import type { LiveRun } from './runLive'

// 弹窗打开时的工作目录：任务上设的优先，没设用所属项目的
export function defaultWorkdir(taskDir: string, inheritDir?: string): { dir: string; from: 'task' | 'project' | '' } {
  if (taskDir.trim()) return { dir: taskDir.trim(), from: 'task' }
  if (inheritDir?.trim()) return { dir: inheritDir.trim(), from: 'project' }
  return { dir: '', from: '' }
}

// 请求体只有这三个字段（契约 POST /api/objects/{id}/run）
export function runRequest(workdir: string, extra: string, allowWrites: boolean): Required<RunRequest> {
  return { workdir: workdir.trim(), extra_prompt: extra.trim(), allow_writes: allowWrites }
}

// 同一任务正在跑的执行：本页刚发起还没收尾的流，或者执行记录里没收尾的那条。
// 返回 run id（还没拿到时为空串）；没有在跑的返回 undefined
export function runningOf(objectId: string, rows: readonly TaskRun[] | undefined, live: readonly LiveRun[]): string | undefined {
  const row = rows?.find((r) => !runFinished(r))
  if (row) return row.id
  const l = live.find((x) => x.objectId === objectId && (x.phase === 'starting' || x.phase === 'streaming'))
  return l ? l.runId ?? '' : undefined
}
