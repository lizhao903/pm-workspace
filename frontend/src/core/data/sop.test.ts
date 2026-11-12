// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { QueryClient, type QueryKey } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyChange, type Change } from './invalidate'
import { dataKeys } from './keys'
import { sopApi } from './sop'
import { todayKeys } from './today'

describe('SOP 的失效（SOP-04b）', () => {
  const keys = {
    flows: dataKeys.sop.flows,
    nodeTypes: dataKeys.sop.nodeTypes,
    runs: dataKeys.sop.runList,
    run: dataKeys.sop.run('spr_1'),
    today: todayKeys.of(),
    objects: dataKeys.objects.list(),
  } satisfies Record<string, QueryKey>
  async function stale(c: Change) {
    const qc = new QueryClient()
    for (const k of Object.values(keys)) qc.setQueryData(k, {})
    await applyChange(qc, c)
    return (Object.keys(keys) as (keyof typeof keys)[]).filter((n) => qc.getQueryState(keys[n])?.isInvalidated)
  }

  it('执行一变，刷执行列表、打开着的执行和今日', async () => {
    expect(await stale({ kind: 'sop-run', id: 'spr_1' })).toEqual(['runs', 'run', 'today'])
  })

  it('删流程只刷流程列表；改对象不动 SOP', async () => {
    expect(await stale({ kind: 'sop-flow', id: 'sop_a' })).toEqual(['flows'])
    expect(await stale({ kind: 'object' })).not.toContain('runs')
  })
})

describe('sopApi', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('动作按契约发 body，空数组补齐', async () => {
    const calls: { url: string; body: unknown }[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : undefined })
      const run = {
        id: 'spr_1', flow_id: 'sop_a', flow_name: '甲', flow_version: 1, title: '甲', input: null, step_through: false, stopped: false,
        status: 'running', started_at: '', updated_at: '',
        flow: { id: 'sop_a', name: '甲', desc: '', trigger: '', fields: null, steps: [{ key: 'a', name: 'A', kind: 'auto' }], version: 1 },
        steps: [{ key: 'a', status: 'running', input: null, output: null, attempts: 1, log: null }],
      }
      return new Response(JSON.stringify({ data: run }), { status: 200 })
    }))
    const r = await sopApi.act('spr_1', { kind: 'approve', step: 2, output: { x: 1 } })
    expect(calls[0].url).toContain('/api/sop/runs/spr_1/actions')
    expect(calls[0].body).toEqual({ kind: 'approve', step: 2, output: { x: 1 } })
    expect(r.input).toEqual({})
    expect(r.flow.fields).toEqual([])
    expect(r.steps[0].log).toEqual([])
  })
})
