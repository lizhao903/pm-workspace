import { describe, expect, it } from 'vitest'
import type { ImMessage } from '../../core/data'
import { messageTitle, searchMessages, SEARCH_MAX } from './search'

const msg = (id: string, over: Partial<ImMessage>) =>
  ({ id, text: '', sender_name: '', contact_name: '', conversation: '', at: '2026-10-01T08:00:00Z', ...over }) as ImMessage

describe('searchMessages', () => {
  const rows = [
    msg('m1', { text: '验收标准麻烦再确认一下', sender_name: 'U01', contact_name: '常乐', conversation: 'Octok 产品群', at: '2026-10-01T08:00:00Z' }),
    msg('m2', { text: '好的收到', sender_name: 'lisa', conversation: '', at: '2026-10-02T08:00:00Z' }),
    msg('m3', { text: '验收\n明天做', sender_name: 'bob', conversation: 'XAUE', at: '2026-10-03T08:00:00Z' }),
  ]
  it('按正文、发信人、群名搜，新的在前', () => {
    expect(searchMessages(rows, '验收').map((m) => m.id)).toEqual(['m3', 'm1'])
    expect(searchMessages(rows, 'LISA').map((m) => m.id)).toEqual(['m2'])
    expect(searchMessages(rows, '常乐').map((m) => m.id)).toEqual(['m1'])
    expect(searchMessages(rows, 'octok').map((m) => m.id)).toEqual(['m1'])
  })
  it('多个词每个都要命中；空输入不出结果', () => {
    expect(searchMessages(rows, '验收 xaue').map((m) => m.id)).toEqual(['m3'])
    expect(searchMessages(rows, '')).toEqual([])
  })
  it('最多给 SEARCH_MAX 条', () => {
    const many = Array.from({ length: 10 }, (_, i) => msg('x' + i, { text: '同步一下' }))
    expect(searchMessages(many, '同步')).toHaveLength(SEARCH_MAX)
  })
  it('标题是发信人：正文，认上联系人用联系人名，换行压成空格', () => {
    expect(messageTitle(rows[0])).toBe('常乐：验收标准麻烦再确认一下')
    expect(messageTitle(rows[2])).toBe('bob：验收 明天做')
  })
})
