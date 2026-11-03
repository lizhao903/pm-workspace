import { describe, expect, it } from 'vitest'
import { isSopRunRelaunched, sopRunShow, type SopRunBrief } from './sop'
import { applyRerun } from './sopBatch'

type Row = Pick<SopRunBrief, 'id' | 'status' | 'relaunched_to' | 'steps'>
const row = (id: string, status: SopRunBrief['status']): Row => ({ id, status, steps: [{ key: 'ai', name: 'AI', kind: 'ai', status: status === 'failed' ? 'failed' : 'done' }] })

describe('重跑结果写进缓存', () => {
  it('relaunch：新起了的和已重跑过的记上 relaunched_to；retry：重试上的变执行中；别的不动', () => {
    const runs = [row('a', 'failed'), row('b', 'failed'), row('c', 'failed'), row('d', 'done')]
    const r1 = applyRerun(runs, 'relaunch', {
      done: [{ run_id: 'a', new_run_id: 'na' }],
      skipped: [{ run_id: 'b', reason: '已重跑过', new_run_id: 'nb' }, { run_id: 'c', reason: '和同一批里的执行同属顶层执行 x，已一起重新发起', new_run_id: 'na' }],
      failed: [],
    })
    expect(r1.map((x) => x.relaunched_to)).toEqual(['na', 'nb', undefined, undefined])
    expect(r1.map(sopRunShow)).toEqual(['relaunched', 'relaunched', 'failed', 'done'])
    const r2 = applyRerun(runs, 'retry', { done: [{ run_id: 'c', steps: ['ai'] }], skipped: [], failed: [] })
    expect(r2[2].status).toBe('running')
    expect(r2[2].steps[0].status).toBe('running')
    expect(r2[0]).toBe(runs[0])
  })

  it('已重跑只认失败的', () => {
    expect(isSopRunRelaunched({ status: 'failed', relaunched_to: 'x' })).toBe(true)
    expect(isSopRunRelaunched({ status: 'done', relaunched_to: 'x' })).toBe(false)
    expect(isSopRunRelaunched({ status: 'failed' })).toBe(false)
  })
})
