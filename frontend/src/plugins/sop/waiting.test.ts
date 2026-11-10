// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { QueryClient } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { activatePlugin, deactivatePlugin, objectSectionStore, sectionTabs, sectionsFor, todaySourceStore } from '../../core/plugin'

// SOP 插件启用后登记的今日「待我处理」来源和任务详情的「流水线」标签（AUTO-12）

afterEach(() => {
  deactivatePlugin('sop')
  vi.unstubAllGlobals()
})

const at = (min: number) => new Date(Date.parse('2026-11-04T01:00:00.000Z') + min * 60_000).toISOString()

describe('SOP 插件的待我处理和流水线标签', () => {
  it('启用后登记今日来源（排在最前）和任务的流水线标签，停用后撤掉', async () => {
    expect((await activatePlugin('sop')).ok).toBe(true)
    const src = todaySourceStore.list().find((s) => s.plugin === 'sop' && s.key === 'waiting')
    expect(src).toMatchObject({ slot: 'need', label: '待我处理', order: 10, more: '/sop/waiting' })
    expect(src!.queryKey[0]).toBe('today')
    const tabs = sectionTabs(sectionsFor(objectSectionStore.list(), 'task')).map((t) => t.tab.key)
    expect(tabs).toEqual(['pipeline', 'sop'])
    deactivatePlugin('sop')
    expect(todaySourceStore.list().some((s) => s.plugin === 'sop')).toBe(false)
  })

  it('一起取等人的步骤和停在等人阶段的任务，合成一组', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const u = new URL(String(input), 'http://x')
      calls.push(`${u.pathname}${u.search}`)
      const list = (data: unknown[]) => new Response(JSON.stringify({ data, meta: { total: data.length, limit: 200, offset: 0 } }))
      if (u.pathname === '/api/sop/waiting') {
        return list([{ run_id: 'spr_1', run_title: '研发 pipeline · x', flow_id: 'f', flow_name: '研发 pipeline', step_key: 'accept', step_name: '人工验收',
          step_kind: 'decide', step_status: 'review', wait: 'decide', reason: '', since: at(5), task_id: 'obj_a' }])
      }
      if (u.pathname === '/api/objects') {
        return list([
          { id: 'obj_a', type_id: 'task', ref: 'TSK-0001', title: '加验证码', props: { stage: 'accepting' }, updated_at: at(1) },
          { id: 'obj_b', type_id: 'task', ref: 'TSK-0002', title: '导出报表', props: { stage: 'confirm_project' }, updated_at: at(2) },
        ])
      }
      return list([])
    }))
    await activatePlugin('sop')
    const src = todaySourceStore.list().find((s) => s.plugin === 'sop' && s.key === 'waiting')!
    const qc = new QueryClient()
    const data = await qc.fetchQuery({ queryKey: src.queryKey, queryFn: src.queryFn })
    const r = src.select(data)
    expect(calls.find((c) => c.startsWith('/api/objects'))).toContain('stage=confirm_project%2Cneed_human%2Caccepting')
    expect(r.total).toBe(2)
    expect(r.items.map((x) => [x.title, x.action, x.to])).toEqual([
      ['人工验收 · 研发 pipeline', '去判断', '/sop/runs/spr_1'],
      ['TSK-0002 导出报表', '去选项目', '/tasks?t=obj_b&tab=pipeline'],
    ])
  })
})
