// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 运行中心（P0-O1）：Agent 执行记录和任务执行统一一页看到，接 GET /api/runs/all。
// 状态、来源在后端筛；Agent 行能停、能重新执行、能去会话或执行记录，任务行能取消、能打开任务。
// 停止、重试复用执行记录原来的接口（O-2），取消任务走 /api/runs/{id}/cancel（后端并行开发，按契约先写）。
import { useState } from 'react'
import { useNavigate } from 'react-router'
import { Button, EmptyState, ErrorState, LoadingState, PageTitle, Pill, cls } from '../../core/ui'
import { AGENT_RUN_STATUS, useRetryAgentRun, useStopAgentRun } from '../../core/data/agentRuns'
import type { AgentRunStatus } from '../../core/data/agents'
import { errorText } from '../../core/data/errors'
import {
  runElapsed, useCancelTaskRun, useRunCenter, type RunCenterItem, type RunCenterKind, type RunCenterStatus,
} from '../../core/data/runCenter'
import { timeAgo } from '../../core/chat/chatModel'
import './runs.css'

/** 一次先露多少条，往下点「显示更多」 */
const PAGE = 100
// 状态切换：全部 + 执行中 / 等你确认 / 失败 / 已完成 / 已停止
const SEG: ('' | RunCenterStatus)[] = ['', 'running', 'waiting', 'failed', 'done', 'canceled']
const SOURCES: { key: '' | RunCenterKind; label: string }[] = [
  { key: '', label: '全部' },
  { key: 'agent', label: 'Agent' },
  { key: 'task', label: '任务' },
]

const statusOf = (s: string) => AGENT_RUN_STATUS[s as AgentRunStatus] ?? { label: s, color: 'var(--muted)' }

/** 运行中心的一行：状态、标题、sub、说明（截断）、相对时间、耗时，右边是能做的操作 */
function RunCenterRow({ item, now, onOpenRun, onOpenSession, onOpenTask, onStop, onRetry, onCancel, stopping, retrying, canceling }: {
  item: RunCenterItem
  now: Date
  onOpenRun: (id: string) => void
  onOpenSession: (id: string) => void
  onOpenTask: (item: RunCenterItem) => void
  onStop: () => void
  onRetry: () => void
  onCancel: () => void
  stopping: boolean
  retrying: boolean
  canceling: boolean
}) {
  const st = statusOf(item.status)
  const isAgent = item.kind === 'agent'
  const elapsed = runElapsed(item, now)
  return (
    <div className="runs-row" data-run-center={item.id} data-kind={item.kind} data-status={item.status}>
      <div className="runs-row-main">
        <div className="runs-row-top">
          <Pill label={st.label} color={st.color} />
          <button type="button" className="runs-title ellipsis" title={isAgent ? `打开执行记录 · ${item.title}` : `打开任务 · ${item.title}`}
            onClick={() => (isAgent ? onOpenRun(item.id) : onOpenTask(item))}>{item.title}</button>
          <span className="spacer" />
          <span className="runs-time" title={item.started_at}>{timeAgo(item.started_at, now)}</span>
          {elapsed && <span className="runs-elapsed" title="耗时">{elapsed}</span>}
        </div>
        <div className="runs-row-sub">
          <span className="runs-sub ellipsis" title={item.sub}>{item.sub}</span>
          {item.pending > 0 && <span className="runs-wait">{item.pending} 处等你确认</span>}
        </div>
        {item.summary && <div className="runs-summary ellipsis" title={item.summary}>{item.summary}</div>}
      </div>
      <div className="runs-acts">
        {isAgent && item.status === 'running' && (
          <Button size="sm" variant="danger" disabled={stopping} title="停掉这次执行；已经执行的调用不会撤回" onClick={onStop}>
            {stopping ? '停止中…' : '停止'}
          </Button>
        )}
        {isAgent && (item.status === 'failed' || item.status === 'canceled') && (
          <Button size="sm" disabled={retrying} title="按这次执行的输入重新发起一次" onClick={onRetry}>
            {retrying ? '重新发起中…' : '重新执行'}
          </Button>
        )}
        {isAgent && item.session_id && <Button size="sm" onClick={() => onOpenSession(item.session_id!)}>打开会话</Button>}
        {!isAgent && item.status === 'running' && (
          <Button size="sm" variant="danger" disabled={canceling} title="取消这次任务执行" onClick={onCancel}>
            {canceling ? '取消中…' : '取消'}
          </Button>
        )}
        {!isAgent && <Button size="sm" onClick={() => onOpenTask(item)}>打开任务</Button>}
      </div>
    </div>
  )
}

