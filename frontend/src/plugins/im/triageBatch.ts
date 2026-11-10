// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 批量分诊自动分批（TSK-0492，SPEC-messages-1.51）：要分诊的消息超过一次批量发起的上限（SOP_BATCH_MAX，200）时，
// 按每批 200 条依次（串行）调 POST /api/sop/flows/{id}/runs/batch，不并发，免得一下子把模型名额排满。
// 每批的结果按 index 对回消息编号；整批请求失败（网络、流程被删）算这批每条都失败，接着发下一批。
// 中途停止：当前这批发出去了就等它回来（已发起的保留），之后的批不再发，记成「没发起」。
// 去重口径不变：每批都带同一个 skip_existing_key（不勾「已跑过的也重跑」时为 message_id），由后端按这条流程已有执行跳过。
// 立即停止（TSK-0717）：每批都带同一个批次 batch_id（TriageDialog 生成），按批次一次停掉这次分诊已发起的全部执行；
// 批次停了以后后端不再发起，回 cancelled，这里记进「没发起」并且不再发下一批。
import type { SopBatchResult } from '../../core/data'

/** 一次批量分诊最多多少条（自动分批前的总数）；超过不发起，让人先缩小范围。防误操作：每条都会调模型 */
export const TRIAGE_TOTAL_MAX = 1000

/** 按 size 切成几批，最后一批可以不满 */
export function chunkIds<T>(xs: readonly T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size))
  return out
}

/** 分批的批数 */
export const batchCount = (n: number, size: number) => (n > 0 ? Math.ceil(n / size) : 0)

export type TriageFail = { id: string; error: string }

/** 分批发起的进度和结果：batch 是已经发完（回来了）的批数 */
export type TriageProgress = {
  total: number
  batches: number
  batch: number
  started: string[]
  skipped: string[]
  failed: TriageFail[]
  /** 停止后没发出去的 */
  rest: string[]
  stopped: boolean
  finished: boolean
}

export const initialProgress = (ids: readonly string[], size: number): TriageProgress => ({
  total: ids.length, batches: batchCount(ids.length, size), batch: 0, started: [], skipped: [], failed: [], rest: [], stopped: false, finished: false,
})

/**
 * 逐批串行发起。start 发一批（回后端结果），shouldStop 在每批发出前查一次；每批回来后 onProgress 一次，结束再一次（finished=true）
 */
export async function runTriageBatches(ids: readonly string[], size: number, start: (ids: string[]) => Promise<SopBatchResult>, opts: {
  shouldStop: () => boolean
  onProgress: (p: TriageProgress) => void
  errorText: (e: unknown) => string
}): Promise<TriageProgress> {
  const chunks = chunkIds(ids, size)
  let p = initialProgress(ids, size)
  for (let i = 0; i < chunks.length; i++) {
    if (opts.shouldStop()) {
      p = { ...p, stopped: true, rest: chunks.slice(i).flat() }
      break
    }
    const part = chunks[i]
    const at = (x: { index: number; key: string }) => part[x.index] ?? x.key
    try {
      const r = await start(part)
      const cancelled = (r.cancelled ?? []).map(at)
      p = {
        ...p, batch: i + 1,
        started: [...p.started, ...r.started.map(at)],
        skipped: [...p.skipped, ...r.skipped.map(at)],
        failed: [...p.failed, ...r.failed.map((x) => ({ id: at(x), error: x.error ?? '没发起成' }))],
      }
      if (cancelled.length) {
        // 批次已被立即停止：这批里没发起的和之后的批都不发
        p = { ...p, stopped: true, rest: [...cancelled, ...chunks.slice(i + 1).flat()] }
        opts.onProgress(p)
        break
      }
    } catch (e) {
      const error = opts.errorText(e)
      p = { ...p, batch: i + 1, failed: [...p.failed, ...part.map((id) => ({ id, error }))] }
    }
    opts.onProgress(p)
  }
  p = { ...p, finished: true }
  opts.onProgress(p)
  return p
}

/** 换成批量发起接口的结果形状，标题行的一句话（triageNote）沿用 */
export function progressResult(p: TriageProgress): SopBatchResult {
  return {
    started: p.started.map((key, index) => ({ index, key })),
    skipped: p.skipped.map((key, index) => ({ index, key })),
    failed: p.failed.map((f, index) => ({ index, key: f.id, error: f.error })),
  }
}

/** 失败原因归并：同一个原因写一次，带条数，原因多的在前 */
export function failReasons(failed: readonly TriageFail[]): { error: string; n: number }[] {
  const m = new Map<string, number>()
  for (const f of failed) m.set(f.error, (m.get(f.error) ?? 0) + 1)
  return [...m.entries()].map(([error, n]) => ({ error, n })).sort((a, b) => b.n - a.n)
}
