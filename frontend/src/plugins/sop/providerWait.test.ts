// 等服务商恢复的步骤（TSK-0392，SPEC-sop-7.50）：仍是 running，带 provider_wait 时显示「等服务商恢复」。
import { describe, expect, it } from 'vitest'
import { PROVIDER_WAIT_LOOK, QUEUED_LOOK, runStepLook } from './model'

const wait = { provider_id: 'apv_1', provider: 'NewAPI', reason: '模型服务异常（HTTP 503）', since: '2026-11-02T06:42:00Z', retry_at: '2026-11-02T06:43:00Z' }

describe('等服务商恢复', () => {
  it('running 带 provider_wait 显示等服务商恢复，优先于排队', () => {
    expect(runStepLook({ status: 'running', provider_wait: wait })).toBe(PROVIDER_WAIT_LOOK)
    expect(runStepLook({ status: 'running', provider_wait: wait, queue: { ahead: 1 } })).toBe(PROVIDER_WAIT_LOOK)
    expect(runStepLook({ status: 'running', queue: { ahead: 1 } })).toBe(QUEUED_LOOK)
  })
  it('不在执行中的不算', () => {
    expect(runStepLook({ status: 'pending', provider_wait: wait }).label).toBe('未开始')
    expect(PROVIDER_WAIT_LOOK.label).toBe('等服务商恢复')
  })
})
