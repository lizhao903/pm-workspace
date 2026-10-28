// 本页发起的执行的流式状态（DEV-08c，DEV-09 复用）。
// 执行记录的输出只在收尾时落库，运行中的过程只有发起方的 SSE 流里有，
// 所以流的状态放在模块级，抽屉关了再打开、执行记录列表都能读到同一份。
import { useSyncExternalStore } from 'react'
import { isApiError, isStreamError, queryClient, runObject, type RunDone, type RunEvent, type RunRequest } from '../../core/api'
import { taskRunKeys } from '../../core/api/taskRuns'

export type LivePhase = 'starting' | 'streaming' | 'done' | 'failed'

export type LiveRun = {
  // 发起时的本地 key；拿到 start 事件之后才有 runId
  key: string
  objectId: string
  runId?: string
  workdir?: string
  phase: LivePhase
  events: RunEvent[]
  // 流里的 error 事件（不是终止事件）和开流失败、断流的原因
  errors: string[]
  done?: RunDone
}

let seq = 0
let runsList: LiveRun[] = []
const listeners = new Set<() => void>()

function emit() {
  for (const l of listeners) l()
}

function patch(key: string, f: (r: LiveRun) => LiveRun) {
  runsList = runsList.map((r) => (r.key === key ? f(r) : r))
  emit()
}

function subscribe(l: () => void) {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}

const snapshot = () => runsList

// startRun 发起一次执行并把过程记到模块级状态里，返回本地 key。
// 中断读取不等于取消执行，停执行用 runs.cancel(runId)。
export function startRun(objectId: string, req: RunRequest = {}, opts: { signal?: AbortSignal } = {}): string {
  const key = 'live-' + ++seq
  runsList = [...runsList, { key, objectId, phase: 'starting', events: [], errors: [] }]
  emit()
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: taskRunKeys.all })
    // 执行扫描登记的产出物
    queryClient.invalidateQueries({ queryKey: ['artifacts'] })
  }
  runObject(objectId, req, {
    signal: opts.signal,
    onEvent: (e) => {
      patch(key, (r) => {
        const next = { ...r, events: [...r.events, e] }
        if (e.type === 'start') return { ...next, runId: e.run_id, workdir: e.workdir, phase: 'streaming' }
        if (e.type === 'error') return { ...next, errors: [...r.errors, e.message] }
        if (e.type === 'done') return { ...next, done: e, phase: 'done' }
        return next
      })
      // 记录已经建好，列表里马上出现这一条
      if (e.type === 'start') queryClient.invalidateQueries({ queryKey: taskRunKeys.list(objectId) })
    },
  }).then(refresh, (err: unknown) => {
    const msg = isApiError(err) || isStreamError(err) || err instanceof Error ? err.message : String(err)
    patch(key, (r) => ({ ...r, phase: 'failed', errors: [...r.errors, msg] }))
    refresh()
  })
  return key
}

export function useLiveRuns(): LiveRun[] {
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}

// 按 run id 找本页的流；找不到说明这次执行不是从这个页面发起的
export function useLiveRun(runId: string | undefined): LiveRun | undefined {
  const all = useLiveRuns()
  return runId ? all.find((r) => r.runId === runId) : undefined
}

// 按发起时的 key 找，DEV-09 发起后用它跟踪还没拿到 run id 的那段
export function useLiveRunByKey(key: string | undefined): LiveRun | undefined {
  const all = useLiveRuns()
  return key ? all.find((r) => r.key === key) : undefined
}

// 测试用：清空模块级状态
export function resetLiveRuns() {
  runsList = []
  emit()
}
