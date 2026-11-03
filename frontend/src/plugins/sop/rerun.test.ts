import { describe, expect, it } from 'vitest'
import { defaultRerun, rerunNote, staleRuns } from './rerun'

describe('批量重跑', () => {
  it('流程发起后改过的才算旧版本，删了的流程不算', () => {
    const flows = [{ id: 'a', version: 3 }, { id: 'b', version: 1 }]
    const runs = [{ flow_id: 'a', flow_version: 2 }, { flow_id: 'a', flow_version: 3 }, { flow_id: 'b', flow_version: 1 }, { flow_id: 'gone', flow_version: 1 }]
    expect(staleRuns(runs, flows)).toEqual([{ flow_id: 'a', flow_version: 2 }])
    expect(defaultRerun(1)).toBe('relaunch')
    expect(defaultRerun(0)).toBe('retry')
  })

  it('结果一行', () => {
    expect(rerunNote('retry', { done: [{ run_id: 'r1' }, { run_id: 'r2' }], skipped: [], failed: [] }))
      .toEqual({ text: '重试了 2 条。要调模型的步骤按同时调模型的上限排队，排到了自动开始', bad: false })
    const n = rerunNote('relaunch', {
      done: [{ run_id: 'r1', new_run_id: 'n1' }],
      skipped: [{ run_id: 'r2', reason: '不是失败状态（执行中）' }],
      failed: [{ run_id: 'r3', error: '流程「周会」已删除' }],
    })
    expect(n.text).toBe('新发起 1 条、跳过 1 条、失败 1 条。要调模型的步骤按同时调模型的上限排队，排到了自动开始。原因：流程「周会」已删除；不是失败状态（执行中）')
    expect(n.bad).toBe(true)
    expect(rerunNote('retry', { done: [], skipped: [{ run_id: 'x', reason: '执行不存在' }], failed: [] }))
      .toEqual({ text: '重试了 0 条、跳过 1 条。原因：执行不存在', bad: true })
    // 重复点击被幂等挡掉的不标红
    expect(rerunNote('relaunch', { done: [], skipped: [{ run_id: 'x', reason: '已重跑过', new_run_id: 'n' }], failed: [] }))
      .toEqual({ text: '新发起 0 条、跳过 1 条。原因：已重跑过', bad: false })
  })
})
