// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { describe, expect, it } from 'vitest'
import type { WorkObject } from '../../core/data'
import { NO_REQUESTER, matchRequester, requesterKey, requesterOf, requesterOptions, stageColumns, stageLabel, stageOf } from './stageModel'

const t = (id: string, props: Record<string, unknown> | null) => ({ id, props }) as WorkObject

describe('阶段与提出人', () => {
  it('读 props.stage、props.requester；形状不对按没有算', () => {
    expect(stageOf(t('a', { stage: 'designing' }))).toBe('designing')
    expect(stageOf(t('a', null))).toBe('')
    expect(stageLabel('need_human')).toBe('需人工')
    expect(stageLabel('')).toBe('未设阶段')
    expect(requesterOf(t('a', { requester: 'x' }))).toBeNull()
    expect(requesterOf(t('a', { requester: { channel: 'slack', sender_id: 'U1', sender_name: '路人' } }))).toEqual(
      { name: '路人', channel: 'slack', sender_id: 'U1', sender_name: '路人' })
  })

  it('筛选键：联系人按 id，认不上的按渠道加发送者，没有提出人单独一个值', () => {
    const a = t('a', { requester: { contact_id: 'stk_a', name: '甲', channel: 'slack', sender_id: 'U1' } })
    const b = t('b', { requester: { name: '路人', channel: 'slack', sender_id: 'U9' } })
    const c = t('c', null)
    expect(requesterKey(requesterOf(a))).toBe('c:stk_a')
    expect(requesterKey(requesterOf(b))).toBe('s:slack:U9')
    expect(matchRequester(c, NO_REQUESTER)).toBe(true)
    expect(matchRequester(a, 'c:stk_a') && !matchRequester(b, 'c:stk_a')).toBe(true)
    expect(requesterOptions([a, b, a])).toEqual([
      { value: 'c:stk_a', label: '甲', n: 2 },
      { value: 's:slack:U9', label: '路人（slack）', n: 1 },
    ])
  })

  it('分列：列序同阶段全集；不认识的阶段并进「未设阶段」，只有勾了才出这一列', () => {
    const rows = [t('a', { stage: 'released' }), t('b', { stage: 'bogus' }), t('c', null), t('d', { stage: 'received' })]
    const cols = stageColumns(rows, false)
    expect(cols).toHaveLength(11)
    expect(cols[0].stage.key).toBe('received')
    expect(cols[0].rows.map((r) => r.id)).toEqual(['d'])
    expect(cols[10].rows.map((r) => r.id)).toEqual(['a'])
    const withNone = stageColumns(rows, true)
    expect(withNone[0].stage.label).toBe('未设阶段')
    expect(withNone[0].rows.map((r) => r.id)).toEqual(['b', 'c'])
  })
})
