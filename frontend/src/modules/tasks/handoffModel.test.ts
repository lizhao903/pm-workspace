import { describe, expect, it } from 'vitest'
import type { TaskRun } from '../../core/data'
import {
  NO_PRESET, TERMINAL_OFF_HINT, defaultWorkdir, effectiveAllow, launchFailSummary, modeHint, pickedPreset, roleOptionLabel, runRequest, runningOf, submitLabel, terminalRequest,
} from './handoffModel'
import type { LiveRun } from './runLive'

const row = (p: Partial<TaskRun>) => ({ id: 'run_1', status: 'done', ...p }) as TaskRun
const live = (p: Partial<LiveRun>): LiveRun => ({ key: 'live-1', objectId: 'obj_1', phase: 'streaming', events: [], errors: [], ...p })

describe('交给 Claude Code', () => {
  it('工作目录：任务上设的优先，没设用项目的，都没有为空', () => {
    expect(defaultWorkdir(' /a ', '/p')).toEqual({ dir: '/a', from: 'task' })
    expect(defaultWorkdir('', '/p')).toEqual({ dir: '/p', from: 'project' })
    expect(defaultWorkdir('  ')).toEqual({ dir: '', from: '' })
  })

  it('请求体只有三个字段，去掉首尾空白', () => {
    const r = runRequest(' /w ', ' 只读 a.txt ', false)
    expect(Object.keys(r).sort()).toEqual(['allow_writes', 'extra_prompt', 'workdir'])
    expect(r).toEqual({ workdir: '/w', extra_prompt: '只读 a.txt', allow_writes: false })
  })

  it('选了预置提示词时请求体带 preset_id，没选不带（SPEC-tasks-6.18）', () => {
    expect(runRequest('/w', '', true, 'rp_pm')).toEqual({ workdir: '/w', extra_prompt: '', allow_writes: true, preset_id: 'rp_pm' })
    expect(terminalRequest('/w', '', 'rp_pm')).toEqual({ workdir: '/w', extra_prompt: '', preset_id: 'rp_pm' })
    expect(terminalRequest('/w', '', NO_PRESET)).toEqual({ workdir: '/w', extra_prompt: '' })
  })

  it('选中的预置提示词：选过的优先，选的被删了算不用；没选过取默认，没有默认为不用', () => {
    const list = [{ id: 'rp_a', scene: 'A', content: 'a', default: false }, { id: 'rp_b', scene: 'B', content: 'b', default: true }]
    expect(pickedPreset(list, null)).toBe('rp_b')
    expect(pickedPreset(list, 'rp_a')).toBe('rp_a')
    expect(pickedPreset(list, NO_PRESET)).toBe(NO_PRESET)
    expect(pickedPreset(list, 'rp_gone')).toBe(NO_PRESET)
    expect(pickedPreset([list[0]], null)).toBe(NO_PRESET)
    expect(pickedPreset(undefined, null)).toBe(NO_PRESET)
  })

  it('允许写入跟着角色走：只读角色锁住；允许改文件的默认勾上，用户能取消；没选角色默认只读（AUTO-03）', () => {
    const ro = { id: 'r', scene: '研发评审', content: 'x', default: false, permission: 'read_only' as const }
    const rw = { id: 'w', scene: '研发', content: 'x', default: false }
    expect(effectiveAllow(ro, true)).toEqual({ allow: false, locked: true })
    expect(effectiveAllow(rw, null)).toEqual({ allow: true, locked: false })
    expect(effectiveAllow(rw, false)).toEqual({ allow: false, locked: false })
    expect(effectiveAllow(undefined, null)).toEqual({ allow: false, locked: false })
    expect(effectiveAllow(undefined, true)).toEqual({ allow: true, locked: false })
    expect(roleOptionLabel({ ...ro, default: true })).toBe('研发评审（只读）（默认）')
    expect(roleOptionLabel(rw)).toBe('研发')
  })

  it('运行中：记录里没收尾的优先，其次本页还在跑的流', () => {
    expect(runningOf('obj_1', [row({ status: 'done' })], [])).toBeUndefined()
    expect(runningOf('obj_1', [row({ id: 'run_9', status: 'running' })], [])).toBe('run_9')
    expect(runningOf('obj_1', [], [live({ phase: 'starting' })])).toBe('')
    expect(runningOf('obj_1', [], [live({ runId: 'run_2' })])).toBe('run_2')
    expect(runningOf('obj_1', [], [live({ phase: 'done', runId: 'run_2' })])).toBeUndefined()
    expect(runningOf('obj_1', [], [live({ objectId: 'obj_2' })])).toBeUndefined()
  })

  it('两种方式：按钮文案、说明、终端请求体没有 allow_writes', () => {
    expect(submitLabel('stream', { typing: false, allow: false, busy: false })).toBe('开始执行（只读）')
    expect(submitLabel('stream', { typing: false, allow: true, busy: false })).toBe('开始执行（允许写入）')
    expect(submitLabel('terminal', { typing: false, allow: true, busy: false })).toBe('在终端中打开')
    expect(submitLabel('terminal', { typing: false, allow: false, busy: true })).toBe('正在打开终端')
    expect(submitLabel('terminal', { typing: true, allow: false, busy: false })).toBe('正在校验目录')
    expect(modeHint('terminal', false)).toBe(TERMINAL_OFF_HINT)
    expect(modeHint('terminal', true)).toContain('MCP 回写')
    expect(terminalRequest(' /w ', ' 只改文档 ')).toEqual({ workdir: '/w', extra_prompt: '只改文档' })
    expect(launchFailSummary('x')).toBe('终端没打开：x')
  })
})
