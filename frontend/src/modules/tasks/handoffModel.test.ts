import { describe, expect, it } from 'vitest'
import type { TaskRun } from '../../core/data'
import { TERMINAL_OFF_HINT, defaultWorkdir, launchFailSummary, modeHint, runRequest, runningOf, submitLabel, terminalRequest } from './handoffModel'
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
