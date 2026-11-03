import { describe, expect, it } from 'vitest'
import type { AgentProvider } from '../data'
import { CHIPS, chipsOf, lastUsedOf, pickDefault, usableProvider } from './quickSessionModel'

const prov = (id: string, over: Partial<AgentProvider> = {}): AgentProvider => ({
  id, name: id, kind: 'openai', base_url: '', model: 'm', enabled: true, is_default: false,
  api_key_masked: '', has_api_key: false, extra: {}, created_at: '', updated_at: '', ...over,
})

describe('快速新建会话的挑选规则', () => {
  it('停用的、没有默认模型的不能直接开聊', () => {
    expect([prov('a'), prov('b', { enabled: false }), prov('c', { model: ' ' })].filter(usableProvider).map((p) => p.id)).toEqual(['a'])
  })

  it('默认选上次聊过的，其次默认服务商，再次第一个', () => {
    const xs = [prov('a'), prov('b', { is_default: true }), prov('c')]
    expect(pickDefault(xs, 'c')).toBe('c')
    expect(pickDefault(xs, 'gone')).toBe('b')
    expect(pickDefault([prov('a'), prov('c')])).toBe('a')
    expect(pickDefault([])).toBe('')
  })

  it('多了只露几个，选中的一定在里面，顺序不变', () => {
    const xs = Array.from({ length: 12 }, (_, i) => prov('p' + i))
    expect(chipsOf(xs.slice(0, CHIPS + 1), 'p0')).toHaveLength(CHIPS + 1)
    const shown = chipsOf(xs, 'p10').map((p) => p.id)
    expect(shown).toHaveLength(CHIPS)
    expect(shown).toContain('p10')
    expect(shown).toEqual([...shown].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))))
  })

  it('上次用的：挂了 Agent 的会话算 Agent（Agent 删了的跳过），没挂的算服务商', () => {
    const ss = [
      { agent_id: 'gone', agent_deleted: true, provider_id: 'p0' },
      { agent_id: null, provider_id: 'p1' },
      { agent_id: 'a1', agent_deleted: false, provider_id: 'p2' },
    ]
    expect(lastUsedOf(ss)).toEqual({ agent: 'a1', provider: 'p1' })
    expect(lastUsedOf([])).toEqual({ agent: undefined, provider: undefined })
  })
})
