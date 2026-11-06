// 执行记录的读写（DEV-08c 起，CORE-03a 迁进数据访问层）：某个对象的执行历史、单条详情、取消，以及发起执行的流。
// 执行开始报 run-started，收尾报 run-settled（执行过程中可能改了对象、登记了产出物），取消报 run-canceled。
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { runObject, runs, type FinishRunInput, type RunDone, type RunEvent, type RunPermissionsInput, type RunPreset, type RunPromptParams, type RunRequest, type StreamOptions, type TaskRun, type TerminalRunRequest } from '../api'
import { streamDecision } from './agent'
import { notifyChange, useNotifyChange } from './invalidate'
import { dataKeys } from './keys'

// 后端单页上限
const LIMIT = 100
// 有记录在跑时多久刷一次。输出只在收尾时落库，轮询只为拿到最终状态
const POLL_MS = 2000

// waiting 是交给工作台 Agent 的执行在等人确认（TSK-0460），也没结束
export const runFinished = (r: Pick<TaskRun, 'status'>) => r.status !== 'running' && r.status !== 'pending' && r.status !== 'waiting'

// 最近的在前（后端排序）；有没收尾的记录时轮询
export function useTaskRuns(objectId: string) {
  return useQuery({
    queryKey: dataKeys.runs.list(objectId),
    queryFn: () => runs.list(objectId, { limit: LIMIT }),
    // 新建任务的抽屉还没有 id
    enabled: !!objectId,
    refetchInterval: (q) => (q.state.data?.some((r) => !runFinished(r)) ? POLL_MS : false),
  })
}

// 单条完整输出，展开时才取；没收尾时跟着轮询
export function useTaskRun(id: string, enabled: boolean) {
  return useQuery({
    queryKey: dataKeys.runs.detail(id),
    queryFn: () => runs.get(id),
    enabled,
    refetchInterval: (q) => (q.state.data && !runFinished(q.state.data) ? POLL_MS : false),
  })
}

// 取消只是发出请求，后端稍后才收尾成 canceled；状态以之后读回的为准
export function useCancelRun() {
  const notify = useNotifyChange()
  return useMutation({
    mutationFn: (id: string) => runs.cancel(id),
    onSettled: () => notify({ kind: 'run-canceled' }),
  })
}

/**
 * 发起一次执行并读流（POST /api/objects/{id}/run）。拿到 start 事件时执行列表就有这一条了，
 * 收尾（done 或失败）后按 run-settled 刷新。事件照样交给 onEvent，失败照样抛出。
 * 作用在应用唯一的缓存上，组件外（模块级状态）也能用。
 */
export function streamRun(objectId: string, req: RunRequest = {}, opts: StreamOptions<RunEvent> = {}): Promise<RunDone> {
  return runObject(objectId, req, {
    ...opts,
    onEvent: (e) => {
      opts.onEvent?.(e)
      if (e.type === 'start') void notifyChange({ kind: 'run-started', objectId })
    },
  }).finally(() => void notifyChange({ kind: 'run-settled', objectId }))
}

/**
 * 确认或拒绝工作台 Agent 执行里一次要人确认的写操作（TSK-0460）：和会话里同一个接口，在途的执行接着跑，
 * 过程在执行自己的流里；这里只等接口回 done，收尾按 run-settled 刷执行记录（状态从 waiting 回到 running）。
 */
export function decideRunCall(callId: string, approve: boolean, objectId: string, sessionId?: string): Promise<void> {
  return streamDecision(callId, approve, sessionId).done
    .then(() => undefined)
    .finally(() => void notifyChange({ kind: 'run-settled', objectId }))
}

/** 提示词预览（0048）：弹窗里随方式、目录、附加说明变；切换参数时先留着上一份，免得闪空 */
export function useRunPrompt(objectId: string, params: RunPromptParams, enabled = true) {
  return useQuery({
    queryKey: dataKeys.runs.prompt(objectId, params),
    queryFn: ({ signal }) => runs.prompt(objectId, params, signal),
    enabled,
    placeholderData: keepPreviousData,
  })
}

/** 发起一次终端执行：建记录、写好临时文件（不起进程），报 run-started */
export function startTerminalRun(objectId: string, req: TerminalRunRequest) {
  return runs.terminal(objectId, req).then((h) => {
    void notifyChange({ kind: 'run-started', objectId })
    return h
  })
}

/** 终端执行收尾（「标记结束」，终端没开出来时也用它记失败），报 run-settled */
export function finishTerminalRun(id: string, objectId: string, body: FinishRunInput) {
  return runs.finish(id, body).finally(() => void notifyChange({ kind: 'run-settled', objectId }))
}

export function useFinishRun(objectId: string) {
  const notify = useNotifyChange()
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: FinishRunInput }) => runs.finish(id, body),
    onSettled: () => notify({ kind: 'run-settled', objectId }),
  })
}

/** 交给 Claude Code 的角色（SPEC-tasks-6.18、SPEC-settings-24，原预置提示词）：没设过时后端回内置的六个 */
export function useRunPresets() {
  return useQuery({ queryKey: dataKeys.runs.presets, queryFn: ({ signal }) => runs.presets(signal) })
}

/** 整组保存：响应是替换后的列表（新条目补了 id），直接写回缓存；400 的 message 由调用方显示 */
export function useSaveRunPresets() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (items: RunPreset[]) => runs.savePresets(items),
    onSuccess: (list) => qc.setQueryData(dataKeys.runs.presets, list),
  })
}

/** 后台执行的权限档位与自定义白名单（TSK-0499）：没设过时写入档位是 accept_edits、白名单为空 */
export function useRunPermissions() {
  return useQuery({ queryKey: dataKeys.runs.permissions, queryFn: ({ signal }) => runs.permissions(signal) })
}

/** 整体保存，响应写回缓存；400 的 message 由调用方显示 */
export function useSaveRunPermissions() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: RunPermissionsInput) => runs.savePermissions(body),
    onSuccess: (v) => qc.setQueryData(dataKeys.runs.permissions, v),
  })
}
