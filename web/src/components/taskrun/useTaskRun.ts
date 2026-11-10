// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 「用本机 Claude Code 执行这个任务」的全部状态机：发起 / 流式收事件 / 停止 / 历史记录。
import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../../lib/api'
import type { TaskRun, TaskRunRequest } from '../../lib/types'
import { streamTaskRun } from './sse'

export type RunItemKind = 'text' | 'tool' | 'tool_result' | 'notice' | 'artifact'

/** 工具行的状态。一直没等到 tool_result 就停在 running——执行被取消时正是这样，
 *  它是诚实的：用户能看出 claude 当时卡在哪一步。流结束时不做统一收尾。 */
export type ToolState = 'running' | 'ok' | 'fail'

export interface RunItem {
  id: string
  kind: RunItemKind
  /** text 的正文、tool 的补充说明、notice 的提示语、tool_result 的错误文本 */
  text: string
  /** tool 用了哪个工具 */
  toolName?: string
  /** 后端给的工具调用 id，tool_result 靠它回填到对应的 tool 行上 */
  toolId?: string
  toolState?: ToolState
  /** 工具失败时后端给的错误文本，可能很长，渲染那边截断 + 可展开 */
  toolError?: string
  /** notice 的语气：报错标红，其余按中性提示 */
  tone?: 'info' | 'error'
  /** artifact 行：登记下来的产物。path 是相对工作目录的路径 */
  artifactId?: string
  artifactNew?: boolean
  artifactSize?: number
}

export interface UseTaskRun {
  items: RunItem[]
  running: boolean
  /** 本次执行的 run_id，后端发了先导事件才有 */
  runId: string
  /** 后端实际用的工作目录，来自先导事件；界面要显示「正在哪里执行」 */
  runWorkdir: string
  /** 已跑秒数，执行中每秒走一格 */
  elapsedMs: number
  /** 收到 done 后的退出码，null 表示还没有结果 */
  exitCode: number | null
  stopping: boolean

  history: TaskRun[]
  historyLoading: boolean
  reloadHistory: () => Promise<void>

  /**
   * allowWrites 为 true 时后端放开写权限（claude 是 --permission-mode acceptEdits，
   * deepseek 是 dsh 沙箱的 workspace-write）。harness 选执行器，空按 claude。
   * resumeSession 只对 deepseek 有意义：接着这个对象上一次的会话继续跑。
   */
  start: (opts: {
    workdir: string
    extraPrompt: string
    allowWrites: boolean
    harness?: 'claude' | 'deepseek'
    resumeSession?: boolean
  }) => Promise<void>
  stop: () => void
}

let seq = 0
const nextId = () => `tr${++seq}`

