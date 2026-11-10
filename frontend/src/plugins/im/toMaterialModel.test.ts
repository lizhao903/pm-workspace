// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { describe, expect, it } from 'vitest'
import type { ImMessage, ImMessageMaterial } from '../../core/data'
import { attachmentsOf, dayLabel, lineTime, materialBody, materialTitle, noteMaterials, priorMaterials } from './toMaterialModel'

let seq = 0
const msg = (p: Partial<ImMessage> = {}): ImMessage => {
  seq += 1
  return {
    id: `msg_${seq}`, channel: 'slack', connector_id: '', external_id: `C:${seq}`, conversation_id: 'cv_1', conversation_external_id: 'C01',
    conversation_kind: 'group', conversation: '#product', sender_id: 'U1', sender_name: 'Lin Yuan', identity_id: null, stakeholder_id: null,
    contact_name: '', text: '正文', attachments: [], relevance: '', status: 'pending', read: true, snooze_until: null, expired_at: null,
    at: '2026-10-30T06:00:00Z', received_at: '2026-10-30T06:00:00Z', adapter: 'fake', task_id: null, task_ref: '', replies: [], reply_error: '',
    project_id: null, project_name: '', project_source: '', sessions: [], split_tasks: [], materials: [], thread: null, reply_count: 0, ...p,
  }
}
const mm = (p: Partial<ImMessageMaterial>): ImMessageMaterial => ({
  material_id: 'mt_1', project_id: 'obj_p', project_name: 'Acme', kind: 'messages', attachment_id: '', title: 't', count: 1, at: '2026-10-30T07:00:00Z', ...p,
})
const now = new Date('2026-11-02T00:00:00Z')

describe('转项目资料的纯函数', () => {
  it('默认标题：群名或对方 + 日期；跨天写起止；不是今年带年份', () => {
    expect(materialTitle([msg({ at: '2026-10-30T06:00:00Z' })], now)).toBe(`#product ${dayLabel('2026-10-30T06:00:00Z', now)} 的消息`)
    const dm = [msg({ conversation: '', conversation_kind: 'direct', sender_name: '周屿', at: '2026-10-28T06:00:00Z' }),
      msg({ conversation: '', conversation_kind: 'direct', sender_name: '周屿', contact_name: '周屿（客户）', at: '2026-10-30T06:00:00Z' })]
    expect(materialTitle(dm, now)).toBe(`周屿（客户） ${dayLabel('2026-10-28T06:00:00Z', now)}至${dayLabel('2026-10-30T06:00:00Z', now)} 的消息`)
    expect(dayLabel('2025-03-01T12:00:00Z', now)).toMatch(/^2025年3月/)
    expect(materialTitle([], now)).toBe('')
  })

  it('正文：头一行渠道和群，按时间正序每条「[时间] 发信人：正文」，多行缩进，附件另起一行', () => {
    const b = msg({ text: '第二条\n还有一行', at: '2026-10-30T06:05:00Z', sender_name: 'Kevin', attachments: [{ id: 'a', name: '清单.xlsx', kind: 'file' }] })
    const a = msg({ text: '第一条', at: '2026-10-30T06:00:00Z' })
    const body = materialBody([b, a], 'Slack')
    expect(body.split('\n')).toEqual([
      'Slack · 群「#product」 · 2 条消息',
      '',
      `[${lineTime(a.at)}] Lin Yuan：第一条`,
      `[${lineTime(b.at)}] Kevin：第二条`,
      '  还有一行',
      '  附件：清单.xlsx',
    ])
    expect(materialBody([msg({ conversation: '', text: ' ' })], 'Telegram')).toContain('和 Lin Yuan 的私聊 · 1 条消息')
    expect(materialBody([msg({ text: '' })], 'Slack')).toContain('Lin Yuan：（没有正文）')
    expect(lineTime('2026-10-30T06:05:00Z')).toMatch(/^\d\d-\d\d \d\d:\d\d$/)
    // 渠道没给名字的用编号
    expect(materialBody([msg({ sender_name: '', sender_id: 'U02J38', text: 'x' })], 'Slack')).toContain('U02J38：x')
  })

  it('附件按时间先后列出', () => {
    const late = msg({ at: '2026-10-30T07:00:00Z', attachments: [{ id: 'b', name: 'B', kind: 'link', url: 'https://x' }] })
    const early = msg({ at: '2026-10-30T06:00:00Z', attachments: [{ id: 'a', name: 'A', kind: 'file' }] })
    expect(attachmentsOf([late, early]).map((x) => `${x.messageId}:${x.attachment.id}`)).toEqual([`${early.id}:a`, `${late.id}:b`])
  })

  it('转过没有：整组都在同一条资料里算转过；只有部分转过给条数；附件加进的不算', () => {
    const whole = mm({ material_id: 'mt_g', count: 2 })
    const a = msg({ materials: [whole] })
    const b = msg({ materials: [whole, mm({ material_id: 'mt_att', kind: 'attachment', attachment_id: 'x' })] })
    const c = msg()
    expect(priorMaterials([a, b])).toEqual({ same: [whole], partial: 0 })
    expect(priorMaterials([a, b, c])).toEqual({ same: [], partial: 2 })
    expect(priorMaterials([c])).toEqual({ same: [], partial: 0 })
    // 单条在更大的一组里转过，也算转过
    expect(priorMaterials([a]).same).toEqual([whole])
    expect(noteMaterials([b]).map((r) => r.material_id)).toEqual(['mt_g'])
  })

  it('转过的资料去重、新的在前', () => {
    const old = mm({ material_id: 'mt_old', at: '2026-10-01T00:00:00Z' })
    const neu = mm({ material_id: 'mt_new', at: '2026-10-31T00:00:00Z' })
    expect(noteMaterials([msg({ materials: [old] }), msg({ materials: [neu, old] })]).map((r) => r.material_id)).toEqual(['mt_new', 'mt_old'])
  })
})
