// 处理队列：分诊这类按消息发起的 SOP 执行（输入带 message_id 的）。
// 「进行中」按开始先后列出没结束的执行（执行中、排队等模型名额、等人确认），能终止单条、全部终止（二次确认）；
// 「最近结束」列最近 20 条，失败的能重试当前步骤。每行：消息摘要、流程名、当前步骤和状态、已等多久；点行打开 SOP 运行详情。
import { useState } from 'react'
import { errorText, sopRunShow, useSopRunAction, useStopSopRuns, type ImMessage, type SopInputRun } from '../../core/data'
import { ConfirmDialog, Drawer, cls } from '../../core/ui'
import { timeAgo } from './model'
import { focusText, isQueued, messageBrief, queueSplit, retryStep, waitFor } from './triageModel'

// relaunched：失败后已按最新流程重跑过（sopRunShow），不再能重试
const RUN_STATE: Record<string, string> = { running: '执行中', waiting: '等人处理', done: '已完成', failed: '失败', stopped: '已终止', relaunched: '已重跑' }

export function QueueDrawer({ runs, messages, now, loading, error, onClose, onOpenRun, onOpenMessage }: {
  runs: readonly SopInputRun[]
  messages: readonly ImMessage[]
  now: number
  loading: boolean
  error: unknown
  onClose: () => void
  onOpenRun: (id: string) => void
  onOpenMessage: (id: string) => void
}) {
  const { active, recent } = queueSplit(runs)
  const byId = new Map(messages.map((m) => [m.id, m]))
  const act = useSopRunAction()
  const stopAll = useStopSopRuns()
  const [confirm, setConfirm] = useState(false)
  const [err, setErr] = useState('')

  const row = (r: SopInputRun) => {
    const m = byId.get(r.input_value)
    const b = m ? messageBrief(m) : null
    const shown = sopRunShow(r)
    const state = r.status === 'running' && isQueued(r) ? '排队中' : RUN_STATE[shown] ?? shown
    const retry = retryStep(r)
    return (
      <div key={r.id} className="im-q-row" role="listitem">
        <button type="button" className="im-q-main" onClick={() => onOpenRun(r.id)} title="打开 SOP 运行详情">
          <span className="im-q-msg">
            {b ? <><b>{b.who}</b><span className="im-muted"> · {b.where}</span> {b.text}</> : <span className="im-muted">消息 {r.input_value}（不在当前列表里）</span>}
          </span>
          <span className="im-q-meta">
            <span>{r.flow_name}</span>
            <span>{focusText(r)}</span>
            <span className={cls('im-state', shown === 'failed' && 'im-state-bad')}>{state}</span>
            <span>{r.status === 'running' || r.status === 'waiting' ? `已等 ${waitFor(r.started_at, now)}` : timeAgo(r.ended_at ?? r.updated_at, now)}</span>
          </span>
        </button>
        <span className="im-q-acts">
          {m && <button type="button" className="im-act im-act-quiet" onClick={() => onOpenMessage(m.id)}>看消息</button>}
          {(r.status === 'running' || r.status === 'waiting') && (
            <button type="button" className="im-act" disabled={act.isPending}
              onClick={() => { setErr(''); act.mutate({ runId: r.id, action: { kind: 'stop' } }, { onError: (e) => setErr(`没终止成：${errorText(e)}`) }) }}>终止</button>
          )}
          {retry !== null && (
            <button type="button" className="im-act" disabled={act.isPending}
              onClick={() => { setErr(''); act.mutate({ runId: r.id, action: { kind: 'retry', step: retry } }, { onError: (e) => setErr(`没重试成：${errorText(e)}`) }) }}>重试</button>
          )}
        </span>
      </div>
    )
  }

  return (
    <Drawer open onClose={onClose} kicker="处理队列" aria-label="处理队列"
      headActions={active.length > 0 && (
        <button type="button" className="btn btn-sm btn-outline" disabled={stopAll.isPending} onClick={() => setConfirm(true)}>全部终止</button>
      )}>
      {error ? <div className="im-err" role="alert">执行没加载出来：{errorText(error)}</div> : null}
      {err && <div className="im-err" role="alert">{err}</div>}
      {stopAll.data && stopAll.data.errors.length > 0 && <div className="im-err" role="alert">有 {stopAll.data.errors.length} 条没终止成：{stopAll.data.errors[0]}</div>}
      <div className="im-section">进行中 {active.length}</div>
      {loading ? <div className="im-muted">加载中</div>
        : active.length ? <div className="im-q-list" role="list" aria-label="进行中">{active.map(row)}</div>
          : <div className="im-muted">没有进行中的分诊</div>}
      <div className="im-section">最近结束</div>
      {recent.length ? <div className="im-q-list" role="list" aria-label="最近结束">{recent.map(row)}</div>
        : !loading && <div className="im-muted">还没有跑完的分诊</div>}
      <ConfirmDialog open={confirm} danger title="全部终止" confirmLabel={stopAll.isPending ? '终止中…' : `终止 ${active.length} 条`} busy={stopAll.isPending}
        onCancel={() => setConfirm(false)}
        onConfirm={() => stopAll.mutate(active.map((r) => r.id), { onSettled: () => setConfirm(false) })}>
        进行中的 {active.length} 条分诊执行都会停下，已经做完的步骤（改过的消息状态、归过的项目）不会撤回。终止后不能接着跑，要重来得重新发起
      </ConfirmDialog>
    </Drawer>
  )
}
