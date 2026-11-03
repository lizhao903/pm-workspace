// 阶段执行器的纯函数（VID-03c，同原型 web-next/src/videos.tsx 的 RUNNER_TYPE、RUNNABLE、runnerName）。
// 能配的阶段、能选的技能是后端的约定（internal/plugins/video/runners.go），没有字典接口，两边一起改
import type { VideoLastRun, VideoRunnerType, VideoStageKey, VideoStageRunner } from '../../core/data'

export const RUNNER_TYPE: Record<VideoRunnerType, string> = { skill: '技能', sop: 'SOP', agent: 'Agent' }
export const RUNNER_TYPES = Object.keys(RUNNER_TYPE) as VideoRunnerType[]

/** 能配执行器的阶段；规划检查、第一章验收只有人能做 */
export const RUNNABLE: VideoStageKey[] = ['script', 'web', 'chapters', 'audio', 'record', 'distribution']

/** 技能现在只认这一个：本机 Claude Code 的 web-video-presentation */
export const RUNNER_SKILLS: RunnerChoice[] = [{ id: 'sk_video', name: '网页演示做视频' }]

export type RunnerChoice = { id: string; name: string }

/** 配了的执行器在列表里对应哪一条：后端 ref_id 认 id 也认名称 */
export const findChoice = (choices: RunnerChoice[], ref: string) => choices.find((c) => c.id === ref) ?? choices.find((c) => c.name === ref)

/**
 * 执行器显示的名字。列表没取回来（插件没启用、请求失败）时 known 为 false，直接显示 ref_id；
 * 取回来了却找不到，就是删掉了，返回 undefined
 */
export function runnerName(r: VideoStageRunner, choices: RunnerChoice[], known: boolean): string | undefined {
  const c = findChoice(choices, r.ref_id)
  if (c) return c.name
  return known ? undefined : r.ref_id
}

/** 跳到这次运行：Agent 会话打开会话，SOP 执行打开运行页 */
export function lastRunLink(run: VideoLastRun): { to: string; label: string } | null {
  const ref = run.ref ?? ''
  if (ref.startsWith('ags_')) return { to: `/conversations?s=${encodeURIComponent(ref)}`, label: '打开会话' }
  if (ref.startsWith('spr_')) return { to: `/sop/runs/${encodeURIComponent(ref)}`, label: '查看这次执行' }
  return null
}
