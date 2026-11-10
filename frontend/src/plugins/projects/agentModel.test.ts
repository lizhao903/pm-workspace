// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { describe, expect, it } from 'vitest'
import type { Agent, AgentSession } from '../../core/data'
import { addAgent, addSession, availAgents, defaultAgent, linkedAgents, makeDefault, projectSessions, removeAgent } from './agentModel'

const agent = (id: string, enabled = true) => ({ id, name: id, desc: '', color: '', enabled }) as Agent
const sess = (id: string, updated_at: string, message_count = 1) => ({ id, title: id, updated_at, message_count }) as AgentSession
const AGENTS = [agent('ag_a'), agent('ag_b', false), agent('ag_c')]

describe('项目 Agent 的纯函数（PR-21）', () => {
  it('按 agent_ids 顺序列，已删的跳过；默认是第一个还在的', () => {
    expect(linkedAgents(['ag_c', 'ag_gone', 'ag_a'], AGENTS).map((a) => a.id)).toEqual(['ag_c', 'ag_a'])
    expect(defaultAgent(['ag_gone', 'ag_a'], AGENTS)?.id).toBe('ag_a')
    expect(defaultAgent([], AGENTS)).toBeUndefined()
  })

  it('候选是还没加的，保持 Agent 列表顺序', () => {
    expect(availAgents(['ag_c'], AGENTS).map((a) => a.id)).toEqual(['ag_a', 'ag_b'])
  })

  it('加到末尾不重复，设为默认挪到第一个，移除只拿掉这个', () => {
    expect(addAgent(['ag_a'], 'ag_c')).toEqual(['ag_a', 'ag_c'])
    expect(addAgent(['ag_a'], 'ag_a')).toEqual(['ag_a'])
    expect(makeDefault(['ag_a', 'ag_b', 'ag_c'], 'ag_c')).toEqual(['ag_c', 'ag_a', 'ag_b'])
    expect(removeAgent(['ag_a', 'ag_b'], 'ag_a')).toEqual(['ag_b'])
  })

  it('新会话记在最前；项目会话只挑记下的、有消息的，按更新时间倒序', () => {
    expect(addSession(['s1', 's2'], 's2')).toEqual(['s2', 's1'])
    const all = [sess('s1', '2026-10-29T01:00:00Z'), sess('s2', '2026-10-29T03:00:00Z'), sess('s3', '2026-10-29T02:00:00Z'), sess('s4', '2026-10-29T04:00:00Z', 0)]
    expect(projectSessions(['s1', 's2', 's4', 's_gone'], all).map((s) => s.id)).toEqual(['s2', 's1'])
  })
})
