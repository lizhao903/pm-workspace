// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { describe, expect, it } from 'vitest'
import type { RunnerSmoke, RunnerStatus } from '../../../core/data'
import { fmtMs, runnerState, smokeSummary } from './runnersModel'

describe('执行器页的纯函数（TSK-0722）', () => {
  it('用时：不到 0.1 秒不写', () => {
    expect(fmtMs(0)).toBe('')
    expect(fmtMs(40)).toBe('')
    expect(fmtMs(2070)).toBe('2.1 秒')
    expect(fmtMs(183534)).toBe('3 分 4 秒')
  })
  it('状态：不可用 / 有提示 / 可用', () => {
    const st = { available: true, problems: [] } as unknown as RunnerStatus
    expect(runnerState(st).text).toBe('可用')
    expect(runnerState({ ...st, problems: [{ code: 'no_mcp', blocking: false }] } as unknown as RunnerStatus).text).toBe('可用，有提示')
    expect(runnerState({ ...st, available: false } as RunnerStatus).tone).toBe('bad')
  })
  it('一句话结论', () => {
    const c = (status: string) => ({ key: status, label: status, status, detail: '', ms: 0 })
    expect(smokeSummary({ status: 'running', checks: [c('pass'), c('running'), c('pending')] } as unknown as RunnerSmoke)).toBe('检查中：1 / 3 项有结果')
    expect(smokeSummary({ status: 'passed', checks: [c('pass'), c('pass')] } as unknown as RunnerSmoke)).toBe('全部 2 项通过')
    expect(smokeSummary({ status: 'failed', checks: [c('pass'), c('fail')] } as unknown as RunnerSmoke)).toBe('1 项没通过：fail')
  })
})
