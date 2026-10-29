import { describe, expect, it } from 'vitest'
import type { Connector, ConnectorDef } from '../../../core/data'
import {
  bulkModes, createBody, fieldOn, initialDraft, missingFields, modesFor, needsRetest, nextName, notReady, oauthLack, oauthReturnTo, oauthState, patchBody,
  pruneModes, refreshNote, rowSummary, tokenPreview,
} from './model'
import { oauthResult } from './oauth'

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

  it('OAuth 还没授权，没就绪；定义不在了也没就绪', () => {
    const c = conn()
    expect(notReady(def, initialDraft(def, c), c)).toBe('')
    expect(notReady({ ...def, auth: ['oauth2', 'token'] }, { ...initialDraft(def, c), authMode: 'oauth2' }, c)).toBe('还没完成 OAuth 授权')
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

// 自定义 MCP 的定义（同后端 connector.CustomMCP 的字段），CONN-04
const mcp: ConnectorDef = {
  tool: 'custom_mcp', label: 'MCP 服务', category: 'custom', color: '#7a4fd6', desc: '', can_send: false, auth: ['none', 'oauth2', 'token'], source: 'core',
  fields: [
    { key: 'url', label: '服务地址', kind: 'text', required: true },
    { key: 'transport', label: '传输方式', kind: 'select', options: ['Streamable HTTP', 'SSE'], default: 'Streamable HTTP', required: true },
    { key: 'token', label: 'Token', kind: 'secret', required: true, auth: ['token'] },
    { key: 'token_header', label: '请求头', kind: 'text', default: 'Authorization', required: false, auth: ['token'] },
    { key: 'token_prefix', label: '前缀', kind: 'text', default: 'Bearer', required: false, auth: ['token'] },
    { key: 'oauth_client_id', label: 'Client ID', kind: 'text', required: true, auth: ['oauth2'] },
  ],
  tools: [],
}

describe('自定义连接器（CONN-04）', () => {
  it('默认名称按已有实例加序号，字段取默认值', () => {
    expect(nextName('MCP 服务', [])).toBe('MCP 服务')
    expect(nextName('MCP 服务', ['MCP 服务', 'MCP 服务 2'])).toBe('MCP 服务 3')
    const d = initialDraft(mcp, undefined, ['MCP 服务'])
    expect(d.name).toBe('MCP 服务 2')
    expect(d.config).toMatchObject({ transport: 'Streamable HTTP', token_header: 'Authorization', token_prefix: 'Bearer' })
  })

  it('必填只算当前认证方式的字段', () => {
    const d = { ...initialDraft(mcp), config: { ...initialDraft(mcp).config, url: 'http://127.0.0.1:9/mcp' } }
    expect(missingFields(mcp, d)).toEqual([])
    expect(missingFields(mcp, { ...d, authMode: 'token' })).toEqual(['token'])
    expect(missingFields(mcp, { ...d, authMode: 'oauth2' })).toEqual(['oauth_client_id'])
    expect(fieldOn(mcp.fields[2], 'none')).toBe(false)
    expect(fieldOn(mcp.fields[0], 'none')).toBe(true)
  })

  it('图标改了才带；改了地址、认证、凭证要提示重测', () => {
    const c = conn({ tool: 'custom_mcp', name: 'MCP 服务', auth_mode: 'none', config: { url: 'http://a/mcp', transport: 'SSE' }, secret_hints: {} })
    const d = initialDraft(mcp, c)
    expect(patchBody(mcp, d, c)).toEqual({})
    expect(patchBody(mcp, { ...d, icon: 'data:image/png;base64,AA' }, c)).toEqual({ icon: 'data:image/png;base64,AA' })
    expect(createBody(mcp, { ...initialDraft(mcp), icon: 'data:image/png;base64,AA' }).icon).toBe('data:image/png;base64,AA')
    expect(needsRetest({ icon: 'x', name: 'y' })).toBe(false)
    expect(needsRetest({ config: { url: 'http://b/mcp' } })).toBe(true)
    expect(needsRetest({ auth_mode: 'token' })).toBe(true)
    expect(needsRetest({ secrets: { token: 't' } })).toBe(true)
  })

  it('Token 预览：请求头加前缀，前缀空就只发 Token，放查询参数时写参数名', () => {
    const d = { ...initialDraft(mcp), authMode: 'token' as const }
    expect(tokenPreview(mcp, d)).toBe('请求时带上：Authorization: Bearer ••••••')
    expect(tokenPreview(mcp, { ...d, config: { ...d.config, token_header: 'X-API-Key', token_prefix: '' } })).toBe('请求时带上：X-API-Key: ••••••')
    expect(tokenPreview(mcp, { ...d, config: { ...d.config, token_header: 'api_key', token_in: '查询参数' } })).toBe('请求时带上查询参数：api_key=••••••')
    expect(tokenPreview(mcp, { ...d, authMode: 'none' })).toBe('')
    expect(tokenPreview(def, { ...initialDraft(def) })).toBe('')
  })
})

describe('OAuth 授权（CONN-04b）', () => {
  const oauthDef: ConnectorDef = {
    ...mcp, auth: ['oauth2', 'token'],
    fields: [
      ...mcp.fields,
      { key: 'oauth_auth_url', label: '授权地址', kind: 'text', required: true, auth: ['oauth2'] },
      { key: 'oauth_token_url', label: '令牌地址', kind: 'text', required: true, auth: ['oauth2'] },
    ],
    oauth: { auth_url: '', token_url: '', scopes: null, auth_url_field: 'oauth_auth_url', token_url_field: 'oauth_token_url', client_id_field: 'oauth_client_id', builtin: false },
  }
  const authed = { authorized_at: '2026-10-29T01:00:00Z', expires_at: '2026-12-29T01:00:00Z', refreshed_at: null, refresh_failed_at: null, scope: 'read' }
  const now = Date.parse('2026-10-30T00:00:00Z')

  it('授权状态：没授权、断开、认证方式不是 OAuth 都算没授权；刷新失败或过了到期时间算过期', () => {
    const c = conn({ tool: 'custom_mcp', auth_mode: 'oauth2', oauth: authed })
    expect(oauthState(undefined)).toBe('none')
    expect(oauthState(c, now)).toBe('ok')
    expect(oauthState({ ...c, auth_mode: 'token' }, now)).toBe('none')
    expect(oauthState({ ...c, status: 'disconnected' }, now)).toBe('none')
    expect(oauthState({ ...c, oauth: { ...authed, authorized_at: null } }, now)).toBe('none')
    expect(oauthState({ ...c, status: 'error', oauth: { ...authed, refresh_failed_at: '2026-10-29T02:00:00Z' } }, now)).toBe('expired')
    expect(oauthState(c, Date.parse('2027-01-01T00:00:00Z'))).toBe('expired')
  })

  it('没填 Client ID、授权地址时不能去授权，写明差什么；定义没有 OAuth 配置也不能', () => {
    const d = { ...initialDraft(oauthDef), authMode: 'oauth2' as const }
    d.config = { ...d.config, url: 'http://127.0.0.1:9/mcp' }
    expect(oauthLack(oauthDef, d)).toBe('先填 Client ID、授权地址、令牌地址，才能去授权')
    const full = { ...d, config: { ...d.config, oauth_client_id: 'cid', oauth_auth_url: 'http://127.0.0.1:9/a', oauth_token_url: 'http://127.0.0.1:9/t' } }
    expect(oauthLack(oauthDef, full)).toBe('')
    expect(oauthLack(oauthDef, { ...full, name: ' ' })).toBe('先填名称，才能去授权')
    expect(oauthLack({ ...oauthDef, oauth: null }, full)).toMatch('不支持')
    expect(oauthLack(oauthDef, full, conn({ available: false }))).toMatch('插件已停用')
  })

  it('回到哪：本机打开给完整地址，否则给站内路径；回调参数解出结果', () => {
    expect(oauthReturnTo({ origin: 'http://127.0.0.1:7789', hostname: '127.0.0.1' })).toBe('http://127.0.0.1:7789/settings/connectors')
    expect(oauthReturnTo({ origin: 'https://bro.vip', hostname: 'bro.vip' })).toBe('/settings/connectors')
    expect(oauthResult('')).toBeNull()
    expect(oauthResult('?oauth=ok&connector=cn_a&message=%E6%8E%88%E6%9D%83%E5%AE%8C%E6%88%90')).toEqual({ ok: true, connector: 'cn_a', message: '授权完成' })
    expect(oauthResult('?oauth=error&connector=cn_a')).toEqual({ ok: false, connector: 'cn_a', message: '' })
  })
})
