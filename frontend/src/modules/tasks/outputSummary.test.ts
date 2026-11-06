import { describe, expect, it } from 'vitest'
import type { ArtifactObjectSummary, DictItem } from '../../core/data'
import { kindParts, kindTable, matchOutputs, sinceParam, summaryText } from './outputSummary'

const dict = (key: string, label: string, archived = false) => ({ key, label, color: '', archived_at: archived ? 'x' : null }) as DictItem

describe('任务的产出物汇总（TSK-0497）', () => {
  it('种类按字典顺序，字典没有的内置种类补在后面，停用的照样有名字', () => {
    const kinds = kindTable([dict('doc', '文档'), dict('commit', '提交', true), dict('video', '视频')])
    expect(kinds.slice(0, 3).map((k) => k.key)).toEqual(['doc', 'commit', 'video'])
    expect(kinds.some((k) => k.key === 'code' && k.label === '代码')).toBe(true)
    expect(kindTable(undefined)[0]).toEqual({ key: 'commit', label: '提交' })
  })

  it('「3 · 提交 2 文档 1」：按种类顺序，0 条的不写，只有一种时省掉分项', () => {
    const kinds = kindTable([dict('commit', '提交'), dict('doc', '文档')])
    const parts = kindParts({ doc: 1, commit: 2, pr: 0, mystery: 1 }, kinds)
    expect(parts.map((p) => p.key)).toEqual(['commit', 'doc', 'mystery'])
    expect(summaryText(4, parts)).toBe('4 · 提交 2 文档 1 mystery 1')
    expect(summaryText(2, kindParts({ commit: 2 }, kinds))).toBe('2 · 提交')
  })

  it('汇总没取到时「有产出 / 无产出」不筛，不把「还不知道」当成「无产出」', () => {
    const m = new Map([['a', {} as ArtifactObjectSummary]])
    expect(matchOutputs('b', 'without', undefined)).toBe(true)
    expect(matchOutputs('a', 'with', m)).toBe(true)
    expect(matchOutputs('b', 'with', m)).toBe(false)
    expect(matchOutputs('b', 'without', m)).toBe(true)
    expect(matchOutputs('a', '', m)).toBe(true)
  })

  it('时间筛选换成本地日期，含今天', () => {
    const now = new Date(2026, 10, 6, 15, 0)
    expect(sinceParam('7d', now)).toBe('2026-10-31')
    expect(sinceParam('', now)).toBeUndefined()
  })
})
