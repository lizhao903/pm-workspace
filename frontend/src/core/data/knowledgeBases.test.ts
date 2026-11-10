// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { QueryClient } from '@tanstack/react-query'
import { describe, expect, it } from 'vitest'
import { applyChange, invalidationsFor } from './invalidate'
import { dataKeys } from './keys'

describe('知识库的失效规则', () => {
  it('改了知识库：列表、文档、未收进来的篇目、检索、Agent 列表一起刷，对象不动', async () => {
    expect(invalidationsFor({ kind: 'knowledge-base' })).toContainEqual(dataKeys.knowledgeBases.all)
    const qc = new QueryClient()
    const keys = [
      dataKeys.knowledgeBases.list, dataKeys.knowledgeBases.docs('kb_a'), dataKeys.knowledgeBases.missing('kb_a'),
      dataKeys.knowledgeBases.search('kb_a', '权限'), dataKeys.knowledgeBases.agents, dataKeys.objects.detail('obj_a'),
    ]
    for (const k of keys) qc.setQueryData(k, 1)
    await applyChange(qc, { kind: 'knowledge-base' })
    expect(keys.map((k) => qc.getQueryState(k)?.isInvalidated)).toEqual([true, true, true, true, true, false])
  })
})
