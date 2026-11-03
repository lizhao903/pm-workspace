import { describe, expect, it } from 'vitest'
import { describeSource, sessionSourceRegistry, sessionSourceStore } from './sessionSources'

describe('会话来源', () => {
  it('按 kind 找登记的；没人认时只显示 label；没有来源为 null；插件停用后撤掉', () => {
    const d = sessionSourceRegistry('im').register({ kind: 'im_message', describe: (r) => ({ label: `消息 ${String(r.message_id)}`, to: '/messages?m=x' }) })
    expect(() => sessionSourceRegistry('other').register({ kind: 'im_message', describe: () => null })).toThrow()
    expect(describeSource(sessionSourceStore.list(), { kind: 'im_message', message_id: 'm1' })).toEqual({ label: '消息 m1', to: '/messages?m=x' })
    expect(describeSource(sessionSourceStore.list(), { kind: 'mail', label: '一封邮件' })).toEqual({ label: '一封邮件', to: '' })
    expect(describeSource(sessionSourceStore.list(), null)).toBeNull()
    sessionSourceStore.removeOwner('im')
    expect(describeSource(sessionSourceStore.list(), { kind: 'im_message', label: 'L' })).toEqual({ label: 'L', to: '' })
    d.dispose()
  })
})
