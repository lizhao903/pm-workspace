import { describe, expect, it } from 'vitest'
import { currentTab, isDevTask, tabParams, visibleTabs, wantedTab, withTab, withoutTabParams, type DevSigns } from './drawerTabs'

const sop = [{ key: 'sop', focusParam: 'sop_run' }]
const q = (s: string) => new URLSearchParams(s)
const none: DevSigns = { acceptance: '', workdir: '', repo: '', opened: false, reviewing: false, progress: 0, artifacts: 0, runs: 0 }

describe('任务详情标签', () => {
  it('地址要的标签：?tab= 优先，其次 ?run= 去执行记录、插件的定位参数去插件标签', () => {
    expect(wantedTab(q('tab=dev&run=r1'), sop)).toBe('dev')
    expect(wantedTab(q('run=r1'), sop)).toBe('runs')
    expect(wantedTab(q('sop_run=s1'), sop)).toBe('sop')
    expect(wantedTab(q('sop_run=s1'), [])).toBeNull()
    expect(wantedTab(q('status=all'), sop)).toBeNull()
  })

  it('什么算开发任务：开发字段、点了设为开发任务、待验收、有进展产出物执行记录之一', () => {
    expect(isDevTask(none)).toBe(false)
    expect(isDevTask({ ...none, acceptance: '  ' })).toBe(false)
    for (const p of [{ acceptance: '- [ ] a' }, { workdir: '/w' }, { repo: 'r' }, { opened: true }, { reviewing: true }, { progress: 1 }, { artifacts: 2 }, { runs: 1 }]) {
      expect(isDevTask({ ...none, ...p })).toBe(true)
    }
  })

  it('标签条：基础信息、开发任务、插件、执行记录；不是开发任务时只有基础信息和插件，地址明说要的照样显示', () => {
    expect(visibleTabs(true, sop, null)).toEqual(['info', 'dev', 'sop', 'runs'])
    expect(visibleTabs(false, sop, null)).toEqual(['info', 'sop'])
    expect(visibleTabs(false, [], null)).toEqual(['info'])
    expect(visibleTabs(false, [], 'runs')).toEqual(['info', 'dev', 'runs'])
    expect(visibleTabs(false, [], 'dev')).toEqual(['info', 'dev', 'runs'])
  })

  it('停在哪个标签：要的不在标签条里回默认，默认也不在时回基础信息', () => {
    expect(currentTab('sop', ['info', 'sop'], 'info')).toBe('sop')
    expect(currentTab('sop', ['info'], 'info')).toBe('info')
    expect(currentTab(null, ['info', 'dev', 'runs'], 'dev')).toBe('dev')
    expect(currentTab(null, ['info'], 'dev')).toBe('info')
  })

  it('切标签去掉定位参数，关抽屉全去掉，别的参数不动', () => {
    expect(tabParams(sop)).toEqual(['tab', 'run', 'sop_run'])
    expect(withTab(q('t=o1&status=all&run=r1&sop_run=s1'), 'info', sop).toString()).toBe('t=o1&status=all&tab=info')
    expect(withoutTabParams(q('status=all&tab=runs&run=r1'), sop).toString()).toBe('status=all')
  })
})
