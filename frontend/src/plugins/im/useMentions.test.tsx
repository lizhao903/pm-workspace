// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { describe, expect, it } from 'vitest'
import type { ImMessage } from '../../core/data'
import { quickReplyAction } from './useMentions'

describe('回复时 @ 对方（本机开关）', () => {
  it('列表行的快捷回复跟着本机「回复时 @ 对方」开关，私聊不加', () => {
    const g = { conversation_kind: 'group', sender_id: 'U1', sender_name: 'lin', contact_name: '林原' } as ImMessage
    localStorage.removeItem('pmw.im.replyMention')
    expect(quickReplyAction(g, '收到', true)).toEqual({ kind: 'reply', text: '@林原 收到', done: true, mentions: [{ external_id: 'U1', name: '林原' }] })
    localStorage.setItem('pmw.im.replyMention', 'off')
    expect(quickReplyAction(g, '收到', false)).toEqual({ kind: 'reply', text: '收到', done: false })
    localStorage.removeItem('pmw.im.replyMention')
    expect(quickReplyAction({ ...g, conversation_kind: 'direct' }, '收到', false)).toEqual({ kind: 'reply', text: '收到', done: false })
  })
})
