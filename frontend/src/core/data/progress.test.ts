// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { describe, expect, it } from 'vitest'
import { chronological, isInProgress, progressKindLabel, revisionSummary, shortSession } from './progress'
import type { Progress } from '../api'

const p = (id: string, kind: Progress['kind'], at: string, status = ''): Progress => ({
  id, object_id: 'o', kind, text: id, commits: [], files: [], status,
  actor: 'me', actor_name: 'me', session_id: '', source: 'ui', created_at: at,
})

describe('进展', () => {
  it('接口最近的在前，时间线按时间顺序；同一秒的按接口顺序，不按 id 重排', () => {
    const at = '2026-10-28T10:00:00Z'
    const rows = [p('rev_a', 'review', at), p('rev_c', 'note', at), p('rev_b', 'claim', at)]
    expect(chronological(rows).map((x) => x.id)).toEqual(['rev_b', 'rev_c', 'rev_a'])
    expect(rows[0].id).toBe('rev_a')
  })

  it('类型标识', () => {
    expect(['claim', 'note', 'review', 'x'].map(progressKindLabel)).toEqual(['领取', '进展', '提交验收', 'x'])
    expect(shortSession('332d2cac-6041-4a72')).toBe('332d2cac')
  })

  it('进行中：状态是最近一次领取切到的状态；没有领取看 doing', () => {
    const claimed = [p('b', 'note', '2', ''), p('a', 'claim', '1', 'doing')]
    expect(isInProgress('doing', claimed)).toBe(true)
    expect(isInProgress('review', claimed)).toBe(false)
    expect(isInProgress('blocked', [p('a', 'claim', '1', 'blocked')])).toBe(true)
    expect(isInProgress('doing', [])).toBe(true)
    expect(isInProgress('todo', [])).toBe(false)
  })
})

describe('修订显示', () => {
  it('进展行只显示正文，不把元数据 JSON 当旧值', () => {
    const s = revisionSummary({ field: 'progress', old_value: '{"kind":"review","commits":["a1"],"files":[]}', new_value: '做完了' })
    expect(s).toBe('提交验收：做完了')
    expect(s).not.toContain('{')
    expect(revisionSummary({ field: 'progress', old_value: 'not json', new_value: '记一笔' })).toBe('进展：记一笔')
  })

  it('普通字段按从 old 改成 new', () => {
    expect(revisionSummary({ field: 'status', old_value: 'todo', new_value: 'doing' })).toBe('status 从 todo 改成 doing')
  })
})
