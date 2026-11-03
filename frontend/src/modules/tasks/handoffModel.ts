// 交给 Claude Code（DEV-09）的纯函数：默认工作目录、请求体、运行中的那条；两种方式（0048）的文案和终端执行的善后。
import { runFinished, type RunMode, type RunRequest, type TaskRun, type TerminalRunRequest } from '../../core/data'
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

/** 终端插件没在跑时「切换到终端」置灰，旁边说这句 */
export const TERMINAL_OFF_HINT = '终端插件没启用，到 设置 > 插件 里启用后可用'

export const MODE_LABEL: Record<RunMode, string> = { stream: '流式执行', terminal: '切换到终端' }

/** 两种方式各自的说明，显示在方式下面 */
export function modeHint(mode: RunMode, terminalOn: boolean): string {
  if (mode === 'stream') return '工作台在后台跑 Claude Code，过程流式显示在任务的执行记录里'
  if (!terminalOn) return TERMINAL_OFF_HINT
  return '在工作台的终端里新开一个标签，执行设置里的启动命令开一个交互式会话；结束和结论由它经 MCP 回写'
}

/** 提交按钮的文案 */
export function submitLabel(mode: RunMode, opts: { typing: boolean; allow: boolean; busy: boolean }): string {
  if (opts.typing) return '正在校验目录'
  if (mode === 'terminal') return opts.busy ? '正在打开终端' : '在终端中打开'
  return opts.allow ? '开始执行（允许写入）' : '开始执行（只读）'
}

/** 终端方式的请求体：没有 allow_writes，权限由用户的启动命令决定 */
export function terminalRequest(workdir: string, extra: string): Required<TerminalRunRequest> {
  return { workdir: workdir.trim(), extra_prompt: extra.trim() }
}

/** 终端没开出来时给这次执行记的失败结论 */
export function launchFailSummary(err: string): string {
  return `终端没打开：${err}`
}
