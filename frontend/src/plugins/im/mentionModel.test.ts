import { describe, expect, it } from 'vitest'
import type { ImMember } from '../../core/data'
import { activeMention, composeMentions, defaultMention, filterMembers, insertMention } from './mentionModel'

const member = (p: Partial<ImMember>): ImMember => ({ external_id: '', name: '', sender_name: '', identity_id: '', contact_id: '', source: 'conversation', last_at: '', is_bot: false, is_self: false, ...p })

describe('回复、发消息里的 @', () => {
  it('群聊回复 @ 原发信人（联系人名优先），私聊没有', () => {
    expect(defaultMention({ conversation_kind: 'group', sender_id: 'U1', sender_name: 'lin', contact_name: '林原' })).toEqual({ external_id: 'U1', name: '林原' })
    expect(defaultMention({ conversation_kind: 'group', sender_id: 'U1', sender_name: 'lin', contact_name: '' })).toEqual({ external_id: 'U1', name: 'lin' })
    expect(defaultMention({ conversation_kind: 'direct', sender_id: 'U1', sender_name: 'lin', contact_name: '林原' })).toBeNull()
  })

  it('认光标前正在输入的 @，邮箱和带空白的不算', () => {
    expect(activeMention('@', 1)).toEqual({ start: 0, query: '' })
    expect(activeMention('你好 @林', 5)).toEqual({ start: 3, query: '林' })
    expect(activeMention('你好，@林', 5)).toEqual({ start: 3, query: '林' })
    expect(activeMention('a@b', 3)).toBeNull()
    expect(activeMention('@林原 好', 5)).toBeNull()
    expect(activeMention('没有', 2)).toBeNull()
  })

  it('搜候选：名字开头的在前，也按渠道名字、编号搜', () => {
    const ms = [member({ name: '小林', external_id: 'U2' }), member({ name: '林原', sender_name: 'Lin Yuan', external_id: 'U1' }), member({ name: '周宇', external_id: 'U9' })]
    expect(filterMembers(ms, '林').map((m) => m.name)).toEqual(['林原', '小林'])
    expect(filterMembers(ms, 'lin').map((m) => m.name)).toEqual(['林原'])
    expect(filterMembers(ms, 'u9').map((m) => m.name)).toEqual(['周宇'])
    expect(filterMembers(ms, '', 2)).toHaveLength(2)
  })

  it('选中后换成「@名字 」，光标落在后面', () => {
    expect(insertMention('看下 @林 吧', 5, 3, '林原')).toEqual({ text: '看下 @林原 吧', caret: 7 })
    expect(insertMention('@', 1, 0, 'Lin Yuan')).toEqual({ text: '@Lin Yuan ', caret: 10 })
  })

  it('发送：对方拼到开头（已写了不重复），只带正文里还在的，同一人只带一次', () => {
    const tag = { external_id: 'U1', name: '林原' }
    expect(composeMentions(' 收到 ', tag, [])).toEqual({ text: '@林原 收到', mentions: [tag] })
    expect(composeMentions('@林原 收到', tag, [tag])).toEqual({ text: '@林原 收到', mentions: [tag] })
    const zhou = { external_id: 'U9', name: '周宇' }
    const gone = { external_id: 'U5', name: '陈晨' }
    expect(composeMentions('@周宇 看下 @周宇 @王五', null, [zhou, gone, zhou])).toEqual({ text: '@周宇 看下 @周宇 @王五', mentions: [zhou] })
  })
})
