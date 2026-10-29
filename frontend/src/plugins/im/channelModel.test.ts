import { describe, expect, it } from 'vitest'
import type { Connector, ConnectorDef } from '../../core/data'
import { addableDefs, callbackUrl, imConnectors, memberIdError, slackTokenError, syncText } from './channelModel'

const def = (tool: string, category = 'im'): ConnectorDef => ({ tool, label: tool, category, color: '', desc: '', can_send: true, auth: ['token'], fields: [], tools: [], source: 'im' })
const conn = (id: string, tool: string): Connector => ({
  id, tool, name: tool, account: '', status: 'connected', error: '', auth_mode: 'token', config: {}, secret_hints: {}, direction: 'both',
  interval: 0, tools: [], tools_at: null, last_tested_at: null, last_sync_at: null, available: true, created_at: '', updated_at: '',
})

describe('渠道配置的纯函数', () => {
  it('只列 IM 类，按定义顺序；能接入的是还没接过的，Slack、Telegram 在前', () => {
    const defs = [def('lark'), def('gdrive', 'docs'), def('telegram'), def('slack')]
    const list = [conn('cn_1', 'slack'), conn('cn_2', 'gdrive'), conn('cn_3', 'lark')]
    expect(imConnectors(defs, list).map((c) => c.id)).toEqual(['cn_3', 'cn_1'])
    expect(addableDefs(defs, list).map((d) => d.tool)).toEqual(['telegram'])
    expect(addableDefs(defs, []).map((d) => d.tool)).toEqual(['slack', 'telegram', 'lark'])
  })

  it('Slack Token 和 Member ID 的校验', () => {
    expect(slackTokenError('', false)).toBe('必填')
    expect(slackTokenError('', true)).toBeUndefined()
    expect(slackTokenError('xoxp-123', false)).toMatch(/用户 Token/)
    expect(slackTokenError('abc', false)).toMatch(/xoxb-/)
    expect(slackTokenError(' xoxb-1-2 ', false)).toBeUndefined()
    expect(memberIdError('')).toBeUndefined()
    expect(memberIdError('U01ABCDEF')).toBeUndefined()
    expect(memberIdError('@lin')).toMatch(/Member ID/)
  })

  it('同步结果和回调地址', () => {
    expect(syncText({ connector_id: 'cn', adapter: 'slack', ids: ['a', 'b'], duplicates: 0 })).toBe('收到 2 条新消息')
    expect(syncText({ connector_id: 'cn', adapter: 'slack', ids: [], duplicates: 3 })).toMatch(/都收过了/)
    expect(callbackUrl('slack', 'https://bro.vip')).toBe('https://bro.vip/api/im/callbacks/slack')
  })
})