export function useTaskRun(objectId: string): UseTaskRun {
  const [items, setItems] = useState<RunItem[]>([])
  const [running, setRunning] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [runId, setRunId] = useState('')
  const [runWorkdir, setRunWorkdir] = useState('')
  const [exitCode, setExitCode] = useState<number | null>(null)
  const [startedAt, setStartedAt] = useState(0)
  const [elapsedMs, setElapsedMs] = useState(0)
  const [history, setHistory] = useState<TaskRun[]>([])
  const [historyLoading, setHistoryLoading] = useState(true)

  const abortRef = useRef<AbortController | null>(null)
  // 事件回调里要拿最新的 run_id，state 有一帧延迟，另存一份
  const runIdRef = useRef('')
  const timersRef = useRef<number[]>([])

  const push = useCallback((it: RunItem) => setItems((prev) => [...prev, it]), [])

  /* ───────── 历史记录 ───────── */

  const reloadHistory = useCallback(async () => {
    setHistoryLoading(true)
    // 后端可能还没上线：失败一律按空态，不弹错误横幅
    const rows = await api.taskRuns(objectId).catch(() => null)
    setHistory(rows ?? [])
    setHistoryLoading(false)
  }, [objectId])

  useEffect(() => {
    let alive = true
    setHistoryLoading(true)
    void api.taskRuns(objectId)
      .then((rows) => { if (alive) setHistory(rows) })
      .catch(() => { if (alive) setHistory([]) })
      .finally(() => { if (alive) setHistoryLoading(false) })
    return () => { alive = false }
  }, [objectId])

  // 换对象时把上一条的流断掉，免得输出串到别的对象上
  useEffect(() => () => {
    abortRef.current?.abort()
    timersRef.current.forEach((t) => window.clearTimeout(t))
    timersRef.current = []
  }, [objectId])

  /** 后端的 /cancel 只发信号就返回，进程要几秒才收尾落库，
   *  只刷一次历史会停在「执行中」上。隔一会儿再各补一次。 */
  const refreshLater = useCallback(() => {
    for (const ms of [1200, 4000]) {
      timersRef.current.push(window.setTimeout(() => { void reloadHistory() }, ms))
    }
  }, [reloadHistory])

  /* ───────── 计时 ───────── */

  useEffect(() => {
    if (!running || !startedAt) return
    setElapsedMs(Date.now() - startedAt)
    const t = window.setInterval(() => setElapsedMs(Date.now() - startedAt), 1000)
    return () => window.clearInterval(t)
  }, [running, startedAt])

  /* ───────── 发起执行 ───────── */

  const start = useCallback(async ({
    workdir, extraPrompt, allowWrites, harness = 'claude', resumeSession = false,
  }: {
    workdir: string
    extraPrompt: string
    allowWrites: boolean
    harness?: 'claude' | 'deepseek'
    resumeSession?: boolean
  }) => {
    if (running || !workdir.trim()) return

    setItems([])
    setExitCode(null)
    setRunId('')
    setRunWorkdir('')
    runIdRef.current = ''
    setStopping(false)
    const t0 = Date.now()
    setStartedAt(t0)
    setElapsedMs(0)

    const ac = new AbortController()
    abortRef.current = ac
    setRunning(true)
    let sawTerminal = false // 收到 done 或 error 才算正常收场

    try {
      const res = await fetch(api.taskRunUrl(objectId), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Actor-Source': 'ui' },
        body: JSON.stringify({
          workdir: workdir.trim(),
          extra_prompt: extraPrompt.trim(),
          allow_writes: allowWrites,
          harness,
          // 只有 deepseek 认这个开关；claude 传了也无害，后端不看
          resume_session: harness === 'deepseek' ? resumeSession : undefined,
        } satisfies TaskRunRequest),
        signal: ac.signal,
      })
      if (!res.ok || !res.body) {
        const detail = await res.text().catch(() => '')
        throw new Error(`执行请求失败（HTTP ${res.status}）${detail ? `：${detail.slice(0, 200)}` : ''}`)
      }

      for await (const ev of streamTaskRun(res.body)) {
        switch (ev.type) {
          case 'start':
            runIdRef.current = ev.run_id
            setRunId(ev.run_id)
            // 生效目录可能来自对象设置，也可能是面板上临时填的，以后端回的为准
            setRunWorkdir(ev.workdir)
            break
          case 'delta':
            // 连续的文本并成一段，别每个 delta 都开一个新块
            setItems((prev) => {
              const last = prev[prev.length - 1]
              if (last?.kind === 'text') {
                const next = prev.slice()
                next[next.length - 1] = { ...last, text: last.text + ev.text }
                return next
              }
              return [...prev, { id: nextId(), kind: 'text', text: ev.text }]
            })
            break
          case 'tool':
            push({
              id: nextId(), kind: 'tool', text: ev.detail ?? '',
              toolName: ev.name, toolId: ev.id, toolState: 'running',
            })
            break
          case 'tool_result':
            setItems((prev) => {
              // 按后端的 id 回填到那条 tool 行上
              const i = prev.findLastIndex(
                (x) => x.kind === 'tool' && x.toolId === ev.id && x.toolState === 'running',
              )
              const state: ToolState = ev.ok ? 'ok' : 'fail'
              if (i < 0) {
                // 配不上就独立成一行，别静默丢掉——后端在 tool_result 上补了 name 就是为了这个
                return [...prev, {
                  id: nextId(), kind: 'tool_result', text: '',
                  toolName: ev.name, toolId: ev.id, toolState: state, toolError: ev.error ?? '',
                }]
              }
              // detail（文件路径那截）要留着，错误另存一个字段
              const next = prev.slice()
              next[i] = { ...next[i], toolState: state, toolError: ev.ok ? '' : (ev.error ?? '') }
              return next
            })
            break
          case 'done':
            sawTerminal = true
            if (ev.run_id) { runIdRef.current = ev.run_id; setRunId(ev.run_id) }
            setExitCode(typeof ev.exit_code === 'number' ? ev.exit_code : 0)
            break
          case 'artifact':
            // 收尾时扫目录扫出来的产出，在 done 之前到。
            // 单独成行而不是并进 notice：用户扫一眼要能数清这次产出了几件。
            push({
              id: nextId(), kind: 'artifact', text: ev.path,
              artifactId: ev.artifact_id, artifactNew: ev.is_new, artifactSize: ev.size,
            })
            break
          case 'error':
            sawTerminal = true
            push({ id: nextId(), kind: 'notice', tone: 'error', text: ev.message })
            setExitCode((c) => c ?? -1)
            break
        }
      }

      // 后端半路挂了 / 网络断了，TCP 一关流就「正常」结束了，读不到任何异常。
      // 只有靠「没见过 done 也没见过 error」才认得出来，否则界面会静默停在半句话上。
      if (!sawTerminal) {
        push({ id: nextId(), kind: 'notice', tone: 'error', text: '执行流意外中断：没有收到完成信号，本机进程可能仍在运行。' })
        setExitCode((c) => c ?? -1)
      }
    } catch (e) {
      if (ac.signal.aborted) {
        push({ id: nextId(), kind: 'notice', tone: 'info', text: '已停止执行。' })
      } else {
        const why = e instanceof Error ? e.message : String(e)
        push({ id: nextId(), kind: 'notice', tone: 'error', text: `执行中断：${why}` })
        setExitCode((c) => c ?? -1)
      }
    } finally {
      abortRef.current = null
      setRunning(false)
      setStopping(false)
      setElapsedMs(Date.now() - t0)
      void reloadHistory()
    }
  }, [objectId, running, push, reloadHistory])

  /* ───────── 停止 ───────── */

  // abort() 只断前端这一头，本机的 claude 进程还在跑，必须同时让后端 kill。
  const stop = useCallback(() => {
    if (!running) return
    setStopping(true)
    abortRef.current?.abort()

    void (async () => {
      let id = runIdRef.current
      if (!id) {
        // 后端没发先导事件时兜底：从历史里找这条对象仍在跑的记录
        const rows = await api.taskRuns(objectId).catch(() => null)
        id = rows?.find((r) => r.status === 'running' || r.status === 'pending')?.id ?? ''
      }
      if (!id) {
        push({
          id: nextId(), kind: 'notice', tone: 'error',
          text: '已断开输出，但没拿到执行 id，无法通知后端结束进程——本机的 claude 可能还在跑。',
        })
        return
      }
      await api.cancelTaskRun(id).catch((e: unknown) => {
        push({
          id: nextId(), kind: 'notice', tone: 'error',
          text: `取消执行失败：${e instanceof Error ? e.message : String(e)}`,
        })
      })
      void reloadHistory()
      refreshLater()
    })()
  }, [running, objectId, push, reloadHistory, refreshLater])

  return {
    items, running, runId, runWorkdir, elapsedMs, exitCode, stopping,
    history, historyLoading, reloadHistory,
    start, stop,
  }
}
