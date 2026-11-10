// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { describe, expect, it } from 'vitest'
import type { ImAttachmentFile, ImMessage, ProjectMaterial } from '../../core/data'
import { attachmentRows, fetchLabel, filterRows, kindCounts, segCounts, todoCount } from './attachmentModel'

const msg = (id: string, at: string, attachments: ImAttachmentFile[], over: Partial<ImMessage> = {}): ImMessage => ({
  id, channel: 'slack', connector_id: '', external_id: id, conversation_id: 'cv', conversation_external_id: 'C1', conversation_kind: 'group',
  conversation: '#product', sender_id: 'U1', sender_name: 'Lin Yuan', identity_id: null, stakeholder_id: null, contact_name: '林予安',
  text: '', attachments, relevance: '', status: 'pending', read: false, snooze_until: null, at, received_at: at,
  adapter: 'fake', task_id: null, task_ref: '', replies: [], reply_error: '', expired_at: null, project_id: null, project_name: '', project_source: '', sessions: [], split_tasks: [], materials: [], thread: null, reply_count: 0,
  ...over,
})
const mat = (over: Partial<ProjectMaterial>): ProjectMaterial => ({
  id: 'mt1', project_id: 'p', kind: 'file', name: '', value: '', category: '', status: '', tags: [], source: 'manual', created_at: '', updated_at: '', ...over,
})
const LINK = 'https://figma.com/x'
const M1 = msg('m1', '2026-10-29T03:00:00Z', [
  { id: 'a1', name: '清单.xlsx', kind: 'file', size: 2048, fetch: 'done', local: '/d/slack/清单.xlsx' },
  { id: 'a2', name: 'Figma 稿', kind: 'link', url: LINK },
])
const M2 = msg('m2', '2026-10-29T02:00:00Z', [{ id: 'a1', name: '截图.png', kind: 'image', fetch: 'idle' }], { contact_name: '', sender_name: 'Chen', conversation: '#ops' })
const M3 = msg('m3', '2026-10-29T04:00:00Z', [{ id: 'b1', name: '说明.pdf', kind: 'file', fetch: 'error', error: 'gone' }])

describe('附件行', () => {
  it('按消息时间倒序，同一条消息的同一个附件只算一次；不同消息里同名 id 的附件各算各的', () => {
    const rows = attachmentRows([M1, M2, M3, M1], [], [])
    expect(rows.map((r) => r.key)).toEqual(['m3:b1', 'm1:a1', 'm1:a2', 'm2:a1'])
  })

  it('去向：按资料 value 认已加入，记在不加入里的算不加入，两样都有时算已加入', () => {
    const rows = attachmentRows([M1, M2, M3], [mat({ id: 'mt_link', kind: 'link', value: LINK })], ['m2:a1', 'm1:a2'])
    const by = Object.fromEntries(rows.map((r) => [r.key, r]))
    expect(by['m1:a2'].state).toBe('added')
    expect(by['m1:a2'].material?.id).toBe('mt_link')
    expect(by['m2:a1'].state).toBe('skipped')
    expect(by['m1:a1'].state).toBe('todo')
    expect(todoCount(rows)).toBe(2)
  })

  it('资料还没取到时都按待决定', () => {
    expect(attachmentRows([M1], undefined, []).every((r) => r.state === 'todo')).toBe(true)
  })
})

describe('筛选和计数', () => {
  const rows = attachmentRows([M1, M2, M3], [mat({ kind: 'link', value: LINK })], ['m2:a1'])

  it('分段数字跟着种类和搜索走', () => {
    expect(segCounts(rows, { kind: '', q: '' })).toEqual({ todo: 2, added: 1, skipped: 1, all: 4 })
    expect(segCounts(rows, { kind: 'file', q: '' })).toEqual({ todo: 2, added: 0, skipped: 0, all: 2 })
    expect(segCounts(rows, { kind: '', q: 'chen' })).toEqual({ todo: 0, added: 0, skipped: 1, all: 1 })
  })

  it('种类数字跟着分段走', () => {
    expect(kindCounts(rows, { seg: 'todo', q: '' })).toEqual({ image: 0, file: 2, link: 0 })
    expect(kindCounts(rows, { seg: '', q: '' })).toEqual({ image: 1, file: 2, link: 1 })
  })

  it('搜文件名、联系人姓名、平台名字、群名，空格切词都要命中，不区分大小写', () => {
    expect(filterRows(rows, { seg: '', kind: '', q: '清单' }).map((r) => r.key)).toEqual(['m1:a1'])
    expect(filterRows(rows, { seg: '', kind: '', q: '林予安 PDF' }).map((r) => r.key)).toEqual(['m3:b1'])
    expect(filterRows(rows, { seg: '', kind: '', q: 'lin yuan' }).length).toBe(3)
    expect(filterRows(rows, { seg: '', kind: '', q: '#ops' }).map((r) => r.key)).toEqual(['m2:a1'])
    expect(filterRows(rows, { seg: 'skipped', kind: 'image', q: '' }).map((r) => r.key)).toEqual(['m2:a1'])
  })

  it('获取状态', () => {
    expect(rows.map((r) => fetchLabel(r.a))).toEqual(['获取失败', '已获取', '不用获取', '没获取'])
  })
})
