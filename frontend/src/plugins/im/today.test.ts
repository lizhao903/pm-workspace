// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { describe, expect, it } from 'vitest'
import type { ImMessage } from '../../core/data'
import { todayNeeds } from './index'

const m = (id: string, p: Partial<ImMessage>) =>
  ({ id, status: 'pending', snooze_until: null, relevance: '', sender_name: 'Lin', contact_name: '', text: id, conversation: '#g', at: '2026-10-29T00:00:00Z', ...p }) as ImMessage

describe('今日的 IM 消息组（B-01）', () => {
  it('只算与我相关的待处理，不含稍后；@我 排前面', () => {
    const now = Date.parse('2026-10-29T00:00:00Z')
    const r = todayNeeds([
      m('chat', {}), m('me', { relevance: 'me' }), m('all', { relevance: 'all' }), m('dm', { relevance: 'dm', conversation: '' }),
      m('done', { relevance: 'me', status: 'done' }), m('later', { relevance: 'me', snooze_until: '2026-10-29T01:00:00Z' }),
    ], now)
    expect(r.total).toBe(3)
    expect(r.items.map((x) => [x.id, x.rank])).toEqual([['me', 0], ['all', 1], ['dm', 1]])
    expect(r.items[2].sub).toBe('私聊')
  })
})
