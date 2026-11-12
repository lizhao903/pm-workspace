// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { describe, expect, it } from 'vitest'
import { EMPTY_CTX, nodeInfo } from './nodes'

// 调模型的节点选 Agent（0045）：选了不显示服务商和模型，摘要写 Agent 名；节点上没有单独的思考配置
describe('调模型的节点选 Agent', () => {
  const ctx = { ...EMPTY_CTX, agents: [{ id: 'ag_1', name: '内容分诊' }] }
  const shown = (kind: string, cfg: Record<string, string>) => nodeInfo(kind).fields.filter((f) => !f.hidden?.(cfg)).map((f) => f.key)

  it('ai、extract、classifier、iterate 都有 Agent 配置项，没有思考配置项', () => {
    for (const k of ['ai', 'extract', 'classifier', 'iterate']) {
      const keys = nodeInfo(k).fields.map((f) => f.key)
      expect(keys).toContain('agent')
      expect(keys).not.toContain('thinking')
    }
  })

  it('AI 处理选了 Agent 隐去服务商和模型，摘要写 Agent 名', () => {
    expect(shown('ai', {})).toEqual(['agent', 'provider', 'model', 'output'])
    expect(shown('ai', { agent: 'ag_1', provider: 'apv_x' })).toEqual(['agent', 'output'])
    expect(nodeInfo('ai').summary?.({ agent: 'ag_1', provider: 'apv_x' }, ctx)).toBe('内容分诊')
    expect(nodeInfo('classifier').summary?.({ agent: 'ag_1' }, ctx)).toBe('内容分诊')
  })

  it('Agent 下拉：第一项不选，选着的删了标出来', () => {
    const f = nodeInfo('classifier').fields.find((x) => x.key === 'agent')!
    expect(f.options?.(ctx, {}).map((o) => o.label)).toEqual(['不选（用场景默认）', '内容分诊'])
    expect(f.options?.(ctx, { agent: 'ag_gone' }).at(-1)).toEqual({ value: 'ag_gone', label: '已删除的 Agent' })
  })
})
