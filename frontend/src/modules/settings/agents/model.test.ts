// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { describe, expect, it } from 'vitest'
import type { Agent, AgentProvider, Connector } from '../../../core/data'
import {
  blankDraft, bulkGrants, bulkLevelOf, choiceKey, createBody, defaultChoice, draftChanged, draftOf, draftPatch, editorIssues, grantsBody, grantsEqual, hasAll, modeOptions,
  modelChoices, mountableConns, mountGrants, newGrants, normDir, shownMode, toolsOn, unmountGrants,
  triggerHasCondition, triggerSummary,
} from './model'

function prov(p: Partial<AgentProvider> & { id: string }): AgentProvider {
  return {
    name: p.id, kind: 'anthropic', base_url: '', model: '', enabled: true, is_default: false, api_key_masked: '', has_api_key: true,
    extra: {}, created_at: '2026-10-29T00:00:00Z', updated_at: '2026-10-29T00:00:00Z', ...p,
  }
}

const agent = (p: Partial<Agent> = {}): Agent => ({
  id: 'ag_1', name: '分诊', desc: '', color: '#0f8a8a', avatar: { kind: 'text', value: '' }, provider_id: 'apv_a', model: 'claude-haiku-5-5',
  instructions: '', skills: [], mcps: [], kbs: [], triggers: [{ kind: 'manual', detail: '' }], enabled: true,
  created_at: '2026-10-29T00:00:00Z', updated_at: '2026-10-29T00:00:00Z', ...p,
})

describe('模型可选项', () => {
  it('按服务商列：目录里的模型带上下文，默认模型排最前，Ollama 不要求 API Key', () => {
    const ms = modelChoices([
      prov({ id: 'apv_a', name: 'Anthropic', model: 'claude-sonnet-5-5' }),
      prov({ id: 'apv_o', name: '本机', kind: 'ollama', has_api_key: false, extra: { model_ids: 'qwen3:4b' } }),
    ])
    expect(ms.map((m) => [m.providerId, m.model, m.ok])).toEqual([
      ['apv_a', 'claude-sonnet-5-5', true], ['apv_a', 'claude-opus-5-5', true], ['apv_a', 'claude-haiku-5-5', true],
      ['apv_o', 'qwen3:4b', true],
    ])
    expect(ms[0]).toMatchObject({ label: 'Claude Sonnet 5.5', note: 'Anthropic · 200K 上下文', group: 'Anthropic' })
    expect(ms[3].note).toBe('本机')
  })

  it('测通了用实际返回的列表；停用、没配密钥、测试失败都标不可用并写原因', () => {
    const ok = { result: { ok: true, latency_ms: 1, message: '', models: ['m-1'] }, at: 0 }
    const bad = { result: { ok: false, latency_ms: 1, message: 'x' }, at: 0 }
    expect(modelChoices([prov({ id: 'p', kind: 'openai' })], { p: ok }).map((m) => m.model)).toEqual(['m-1'])
    const off = modelChoices([prov({ id: 'p', name: 'A', enabled: false })])[0]
    expect([off.ok, off.note]).toEqual([false, 'A 已停用'])
    expect(modelChoices([prov({ id: 'p', name: 'A', has_api_key: false })])[0].note).toBe('A 还没配 API Key')
    expect(modelChoices([prov({ id: 'p', name: 'A' })], { p: bad })[0].note).toBe('A 连接异常')
  })

  it('正在用的模型不在列表里也补上；服务商删了的单独列成不可用', () => {
    const ms = modelChoices([prov({ id: 'apv_a' })], {}, [
      { provider_id: 'apv_a', model: 'claude-old' }, { provider_id: 'apv_gone', model: 'gpt-5' },
    ])
    expect(ms.find((m) => m.model === 'claude-old')?.ok).toBe(true)
    expect(ms.find((m) => m.key === choiceKey('apv_gone', 'gpt-5'))).toMatchObject({ ok: false, note: '服务商已删除', group: '不可用' })
  })

  it('默认取第一个可用的，没有可用的取第一个', () => {
    const ms = modelChoices([prov({ id: 'a', enabled: false }), prov({ id: 'b' })])
    expect(defaultChoice(ms)?.providerId).toBe('b')
    expect(defaultChoice(modelChoices([prov({ id: 'a', enabled: false })]))?.providerId).toBe('a')
    expect(defaultChoice([])).toBeUndefined()
  })
})

