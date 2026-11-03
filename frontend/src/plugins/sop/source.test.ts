import { describe, expect, it } from 'vitest'
import { sourceText, type NameOf } from './source'

const names: NameOf = (kind, id) => (kind === 'agent' && id === 'ag_1' ? '分诊助手（改名后）' : kind === 'schedule' && id === 'sch_1' ? '周一例会' : undefined)

describe('执行的发起来源（SOP-06）', () => {
  it('各来源的文字；Agent、定时任务现查名字，查不到用记下的名字，再没有用 id', () => {
    expect(sourceText({ source: 'manual' }, names)).toBe('手动')
    expect(sourceText({ source: 'manual', source_ref: 'spr_1', source_name: '批量重跑' }, names)).toBe('手动（批量重跑）')
    expect(sourceText({ source: 'agent', source_ref: 'ag_1', source_name: '分诊助手' }, names)).toBe('Agent：分诊助手（改名后）')
    expect(sourceText({ source: 'agent', source_ref: 'ag_gone', source_name: '旧助手' }, names)).toBe('Agent：旧助手')
    expect(sourceText({ source: 'agent', source_ref: 'ag_gone' }, names)).toBe('Agent：ag_gone')
    expect(sourceText({ source: 'agent' }, names)).toBe('Agent')
    expect(sourceText({ source: 'schedule', source_ref: 'sch_1', source_name: '旧名' }, names)).toBe('定时：周一例会')
    expect(sourceText({ source: 'schedule' }, names)).toBe('定时')
    expect(sourceText({ source: 'im', source_ref: 'msg_1' }, names)).toBe('IM 消息')
    expect(sourceText({ source: 'subflow', source_ref: 'spr_1', source_name: '父流程 · 周报' }, names)).toBe('子流程')
    expect(sourceText({ source: 'plugin', source_ref: 'video', source_name: 'video' }, names)).toBe('插件：video')
    // 以前的执行没有来源，不显示
    expect(sourceText({ source: '' }, names)).toBe('')
    expect(sourceText({}, names)).toBe('')
  })
})
