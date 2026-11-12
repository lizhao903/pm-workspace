// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { describe, expect, it } from 'vitest'
import type { SopBatchResult } from '../../core/data'
import { batchCount, chunkIds, failReasons, progressResult, runTriageBatches, type TriageProgress } from './triageBatch'

const ids = (n: number) => Array.from({ length: n }, (_, i) => `msg_${i}`)
const ok = (part: string[]): SopBatchResult => ({ started: part.map((key, index) => ({ index, key, run_id: `spr_${key}` })), skipped: [], failed: [] })
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))

describe('批量分诊自动分批（TSK-0492）', () => {
  it('按 200 切批，最后一批不满；批数', () => {
    expect(chunkIds(ids(450), 200).map((x) => x.length)).toEqual([200, 200, 50])
    expect(batchCount(450, 200)).toBe(3)
    expect(batchCount(200, 200)).toBe(1)
    expect(batchCount(0, 200)).toBe(0)
  })

  it('逐批串行：上一批回来才发下一批；每批回来报一次进度', async () => {
    let inFlight = 0
    let maxInFlight = 0
    const seen: number[] = []
    const p = await runTriageBatches(ids(450), 200, async (part) => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((r) => setTimeout(r, 1))
      inFlight -= 1
      return ok(part)
    }, { shouldStop: () => false, onProgress: (x) => seen.push(x.batch), errorText })
    expect(maxInFlight).toBe(1)
    expect(seen).toEqual([1, 2, 3, 3])
    expect(p).toMatchObject({ total: 450, batches: 3, batch: 3, finished: true, stopped: false })
    expect(p.started).toHaveLength(450)
  })

  it('按 index 对回消息；某条没发起成、整批报错都记失败，其余批照发', async () => {
    let n = 0
    const p = await runTriageBatches(ids(5), 2, async (part) => {
      n += 1
      if (n === 2) throw new Error('流程已删除')
      if (n === 1) return { started: [{ index: 1, key: 'x', run_id: 'spr_1' }], skipped: [], failed: [{ index: 0, key: '', error: '「客户」必填' }] }
      return { started: [], skipped: [{ index: 0, key: part[0], run_id: 'spr_old' }], failed: [] }
    }, { shouldStop: () => false, onProgress: () => {}, errorText })
    expect(p.started).toEqual(['msg_1'])
    expect(p.skipped).toEqual(['msg_4'])
    expect(p.failed).toEqual([{ id: 'msg_0', error: '「客户」必填' }, { id: 'msg_2', error: '流程已删除' }, { id: 'msg_3', error: '流程已删除' }])
    expect(failReasons(p.failed)).toEqual([{ error: '流程已删除', n: 2 }, { error: '「客户」必填', n: 1 }])
    const r = progressResult(p)
    expect([r.started.length, r.skipped.length, r.failed.length]).toEqual([1, 1, 3])
  })

  it('中途停止：发出去的这批等它回来，之后的不发，记成没发起', async () => {
    let stop = false
    const sent: number[] = []
    const last: TriageProgress[] = []
    const p = await runTriageBatches(ids(450), 200, async (part) => {
      sent.push(part.length)
      stop = true
      return ok(part)
    }, { shouldStop: () => stop, onProgress: (x) => last.push(x), errorText })
    expect(sent).toEqual([200])
    expect(p).toMatchObject({ batch: 1, stopped: true, finished: true })
    expect(p.started).toHaveLength(200)
    expect(p.rest).toEqual(ids(450).slice(200))
    expect(last.at(-1)?.finished).toBe(true)
  })

  it('批次被立即停止：后端回 cancelled 的记成没发起，之后的批不再发（TSK-0717）', async () => {
    const sent: number[] = []
    const p = await runTriageBatches(ids(450), 200, async (part) => {
      sent.push(part.length)
      // 第一批发到一半批次被停：前 50 条发起了，后 150 条没发起
      return { started: part.slice(0, 50).map((key, index) => ({ index, key, run_id: `spr_${key}` })), skipped: [], failed: [],
        cancelled: part.slice(50).map((_, i) => ({ index: i + 50, key: '' })) }
    }, { shouldStop: () => false, onProgress: () => {}, errorText })
    expect(sent).toEqual([200])
    expect(p).toMatchObject({ batch: 1, stopped: true, finished: true })
    expect(p.started).toHaveLength(50)
    expect(p.rest).toEqual(ids(450).slice(50))
  })
})
