import { describe, expect, it } from 'vitest'
import type { Agent, ImMessage } from '../../core/data'
import { pickAgent, relatedDir, sessionPrompt, sessionTitle, sourceRef } from './sessionModel'

const m = (p: Partial<ImMessage>): ImMessage => ({
  id: 'm1', channel: 'slack', connector_id: 'cn_1', external_id: 'x1', conversation_id: 'cv_1', conversation_external_id: 'C1',
  conversation_kind: 'group', conversation: '#product', sender_id: 'U1', sender_name: 'Lin', identity_id: null, stakeholder_id: null, contact_name: '林原',
  text: '登录页改版，下周三前给稿', attachments: [], relevance: '', status: 'pending', read: true, snooze_until: null, expired_at: null,
  at: '2026-11-02T02:00:00Z', received_at: '', adapter: 'fake', task_id: null, task_ref: '', replies: [], reply_error: '',
  project_id: null, project_name: '', project_source: '', sessions: [], split_tasks: [], materials: [], thread: null, reply_count: 0, ...p,
})
const agent = (p: Partial<Agent>): Agent => ({
  id: 'ag', name: '', desc: '', color: '', avatar: { kind: 'text', value: '' }, provider_id: 'p', model: 'm', instructions: '', skills: [], mcps: [], kbs: [],
  triggers: [{ kind: 'manual', detail: '' }], enabled: true, created_at: '', updated_at: '', ...p,
})

describe('从消息发起会话', () => {
  it('默认 Agent：上次用的、带 IM 触发的、像管任务的、第一个启用的；停用的不挑', () => {
    const a = agent({ id: 'a', name: '写周报' })
    const b = agent({ id: 'b', name: '任务拆解' })
    const c = agent({ id: 'c', name: '收消息', triggers: [{ kind: 'im', detail: '' }] })
    const off = agent({ id: 'off', enabled: false })
    expect(pickAgent([a, b, c, off], 'off')?.id).toBe('c')
    expect(pickAgent([a, b, c], 'a')?.id).toBe('a')
    expect(pickAgent([a, b])?.id).toBe('b')
    expect(pickAgent([a])?.id).toBe('a')
    expect(pickAgent([off])).toBeUndefined()
    // 拆分任务：先在能建任务的里挑
    expect(pickAgent([a, b, c], null, (x) => x.id !== 'c')?.id).toBe('b')
    expect(pickAgent([a, c], null, () => false)?.id).toBe('c')
  })

  it('来源同转任务的形状，多 message_ids、项目；第一句话带原文、群、项目、附件和意图', () => {
    const xs = [m({ id: 'm2', at: '2026-11-02T02:05:00Z', text: '附件里是需求', project_id: 'obj_p', project_name: 'Octok', attachments: [{ id: 'a', name: '需求.pdf', kind: 'file' }] }), m({})]
    const ref = sourceRef(xs, 'Slack')
    expect(ref).toMatchObject({ kind: 'im_message', message_id: 'm2', message_ids: ['m1', 'm2'], conversation: '#product', sender: '林原', project_id: 'obj_p' })
    expect(String(ref.label)).toContain('等 2 条')
    const split = sessionPrompt(xs, 'split', { chLabel: 'Slack', grant: 'confirm' })
    for (const want of ['群「#product」', '林原（Slack 编号 U1）', '归属项目：Octok', '附件：需求.pdf', '林原：登录页改版', '确认卡片', '项目「Octok」']) expect(split).toContain(want)
    expect(sessionPrompt(xs, 'split', { chLabel: 'Slack', grant: 'auto' })).toContain('列完先停下')
    expect(sessionPrompt([m({})], 'chat', { chLabel: 'Slack' })).toContain('未归项目')
    expect(sessionTitle(xs, 'split')).toMatch(/^拆分任务：林原「/)
  })
})

describe('relatedDir：项目没设本地目录时用第一个关联目录', () => {
  it('取第一个有路径的关联目录，file:// 去掉，没有时空串', () => {
    expect(relatedDir({ related: [{ label: 'a', path: '/Volumes/docs/Know Me/Octok项目' }, { path: '/x' }] })).toBe('/Volumes/docs/Know Me/Octok项目')
    expect(relatedDir({ related: [{ label: '空' }, { path: 'file:///tmp/xaue' }] })).toBe('/tmp/xaue')
    expect(relatedDir({})).toBe('')
    expect(relatedDir(null)).toBe('')
  })
})
