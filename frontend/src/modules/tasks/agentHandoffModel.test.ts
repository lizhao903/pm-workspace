// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { describe, expect, it } from 'vitest'
import type { Agent, AgentScenario, TaskRun } from '../../core/data'
import { AGENT_RUN_DEFAULTS, agentRunRequest, canResume, clampInt, pickAgent } from './agentHandoffModel'
import { agentSessionOf, confirmStateText, extraOf, foldEvents, harnessLabel, parseOutput } from './runsModel'

const ag = (id: string, enabled = true) => ({ id, enabled }) as Agent

describe('交给工作台 Agent 的纯函数（TSK-0460）', () => {
  it('pickAgent：选过的 > 场景的 > 第一个启用的', () => {
    const list = [ag('a', false), ag('b'), ag('c')]
    const sc = [{ key: 'task_run', agent_id: 'c' }] as AgentScenario[]
    expect(pickAgent(list, sc, null)).toBe('c')
    expect(pickAgent(list, sc, 'b')).toBe('b')
    expect(pickAgent(list, sc, 'a')).toBe('c')
    expect(pickAgent(list, [{ key: 'task_run', agent_id: 'a' }] as AgentScenario[], null)).toBe('b')
    expect(pickAgent([ag('a', false)], undefined, null)).toBe('')
  })

  it('canResume 只认带会话的 agent 执行', () => {
    expect(canResume([{ harness: 'claude', harness_session: 'x' }] as TaskRun[])).toBe(false)
    expect(canResume([{ harness: 'agent', harness_session: '' }] as TaskRun[])).toBe(false)
    expect(canResume([{ harness: 'agent', harness_session: 'ses_1' }] as TaskRun[])).toBe(true)
  })

  it('请求体：默认值不带，续跑不带 agent_id', () => {
    const base = { agentId: 'ag_1', providerId: '', model: '', presetId: '', extra: '', workdir: '', resume: false, steps: AGENT_RUN_DEFAULTS.steps, minutes: AGENT_RUN_DEFAULTS.minutes }
    expect(agentRunRequest(base)).toEqual({ harness: 'agent', agent_id: 'ag_1' })
    expect(agentRunRequest({ ...base, resume: true, providerId: 'apv', model: ' m ', steps: 5, minutes: 3 }))
      .toEqual({ harness: 'agent', resume_session: true, provider_id: 'apv', model: 'm', max_steps: 5, max_minutes: 3 })
    expect(clampInt('500', 30, 100)).toBe(30)
    expect(clampInt('1.5', 30, 100)).toBe(30)
    expect(clampInt(' 12 ', 30, 100)).toBe(12)
  })

  it('确认卡片：confirm 折成一张，decision 改状态；落库输出里的确认行也认', () => {
    const blocks = foldEvents([
      { type: 'confirm', id: 'atc_1', name: 'update_object', args: '{}', summary: '修改 TSK-1', deadline: '' },
      { type: 'decision', id: 'atc_1', approved: false, reason: 'timeout' },
    ])
    expect(blocks).toEqual([{ k: 'confirm', id: 'atc_1', name: 'update_object', summary: '修改 TSK-1', deadline: '', state: 'timeout' }])
    const tools = foldEvents([
      { type: 'tool', id: 't1', name: 'update_object', detail: '' },
      { type: 'tool_result', id: 't1', name: 'update_object', ok: true, error: '', summary: '已修改 TSK-1' },
    ])
    expect(tools[0]).toMatchObject({ k: 'tool', state: 'ok', summary: '已修改 TSK-1' })
    const out = parseOutput('开始\n[工具] get_object · {}\n\n[等待确认] 修改 TSK-1\n[已拒绝]\n不改了', 'done')
    expect(out.map((b) => b.k)).toEqual(['text', 'tool', 'confirm', 'text'])
    expect(out[2]).toMatchObject({ k: 'confirm', summary: '修改 TSK-1', state: 'rejected' })
    expect(confirmStateText('pending', new Date(Date.now() + 90_000).toISOString())).toBe('等你确认，2 分钟内没确认按拒绝处理')
    expect(confirmStateText('approved', '')).toBe('已确认，执行了')
  })

  it('交给工作台 Agent 的提示词也能取出补充说明', () => {
    expect(extraOf('## 本次执行的补充要求\n先看 A 家\n\n## 怎么做\n- 先读')).toBe('先看 A 家')
  })

  it('执行器名字和会话', () => {
    expect(harnessLabel(undefined)).toBe('Claude Code')
    expect(harnessLabel('agent')).toBe('工作台 Agent')
    expect(agentSessionOf({ harness: 'agent', harness_session: 'ses_1' })).toBe('ses_1')
    expect(agentSessionOf({ harness: 'deepseek', harness_session: 'x' })).toBe('')
  })
})
