// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { describe, expect, it } from 'vitest'
import type { Connector, Skill } from '../../../core/data'
import {
  agentNames, connectorToolOptions, copyForm, createBody, deleteText, filterSkills, formOf, groupOf, missingOf, patchBody, pickedTools,
  withPicked,
} from './model'

const sk = (p: Partial<Skill> & { id: string }): Skill => ({
  name: p.id, desc: '', source: 'custom', uses: [], instructions: 'x', when: '', agents: [], ...p,
})

const conn = (p: Partial<Connector> & { id: string; name: string }): Connector => ({
  tool: 'fake', account: '', status: 'connected', error: '', auth_mode: 'token', config: {}, secret_hints: {}, direction: 'both',
  interval: 0, tools: [], tools_at: null, last_tested_at: null, last_sync_at: null, available: true, ...p,
} as Connector)

describe('技能页的纯函数', () => {
  it('来源分组：builtin、custom 以外的都是插件', () => {
    expect(groupOf({ source: 'builtin' })).toBe('builtin')
    expect(groupOf({ source: 'custom' })).toBe('custom')
    expect(groupOf({ source: 'video' })).toBe('plugin')
  })

  it('按来源和关键词筛：名称、说明、用到的工具都能搜，不分大小写', () => {
    const list = [
      sk({ id: 'a', name: '写周报', source: 'builtin', uses: ['查任务'] }),
      sk({ id: 'b', name: '业务数据查询', desc: 'PostgreSQL 只读' }),
      sk({ id: 'c', name: '剪视频', source: 'video' }),
    ]
    expect(filterSkills(list, '', '').map((s) => s.id)).toEqual(['a', 'b', 'c'])
    expect(filterSkills(list, 'builtin', '').map((s) => s.id)).toEqual(['a'])
    expect(filterSkills(list, 'plugin', '').map((s) => s.id)).toEqual(['c'])
    expect(filterSkills(list, '', 'postgresql').map((s) => s.id)).toEqual(['b'])
    expect(filterSkills(list, '', '查任务').map((s) => s.id)).toEqual(['a'])
    expect(filterSkills(list, 'custom', '查任务')).toEqual([])
  })

  it('连接器工具选项：只要开着的工具，暂停、断开的连接器不算，按连接器分组', () => {
    const opts = connectorToolOptions([
      conn({ id: 'c1', name: 'GitHub', tools: [{ name: 'list_issues', desc: '', write: false, mode: 'auto' }, { name: 'merge', desc: '', write: true, mode: 'off' }] }),
      conn({ id: 'c2', name: 'Jira', status: 'paused', tools: [{ name: 'search', desc: '', write: false, mode: 'auto' }] }),
      conn({ id: 'c3', name: 'Binance', tools: [{ name: 'ticker', desc: '', write: false, mode: 'confirm' }] }),
    ])
    expect(opts.map((o) => [o.group, o.value])).toEqual([['Binance', 'Binance · ticker'], ['GitHub', 'GitHub · list_issues']])
    expect(opts[0].label).toBe('ticker')
  })

  it('内置工具和其余的工具分开；换其余部分时内置勾选保留', () => {
    const uses = ['查任务', 'GitHub · list_issues', '写文档', 'B 站']
    expect(pickedTools(uses)).toEqual(['GitHub · list_issues', 'B 站'])
    expect(withPicked(uses, ['B 站'])).toEqual(['查任务', '写文档', 'B 站'])
  })

  it('复制：内容照搬，名称加「（我的）」；创建带 copy_from', () => {
    const src = sk({ id: 'sk_weekly', name: '写周报', source: 'builtin', desc: '按项目归类', uses: ['查任务'], instructions: '步骤', when: '周五' })
    const f = copyForm(src)
    expect(f).toEqual({ name: '写周报（我的）', desc: '按项目归类', when: '周五', instructions: '步骤', uses: ['查任务'] })
    expect(createBody(f, 'sk_weekly')).toEqual({ ...f, copy_from: 'sk_weekly' })
    expect(createBody({ ...f, name: '  x  ' })).not.toHaveProperty('copy_from')
  })

  it('必填：名称和怎么做；修改只带改了的字段', () => {
    expect(missingOf({ name: ' ', desc: '', when: '', instructions: '', uses: [] })).toEqual({ name: true, instructions: true })
    const s = sk({ id: 'sk_1', name: 'a', uses: ['查任务'] })
    expect(patchBody(formOf(s), s)).toEqual({})
    expect(patchBody({ ...formOf(s), name: ' b ', uses: ['查任务', '写文档'] }, s)).toEqual({ name: 'b', uses: ['查任务', '写文档'] })
  })

  it('删除确认的文案：有 Agent 挂着就点名，多于三个收成「等 N 个」', () => {
    expect(deleteText([])).toBe('删除后不能恢复')
    expect(deleteText([{ name: '甲' }, { name: '乙' }])).toBe('甲、乙 挂着它，删除后会自动卸下')
    expect(agentNames([{ name: '1' }, { name: '2' }, { name: '3' }, { name: '4' }])).toBe('1、2、3 等 4 个 Agent')
  })
})
