// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 执行器能选的技能、SOP、Agent（VID-03c），给 Runner.tsx 用
import { useAgents, useSopFlows, type VideoRunnerType } from '../../core/data'
import { RUNNER_SKILLS, type RunnerChoice } from './runnerModel'

export type RunnerChoices = { list: (t: VideoRunnerType) => RunnerChoice[]; known: (t: VideoRunnerType) => boolean }

/** 三种执行器能选的：技能是固定的，SOP、Agent 现取；SOP 插件没启用时取不回来 */
export function useRunnerChoices(): RunnerChoices {
  const sops = useSopFlows()
  const agents = useAgents()
  const sopList = (sops.data ?? []).map((f) => ({ id: f.id, name: f.name }))
  const agentList = (agents.data ?? []).map((a) => ({ id: a.id, name: a.name || '未命名 Agent' }))
  return {
    list: (t) => (t === 'skill' ? RUNNER_SKILLS : t === 'sop' ? sopList : agentList),
    known: (t) => (t === 'skill' ? true : t === 'sop' ? sops.isSuccess : agents.isSuccess),
  }
}
