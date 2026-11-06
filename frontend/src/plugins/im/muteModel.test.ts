import { describe, expect, it } from 'vitest'
import { findMute, type ImMute } from '../../core/data'
import { muteReason, muteScopeText, muteWhoText } from './muteModel'

const base: ImMute = {
  id: 'imu_1', kind: 'sender', channel: 'slack', sender_id: 'B0GCAL', stakeholder_id: null, contact_name: '', conversation_id: null,
  conversation: '', name: 'Google Calendar', ignored: 3, last_at: null, created_at: '2026-11-06T00:00:00.000Z',
}

describe('自动忽略的显示口径（TSK-0495）', () => {
  it('谁、范围', () => {
    expect(muteWhoText(base, 'Slack')).toBe('Slack · B0GCAL')
    expect(muteWhoText({ ...base, kind: 'contact', channel: '', sender_id: '', stakeholder_id: 'stk_1', contact_name: '林原', name: '林原' })).toBe('联系人「林原」的全部 IM 身份')
    expect(muteScopeText(base)).toBe('全部会话')
    expect(muteScopeText({ ...base, conversation_id: 'cv_1', conversation: '#product' })).toBe('只在「#product」里')
    expect(muteScopeText({ ...base, conversation_id: 'cv_1' })).toBe('只在一个会话里')
  })
  it('消息详情的原因：取消后注明', () => {
    expect(muteReason({ muted: null })).toBe('')
    expect(muteReason({ muted: { mute_id: 'imu_1', name: 'Confluence', active: true } })).toBe('因发信人 Confluence 被设为自动忽略')
    expect(muteReason({ muted: { mute_id: 'imu_1', name: 'Confluence', active: false } })).toContain('已取消')
  })
  it('找命中的：渠道身份、联系人、会话范围', () => {
    const contact: ImMute = { ...base, id: 'imu_2', kind: 'contact', channel: '', sender_id: '', stakeholder_id: 'stk_lin', conversation_id: 'cv_prod' }
    const all = [base, contact]
    expect(findMute(all, { channel: 'slack', sender_id: 'B0GCAL' }).map((m) => m.id)).toEqual(['imu_1'])
    expect(findMute(all, { channel: 'telegram', sender_id: 'B0GCAL' })).toEqual([])
    expect(findMute(all, { channel: 'slack', sender_id: 'U1', stakeholder_id: 'stk_lin', conversation_id: 'cv_prod' }).map((m) => m.id)).toEqual(['imu_2'])
    expect(findMute(all, { channel: 'slack', sender_id: 'U1', stakeholder_id: 'stk_lin', conversation_id: 'cv_ops' })).toEqual([])
  })
})