describe('草稿', () => {
  it('什么都没填的新建不算改动；改了名称才算', () => {
    const b = blankDraft('#3d4fd6')
    expect(draftChanged(b, { ...b })).toBe(false)
    expect(draftChanged(b, { ...b, name: '  ' })).toBe(false)
    expect(draftChanged(b, { ...b, name: '新助手' })).toBe(true)
  })

  it('PATCH 只带改了的字段，名称去首尾空白比较', () => {
    const base = draftOf(agent())
    expect(draftPatch(base, { ...base, name: ' 分诊 ' })).toEqual({})
    expect(draftPatch(base, { ...base, provider_id: 'apv_b', model: 'gpt-5', kbs: ['kb_1'] })).toEqual({ provider_id: 'apv_b', model: 'gpt-5', kbs: ['kb_1'] })
  })

  it('新建没选模型时用默认的那个，名称去空白', () => {
    const fb = modelChoices([prov({ id: 'apv_a', model: 'claude-haiku-5-5' })])[0]
    expect(createBody({ ...blankDraft('#3d4fd6'), name: ' 新 ' }, fb)).toMatchObject({ name: '新', provider_id: 'apv_a', model: 'claude-haiku-5-5' })
    expect(createBody({ ...blankDraft('#3d4fd6'), name: 'x', provider_id: 'p', model: 'm' }, fb)).toMatchObject({ provider_id: 'p', model: 'm' })
  })
})

describe('问题汇总和显示', () => {
  it('名称没填、没选模型、模型不可用、连接器异常、触发没填条件', () => {
    const ms = modelChoices([prov({ id: 'p', enabled: false, name: 'A' })])
    const d = { ...blankDraft('#3d4fd6'), triggers: [{ kind: 'schedule', detail: '' }] }
    expect(editorIssues(d, undefined, ['GitHub'])).toEqual({
      basic: '名称还没填', model: '还没选模型', tools: 'GitHub 连接异常', triggers: '有触发方式没填条件',
    })
    expect(editorIssues({ ...d, name: 'a', triggers: [{ kind: 'manual', detail: '' }] }, ms[0]).model).toBe(`${ms[0].label} 当前不可用`)
  })

  it('任务触发总有条件（默认分配给它）；IM 选了连接器、会话或只看与我相关也算填了', () => {
    expect(triggerHasCondition({ kind: 'task', detail: '' })).toBe(true)
    expect(triggerHasCondition({ kind: 'im', detail: '' })).toBe(false)
    const m = { assigned: false, tags: [], connector_id: '', channel: '', conversation_id: '', only_me: true }
    expect(triggerHasCondition({ kind: 'im', detail: '', match: m })).toBe(true)
    expect(triggerHasCondition({ kind: 'schedule', detail: '每周五' })).toBe(true)
  })

  it('卡片底部：手动写「手动」，其余写条件，没条件写类型名', () => {
    expect(triggerSummary([{ kind: 'manual', detail: '' }, { kind: 'im', detail: '飞书群' }, { kind: 'task', detail: '' }])).toBe('手动 · 飞书群 · 任务分配给它')
  })

  it('搜索：空格隔开的词都要命中；目录要绝对路径，去掉末尾斜杠', () => {
    expect(hasAll('消息分诊助手 先确认是谁', '分诊 确认')).toBe(true)
    expect(hasAll('消息分诊助手', '分诊 周报')).toBe(false)
    expect(normDir(' /a/b/ ')).toEqual({ dir: '/a/b', error: '' })
    expect(normDir('a/b').error).toBe('填绝对路径，以 / 开头')
    expect(normDir('/')).toEqual({ dir: '/', error: '' })
  })
})

