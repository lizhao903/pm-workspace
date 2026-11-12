// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { QueryClient, type QueryKey } from '@tanstack/react-query'
import { describe, expect, it } from 'vitest'
import { agentConfigKeys } from './agentConfigKeys'
import { agentKeys } from './agentKeys'
import { applyChange, type Change } from './invalidate'
import { dataKeys } from './keys'
import { skillKeys } from './skillKeys'

describe('Agent 配置的失效（AG-01b5）', () => {
  const keys = {
    list: agentConfigKeys.list,
    detail: agentConfigKeys.detail('ag_1'),
    impact: agentConfigKeys.impact('ag_1'),
    grants: agentConfigKeys.grants('ag_1'),
    skills: skillKeys.list,
    kbs: dataKeys.knowledgeBases.list,
    sessions: agentKeys.sessions.unscoped,
    providers: agentKeys.providers,
    objects: dataKeys.objects.lists,
  } satisfies Record<string, QueryKey>
  async function stale(c: Change) {
    const qc = new QueryClient()
    for (const k of Object.values(keys)) qc.setQueryData(k, {})
    await applyChange(qc, c)
    return (Object.keys(keys) as (keyof typeof keys)[]).filter((n) => qc.getQueryState(keys[n])?.isInvalidated)
  }

  it('改 Agent 刷 Agent 的全部缓存、技能和知识库上的「在用的 Agent」、会话', async () => {
    expect(await stale({ kind: 'agent', id: 'ag_1' })).toEqual(['list', 'detail', 'impact', 'grants', 'skills', 'kbs', 'sessions'])
  })

  it('删技能、删知识库会从 Agent 上摘掉，Agent 跟着刷', async () => {
    expect(await stale({ kind: 'skill' })).toEqual(['list', 'detail', 'impact', 'grants', 'skills'])
    expect(await stale({ kind: 'knowledge-base' })).toEqual(['list', 'detail', 'impact', 'grants', 'kbs'])
  })

  it('改服务商不动 Agent（模型可用性由前端按服务商列表算）', async () => {
    expect(await stale({ kind: 'agent-provider' })).toEqual(['providers'])
  })
})
