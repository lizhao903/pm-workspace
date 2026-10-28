import { describe, expect, it } from 'vitest'
import type { Connector, ConnectorDef } from '../../../core/data'
import { bulkModes, createBody, initialDraft, missingFields, modesFor, notReady, patchBody, pruneModes, refreshNote, rowSummary } from './model'

const def: ConnectorDef = {
  tool: 'fake', label: '测试连接器', category: 'dev', color: '#64748b', desc: '', can_send: false, auth: ['token'], source: 'core',
  fields: [
    { key: 'base_url', label: '服务地址', kind: 'text', required: false },
    { key: 'variant', label: '工具清单版本', kind: 'select', options: ['v1', 'v2'], required: false },
    { key: 'token', label: '访问令牌', kind: 'secret', required: true },
  ],
  tools: [],
}

function conn(p: Partial<Connector> = {}): Connector {
  return {
    id: 'cn_a', tool: 'fake', name: '测试连接器', account: '', status: 'connected', error: '', auth_mode: 'token', config: { variant: 'v1' },
    secret_hints: { token: 'tok…abcd' }, direction: 'receive', interval: 0, tools: [], tools_at: null, last_tested_at: null, last_sync_at: null,
    available: true, created_at: '', updated_at: '', ...p,
  }
}

describe('草稿和请求体', () => {
  it('新建：下拉默认第一项，名称默认工具名，空值和空白不带', () => {
    const d = initialDraft(def)
    expect(d.config).toEqual({ base_url: '', variant: 'v1' })
    expect(missingFields(def, d)).toEqual(['token'])
    expect(createBody(def, { ...d, secrets: { token: ' tok-1 ' } })).toEqual({
      tool: 'fake', name: '测试连接器', auth_mode: 'token', enabled: true, config: { variant: 'v1' }, secrets: { token: 'tok-1' },
    })
  })

  it('即时通讯类带方向和间隔；平台不能发时默认只收', () => {
    const im = { ...def, category: 'im', can_send: true }
    expect(initialDraft(im)).toMatchObject({ direction: 'both', interval: 5 })
    expect(initialDraft({ ...im, can_send: false }).direction).toBe('receive')
    expect(createBody(im, { ...initialDraft(im), secrets: { token: 'x' } })).toMatchObject({ direction: 'both', interval: 5 })
  })

  it('编辑：凭证已配过不算没填、空着不带；清空的 config 传空串；只带改了的', () => {
    const c = conn({ config: { base_url: 'https://a', variant: 'v1' } })
    const d = initialDraft(def, c)
    expect(d.secrets).toEqual({ token: '' })
    expect(missingFields(def, d, c)).toEqual([])
    expect(patchBody(def, d, c)).toEqual({})
    expect(patchBody(def, { ...d, config: { base_url: '', variant: 'v2' } }, c)).toEqual({ config: { base_url: '', variant: 'v2' } })
    expect(patchBody(def, { ...d, secrets: { token: 'new' }, enabled: false }, c)).toEqual({ secrets: { token: 'new' }, enabled: false })
    expect(initialDraft(def, conn({ status: 'paused' })).enabled).toBe(false)
  })

  it('OAuth 还没开放，没就绪；定义不在了也没就绪', () => {
    const c = conn()
    expect(notReady(def, initialDraft(def, c), c)).toBe('')
    expect(notReady({ ...def, auth: ['oauth2', 'token'] }, { ...initialDraft(def, c), authMode: 'oauth2' }, c)).toMatch('OAuth')
    expect(notReady(def, initialDraft(def), undefined)).toBe('还没填：访问令牌')
    expect(notReady(def, initialDraft(def, c), conn({ available: false }))).toMatch('插件已停用')
  })
})

describe('工具授权', () => {
  const tools = [
    { name: 'list', desc: '', write: false, mode: 'auto' as const },
    { name: 'create', desc: '', write: true, mode: 'confirm' as const },
  ]

  it('只读工具没有需确认', () => {
    expect(modesFor(tools[0])).toEqual(['off', 'auto'])
    expect(modesFor(tools[1])).toEqual(['off', 'confirm', 'auto'])
  })

  it('只留和后端不同、工具还在、合法的改动', () => {
    expect(pruneModes(tools, { list: 'auto', create: 'auto', gone: 'off' })).toEqual({ create: 'auto' })
    expect(pruneModes(tools, { list: 'confirm' })).toEqual({})
  })

  it('批量：推荐、只开只读、全部关闭', () => {
    expect(bulkModes(tools, 'recommended')).toEqual({})
    expect(bulkModes(tools, 'readonly')).toEqual({ create: 'off' })
    expect(bulkModes(tools, 'off')).toEqual({ list: 'off', create: 'off' })
  })

  it('拉取说明和行摘要', () => {
    const c = conn({ tools })
    expect(refreshNote(0, { added: ['list', 'create'], removed: [], connector: c })).toBe('发现 2 个工具：只读的默认自动，写操作默认需确认')
    expect(refreshNote(2, { added: ['x'], removed: ['y'], connector: c })).toBe('新增 1 个，移除 1 个，其余保留原来的权限')
    expect(rowSummary(def, conn({ tools: [tools[0], { ...tools[1], mode: 'off' }] }), 'Token')).toBe('Token · 1/2 个工具可用')
    expect(rowSummary({ ...def, category: 'im' }, conn({ direction: 'both' }), 'Token')).toBe('收发 · 未同步')
  })
})