describe('工具与权限（SPEC-settings-9.15 到 9.20）', () => {
  const conn = (p: Partial<Connector> & { id: string }): Connector => ({
    tool: 'github', name: p.id, account: '', status: 'connected', error: '', auth_mode: 'token', config: {}, secret_hints: {}, direction: 'both',
    interval: 5, tools: [], tools_at: '2026-10-29T00:00:00Z', last_tested_at: null, last_sync_at: null, available: true, created_at: '', updated_at: '', ...p,
  })
  const gh = conn({
    id: 'cn_1', name: '公司 GitHub', tools: [
      { name: 'list_issues', desc: '列 issue', write: false, mode: 'auto' },
      { name: 'create_issue', desc: '建 issue', write: true, mode: 'confirm' },
      { name: 'delete_repo', desc: '删仓库', write: true, mode: 'off' },
    ],
  })

  it('只读没有需确认；连接器上限为需确认的写工具选不到自动', () => {
    expect(modeOptions(false)).toEqual(['off', 'auto'])
    expect(modeOptions(true)).toEqual(['off', 'confirm', 'auto'])
    expect(modeOptions(true, 'confirm')).toEqual(['off', 'confirm'])
    expect(modeOptions(false, 'off')).toEqual(['off'])
    // 存着的超过上限：按能选的最高档显示
    expect(shownMode('auto', modeOptions(true, 'confirm'))).toBe('confirm')
    expect(shownMode(undefined, modeOptions(true))).toBe('off')
  })

  it('可挂的连接器：关掉的工具不列；没拉过清单、暂停、断开、定义不在的不能新挂', () => {
    const { all, mountable } = mountableConns([
      gh, conn({ id: 'cn_2', tools_at: null }), conn({ id: 'cn_3', status: 'paused' }), conn({ id: 'cn_4', available: false }),
      conn({ id: 'cn_5', status: 'error' }),
    ], (t) => (t === 'github' ? 'GitHub' : t))
    expect(all[0]).toMatchObject({ kind: 'GitHub', ok: true })
    expect(all[0].tools.map((t) => [t.key, t.cap])).toEqual([['conn:cn_1:list_issues', 'auto'], ['conn:cn_1:create_issue', 'confirm']])
    expect([...mountable]).toEqual(['cn_1', 'cn_5'])
    expect(all[4].ok).toBe(false)
  })

  it('挂上时只读默认自动、写默认关闭，配过的保留；卸下清掉 conn:<id>:*', () => {
    const c = mountableConns([gh], (t) => t).all[0]
    const g = mountGrants({ ...newGrants(), 'conn:cn_1:create_issue': 'confirm' }, c)
    expect(g['conn:cn_1:list_issues']).toBe('auto')
    expect(g['conn:cn_1:create_issue']).toBe('confirm')
    expect(toolsOn(g, [c])).toBe(4)
    const off = unmountGrants({ ...g, 'conn:cn_10:x': 'auto' }, 'cn_1')
    expect(Object.keys(off).filter((k) => k.startsWith('conn:'))).toEqual(['conn:cn_10:x'])
  })

  it('发给后端的只带开着的、还在清单里的；比较按开着的比', () => {
    const c = mountableConns([gh], (t) => t).all[0]
    const body = grantsBody({ ...newGrants(), write_tasks: 'confirm', 'conn:cn_1:list_issues': 'auto', 'conn:cn_1:gone': 'auto', 'conn:cn_1:delete_repo': 'auto' }, [c])
    expect(body).toEqual({ read_tasks: 'auto', read_contacts: 'auto', write_tasks: 'confirm', 'conn:cn_1:list_issues': 'auto' })
    expect(grantsEqual(newGrants(), { read_tasks: 'auto', read_contacts: 'auto' })).toBe(true)
    expect(grantsEqual(newGrants(), { read_tasks: 'auto' })).toBe(false)
  })
})

describe('一键全量设置权限', () => {
  const tools = [
    { key: 'c:read', write: false },
    { key: 'c:write', write: true },
    // 连接器那边要求写操作必须确认
    { key: 'c:send', write: true, cap: 'confirm' as const },
    // 连接器那边关掉了
    { key: 'c:drop', write: true, cap: 'off' as const },
  ]
  it('每一档按读写分别定，再压到工具自己的上限', () => {
    expect(bulkGrants(tools, 'off')).toEqual({ 'c:read': 'off', 'c:write': 'off', 'c:send': 'off', 'c:drop': 'off' })
    expect(bulkGrants(tools, 'read')).toEqual({ 'c:read': 'auto', 'c:write': 'off', 'c:send': 'off', 'c:drop': 'off' })
    expect(bulkGrants(tools, 'rw_confirm')).toEqual({ 'c:read': 'auto', 'c:write': 'confirm', 'c:send': 'confirm', 'c:drop': 'off' })
    expect(bulkGrants(tools, 'rw_auto')).toEqual({ 'c:read': 'auto', 'c:write': 'auto', 'c:send': 'confirm', 'c:drop': 'off' })
  })
  it('认出现在是哪一档，对不上是自定义', () => {
    expect(bulkLevelOf(tools, bulkGrants(tools, 'rw_auto'))).toBe('rw_auto')
    expect(bulkLevelOf(tools, bulkGrants(tools, 'read'))).toBe('read')
    expect(bulkLevelOf(tools, {})).toBe('off')
    expect(bulkLevelOf(tools, { ...bulkGrants(tools, 'read'), 'c:write': 'confirm' })).toBeNull()
    expect(bulkLevelOf([], {})).toBeNull()
  })
})
