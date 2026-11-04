import { describe, expect, it } from 'vitest'
import type { Agent, AgentRunCall, AgentToolCall } from '../../core/data'
import { matchAgentFilter, recentAgents, whoOf, whoUsable, FILTER_GONE, FILTER_NO_AGENT } from '../../core/chat/chatModel'
import { MANY_AGENTS, TOP_AGENTS, runCallViews, topAgents } from './runModel'

const call = (tool: string, summary: string, args = '{}'): AgentRunCall => ({ tool, args, summary, at: '' })
const tc = (id: string, tool: string, state: string, result = ''): AgentToolCall => ({
  id, agent_id: 'ag_1', session_id: 'ags_1', run_id: 'ar_1', call_id: 'c', tool, grant_key: 'write_tasks', args: '{"title":"x"}', state, result,
  created_at: '', decided_at: null,
})
const agent = (id: string, over: Partial<Agent> = {}): Agent => ({
  id, name: id, desc: '', color: '#000', avatar: { kind: 'text', value: '' }, provider_id: 'apv_1', model: 'm', instructions: '',
  skills: [], mcps: [], kbs: [], triggers: [], enabled: true, created_at: '', updated_at: '', ...over,
})

describe('执行记录的调用卡片', () => {
  it('「等待确认」那条换成要确认的调用，状态取它的；确认后真正执行的那条照常是已执行', () => {
    const views = runCallViews(
      [call('search_objects', '找到 3 条'), call('create_object', '等待确认：新建「x」'), call('create_object', '已新建 TSK-0001')],
      [tc('atc_1', 'create_object', 'confirmed', '已新建 TSK-0001')],
    )
    expect(views.map((v) => [v.name, v.state, v.id])).toEqual([
      ['search_objects', 'done', undefined], ['create_object', 'confirmed', 'atc_1'], ['create_object', 'done', undefined],
    ])
  })

  it('等确认的按顺序配对，没配上的补在最后', () => {
    const views = runCallViews(
      [call('create_object', '等待确认：新建「a」'), call('update_object', '等待确认：改「b」')],
      [tc('atc_1', 'create_object', 'pending'), tc('atc_2', 'update_object', 'rejected', '用户拒绝了'), tc('atc_3', 'write_file', 'pending')],
    )
    expect(views.map((v) => [v.id, v.state])).toEqual([['atc_1', 'pending'], ['atc_2', 'rejected'], ['atc_3', 'pending']])
    expect(views[1].summary).toBe('用户拒绝了')
  })

  it('Agent 不多时全是 chip；多了取执行记录最多的几个，其余进下拉', () => {
    const few = Array.from({ length: MANY_AGENTS }, (_, i) => ({ id: 'a' + i }))
    expect(topAgents(few, new Map()).chips).toHaveLength(MANY_AGENTS)
    const many = Array.from({ length: MANY_AGENTS + 2 }, (_, i) => ({ id: 'a' + i }))
    const { chips, rest } = topAgents(many, new Map([['a7', 5], ['a3', 2]]))
    expect(chips).toHaveLength(TOP_AGENTS)
    expect(chips.slice(0, 2).map((a) => a.id)).toEqual(['a7', 'a3'])
    expect(rest).toHaveLength(many.length - TOP_AGENTS)
  })
})

describe('会话和谁聊', () => {
  const agents = [agent('ag_1'), agent('ag_off', { enabled: false })]
  it('挂了 Agent 按 Agent，停用的不能发；删了的是 gone；列表没回来先不让发；没挂的按服务商', () => {
    expect(whoOf({ agent_id: 'ag_1', provider_id: 'p' }, agents, [])).toEqual({ kind: 'agent', agent: agents[0] })
    expect(whoUsable(whoOf({ agent_id: 'ag_off', provider_id: 'p' }, agents, []))).toEqual({ usable: false, note: '这个 Agent 已停用，只能回看' })
    expect(whoOf({ agent_id: 'ag_1', agent_deleted: true, provider_id: 'p' }, agents, []).kind).toBe('gone')
    expect(whoOf({ agent_id: 'ag_x', provider_id: 'p' }, agents, []).kind).toBe('gone')
    expect(whoOf({ agent_id: 'ag_1', provider_id: 'p' }, undefined, []).kind).toBe('pending')
    expect(whoUsable({ kind: 'gone' })).toEqual({ usable: false, note: '这个 Agent 已删除，只能回看' })
    expect(whoOf({ agent_id: null, provider_id: 'p' }, agents, []).kind).toBe('provider')
  })

  it('筛选：全部、某个 Agent、已删除的 Agent、不挂 Agent 的', () => {
    const live = { agent_id: 'ag_1', agent_deleted: false }
    const gone = { agent_id: 'ag_2', agent_deleted: true }
    const none = { agent_id: null }
    expect([live, gone, none].filter((s) => matchAgentFilter(s, ''))).toHaveLength(3)
    expect([live, gone, none].filter((s) => matchAgentFilter(s, 'ag_1'))).toEqual([live])
    expect([live, gone, none].filter((s) => matchAgentFilter(s, FILTER_GONE))).toEqual([gone])
    expect([live, gone, none].filter((s) => matchAgentFilter(s, FILTER_NO_AGENT))).toEqual([none])
  })

  it('新会话面板：最近聊过的 Agent 在前', () => {
    const xs = [agent('a'), agent('b'), agent('c')]
    const ss = [{ agent_id: 'c', updated_at: '2026-10-02' }, { agent_id: 'b', updated_at: '2026-10-01' }, { agent_id: null, updated_at: '2026-10-03' }]
    expect(recentAgents(xs, ss).map((a) => a.id)).toEqual(['c', 'b', 'a'])
  })
})