export default function Page() {
  const navigate = useNavigate()
  const [status, setStatus] = useState<'' | RunCenterStatus>('')
  const [source, setSource] = useState<'' | RunCenterKind>('')
  const [limit, setLimit] = useState(PAGE)
  const [err, setErr] = useState('')
  const list = useRunCenter({ status: status || undefined, source: source || undefined, limit })
  const stop = useStopAgentRun()
  const retry = useRetryAgentRun()
  const cancel = useCancelTaskRun()
  // 「现在」取页面打开那一刻，每次重新取到后跟着往前走；渲染里不直接 new Date()
  const [opened] = useState(() => Date.now())
  const now = new Date(Math.max(opened, list.dataUpdatedAt))

  const pickStatus = (k: '' | RunCenterStatus) => { setStatus(k); setLimit(PAGE) }
  // 单选，再点一次取消
  const pickSource = (k: '' | RunCenterKind) => { setSource(k === source ? '' : k); setLimit(PAGE) }

  // 停、重试、取消：错了在列表上方说一句，完事重新取这一页
  const act = async (fn: () => Promise<unknown>) => {
    setErr('')
    try { await fn() } catch (e) { setErr(errorText(e)) } finally { void list.refetch() }
  }
  const openRun = (id: string) => navigate(`/conversations/runs?run=${encodeURIComponent(id)}`)
  const openSession = (id: string) => navigate(`/conversations?s=${encodeURIComponent(id)}`)
  // 任务行回任务抽屉的执行记录标签，并定位这次执行
  const openTask = (item: RunCenterItem) =>
    navigate(`/tasks?t=${encodeURIComponent(item.object_id)}&tab=runs&run=${encodeURIComponent(item.id)}`)

  const rows = list.data?.data ?? []
  const total = list.data?.total ?? 0

  let body
  if (list.isPending) body = <LoadingState />
  else if (list.isError) body = <ErrorState title="运行记录加载失败" error={list.error} onRetry={() => void list.refetch()} />
  else if (!rows.length) {
    body = status || source
      ? <EmptyState title="没有符合条件的运行记录" desc="换个状态或来源看看" />
      : <EmptyState title="还没有运行记录" desc="Agent 被触发、任务被执行后，每一次执行都会出现在这里" />
  } else {
    body = (
      <div className="runs-list">
        {rows.map((item) => (
          <RunCenterRow key={`${item.kind}:${item.id}`} item={item} now={now}
            onOpenRun={openRun} onOpenSession={openSession} onOpenTask={openTask}
            onStop={() => void act(() => stop.mutateAsync(item.id))}
            onRetry={() => void act(() => retry.mutateAsync(item.id))}
            onCancel={() => void act(() => cancel.mutateAsync(item.id))}
            stopping={stop.isPending && stop.variables === item.id}
            retrying={retry.isPending && retry.variables === item.id}
            canceling={cancel.isPending && cancel.variables === item.id} />
        ))}
        {total > rows.length && (
          <button type="button" className="runs-more" disabled={list.isFetching} onClick={() => setLimit(limit + PAGE)}>
            显示更多（还有 {total - rows.length} 条）
          </button>
        )}
      </div>
    )
  }

  return (
    <div className="runs-page">
      <PageTitle count={list.isSuccess ? total : undefined}
        desc="Agent 执行和任务执行一页看到；在跑的能停止、取消，失败的能重新发起">运行中心</PageTitle>
      <div className="runs-toolbar">
        <div className="runs-seg" role="tablist" aria-label="状态">
          {SEG.map((k) => (
            <button key={k} type="button" role="tab" aria-selected={status === k} className={cls(status === k && 'on')} onClick={() => pickStatus(k)}>
              {k ? statusOf(k).label : '全部'}
            </button>
          ))}
        </div>
        <div className="runs-seg" role="group" aria-label="来源">
          {SOURCES.map((s) => (
            <button key={s.key} type="button" aria-pressed={source === s.key} className={cls(source === s.key && 'on')} onClick={() => pickSource(s.key)}>
              {s.label}
            </button>
          ))}
        </div>
      </div>
      {err && <div className="field-err runs-err" role="alert">没操作成：{err}</div>}
      {body}
    </div>
  )
}
